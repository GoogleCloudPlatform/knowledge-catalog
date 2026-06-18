"""OKF (Open Knowledge Format) serializer — the Python twin of kcmd's

`layouts/okf.ts`.

Emits ONE markdown file per concept (YAML frontmatter + body) plus reserved
`index.md` directory listings, byte-compatible with the kcmd `OkfLayout` so
`kcmd push --format okf` can publish exactly what the agent writes. The full
Dataplex entry is preserved under a hidden `x-kcmd` frontmatter key for faithful
round-trip (consumers ignore unknown keys per SPEC.md); the markdown body is the
`overview` aspect content.

See SPEC.md: github.com/GoogleCloudPlatform/knowledge-catalog okf/SPEC.md
"""

import os
import re

import yaml

OKF_VERSION = "0.1"
STASH_KEY = "x-kcmd"
_QUERIES_ASPECT_KEY = "dataplex-types.global.queries"


def _frontmatter(entry: dict) -> dict:
  """Build the OKF frontmatter for a concept from its kcmd entry dict.

  Top-level keys are the SPEC-recommended fields (type/title/description/tags/
  timestamp/resource); the full entry is stashed under `x-kcmd` so kcmd can
  reconstruct it losslessly. None-valued keys are dropped.
  """
  resource = entry.get("resource") or {}
  labels = resource.get("labels") or {}
  tags = [k for k, v in labels.items() if v == "true"] or None
  fm = {
      "type": entry.get("type"),
      "title": resource.get("displayName") or resource.get("name"),
      "description": resource.get("description"),
      "tags": tags,
      "timestamp": resource.get("updateTime") or resource.get("createTime"),
      "resource": resource.get("name"),
      # Faithful round-trip stash. The overview lives in the body, not here.
      STASH_KEY: entry,
  }
  return {k: v for k, v in fm.items() if v is not None}


def dump_concept(entry: dict, body: str) -> str:
  """Return the full OKF concept file content (frontmatter + body)."""
  fm = yaml.safe_dump(
      _frontmatter(entry), sort_keys=False, allow_unicode=True
  ).strip()
  body = body if body.endswith("\n") else body + "\n"
  return f"---\n{fm}\n---\n{body}"


def write_concept(md_path: str, entry: dict, body: str) -> None:
  """Write one OKF concept file at `md_path` (a `<name>.md` path).

  `body` should already be cleaned (e.g. via common.clean_overview_body).
  """
  os.makedirs(os.path.dirname(md_path), exist_ok=True)
  with open(md_path, "w") as f:
    f.write(dump_concept(entry, body))


def _split_frontmatter(text: str) -> tuple[dict, str]:
  """Split a `---\\n…\\n---\\n` leading block. Returns (frontmatter, body)."""
  if not text.startswith("---"):
    return {}, text
  m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
  if not m:
    return {}, text
  data = yaml.safe_load(m.group(1)) or {}
  return (data if isinstance(data, dict) else {}), m.group(2)


def _okf_citations_heading(body: str) -> str:
  """Rename the overview's `Source References` heading to OKF's `Citations`.

  Our writer prompts emit a `## Source References` section; OKF's body
  convention calls this `# Citations` (SPEC §Citations). Only the heading line
  is renamed (the `#` level is preserved); inline mentions are untouched.
  """
  return re.sub(
      r"(?m)^(#{1,6}[ \t]+)Source References[ \t]*$",
      r"\1Citations",
      body,
  )


def convert_tree(output_dir: str) -> str | None:
  """Convert a finished kcmd-native `catalog/` tree into an OKF `bundle/`.

  Reads every entry (`X.yaml` + sibling `X.overview.md` body + optional
  `X.queries.md` aspect sidecar) and emits a single `bundle/X.md` OKF concept
  (frontmatter + body, full entry stashed under `x-kcmd`). Read-only reference
  mirrors (`X.ref.yaml` / `X.ref.overview.md`) become `X.ref.md`. Reserved
  `catalog.yaml` and `index.*` are skipped; `index.md` listings are regenerated.

  Leaves `catalog/` in place (refinement + the webapp still read it); `bundle/`
  is the publishable OKF deliverable (`kcmd push --format okf`). Returns the
  bundle path, or None if there is no catalog/ to convert.
  """
  catalog_dir = os.path.join(output_dir, "catalog")
  bundle_dir = os.path.join(output_dir, "bundle")
  if not os.path.isdir(catalog_dir):
    return None

  for dirpath, _subdirs, files in os.walk(catalog_dir):
    for fn in files:
      if not fn.endswith(".yaml") or fn in ("catalog.yaml", "index.yaml"):
        continue
      is_ref = fn.endswith(".ref.yaml")
      base = fn[: -len(".ref.yaml")] if is_ref else fn[: -len(".yaml")]
      with open(os.path.join(dirpath, fn)) as f:
        entry = yaml.safe_load(f) or {}
      if not isinstance(entry, dict):
        continue

      # Overview body (the `.md` body in OKF). Ref overviews may carry
      # frontmatter; concept overviews are pure markdown.
      ov_suffix = ".ref.overview.md" if is_ref else ".overview.md"
      ov_path = os.path.join(dirpath, base + ov_suffix)
      body = ""
      if os.path.exists(ov_path):
        with open(ov_path) as f:
          _fm, body = _split_frontmatter(f.read())
        body = _okf_citations_heading(body)

      # Queries aspect sidecar (frontmatter-only) -> fold into the entry so it
      # round-trips via x-kcmd on push.
      q_path = os.path.join(dirpath, base + ".queries.md")
      if os.path.exists(q_path):
        with open(q_path) as f:
          q_fm, _q_body = _split_frontmatter(f.read())
        if q_fm:
          entry.setdefault("aspects", {})[_QUERIES_ASPECT_KEY] = q_fm

      rel = os.path.relpath(os.path.join(dirpath, base), catalog_dir).replace(
          os.sep, "/"
      )
      out_rel = f"{rel}.ref.md" if is_ref else f"{rel}.md"
      write_concept(os.path.join(bundle_dir, out_rel), entry, body)

  write_indexes(bundle_dir, catalog_dir)
  return bundle_dir


