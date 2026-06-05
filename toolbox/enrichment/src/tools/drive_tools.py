"""Google Drive input helpers: folder discovery + multi-format content reads.

Google Docs are read via the internal gdocs CLI (no OAuth scope needed). Folder
listing and non-Doc formats (Sheets, Slides, PDF) go through the Drive v3 API,
which requires an ADC token with the drive.readonly scope. If you see 403
insufficientPermissions on content reads, re-run:

    gcloud auth application-default login --scopes='openid,\\
    https://www.googleapis.com/auth/userinfo.email,\\
    https://www.googleapis.com/auth/cloud-platform,\\
    https://www.googleapis.com/auth/drive.readonly'
"""

import io
import os
import re
import subprocess
import tempfile
import threading

_DOC_MIME = "application/vnd.google-apps.document"
_SHEET_MIME = "application/vnd.google-apps.spreadsheet"
_SLIDES_MIME = "application/vnd.google-apps.presentation"
_PDF_MIME = "application/pdf"

_DEFAULT_MAX_CHARS = 60000

_GDOCS_BIN = "/google/bin/releases/gemini-agents-gdocs/gdocs"
_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"

# Per-thread Drive service cache. googleapiclient is built on httplib2, whose
# Http/connection objects are NOT thread-safe: sharing one service across the
# crawler's worker threads leads to concurrent SSL socket use and heap
# corruption (double free -> SIGABRT). Each thread therefore gets its own
# service (and its own httplib2.Http) via thread-local storage.
_thread_local = threading.local()


def get_service():
    """Returns a thread-local, authenticated Drive v3 service via ADC.

    The underlying ADC token must include the drive.readonly scope (see module
    docstring). The googleapiclient import is local so callers that only use the
    gdocs CLI path (fetch_gdoc) don't pull in the Drive API dependency.

    A fresh service is built per thread because the underlying httplib2 transport
    is not thread-safe; reusing one across threads corrupts the SSL connection.
    """
    service = getattr(_thread_local, "service", None)
    if service is None:
        from google.auth import default
        from googleapiclient.discovery import build

        creds, _ = default(scopes=[_DRIVE_SCOPE])
        service = build(
            "drive", "v3", credentials=creds, cache_discovery=False
        )
        _thread_local.service = service
    return service


def extract_gdoc_id(url_or_id: str) -> str:
    """Extracts the Doc ID from a Google Doc URL or returns the ID if already clean."""
    match = re.search(r"https://docs\.google\.com/document/d/([a-zA-Z0-9-_]+)", url_or_id or "")
    return match.group(1) if match else (url_or_id or "")


def extract_folder_id(url_or_id: str) -> str:
    """Extracts the folder ID from a Drive folder URL or returns the ID as-is.

    Accepts any of: a bare folder id, or a full URL such as
    https://drive.google.com/corp/drive/folders/<id>,
    https://drive.google.com/drive/folders/<id>, or
    https://drive.google.com/drive/u/0/folders/<id> (with optional query/anchor).
    """
    s = (url_or_id or "").strip()
    match = re.search(r"/folders/([a-zA-Z0-9_-]+)", s)
    if match:
        return match.group(1)
    # Bare id (possibly with stray query params/trailing slash) — keep the id token.
    return s.split("?", 1)[0].rstrip("/")


