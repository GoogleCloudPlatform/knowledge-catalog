"""Google Drive input helpers: folder discovery + multi-format content reads.

Folder listing and all content reads (Google Docs, Sheets, Slides, PDF) go
through the public Drive v3 API, which requires an ADC token with the
drive.readonly scope. If you see 403 insufficientPermissions on content reads,
re-run:

    gcloud auth application-default login --scopes='openid,\\
    https://www.googleapis.com/auth/userinfo.email,\\
    https://www.googleapis.com/auth/cloud-platform,\\
    https://www.googleapis.com/auth/drive.readonly'
"""

import glob
import io
import os
import re
import threading

_DOC_MIME = "application/vnd.google-apps.document"
_SHEET_MIME = "application/vnd.google-apps.spreadsheet"
_SLIDES_MIME = "application/vnd.google-apps.presentation"
_PDF_MIME = "application/pdf"

_DEFAULT_MAX_CHARS = 60000

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
  docstring). The googleapiclient import is local so importing this module is
  cheap for callers that never read Drive content.

  A fresh service is built per thread because the underlying httplib2 transport
  is not thread-safe; reusing one across threads corrupts the SSL connection.
  """
  service = getattr(_thread_local, "service", None)
  if service is None:
    from google.auth import default
    from googleapiclient.discovery import build

    creds, _ = default(scopes=[_DRIVE_SCOPE])
    service = build("drive", "v3", credentials=creds, cache_discovery=False)
    _thread_local.service = service
  return service


def extract_gdoc_id(url_or_id: str) -> str:
  """Extracts the Doc ID from a Google Doc URL or returns the ID if already clean."""
  match = re.search(
      r"https://docs\.google\.com/document/d/([a-zA-Z0-9-_]+)", url_or_id or ""
  )
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


_MD_EXTS = (".md", ".markdown")


def is_local_path(s: str) -> bool:
  """Route a single --docs/--folder entry to local markdown vs Google Drive.

  Format-first so the decision never depends on what happens to exist in the
  process CWD (which, via the webapp, is the agent subprocess's dir): an
  http(s) URL or a bare Drive-id token is Drive; a `.md`/`.markdown` suffix or
  a path-shaped string (absolute, `./`, `../`, `~`, or containing a separator)
  is local. Only a bare relative name with no path markers falls back to an
  existence check before defaulting to Drive. See `extract_gdoc_id` /
  `extract_folder_id` for the Drive side.
  """
  s = (s or "").strip()
  if not s:
    return False
  low = s.lower()
  if low.startswith(("http://", "https://")):  # Google Doc / Drive folder URL
    return False
  if "docs.google.com" in low or "drive.google.com" in low:  # scheme-less URL
    return False
  if low.endswith(_MD_EXTS):  # explicit markdown file
    return True
  if s.startswith(("/", "./", "../", "~")) or os.sep in s:  # path-shaped
    return True
  return os.path.exists(os.path.expanduser(s))  # bare name: tiebreak, else Drive


def list_local_md(path: str) -> list[str]:
  """Expand a local path into a sorted list of ABSOLUTE markdown file paths.

  A local .md/.markdown file -> [that file]; a local directory -> every
  .md/.markdown under it (recursive). Anything else -> []. Relative paths are
  resolved against the process CWD (absolute paths are recommended for
  customers). Local analogue of list_folder_files() for a Drive folder.

  Args:
    path: A local file or directory path (relative paths resolve from CWD).

  Returns:
    A sorted list of absolute .md/.markdown file paths, or [] if none.
  """
  p = os.path.abspath(os.path.expanduser(path or ""))
  if os.path.isfile(p):
    return [p] if p.lower().endswith(_MD_EXTS) else []
  if os.path.isdir(p):
    out = []
    for ext in _MD_EXTS:
      out.extend(glob.glob(os.path.join(p, "**", "*" + ext), recursive=True))
    return sorted(set(out))
  return []


def read_local_md(path: str, max_chars: int = _DEFAULT_MAX_CHARS) -> str:
  """Read a local markdown file's text (local analogue of fetch_doc_text)."""
  try:
    with open(
        os.path.expanduser(path), encoding="utf-8", errors="replace"
    ) as f:
      return f.read()[:max_chars]
  except OSError as e:
    print(f"[Local] could not read {path}: {e}", flush=True)
    return ""


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
              fields=(
                  "nextPageToken, files(id, name, mimeType, webViewLink,"
                  " modifiedTime)"
              ),
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
  except HttpError as e:
    # Don't fail silently: a 403 here (missing drive.readonly scope) otherwise
    # looks like an empty folder and the Drive source is quietly skipped.
    print(
        f"[Folder] ⚠️  Drive list failed for folder {folder_id!r}: {e}\n"
        "          If this is 403 insufficientPermissions, your ADC token is\n"
        "          missing the drive.readonly scope — re-run: gcloud auth\n"
        "          application-default login --scopes='openid,https://www."
        "googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/"
        "drive.readonly'",
        flush=True,
    )
    return out
  return out


# Cache config — three modes, gated by KC_ENRICH_CACHE_MODE.
#
#   off     — no caching at all. Every run re-fetches from Drive and
#             re-summarizes from scratch.
#   raw     — legacy behavior: cache the raw doc text on disk. Fast re-runs
#             but raw text can contain sensitive content.
#   summary — DEFAULT. Cache topic-agnostic per-doc summaries (see
#             modes/doc_mode.py + engine.summarize_single_doc). Re-runs of
#             the SAME corpus skip both the Drive fetch AND the per-doc
#             summarizer LLM call. Raw text is NEVER persisted to disk.
#
# Compat: KC_ENRICH_CACHE=off (legacy flag) still forces mode=off.
#
# Cache dir lives under $HOME (not /tmp) and is chmod 700 so other users on
# the machine can't read it. This addresses the "raw doc text leaking via
# /tmp" concern that motivated the summary-cache redesign.

_CACHE_DIR = os.path.join(os.environ.get("HOME", "/tmp"), ".kc_enrich_cache")
_DOC_CACHE_DIR = os.path.join(_CACHE_DIR, "docs")  # raw text (mode=raw only)
_SUMMARY_CACHE_DIR = os.path.join(
    _CACHE_DIR, "summaries"
)  # per-doc summaries (mode=summary)


def _resolve_cache_mode() -> str:
  """Resolve cache mode from env.

  Priority: KC_ENRICH_CACHE=off compat alias beats everything; otherwise
  KC_ENRICH_CACHE_MODE wins; otherwise default.
  """
  legacy = os.environ.get("KC_ENRICH_CACHE", "").lower()
  if legacy in ("off", "0", "false", "no"):
    return "off"
  mode = os.environ.get("KC_ENRICH_CACHE_MODE", "").lower().strip()
  if mode in ("off", "raw", "summary"):
    return mode
  return "summary"


_CACHE_MODE = _resolve_cache_mode()
# Back-compat alias used by older call sites still in this file.
_CACHE_DISABLED = _CACHE_MODE == "off"

# Per-cache stats. `docs.*` covers raw-text cache (mode=raw); `summary.*`
# covers per-doc summary cache (mode=summary). Both are populated by
# `get_cache_stats()` and printed at the end of a doc-mode run.
_CACHE_STATS = {
    "hit": 0,
    "miss": 0,
    "stale": 0,  # raw-text cache
    "summary_hit": 0,
    "summary_miss": 0,
    "summary_stale": 0,  # summary cache
}


def _ensure_private_dir(path: str):
  """Create dir (if missing) and force chmod 700 on the cache root.

  Idempotent. The chmod runs every call so manual perm changes get fixed up
  next run. Errors are swallowed — caching is best-effort.
  """
  try:
    os.makedirs(path, exist_ok=True)
    # Tighten perms on the root only; subdirs inherit umask but the root
    # being 700 prevents traversal regardless of subdir mode.
    os.chmod(_CACHE_DIR, 0o700)
  except OSError:
    pass


def _safe_filename(doc_id: str) -> str:
  return re.sub(r"[^A-Za-z0-9_.-]", "_", doc_id)[:200]


def _cache_paths(file_id: str) -> tuple[str, str]:
  """Returns (content_path, meta_path) for a doc's RAW-text cache entries."""
  safe = _safe_filename(extract_gdoc_id(file_id))
  return (
      os.path.join(_DOC_CACHE_DIR, f"{safe}.txt"),
      os.path.join(_DOC_CACHE_DIR, f"{safe}.meta"),
  )


def _summary_paths(file_id: str) -> tuple[str, str]:
  """Returns (summary_path, meta_path) for a doc's SUMMARY cache entries."""
  safe = _safe_filename(extract_gdoc_id(file_id))
  return (
      os.path.join(_SUMMARY_CACHE_DIR, f"{safe}.summary"),
      os.path.join(_SUMMARY_CACHE_DIR, f"{safe}.meta"),
  )


def _read_cache(file_id: str, modified_time: str | None) -> str | None:
  """Raw-text cache read. Only active when KC_ENRICH_CACHE_MODE=raw."""
  if _CACHE_MODE != "raw":
    return None
  content_p, meta_p = _cache_paths(file_id)
  if not os.path.exists(content_p):
    _CACHE_STATS["miss"] += 1
    return None
  if modified_time and os.path.exists(meta_p):
    try:
      with open(meta_p) as f:
        cached_mtime = f.read().strip()
      if cached_mtime != modified_time:
        _CACHE_STATS["stale"] += 1
        return None
    except OSError:
      pass
  _CACHE_STATS["hit"] += 1
  try:
    with open(content_p, encoding="utf-8") as f:
      return f.read()
  except OSError:
    return None


def _write_cache(file_id: str, content: str, modified_time: str | None):
  """Raw-text cache write. Only active when KC_ENRICH_CACHE_MODE=raw."""
  if _CACHE_MODE != "raw" or not content:
    return
  if content.startswith(("Error:", "Failed to export")):
    return  # never cache failures
  try:
    _ensure_private_dir(_DOC_CACHE_DIR)
    content_p, meta_p = _cache_paths(file_id)
    with open(content_p, "w", encoding="utf-8") as f:
      f.write(content)
    if modified_time:
      with open(meta_p, "w") as f:
        f.write(modified_time)
  except OSError:
    pass


def read_summary_cache(file_id: str, modified_time: str | None) -> str | None:
  """Per-doc summary cache read. Active when KC_ENRICH_CACHE_MODE=summary.

  Returns the cached summary text, or None on miss / stale / mode-disabled.
  Stale check: when modified_time is provided and the cached mtime doesn't
  match, the entry is treated as miss and `summary_stale` is incremented.
  """
  if _CACHE_MODE != "summary":
    return None
  summary_p, meta_p = _summary_paths(file_id)
  if not os.path.exists(summary_p):
    _CACHE_STATS["summary_miss"] += 1
    return None
  if modified_time and os.path.exists(meta_p):
    try:
      with open(meta_p) as f:
        cached_mtime = f.read().strip()
      if cached_mtime != modified_time:
        _CACHE_STATS["summary_stale"] += 1
        return None
    except OSError:
      pass
  _CACHE_STATS["summary_hit"] += 1
  try:
    with open(summary_p, encoding="utf-8") as f:
      return f.read()
  except OSError:
    return None


def write_summary_cache(file_id: str, summary: str, modified_time: str | None):
  """Per-doc summary cache write. Active when KC_ENRICH_CACHE_MODE=summary.

  Skipped for empty summaries and for placeholder error strings — we never
  want to poison the cache with a failure that gets reused forever.
  """
  if _CACHE_MODE != "summary" or not summary:
    return
  if summary.startswith(("Error:", "Failed to")):
    return
  try:
    _ensure_private_dir(_SUMMARY_CACHE_DIR)
    summary_p, meta_p = _summary_paths(file_id)
    with open(summary_p, "w", encoding="utf-8") as f:
      f.write(summary)
    if modified_time:
      with open(meta_p, "w") as f:
        f.write(modified_time)
  except OSError:
    pass


def get_cache_mode() -> str:
  """Public accessor — used by doc_mode logs + tests."""
  return _CACHE_MODE


def fetch_doc_text(
    file_id: str,
    mime_type: str = "",
    max_chars: int = _DEFAULT_MAX_CHARS,
    modified_time: str | None = None,
) -> str:
  """Unified fetch via the Drive API, dispatched by mimeType in get_doc_content.

  `mime_type` is accepted for caller convenience but the authoritative mimeType
  is re-read from Drive metadata inside get_doc_content.

  Caching behavior depends on KC_ENRICH_CACHE_MODE:
    * `summary` (default) — raw text is NEVER persisted to disk; the doc-mode
      pipeline caches the per-doc summary at a higher level instead. This
      call still happens (we need the raw text in memory to summarize), but
      nothing about it lands on the filesystem.
    * `raw` — legacy behavior. Cache raw text under ~/.kc_enrich_cache/docs/
      keyed on (doc_id, modified_time).
    * `off` — no caching of any kind.

  Returns text, truncated at max_chars.
  """
  del mime_type  # mimeType is resolved from Drive metadata in get_doc_content.
  cached = _read_cache(file_id, modified_time)
  if cached is not None:
    if len(cached) > max_chars:
      return (
          cached[:max_chars] + f"\n\n[truncated, original {len(cached)} chars]"
      )
    return cached

  text = get_doc_content(file_id, max_chars=max_chars)
  _write_cache(file_id, text, modified_time)
  return text


def get_cache_stats() -> dict:
  """Returns hit/miss/stale counts for the current process."""
  return dict(_CACHE_STATS)


def reset_cache_stats():
  for k in list(_CACHE_STATS.keys()):
    _CACHE_STATS[k] = 0


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
        header
        + text[:max_chars]
        + f"\n\n[truncated, original {len(text)} chars]"
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
    return f"{prefix}: 404 not found. Double-check the file_id. Raw: {err}"
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
