from __future__ import annotations

from typing import Any

from aws_reference_agent.docs.reader import DocReadError, read
from aws_reference_agent.tools.context import get_docs_state


def list_local_docs() -> dict[str, Any]:
    """List the local documents available for ingestion in this session.

    Call this once at the start. It returns the complete set of documents you
    may read — `read_local_doc` refuses any path not listed here, so there is no
    point guessing filenames. Use each entry's `path`, `bytes`, and `modified`
    to decide what is worth reading and in what order; `modified` is also the
    freshness signal you should record when you cite a document.

    When `truncated_count` is greater than zero, more documents matched than the
    budget allowed and the extras are not readable this session.

    Return shape:
      {"root", "docs": [{"path", "bytes", "modified"}], "count",
       "truncated_count", "max_files_budget"}
    """
    state = get_docs_state()
    docs = [
        {"path": rel, "bytes": meta["bytes"], "modified": meta["modified"]}
        for rel, meta in sorted(state.manifest.items())
    ]
    return {
        "root": str(state.root),
        "docs": docs,
        "count": len(docs),
        "truncated_count": state.truncated_count,
        "max_files_budget": state.max_files,
    }


def read_local_doc(path: str) -> dict[str, Any]:
    """Read one local document and return its content as markdown.

    `path` must be one of the paths returned by `list_local_docs`. The
    session-wide read budget (`max_files`) is enforced inside this tool. When a
    read is rejected the return value contains an `error` field instead of
    content. Treat that as a signal to pick a different document; do not retry
    the same path.

    Successful return shape:
      {"path", "title", "markdown", "bytes", "modified", "truncated",
       "read_count", "max_files_budget"}

    Rejected return shape:
      {"error": "<reason>", "path", "read_count", "max_files_budget"}
    """
    state = get_docs_state()

    def _reject(reason: str) -> dict[str, Any]:
        return {
            "error": reason,
            "path": path,
            "read_count": state.read_count,
            "max_files_budget": state.max_files,
        }

    # Manifest membership is the confinement guard: the agent cannot read a
    # path that discovery did not vet, so traversal and invented filenames are
    # both rejected here.
    if path not in state.manifest:
        return _reject(
            "path is not in the document manifest returned by list_local_docs"
        )
    if path in state.read:
        return _reject("already read in this session")
    if state.read_count >= state.max_files:
        return _reject("max_files reached")

    try:
        doc = read(state.root, path, max_bytes=state.max_bytes)
    except DocReadError as e:
        return _reject(f"read failed: {e}")

    state.read.add(path)
    state.read_count += 1

    return {
        "path": doc.rel_path,
        "title": doc.title,
        "markdown": doc.markdown,
        "bytes": doc.bytes,
        "modified": doc.modified,
        "truncated": doc.bytes > state.max_bytes,
        "read_count": state.read_count,
        "max_files_budget": state.max_files,
    }
