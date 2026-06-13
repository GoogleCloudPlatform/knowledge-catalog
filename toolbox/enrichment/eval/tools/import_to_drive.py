"""Import a folder of local Markdown files into Google Drive as Google Docs.

Doc-mode enrichment reads from Google Drive, so to run a doc-mode eval case you
first need the source documents in *your* Drive. This uploads each `*.md` file in
a local folder as a Google Doc into a new (or given) Drive folder and prints the
folder id — feed that to the agent with `--mode=doc --folder=<id>`, then evaluate
against the matching golden.

Auth: Application Default Credentials with a Drive WRITE scope. Run once:

    gcloud auth application-default login \\
      --scopes='openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive'

Usage:

    python eval/tools/import_to_drive.py --src eval/corpora/supply_chain \\
        --folder-name "kc-eval supply_chain"
    # (optional) --parent <existing_drive_folder_id> to nest the new folder
"""

from __future__ import annotations

import argparse
import os
import sys


def _service():
  from google.auth import default as adc  # pytype: disable=import-error
  from googleapiclient.discovery import build  # pytype: disable=import-error
  creds, _ = adc(scopes=["https://www.googleapis.com/auth/drive"])
  return build("drive", "v3", credentials=creds, cache_discovery=False)


def import_folder(src: str, folder_name: str, parent: str | None = None) -> str:
  """Create a Drive folder and upload every *.md in `src` as a Google Doc.
  Returns the new folder id."""
  from googleapiclient.http import MediaFileUpload  # pytype: disable=import-error
  svc = _service()
  meta = {"name": folder_name, "mimeType": "application/vnd.google-apps.folder"}
  if parent:
    meta["parents"] = [parent]
  folder_id = svc.files().create(body=meta, fields="id").execute()["id"]

  md_files = sorted(f for f in os.listdir(src) if f.endswith(".md"))
  if not md_files:
    print(f"warning: no .md files found in {src}", file=sys.stderr)
  for fn in md_files:
    path = os.path.join(src, fn)
    body = {"name": os.path.splitext(fn)[0],
            "mimeType": "application/vnd.google-apps.document",  # convert MD -> Doc
            "parents": [folder_id]}
    media = MediaFileUpload(path, mimetype="text/markdown", resumable=False)
    doc_id = svc.files().create(body=body, media_body=media,
                                fields="id").execute()["id"]
    print(f"  + {fn}  ->  https://docs.google.com/document/d/{doc_id}")
  return folder_id


def main(argv=None) -> int:
  ap = argparse.ArgumentParser(
      prog="python eval/tools/import_to_drive.py",
      description="Upload a local folder of Markdown files into Drive as Google Docs.")
  ap.add_argument("--src", required=True, help="Local folder containing *.md files.")
  ap.add_argument("--folder-name", default="kc-eval-corpus",
                  help="Name for the new Drive folder.")
  ap.add_argument("--parent", default=None,
                  help="Optional existing Drive folder id to create inside.")
  args = ap.parse_args(argv)
  if not os.path.isdir(args.src):
    print(f"error: not a directory: {args.src}", file=sys.stderr)
    return 2
  folder_id = import_folder(args.src, args.folder_name, args.parent)
  print()
  print(f"Drive folder id: {folder_id}")
  print(f"Now run:  python -m eval ... (enrich with --mode=doc --folder={folder_id}), "
        f"then  python -m eval --output-dir <out> --golden <corpus>.json")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