def _titleize(slug: str) -> str:
  return slug.replace("-", " ").replace("_", " ").strip().title()


def _oneline(s: str) -> str:
  """Collapse whitespace/newlines to single spaces and trim, so a value sits on

  one Markdown list row (an embedded newline would break the row).
  """
  return " ".join((s or "").split())


def _folder_meta(
    catalog_dir: str | None, rel: str, fallback_title: str
) -> tuple[str, str]:
  """(title, description) for a folder, from its kcmd-native `index.yaml` if the

  agent built one (doc/context_overlay), else a derived title + empty desc.
  """
  if catalog_dir:
    idx = (
        os.path.join(catalog_dir, rel, "index.yaml")
        if rel
        else os.path.join(catalog_dir, "index.yaml")
    )
    if os.path.exists(idx):
      try:
        with open(idx) as f:
          data = yaml.safe_load(f) or {}
        res = data.get("resource") or {}
        return (res.get("displayName") or fallback_title), (
            res.get("description") or ""
        )
      except (OSError, yaml.YAMLError):
        pass
  return fallback_title, ""


def _concept_meta(md_path: str) -> tuple[str, str]:
  """(title, description) for a concept .md, from its YAML frontmatter."""
  try:
    with open(md_path) as f:
      fm, _body = _split_frontmatter(f.read())
  except OSError:
    fm = {}
  base = os.path.basename(md_path)[: -len(".md")]
  return (fm.get("title") or base), (fm.get("description") or "")


def write_indexes(root_dir: str, catalog_dir: str | None = None) -> None:
  """Regenerate reserved `index.md` directory listings across the bundle.

  Non-root indexes carry no frontmatter; the bundle-root `index.md` declares
  `okf_version` (the only place frontmatter is permitted in an index.md). Each
  row is `* [<title>](<link>) - <description>` (GA4 bundle convention); the
  folder's own title/description head the file so a consumer (e.g. `kcmd push
  --format okf`) can synthesize a directory/index entry from the file alone.
  `index.md` and `.ref.md` are not listed.
  """
  if not os.path.isdir(root_dir):
    return
  for directory, _subdirs, _files in os.walk(root_dir):
    is_root = os.path.abspath(directory) == os.path.abspath(root_dir)
    rel = (
        ""
        if is_root
        else os.path.relpath(directory, root_dir).replace(os.sep, "/")
    )
    ftitle, fdesc = _folder_meta(
        catalog_dir,
        rel,
        "Index" if is_root else _titleize(os.path.basename(directory)),
    )

    rows: list[str] = []
    for name in sorted(os.listdir(directory)):
      full = os.path.join(directory, name)
      if os.path.isdir(full):
        crel = name if is_root else f"{rel}/{name}"
        ctitle, cdesc = _folder_meta(catalog_dir, crel, _titleize(name))
        link = f"{name}/index.md"
      elif (
          name.endswith(".md")
          and name != "index.md"
          and not name.endswith(".ref.md")
      ):
        ctitle, cdesc = _concept_meta(full)
        link = name
      else:
        continue
      ctitle, cdesc = _oneline(ctitle), _oneline(cdesc)
      rows.append(f"* [{ctitle}]({link})" + (f" - {cdesc}" if cdesc else ""))

    lines = [f"# {_oneline(ftitle)}", ""]
    if fdesc:
      lines += [_oneline(fdesc), ""]
    lines += rows if rows else ["_(empty)_"]
    out = "\n".join(lines) + "\n"
    if is_root:
      out = f'---\nokf_version: "{OKF_VERSION}"\n---\n{out}'
    with open(os.path.join(directory, "index.md"), "w") as f:
      f.write(out)