def fetch_gdoc(url: str) -> str:
    """Fetches the raw text content of a single Google Doc using the internal gdocs CLI."""
    if not url:
        return ""

    if not os.path.exists(_GDOCS_BIN):
        return f"Error: gdocs CLI binary not found at {_GDOCS_BIN}."

    doc_id = extract_gdoc_id(url)
    temp_file = tempfile.NamedTemporaryFile(suffix=".md", delete=False)
    temp_file.close()
    output_path = temp_file.name

    try:
        subprocess.run(
            [
                _GDOCS_BIN,
                "readonly",
                "export",
                doc_id,
                "--format",
                "md",
                "--output",
                output_path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        with open(output_path, "r", encoding="utf-8") as f:
            return f.read()
    except subprocess.CalledProcessError as e:
        return f"Failed to export Google Doc {doc_id}: {e.stderr or e.stdout}"
    finally:
        if os.path.exists(output_path):
            os.unlink(output_path)


def list_folder_files(folder_id: str, page_size: int = 100) -> list[dict]:
    """List supported files in a Drive folder as structured dicts.

    Returns a list of {id, name, mimeType, webViewLink} for Docs, Sheets,
    Slides, and PDFs. Returns [] on error (caller decides how to surface it).
    """
    from googleapiclient.errors import HttpError

    folder_id = extract_folder_id(folder_id)
    service = get_service()
    drive_q = (
        f"'{folder_id}' in parents and trashed = false and "
        f"(mimeType='{_DOC_MIME}' or mimeType='{_SHEET_MIME}' or "
        f"mimeType='{_SLIDES_MIME}' or mimeType='{_PDF_MIME}')"
    )
    out = []
    page_token = None
    try:
        while True:
            resp = (
                service.files()
                .list(
                    q=drive_q,
                    fields="nextPageToken, files(id, name, mimeType, webViewLink)",
                    pageSize=page_size,
                    pageToken=page_token,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                )
                .execute()
            )
            out.extend(resp.get("files", []))
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
    except HttpError:
        return out
    return out


def fetch_doc_text(file_id: str, mime_type: str = "", max_chars: int = _DEFAULT_MAX_CHARS) -> str:
    """Unified fetch: gdocs CLI for Google Docs, Drive API export otherwise.

    For Google Docs (or unknown mime), tries the gdocs CLI first (no OAuth scope
    needed) and falls back to the Drive API exporter. For all other types, uses
    get_doc_content. Returns text, truncated at max_chars.
    """
    is_doc = (mime_type == _DOC_MIME) or (not mime_type)
    if is_doc:
        text = fetch_gdoc(file_id)
        # fetch_gdoc returns an "Error:"/"Failed..." string on failure; only
        # accept a genuine export, otherwise fall through to the Drive API.
        if text and not text.startswith(("Error:", "Failed to export")):
            if len(text) > max_chars:
                return text[:max_chars] + f"\n\n[truncated, original {len(text)} chars]"
            return text
        # fall through to Drive API exporter
    return get_doc_content(file_id, max_chars=max_chars)


def get_doc_content(file_id: str, max_chars: int = _DEFAULT_MAX_CHARS) -> str:
    """Fetch a Drive file's text content, dispatched by mimeType.

    Google Docs → Markdown; Sheets → CSV; Slides → plain text;
    PDFs → bytes downloaded and text-extracted via pypdf.
    Output is truncated at max_chars with an indication of the original length.
    """
    from googleapiclient.errors import HttpError

    service = get_service()
    try:
        meta = (
            service.files()
            .get(
                fileId=extract_gdoc_id(file_id),
                fields="id, name, mimeType, size",
                supportsAllDrives=True,
            )
            .execute()
        )
    except HttpError as e:
        return _format_drive_error("Get doc failed (metadata fetch)", e)

    mt = meta.get("mimeType", "")
    name = meta.get("name", "")
    fid = meta.get("id", extract_gdoc_id(file_id))

    try:
        if mt == _DOC_MIME:
            data = (
                service.files()
                .export_media(fileId=fid, mimeType="text/markdown")
                .execute()
            )
            text = data.decode("utf-8") if isinstance(data, bytes) else str(data)
        elif mt == _SHEET_MIME:
            data = (
                service.files()
                .export_media(fileId=fid, mimeType="text/csv")
                .execute()
            )
            text = data.decode("utf-8") if isinstance(data, bytes) else str(data)
        elif mt == _SLIDES_MIME:
            data = (
                service.files()
                .export_media(fileId=fid, mimeType="text/plain")
                .execute()
            )
            text = data.decode("utf-8") if isinstance(data, bytes) else str(data)
        elif mt == _PDF_MIME:
            text = _extract_pdf_text(service, fid)
        else:
            return f"Unsupported mimeType: {mt}"
    except HttpError as e:
        return _format_drive_error("Get doc failed (content fetch)", e)

    header = f"# {name} ({mt})\n\n"
    if len(text) > max_chars:
        return (
            header + text[:max_chars] + f"\n\n[truncated, original {len(text)} chars]"
        )
    return header + text


def _format_drive_error(prefix: str, err) -> str:
    """Turn raw HttpError into an actionable message.

    Most common failure here is OAuth-scope insufficiency: the user
    authenticated with `drive.metadata.readonly` (lists files but cannot
    read content) instead of `drive.readonly`. That returns 403 with reason
    `insufficientPermissions`. Detecting and explaining it inline saves a
    round-trip to logs.
    """
    status = getattr(err.resp, "status", None) if hasattr(err, "resp") else None
    reason = ""
    try:
        import json as _json
        if getattr(err, "content", None):
            body = _json.loads(err.content.decode("utf-8"))
            errs = body.get("error", {}).get("errors", [])
            if errs:
                reason = errs[0].get("reason", "")
    except Exception:
        pass

    if status == 403 and reason == "insufficientPermissions":
        return (
            f"{prefix}: 403 insufficientPermissions. Your ADC token cannot"
            " read Drive file content. Most likely you authenticated with"
            " drive.metadata.readonly (lists only). Re-run:\n"
            "  gcloud auth application-default login --scopes='openid,"
            "https://www.googleapis.com/auth/userinfo.email,"
            "https://www.googleapis.com/auth/cloud-platform,"
            "https://www.googleapis.com/auth/drive.readonly'"
        )
    if status == 403:
        return (
            f"{prefix}: 403 {reason or 'forbidden'}. The authenticated"
            " account may not have permission to open this specific file."
            f" Raw: {err}"
        )
    if status == 404:
        return (
            f"{prefix}: 404 not found. Double-check the file_id."
            f" Raw: {err}"
        )
    return f"{prefix}: {err}"


def _extract_pdf_text(service, file_id: str) -> str:
    """Download a PDF from Drive and extract its text via pypdf."""
    from googleapiclient.http import MediaIoBaseDownload

    request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    buf.seek(0)

    from pypdf import PdfReader  # local import to defer the dep until needed

    reader = PdfReader(buf)
    pages = [p.extract_text() or "" for p in reader.pages]
    return "\n\n".join(pages)
