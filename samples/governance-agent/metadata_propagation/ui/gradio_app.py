import os

# Force gRPC to use native IPv4 resolver to bypass macOS IPv6 lookup hangs/timeouts
os.environ["GRPC_DNS_RESOLVER"] = "native"
os.environ["GRPC_IPv6"] = "off"

import html
import logging
import re
import shutil
import tempfile
import uuid

import fastapi
import gradio as gr
import pandas as pd
from authlib.integrations.starlette_client import OAuth
from dotenv import load_dotenv
from fastapi.responses import RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

# Load environment variables
load_dotenv(override=True)

# --- Custom OAuth Setup ---
oauth_config = OAuth()
oauth_config.register(
    name="google",
    client_id=os.environ.get("GOOGLE_CLIENT_ID"),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={
        "scope": "openid email profile https://www.googleapis.com/auth/bigquery https://www.googleapis.com/auth/cloud-platform"
    },
)
# ---------------------------

# Import Agent Components
from metadata_propagation.agent.plugins.context import (
    get_oauth_token,
    is_oauth_bypassed,
    require_oauth_globally,
    set_oauth_token,
)
from metadata_propagation.agent.plugins.dq_plugin import DQPlugin
from metadata_propagation.agent.plugins.glossary_plugin import (
    GlossaryPlugin,
)
from metadata_propagation.agent.plugins.lineage_plugin import (
    LineagePlugin,
)
from metadata_propagation.agent.plugins.policy_tag_plugin import (
    PolicyTagPlugin,
)
from metadata_propagation.dataplex_integration.dq_propagation import (
    DQPropagationEngine,
)

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Fetch Project ID from environment or ADC default
def _resolve_default_project():
    if os.environ.get("GOOGLE_CLOUD_PROJECT"):
        return os.environ["GOOGLE_CLOUD_PROJECT"]
    try:
        import google.auth
        _, proj = google.auth.default()
        if proj:
            return proj
    except Exception:
        pass
    return "data-governance-agent-dev"


DEFAULT_PROJECT_ID = _resolve_default_project()
DEFAULT_LOCATION = "europe-west1"
DEFAULT_DATASET_ID = os.environ.get(
    "BIGQUERY_DATASET_ID", "retail_synthetic_data"
)

_candidate_paths = [
    os.path.abspath(os.path.join(os.path.dirname(__file__), "../../knowledge_insights.json")),
    os.path.abspath(os.path.join(os.path.dirname(__file__), "../knowledge_insights.json")),
    os.path.abspath("knowledge_insights.json"),
]
KNOWLEDGE_JSON_PATH = next((p for p in _candidate_paths if os.path.exists(p)), _candidate_paths[0])

# --- Unstructured Document Context Settings & Helpers ---
ALLOWED_DOC_EXTENSIONS = {".pdf", ".txt", ".md", ".xlsx", ".png", ".jpg", ".jpeg"}
MAX_DOC_SIZE_BYTES = 20 * 1024 * 1024  # 20 MB per file limit
UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "governance_agent_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
try:
    os.chmod(UPLOAD_DIR, 0o700)
except Exception:
    pass


def format_file_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


def render_header_doc_badge(docs_state: list, selected_labels: list, context_mode: str = "rag") -> str:
    docs_state = docs_state or []
    selected_labels = selected_labels or []
    total = len(docs_state)
    active_docs = [d for d in docs_state if d.get("label") in selected_labels]
    active_count = len(active_docs)

    if total == 0:
        return (
            "<div class='gcp-doc-badge empty'>"
            "📄 <b>Global Context Documents:</b> No documents uploaded. "
            "Upload PDFs, Spreadsheets, or Markdown files in the section above to enrich AI context across all tabs."
            "</div>"
        )

    safe_names = [f"<code>{html.escape(d.get('name', ''))}</code>" for d in active_docs]
    names_str = ", ".join(safe_names[:4])
    if len(safe_names) > 4:
        names_str += f" (+{len(safe_names) - 4} more)"

    status_class = "active" if active_count > 0 else "inactive"
    mode_badge = f"<span class='gcp-mode-chip'>{html.escape(str(context_mode).upper())}</span>"

    if active_count > 0:
        return (
            f"<div class='gcp-doc-badge {status_class}'>"
            f"🟢 <b>Global Context Documents Active ({active_count}/{total} selected)</b> "
            f"{mode_badge} — Active: {names_str}"
            f"</div>"
        )
    else:
        return (
            f"<div class='gcp-doc-badge {status_class}'>"
            f"⚪ <b>Global Context Documents ({total} uploaded, 0 selected)</b> "
            f"— Check documents below to include them as context for the Agent."
            f"</div>"
        )


def handle_doc_uploads(
    uploaded_files,
    current_docs_state,
    current_selected_labels,
    context_mode,
    request: gr.Request = None,
):
    if uploaded_files:
        token = get_token_from_session(request)
        set_oauth_token(token)
    current_docs_state = list(current_docs_state or [])
    current_selected_labels = list(current_selected_labels or [])

    if not uploaded_files:
        choices = [d["label"] for d in current_docs_state]
        return (
            current_docs_state,
            gr.update(choices=choices, value=current_selected_labels),
            render_header_doc_badge(current_docs_state, current_selected_labels, context_mode),
        )

    if not isinstance(uploaded_files, list):
        uploaded_files = [uploaded_files]

    for file_obj in uploaded_files:
        file_path = file_obj.name if hasattr(file_obj, "name") else str(file_obj)
        if not os.path.exists(file_path):
            continue

        orig_name = os.path.basename(file_path)
        ext = os.path.splitext(orig_name)[1].lower()
        if ext not in ALLOWED_DOC_EXTENSIONS:
            gr.Warning(f"Skipped '{orig_name}': Unsupported extension '{ext}'.")
            continue

        size_bytes = os.path.getsize(file_path)
        if size_bytes > MAX_DOC_SIZE_BYTES:
            gr.Warning(f"Skipped '{orig_name}': File exceeds 20 MB limit.")
            continue

        clean_name = re.sub(r"[^a-zA-Z0-9._-]", "_", orig_name)
        size_str = format_file_size(size_bytes)
        label = f"{clean_name} ({size_str})"

        safe_filename = f"{uuid.uuid4().hex[:8]}_{clean_name}"
        dest_path = os.path.join(UPLOAD_DIR, safe_filename)
        shutil.copy2(file_path, dest_path)
        try:
            os.chmod(dest_path, 0o600)
        except Exception:
            pass

        replaced = False
        for idx, existing in enumerate(current_docs_state):
            if existing["name"] == clean_name:
                old_label = existing["label"]
                current_docs_state[idx] = {
                    "label": label,
                    "name": clean_name,
                    "path": dest_path,
                    "size": size_str,
                }
                if old_label in current_selected_labels:
                    current_selected_labels.remove(old_label)
                if label not in current_selected_labels:
                    current_selected_labels.append(label)
                replaced = True
                break

        if not replaced:
            current_docs_state.append(
                {
                    "label": label,
                    "name": clean_name,
                    "path": dest_path,
                    "size": size_str,
                }
            )
            if label not in current_selected_labels:
                current_selected_labels.append(label)

    choices = [d["label"] for d in current_docs_state]
    has_selected = bool(current_selected_labels)
    return (
        current_docs_state,
        gr.update(choices=choices, value=current_selected_labels),
        render_header_doc_badge(current_docs_state, current_selected_labels, context_mode),
        gr.update(interactive=has_selected, value=has_selected),
    )


def update_doc_selection_badge(docs_state, selected_labels, context_mode, current_fallback_val=False):
    has_selected = bool(selected_labels)
    return (
        render_header_doc_badge(docs_state, selected_labels, context_mode),
        gr.update(interactive=has_selected, value=(current_fallback_val if has_selected else False)),
    )


def select_all_docs(docs_state, context_mode):
    docs_state = docs_state or []
    all_labels = [d["label"] for d in docs_state]
    has_selected = bool(all_labels)
    return (
        gr.update(value=all_labels),
        render_header_doc_badge(docs_state, all_labels, context_mode),
        gr.update(interactive=has_selected, value=has_selected),
    )


def deselect_all_docs(docs_state, context_mode):
    docs_state = docs_state or []
    return (
        gr.update(value=[]),
        render_header_doc_badge(docs_state, [], context_mode),
        gr.update(interactive=False, value=False),
    )


def clear_all_docs(context_mode):
    return (
        [],
        gr.update(choices=[], value=[]),
        render_header_doc_badge([], [], context_mode),
        None,
        gr.update(interactive=False, value=False),
    )


def get_active_doc_paths(docs_state: list | None, selected_labels: list | None) -> list[str] | None:
    if not docs_state or not selected_labels:
        return None
    selected_set = set(selected_labels)
    active_paths = [
        d["path"]
        for d in docs_state
        if d.get("label") in selected_set and d.get("path") and os.path.exists(d["path"])
    ]
    return active_paths if active_paths else None


def handle_refresh_lineage_cache(request: gr.Request = None):
    # Clearing the process-wide cache is a side effect shared by all users,
    # so it must not be reachable by unauthenticated callers.
    set_oauth_token(get_token_from_session(request))
    from metadata_propagation.dataplex_integration.lineage_propagation import (
        LineageGraphTraverser,
    )

    LineageGraphTraverser.clear_global_cache()
    gr.Info("Unified Lineage Cache cleared successfully!")
    return "Unified Lineage Cache cleared."


def get_plugin(project_id, location):
    return LineagePlugin(
        project_id, location, knowledge_json_path=KNOWLEDGE_JSON_PATH
    )


def _as_dict(value):
    if isinstance(value, dict):
        return value
    if value is not None and hasattr(value, "keys"):
        # gr.Request converts dicts into gradio.route_utils.Obj
        return {k: _as_dict(value[k]) for k in value.keys()}
    return value


def _session_token(request) -> dict | None:
    """
    Returns the signed-session OAuth token for this request, or None.

    gr.Request exposes the token in different shapes depending on the path:
    - live queued/direct events: request.state.google_token (set by the
      middleware in create_app) and request.session, where gr.Request converts
      dicts into gradio.route_utils.Obj (not dict), hence _as_dict();
    - pickled requests: the Starlette request is dropped and the state is kept
      under request.request_state; request.session is unavailable.
    """
    if request is None:
        return None
    lookups = (
        lambda: getattr(request.state, "google_token", None),
        lambda: request.request_state.get("google_token"),
        lambda: request.session.get("google_token"),
    )
    for lookup in lookups:
        try:
            token = _as_dict(lookup())
        except (AttributeError, AssertionError, KeyError, TypeError):
            continue
        if isinstance(token, dict) and token.get("access_token"):
            return token
    return None


def get_token_from_session(request: gr.Request):
    if is_oauth_bypassed():
        return None
    token_dict = _session_token(request)
    if token_dict:
        import time

        expires_at = token_dict.get("expires_at")
        if (
            expires_at
            and time.time() > (expires_at - 60)
            and not token_dict.get("refresh_token")
        ):
            # Deny expired tokens instead of falling back to ADC
            try:
                request.session.pop("google_token", None)
            except (AttributeError, AssertionError, KeyError):
                pass  # session is read-only for queued events
            set_oauth_token(None)
            raise gr.Error(
                "Session expired: Please sign in again with Google OAuth."
            )
        return token_dict

    set_oauth_token(None)
    raise gr.Error(
        "Authentication required: Please sign in with Google OAuth to access this endpoint."
    )


def scan_dataset(
    project_id,
    location,
    dataset_id,
    cache_dataset_id=None,
    cache_table_id=None,
    request: gr.Request = None,
):
    token = get_token_from_session(request)
    set_oauth_token(token)
    try:
        lineage_plugin = get_plugin(project_id, location)
        glossary_plugin = GlossaryPlugin(
            project_id,
            location,
            cache_dataset_id=cache_dataset_id,
            cache_table_id=cache_table_id,
        )

        # 1. Scan for missing technical descriptions
        desc_df = lineage_plugin.scan_for_missing_descriptions(dataset_id)

        # 2. Scan for missing glossary terms
        glossary_df = glossary_plugin.scan_for_missing_glossary_terms(
            dataset_id
        )

        # 3. Calculate "Orphaned" Columns (No description AND no glossary term)
        if not desc_df.empty and not glossary_df.empty:
            orphans_df = pd.merge(
                desc_df, glossary_df, on=["Table", "Column"], how="inner"
            )
        else:
            orphans_df = pd.DataFrame(columns=["Table", "Column"])

        # 4. Aggregate by Table for metrics
        desc_agg = (
            desc_df.groupby("Table")
            .size()
            .reset_index(name="Missing Descriptions")
            if not desc_df.empty
            else pd.DataFrame(columns=["Table", "Missing Descriptions"])
        )
        gloss_agg = (
            glossary_df.groupby("Table")
            .size()
            .reset_index(name="Missing Glossary Mappings")
            if not glossary_df.empty
            else pd.DataFrame(columns=["Table", "Missing Glossary Mappings"])
        )
        orphan_agg = (
            orphans_df.groupby("Table")
            .size()
            .reset_index(name="Orphaned Columns")
            if not orphans_df.empty
            else pd.DataFrame(columns=["Table", "Orphaned Columns"])
        )

        # 5. Summary and Metrics
        desc_count = len(desc_df)
        gloss_count = len(glossary_df)
        orphan_count = len(orphans_df)

        if desc_count == 0 and gloss_count == 0:
            summary = "✅ **Metadata Estate is Complete!** All objects have both technical descriptions and business glossary mappings."
        else:
            summary = "### 📊 Governance Gap Analysis\n"
            summary += f"We found **{desc_count}** column gaps in technical descriptions and **{gloss_count}** column gaps in business glossary mappings.\n\n"

            if not desc_agg.empty:
                summary += f"🔍 **Technical Gaps**: {len(desc_agg)} objects affected.\n"
            if not gloss_agg.empty:
                summary += f"📖 **Business Gaps**: {len(gloss_agg)} objects affected.\n"

            summary += "\n*Detailed column recommendations are available in the 'Description Propagation' and 'Glossary Recommendations' tabs.*"

        return (
            summary,
            desc_agg,
            gloss_agg,
            orphan_agg,
            str(desc_count),
            str(gloss_count),
            str(orphan_count),
        )
    except Exception as e:
        logger.error(f"Scan failed: {e}")
        raise gr.Error(f"Scan failed: {e!s}")


GCP_CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap');

/* --- Theme CSS Variables --- */
:root {
    --gcp-bg: #f1f5f9;
    --gcp-card-bg: #ffffff;
    --gcp-border: #dadce0;
    --gcp-text: #202124;
    --gcp-header-bg: #f1f5f9;
    --gcp-primary: #1a73e8;
    --gcp-primary-hover: #1765cc;
    --gcp-secondary-bg: #f1f5f9;
    --gcp-secondary-hover: #e2e8f0;
    --gcp-code-bg: rgba(0,0,0,0.05);
    --gcp-metric-value-color: #1a73e8;
    --gcp-metric-label-color: #5f6368;
    --gcp-doc-accordion-bg: #ffffff;
    --gcp-tab-nav-bg: #e2e8f0;
    --gcp-tab-selected-bg: #ffffff;
    --gcp-pill-bg: #f8fafc;
    --gcp-pill-selected-bg: #eff6ff;
    --gcp-pill-selected-text: #1e3a8a;
}

.dark {
    --gcp-bg: #0f172a;
    --gcp-card-bg: #1e293b;
    --gcp-border: #334155;
    --gcp-text: #f8fafc;
    --gcp-header-bg: #1e293b;
    --gcp-primary: #60a5fa;
    --gcp-primary-hover: #93c5fd;
    --gcp-secondary-bg: #334155;
    --gcp-secondary-hover: #475569;
    --gcp-code-bg: rgba(255,255,255,0.1);
    --gcp-metric-value-color: #60a5fa;
    --gcp-metric-label-color: #94a3b8;
    --gcp-doc-accordion-bg: #1e293b;
    --gcp-tab-nav-bg: #1e293b;
    --gcp-tab-selected-bg: #334155;
    --gcp-pill-bg: #1e293b;
    --gcp-pill-selected-bg: #1e3a8a;
    --gcp-pill-selected-text: #93c5fd;
}

/* --- Global Overrides --- */
* {
    font-family: 'Roboto', sans-serif !important;
}

body, .gradio-container {
    background-color: var(--gcp-bg) !important;
    background: var(--gcp-bg) !important;
    color: var(--gcp-text) !important;
}

/* --- Map Gradio CSS variables to theme-aware GCP variables --- */
:root, .gradio-container, body, .dark, .dark :root {
    --primary-50: var(--gcp-bg) !important;
    --primary-500: var(--gcp-primary) !important;
    --secondary-500: var(--gcp-primary) !important;
    --accent-500: var(--gcp-primary) !important;
    --body-background-fill: var(--gcp-bg) !important;
    --block-background-fill: var(--gcp-card-bg) !important;
    --block-border-color: var(--gcp-border) !important;
    --body-text-color: var(--gcp-text) !important;
    --block-label-text-color: var(--gcp-text) !important;
    --input-text-color: var(--gcp-text) !important;
    --input-background-fill: var(--gcp-card-bg) !important;
    --input-background-fill-focus: var(--gcp-card-bg) !important;
    --input-background-fill-hover: var(--gcp-secondary-bg) !important;
    --table-even-background-fill: var(--gcp-card-bg) !important;
    --table-odd-background-fill: var(--gcp-secondary-bg) !important;
    --table-row-focus: var(--gcp-pill-selected-bg) !important;
    --border-color-primary: var(--gcp-border) !important;
    --button-primary-text-color: #ffffff !important;
    --button-secondary-text-color: var(--gcp-text) !important;
    --background-fill-primary: var(--gcp-card-bg) !important;
    --background-fill-secondary: var(--gcp-secondary-bg) !important;
    --checkbox-label-background-fill: var(--gcp-pill-bg) !important;
    --checkbox-label-background-fill-hover: var(--gcp-secondary-bg) !important;
    --checkbox-label-background-fill-selected: var(--gcp-pill-selected-bg) !important;
    --checkbox-label-text-color: var(--gcp-text) !important;
    --checkbox-label-text-color-selected: var(--gcp-pill-selected-text) !important;
    --checkbox-background-color: var(--gcp-card-bg) !important;
    --checkbox-border-color: var(--gcp-border) !important;
}

/* Ensure text readability on main containers */
body, .gradio-container, p, span, div, h1, h2, h3, h4, h5, h6 {
    color: var(--gcp-text) !important;
}

/* Specific enforcement for Primary Buttons - White Text on Blue */
.primary, .gr-button-primary, button.primary, .lg.primary, .sm.primary,
button[variant="primary"], .gr-button-primary *, button.primary *,
button[variant="primary"] *, [class*="primary"] span, [class*="primary"] div {
    background-color: var(--gcp-primary) !important;
    background: var(--gcp-primary) !important;
    color: #ffffff !important;
    border-color: var(--gcp-primary) !important;
    font-weight: 500 !important;
    fill: #ffffff !important;
}

.primary:hover, .gr-button-primary:hover, button.primary:hover {
    background-color: var(--gcp-primary-hover) !important;
    color: #ffffff !important;
}

.gr-button-secondary, .gr-button-secondary *, button.secondary, button.secondary * {
    color: var(--gcp-text) !important;
    background-color: var(--gcp-secondary-bg) !important;
    border: 1px solid var(--gcp-border) !important;
}

.gr-button-secondary:hover, button.secondary:hover {
    background-color: var(--gcp-secondary-hover) !important;
}

input, textarea, select, .gr-input, .gr-box, .gr-textbox input, .gr-textbox textarea {
    background-color: var(--gcp-card-bg) !important;
    color: var(--gcp-text) !important;
    border: 1px solid var(--gcp-border) !important;
    border-radius: 6px !important;
}

/* Single crisp border for all Dropdowns & Textboxes - theme-aware background and no inner border */
.gradio-dropdown .wrap,
.gradio-dropdown .wrap-inner,
.gradio-dropdown .secondary-wrap,
.gradio-container .dropdown-container {
    border: none !important;
    box-shadow: none !important;
    outline: none !important;
    background-color: var(--gcp-card-bg) !important;
    background: var(--gcp-card-bg) !important;
    color: var(--gcp-text) !important;
}

.gradio-dropdown input,
.dropdown-container input,
[data-testid="dropdown"] input,
.wrap input,
.wrap-inner input {
    border: none !important;
    box-shadow: none !important;
    outline: none !important;
    background-color: var(--gcp-card-bg) !important;
    background: var(--gcp-card-bg) !important;
    color: var(--gcp-text) !important;
}

.gradio-container .dropdown-container .options {
    background-color: var(--gcp-card-bg) !important;
    border: 1px solid var(--gcp-border) !important;
    border-radius: 6px !important;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.1) !important;
    color: var(--gcp-text) !important;
}

.gradio-container .dropdown-container .item {
    color: var(--gcp-text) !important;
    background-color: var(--gcp-card-bg) !important;
}

.gradio-container .dropdown-container .item:hover {
    background-color: var(--gcp-secondary-hover) !important;
}

.gr-label, .block label, span[data-testid="block-info"], .gr-form label, .desc-markdown p {
    color: var(--gcp-text) !important;
    font-weight: 500 !important;
    font-size: 13px !important;
}

.gr-table, .gr-table-container, table, .dataframe, thead, tbody, tr, th, td {
    background-color: var(--gcp-card-bg) !important;
    background: var(--gcp-card-bg) !important;
    color: var(--gcp-text) !important;
    border-color: var(--gcp-border) !important;
}

.gr-table, .gr-table-container, table, .dataframe {
    width: 100% !important;
}

th, thead th, .gr-table thead th, .dataframe thead th, 
.gr-table th, .dataframe th, [class*="thead"] th {
    background-color: var(--gcp-header-bg) !important;
    background: var(--gcp-header-bg) !important;
    white-space: nowrap !important;
    color: var(--gcp-text) !important;
    font-weight: 600 !important;
    text-transform: uppercase !important;
    font-size: 11px !important;
    border-bottom: 2px solid var(--gcp-border) !important;
    padding: 12px 8px !important;
}

/* Force header background and text in all header children specifically */
th span, th div, .gr-table th span, .gr-table th div,
.dataframe th span, .dataframe th div, thead * {
    background-color: var(--gcp-header-bg) !important;
    background: var(--gcp-header-bg) !important;
    color: var(--gcp-text) !important;
}

tbody td, .dark tbody td, tbody td span, tbody td div {
    color: var(--gcp-text) !important;
}

input[type="checkbox"] {
    cursor: pointer !important;
    appearance: checkbox !important;
    accent-color: var(--gcp-primary) !important;
    opacity: 1 !important;
    visibility: visible !important;
}

.gradio-checkbox-group label,
.checkbox-group label,
[data-testid="checkbox-group"] label {
    background: var(--gcp-pill-bg) !important;
    background-color: var(--gcp-pill-bg) !important;
    border: 1px solid var(--gcp-border) !important;
    border-radius: 6px !important;
    color: var(--gcp-text) !important;
    padding: 6px 12px !important;
    font-weight: 500 !important;
}

.gradio-checkbox-group label span,
.checkbox-group label span,
[data-testid="checkbox-group"] label span {
    color: var(--gcp-text) !important;
    background: transparent !important;
}

.gradio-checkbox-group label.selected,
.checkbox-group label.selected,
[data-testid="checkbox-group"] label.selected {
    background: var(--gcp-pill-selected-bg) !important;
    background-color: var(--gcp-pill-selected-bg) !important;
    border-color: var(--gcp-primary) !important;
    color: var(--gcp-pill-selected-text) !important;
}

tr, .gr-table tr, .dataframe tr {
    background-color: var(--gcp-card-bg) !important;
}

.markdown code, .prose code, .markdown span, .prose span {
    background-color: var(--gcp-code-bg) !important;
    color: var(--gcp-text) !important;
    padding: 2px 4px !important;
    border-radius: 4px !important;
}

[style*="background-color: black"], [style*="background: black"], .bg-black {
    background-color: var(--gcp-bg) !important;
    color: var(--gcp-text) !important;
}

.tabs .tab-nav {
    background: var(--gcp-tab-nav-bg) !important;
    border-radius: 10px !important;
    padding: 5px !important;
    margin-bottom: 14px !important;
    border: none !important;
}

.tabs .tabitem.selected, .tabs button.selected {
    border-bottom: none !important;
    color: var(--gcp-text) !important;
    background: var(--gcp-tab-selected-bg) !important;
    border-radius: 8px !important;
    box-shadow: 0 2px 6px rgba(15, 23, 42, 0.1) !important;
    font-weight: 600 !important;
}

.tabs button {
    color: var(--gcp-metric-label-color) !important;
    border-bottom: none !important;
    font-weight: 500 !important;
    padding: 8px 16px !important;
    transition: all 0.15s ease !important;
}

.gcp-card {
    background: var(--gcp-card-bg) !important;
    border: 1px solid var(--gcp-border) !important;
    border-radius: 10px !important;
    box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.03) !important;
    padding: 18px 22px !important;
}

.hero-banner-block,
.gradio-html.hero-banner-block,
.hero-banner-block .prose {
    padding: 0 !important;
    margin: 0 0 10px 0 !important;
    border: none !important;
    background: transparent !important;
    box-shadow: none !important;
    width: 100% !important;
    max-width: 100% !important;
}

.hero-banner-block div.gcp-hero-header,
div.gcp-hero-header {
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    margin: 0 !important;
    background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 55%, #1d4ed8 100%) !important;
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    color: #ffffff !important;
    border-radius: 10px !important;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.12) !important;
    padding: 18px 24px !important;
}

.env-settings-accordion {
    border-left: 4px solid var(--gcp-primary) !important;
    border-radius: 10px !important;
    background: var(--gcp-card-bg) !important;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.05) !important;
    margin-bottom: 10px !important;
}

.doc-context-accordion {
    border-left: 4px solid #0284c7 !important;
    border-radius: 10px !important;
    background: var(--gcp-card-bg) !important;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.05) !important;
    margin-bottom: 12px !important;
}

.gcp-card .prose, .gcp-card .markdown {
    margin: 0 !important;
    padding: 0 !important;
}

.gcp-card h3 {
    margin: 0 0 8px 0 !important;
}

.gcp-card .block, .gcp-card .form, .gcp-card .dataframe {
    margin: 0 !important;
    padding: 0 !important;
}

.gcp-metric-card {
    background: var(--gcp-card-bg) !important;
    border: 1px solid var(--gcp-border) !important;
    border-radius: 8px !important;
    padding: 24px 16px !important;
    text-align: center !important;
}

.gcp-metric-value {
    color: var(--gcp-metric-value-color) !important;
    font-size: 36px !important;
    font-weight: 500 !important;
}

.gcp-metric-label {
    color: var(--gcp-metric-label-color) !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    text-transform: uppercase !important;
}

.gcp-doc-badge {
    border-radius: 6px !important;
    padding: 10px 14px !important;
    font-size: 13px !important;
    margin-bottom: 10px !important;
    border: 1px solid var(--gcp-border) !important;
    background-color: var(--gcp-card-bg) !important;
}
.gcp-doc-badge.active {
    border-left: 4px solid #1e8e3e !important;
    background-color: rgba(30, 142, 62, 0.06) !important;
}
.gcp-doc-badge.inactive {
    border-left: 4px solid #f9ab00 !important;
    background-color: rgba(249, 171, 0, 0.06) !important;
}
.gcp-doc-badge.empty {
    border-left: 4px solid var(--gcp-primary) !important;
    background-color: var(--gcp-secondary-bg) !important;
}
.gcp-mode-chip {
    background-color: var(--gcp-primary) !important;
    color: #ffffff !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    padding: 2px 6px !important;
    border-radius: 4px !important;
    margin: 0 4px !important;
}
</style>
<script>
(function() {
    try {
        if (!localStorage.getItem('theme')) {
            localStorage.setItem('theme', 'light');
            document.body.classList.remove('dark');
            document.documentElement.classList.remove('dark');
        }
    } catch (e) {}
})();
</script>
"""


def analyze_and_preview(
    project_id,
    location,
    dataset_id,
    target_table,
    docs_state=None,
    selected_doc_labels=None,
    context_mode="rag",
    force_refresh=False,
    fallback_to_llm=True,
    request: gr.Request = None,
):
    token = get_token_from_session(request)
    set_oauth_token(token)
    try:
        plugin = get_plugin(project_id, location)
        summary = plugin.get_lineage_summary(dataset_id, target_table)
        active_doc_paths = get_active_doc_paths(docs_state, selected_doc_labels)
        fallback_status = "Enabled" if fallback_to_llm else "Disabled"
        if active_doc_paths:
            summary += (
                f"\n\n📄 **Document Context Active**: Using **{len(active_doc_paths)}** "
                f"selected document(s) in `{str(context_mode).upper()}` mode "
                f"| 🤖 **Gemini Fallback**: **{fallback_status}**"
            )
        else:
            summary += f"\n\n🤖 **Gemini Fallback**: **{fallback_status}**"
        df = plugin.preview_propagation(
            dataset_id,
            target_table,
            document_path=active_doc_paths,
            context_mode=context_mode,
            fallback_to_llm=bool(fallback_to_llm),
            force_refresh=bool(force_refresh),
        )
        if df.empty:
            gr.Warning(f"No upstream candidates found for {target_table}.")
            return summary, pd.DataFrame(
                columns=[
                    "Select",
                    "Target Column",
                    "Source",
                    "Source Column",
                    "Confidence",
                    "Proposed Description",
                    "Type",
                ]
            )
        df.insert(0, "Select", [True] * len(df))
        return summary, df
    except Exception as e:
        logger.error(f"Analyze & Preview failed: {e}")
        if "Not found" in str(e) or "404" in str(e):
            raise gr.Error(
                f"Table '{target_table}' does not exist in dataset '{dataset_id}'."
            )
        raise gr.Error(f"Operation failed: {e!s}")


def apply_propagation_improved(
    project_id,
    location,
    dataset_id,
    target_table,
    candidates_df,
    request: gr.Request = None,
):
    token = get_token_from_session(request)
    set_oauth_token(token)
    try:
        if candidates_df is None or candidates_df.empty:
            raise gr.Error("No candidates to apply.")
        candidates_df["Select"] = candidates_df["Select"].astype(bool)
        selected = candidates_df[candidates_df["Select"]]
        logger.info(
            f"Applying propagation: {len(selected)} selected rows out of {len(candidates_df)}"
        )
        if selected.empty:
            gr.Warning("No columns selected for application.")
            return "No columns selected."
        plugin = get_plugin(project_id, location)
        updates = []
        for _, row in selected.iterrows():
            if "Target Column" in row and "Proposed Description" in row:
                updates.append(
                    {
                        "table": target_table,
                        "column": row["Target Column"],
                        "description": row["Proposed Description"],
                    }
                )
        if not updates:
            return "No valid updates found in selection."
        plugin.apply_propagation(dataset_id, updates)
        return f"Successfully applied {len(updates)} updates to {target_table}!"
    except Exception as e:
        logger.error(f"Apply failed: {e}")
        raise gr.Error(f"Apply failed: {e!s}")


def select_all_lineage(df):
    if df is not None and not df.empty:
        df = df.copy()
        df["Select"] = [True] * len(df)
    return df


def deselect_all_lineage(df):
    if df is not None and not df.empty:
        df = df.copy()
        df["Select"] = [False] * len(df)
    return df


def get_glossary_recommendations(
    project_id,
    location,
    dataset_id,
    table_id,
    min_confidence=0.5,
    cache_dataset_id=None,
    cache_table_id=None,
    docs_state=None,
    selected_doc_labels=None,
    context_mode="rag",
    request: gr.Request = None,
):
    logger.info(
        f"get_glossary_recommendations called with project_id={project_id}, location={location}, dataset_id={dataset_id}, table_id={table_id}, min_confidence={min_confidence} (type: {type(min_confidence)})"
    )
    token = get_token_from_session(request)
    set_oauth_token(token)
    try:
        plugin = GlossaryPlugin(
            project_id,
            location,
            cache_dataset_id=cache_dataset_id,
            cache_table_id=cache_table_id,
        )
        active_doc_paths = get_active_doc_paths(docs_state, selected_doc_labels)
        df = plugin.recommend_terms_for_table(
            dataset_id,
            table_id,
            doc_path=active_doc_paths,
            context_mode=context_mode,
            min_confidence=float(min_confidence),
        )
        if df.empty:
            gr.Info(
                f"No glossary recommendations found for {table_id} with confidence >= {min_confidence}."
            )
            empty_df = pd.DataFrame(
                columns=[
                    "Select",
                    "Column",
                    "Suggested Term",
                    "Term Status",
                    "Source",
                    "Confidence",
                    "Rationale",
                    "Term ID",
                ]
            )
            return empty_df, f"ℹ️ No glossary recommendations found for `{table_id}` with confidence >= {min_confidence}."

        df.insert(0, "Select", [True] * len(df))
        existing_count = int(
            df["Term Status"].astype(str).str.contains("Existing", na=False).sum()
        )
        new_count = int(
            df["Term Status"].astype(str).str.contains("New", na=False).sum()
        )
        if new_count > 0:
            new_names = df[
                df["Term Status"].astype(str).str.contains("New", na=False)
            ]["Suggested Term"].tolist()
            gr.Warning(
                f"Heads up: {len(new_names)} recommended term(s) ({', '.join(new_names)}) do not exist in your Dataplex Business Glossary yet and will be automatically created when you click Apply."
            )

        summary_md = (
            f"### 📊 Found **{len(df)}** Recommendations &nbsp;·&nbsp; "
            f"✅ **{existing_count}** Existing in Dataplex Glossary &nbsp;·&nbsp; "
            f"✨ **{new_count}** New Terms *(Will Auto-Create on Apply)*"
        )
        return df, summary_md
    except Exception as e:
        logger.error(f"Glossary recommendations failed: {e}")
        raise gr.Error(f"Operation failed: {e!s}")


def apply_glossary_selections(
    project_id,
    location,
    dataset_id,
    table_id,
    reco_df,
    cache_dataset_id=None,
    cache_table_id=None,
    request: gr.Request = None,
):
    token = get_token_from_session(request)
    set_oauth_token(token)
    try:
        if reco_df is None or reco_df.empty:
            raise gr.Error("No recommendations to apply.")
        reco_df["Select"] = reco_df["Select"].astype(bool)
        selected = reco_df[reco_df["Select"]]
        if selected.empty:
            gr.Warning("No terms selected for application.")
            return "No terms selected."
        plugin = GlossaryPlugin(
            project_id,
            location,
            cache_dataset_id=cache_dataset_id,
            cache_table_id=cache_table_id,
        )
        updates = []
        for _, row in selected.iterrows():
            updates.append(
                {
                    "column": row["Column"],
                    "term_id": row["Term ID"],
                    "term_display": row["Suggested Term"],
                }
            )
        res = plugin.apply_terms(dataset_id, table_id, updates)
        if isinstance(res, dict):
            created = res.get("created_terms", [])
            applied = res.get("applied_count", len(updates))
            if created:
                return f"✨ Auto-created {len(created)} new Glossary Term(s) in Dataplex ({', '.join(created)}) and successfully applied {applied} glossary terms to {table_id} in Knowledge Catalog!"
            return f"Successfully applied {applied} glossary terms to {table_id} in Knowledge Catalog!"
        return f"Successfully applied {len(updates)} glossary terms to {table_id} in Knowledge Catalog!"
    except Exception as e:
        logger.error(f"Glossary apply failed: {e}")
        raise gr.Error(f"Apply failed: {e!s}")


def select_all_glossary(df):
    if df is not None and not df.empty:
        df = df.copy()
        df["Select"] = [True] * len(df)
    return df


def deselect_all_glossary(df):
    if df is not None and not df.empty:
        df = df.copy()
        df["Select"] = [False] * len(df)
    return df


def get_policy_tag_recommendations(
    project_id,
    location,
    dataset_id,
    table_id,
    docs_state=None,
    selected_doc_labels=None,
    context_mode="rag",
    request: gr.Request = None,
):
    token = get_token_from_session(request)
    set_oauth_token(token)
    try:
        plugin = PolicyTagPlugin(project_id, location)
        active_doc_paths = get_active_doc_paths(docs_state, selected_doc_labels)
        df = plugin.preview_policy_tag_propagation(
            dataset_id,
            table_id,
            doc_path=active_doc_paths,
            context_mode=context_mode,
        )
        if df.empty:
            gr.Info(f"No policy tag recommendations found for {table_id}.")
            return pd.DataFrame(
                columns=[
                    "Select",
                    "Target Column",
                    "Source Table",
                    "Policy Tags",
                    "Recommendation",
                    "Logic",
                    "Access Summary",
                ]
            )
        df.insert(0, "Select", [True] * len(df))
        return df
    except Exception as e:
        logger.error(f"Policy tag recommendations failed: {e}")
        raise gr.Error(f"Operation failed: {e!s}")


def apply_policy_tag_recommendations(
    project_id,
    location,
    dataset_id,
    target_table,
    recommendations_df,
    additional_readers,
    request: gr.Request = None,
):
    token = get_token_from_session(request)
    set_oauth_token(token)
    try:
        if recommendations_df is None or recommendations_df.empty:
            raise gr.Error("No recommendations to apply.")
        recommendations_df["Select"] = recommendations_df["Select"].astype(bool)
        selected = recommendations_df[recommendations_df["Select"]]
        if selected.empty:
            gr.Warning("No columns selected for application.")
            return "No columns selected."
        plugin = PolicyTagPlugin(project_id, location)
        updates = []
        for _, row in selected.iterrows():
            update = {
                "table": target_table,
                "column": row["Target Column"],
                "policy_tag": row["Policy Tags"].split(", ")[0],
            }
            all_readers = []
            if additional_readers:
                all_readers.extend(
                    [
                        r.strip()
                        for r in additional_readers.split(",")
                        if r.strip()
                    ]
                )
            if all_readers:
                update["readers"] = list(set(all_readers))
            updates.append(update)
        plugin.apply_policy_tags(dataset_id, updates)
        return f"Successfully applied {len(updates)} policy tags to {target_table}!"
    except Exception as e:
        logger.error(f"Policy tag apply failed: {e}")
        raise gr.Error(f"Apply failed: {e!s}")


def select_all_policy(df):
    if df is not None and not df.empty:
        df = df.copy()
        df["Select"] = [True] * len(df)
    return df


def deselect_all_policy(df):
    if df is not None and not df.empty:
        df = df.copy()
        df["Select"] = [False] * len(df)
    return df


def get_dq_propagation(
    project_id, location, dataset_id, table_id, request: gr.Request = None
):
    token = get_token_from_session(request)
    set_oauth_token(token)
    try:
        dq_plugin = DQPlugin(project_id, location)
        engine = DQPropagationEngine(
            project_id, location, token=get_oauth_token()
        )
        target_fqn = f"bigquery:{project_id}.{dataset_id}.{table_id}"
        from google.cloud import bigquery

        from metadata_propagation.agent.plugins.context import (
            get_credentials,
        )

        client = bigquery.Client(
            project=project_id, credentials=get_credentials(project_id)
        )
        table = client.get_table(f"{project_id}.{dataset_id}.{table_id}")
        columns = [f.name for f in table.schema]
        propagation_data = engine.propagate_dq_scores(
            target_fqn, dataset_id, table_id, columns
        )
        results = []
        for col in columns:
            data = propagation_data.get(col, {})
            leaves = data.get("leaves", [])
            bonus = data.get("bonus", 0.0)
            if leaves:
                best_conf = max(leaf.get("confidence", 0) for leaf in leaves)
                leaves = [
                    leaf
                    for leaf in leaves
                    if leaf.get("confidence", 0) >= best_conf
                ]
            upstream_scores = []
            source_names = []
            for leaf in leaves:
                src_parts = leaf["source_entity"].split(".")
                if len(src_parts) == 3:
                    s_ds, s_tab = src_parts[1], src_parts[2]
                    s_summary = dq_plugin.fetch_dq_summary(
                        s_ds, s_tab, leaf.get("source_column")
                    )
                    upstream_scores.append(s_summary["score"])
                    source_names.append(f"{s_tab}.{leaf.get('source_column')}")
            if not upstream_scores:
                summary = dq_plugin.fetch_dq_summary(dataset_id, table_id, col)
                base_score = summary["score"]
                source_type = summary["source"]
            else:
                base_score = engine.aggregate_scores(upstream_scores)
                source_type = "DERIVED"
            final_score = min(base_score + bonus, 1.0)
            engine.update_history(
                target_fqn, col, final_score, source_type=source_type
            )
            trend = engine.get_trend(target_fqn, col)
            badge = (
                "🟢 High"
                if final_score > 0.9
                else ("🟡 Medium" if final_score > 0.7 else "🔴 Low")
            )
            if bonus > 0:
                if base_score >= 1.0:
                    bonus_str = f"+{int(bonus * 100)}% (Capped)"
                else:
                    bonus_str = f"+{int(bonus * 100)}%"
            else:
                bonus_str = "None"
            results.append(
                {
                    "Column": col,
                    "Trust Score": round(final_score, 2),
                    "Badge": badge,
                    "Trend": trend.capitalize(),
                    "Bonus (Remediation)": bonus_str,
                    "Upstream Sources": ", ".join(source_names[:2])
                    + ("..." if len(source_names) > 2 else "")
                    or "None (Source)",
                }
            )
        return pd.DataFrame(results)
    except Exception as e:
        logger.error(f"DQ propagation failed: {e}")
        raise gr.Error(f"Operation failed: {e!s}")


with gr.Blocks(title="Governance on Auto-pilot") as demo:
    gr.HTML(GCP_CSS)

    with gr.Column(visible=True) as login_view:
        with gr.Column(elem_classes=["gcp-card"]):
            gr.Markdown("# Welcome to Governance on Auto-pilot")
            gr.Markdown(
                "Proactively manage your metadata and governance at scale."
            )
            login_btn = gr.Button(
                "Login with Google",
                variant="primary",
                elem_classes=["gr-button-primary"],
            )
            login_btn.click(
                lambda: gr.Info("Redirecting to Google Login..."), None, None
            ).then(fn=None, js="() => window.location.href='/google_login'")

    with gr.Column(visible=False) as app_view:
        gr.HTML(
            """
            <div class="gcp-hero-header" style="width: 100%;
                        box-sizing: border-box;
                        background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 55%, #1d4ed8 100%) !important;
                        border: 1px solid rgba(255, 255, 255, 0.15);
                        border-radius: 10px;
                        padding: 18px 24px;
                        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.12);
                        display: flex;
                        align-items: center;
                        justify-content: space-between;">
                <div style="display: flex; align-items: center; gap: 14px;">
                    <div style="background: rgba(255, 255, 255, 0.12);
                                border: 1px solid rgba(255, 255, 255, 0.2);
                                border-radius: 10px;
                                padding: 10px 12px;
                                font-size: 26px;
                                line-height: 1;">🛡️</div>
                    <div>
                        <div style="font-size: 22px; font-weight: 700; color: #ffffff !important; letter-spacing: -0.3px;">
                            Governance on Auto-pilot
                        </div>
                        <div style="font-size: 13px; color: #cbd5e1 !important; margin-top: 2px;">
                            Knowledge Catalog · Gemini AI · Lineage & Multi-Document RAG Engine
                        </div>
                    </div>
                </div>
                <div>
                    <a href="/logout"
                       style="background: rgba(255, 255, 255, 0.14);
                              border: 1px solid rgba(255, 255, 255, 0.28);
                              color: #ffffff !important;
                              padding: 7px 18px;
                              border-radius: 9999px;
                              font-size: 13px;
                              font-weight: 500;
                              text-decoration: none;
                              transition: background 0.15s ease;">
                        Logout
                    </a>
                </div>
            </div>
            """,
            elem_classes=["hero-banner-block"],
        )

        with gr.Accordion(
            "⚙️ Global Environment Settings",
            open=True,
            elem_classes=["env-settings-accordion"],
        ):
            with gr.Row():
                config_project = gr.Dropdown(
                    label="Project ID",
                    choices=list(dict.fromkeys([DEFAULT_PROJECT_ID, "data-governance-agent-dev", "governance-agent"])),
                    value=DEFAULT_PROJECT_ID,
                    allow_custom_value=True,
                )
                config_location = gr.Dropdown(
                    label="Location",
                    choices=[
                        "us-central1",
                        "europe-west1",
                        "us-east1",
                        "us-west1",
                        "europe-west2",
                        "asia-east1",
                    ],
                    value=DEFAULT_LOCATION,
                    allow_custom_value=True,
                )
            with gr.Row():
                config_cache_dataset = gr.Textbox(
                    label="Glossary Cache Dataset ID",
                    value="",
                    placeholder="Default: Active Scanned Dataset ID",
                    info="Optional: Redirect embeddings cache storage to a separate writable dataset",
                )
                config_cache_table = gr.Textbox(
                    label="Glossary Cache Table ID",
                    value="glossary_embeddings_cache",
                    info="Configure custom BigQuery table name for glossary embeddings cache",
                )
                refresh_lineage_btn = gr.Button(
                    "🔄 Refresh Lineage Cache",
                    variant="secondary",
                    size="sm",
                    elem_classes=["gr-button-secondary"],
                )

            refresh_lineage_btn.click(
                handle_refresh_lineage_cache, inputs=None, outputs=None
            )

        # --- Global Document Context (Header Level) ---
        docs_state = gr.State([])

        with gr.Accordion(
            "📄 Global Document Context (Upload & Select Docs for AI Context)",
            open=True,
            elem_classes=["doc-context-accordion"],
        ):
            with gr.Row():
                with gr.Column(scale=4):
                    doc_upload_input = gr.File(
                        file_count="multiple",
                        file_types=[
                            ".pdf",
                            ".txt",
                            ".md",
                            ".xlsx",
                            ".png",
                            ".jpg",
                            ".jpeg",
                        ],
                        label="Upload Reference Documents (PDF, XLSX, MD, TXT, Images)",
                    )
                with gr.Column(scale=6):
                    doc_checkbox_group = gr.CheckboxGroup(
                        choices=[],
                        value=[],
                        label="Uploaded Documents (Check to tell Agent to use document for context)",
                        info="Selected documents are automatically reused across Description Propagation, Glossary Recommendations, and Policy Tag Propagation.",
                    )
                    # Allow dynamically uploaded file labels in CheckboxGroup without static choice errors
                    doc_checkbox_group.preprocess = lambda x: x or []
                    with gr.Row():
                        select_all_docs_btn = gr.Button(
                            "Select All Docs",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )
                        deselect_all_docs_btn = gr.Button(
                            "Deselect All Docs",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )
                        clear_docs_btn = gr.Button(
                            "🗑️ Clear Uploaded Docs",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )
                    with gr.Row():
                        doc_context_mode = gr.Dropdown(
                            choices=["rag", "direct"],
                            value="rag",
                            label="Document Processing Mode",
                            info="'rag' chunks & embeds for semantic retrieval; 'direct' injects full extracted text",
                        )
                        doc_fallback_to_llm = gr.Checkbox(
                            value=False,
                            interactive=False,
                            label="Enable Gemini Fallback",
                            info="Requires at least one uploaded document to be selected for context",
                        )
                        doc_force_refresh = gr.Checkbox(
                            value=False,
                            label="Force Refresh RAG Cache",
                            info="Re-extract document markdown via Gemini even if cached",
                        )

        header_doc_badge = gr.HTML(render_header_doc_badge([], [], "rag"))

        doc_upload_input.upload(
            handle_doc_uploads,
            inputs=[
                doc_upload_input,
                docs_state,
                doc_checkbox_group,
                doc_context_mode,
            ],
            outputs=[
                docs_state,
                doc_checkbox_group,
                header_doc_badge,
                doc_fallback_to_llm,
            ],
        )
        doc_checkbox_group.change(
            update_doc_selection_badge,
            inputs=[
                docs_state,
                doc_checkbox_group,
                doc_context_mode,
                doc_fallback_to_llm,
            ],
            outputs=[header_doc_badge, doc_fallback_to_llm],
        )
        doc_context_mode.change(
            update_doc_selection_badge,
            inputs=[
                docs_state,
                doc_checkbox_group,
                doc_context_mode,
                doc_fallback_to_llm,
            ],
            outputs=[header_doc_badge, doc_fallback_to_llm],
        )
        select_all_docs_btn.click(
            select_all_docs,
            inputs=[docs_state, doc_context_mode],
            outputs=[
                doc_checkbox_group,
                header_doc_badge,
                doc_fallback_to_llm,
            ],
        )
        deselect_all_docs_btn.click(
            deselect_all_docs,
            inputs=[docs_state, doc_context_mode],
            outputs=[
                doc_checkbox_group,
                header_doc_badge,
                doc_fallback_to_llm,
            ],
        )
        clear_docs_btn.click(
            clear_all_docs,
            inputs=[doc_context_mode],
            outputs=[
                docs_state,
                doc_checkbox_group,
                header_doc_badge,
                doc_upload_input,
                doc_fallback_to_llm,
            ],
        )

        with gr.Tabs():
            with gr.TabItem("Dashboard"):
                with gr.Column(elem_classes=["gcp-card"]):
                    gr.Markdown("## 📋 Data Estate Governance")
                    with gr.Group():
                        with gr.Row():
                            global_dataset = gr.Textbox(
                                label="Active Dataset ID",
                                value=DEFAULT_DATASET_ID,
                                placeholder="e.g. retail_synthetic_data",
                                info="Select a dataset to scan for gaps in descriptions and glossary mappings.",
                            )

                    with gr.Row():
                        scan_btn = gr.Button(
                            "Analyze Governance Health",
                            variant="primary",
                            elem_classes=["gr-button-primary"],
                        )

                    dash_summary = gr.Markdown(
                        "Enter a dataset and click 'Analyze' to view the current governance state."
                    )

                with gr.Row():
                    with gr.Column(elem_classes=["gcp-metric-card"]):
                        desc_metric = gr.HTML(
                            "<div class='gcp-metric-value'>-</div><div class='gcp-metric-label'>Description Gaps</div>"
                        )
                    with gr.Column(elem_classes=["gcp-metric-card"]):
                        gloss_metric = gr.HTML(
                            "<div class='gcp-metric-value'>-</div><div class='gcp-metric-label'>Glossary Gaps</div>"
                        )
                    with gr.Column(elem_classes=["gcp-metric-card"]):
                        orphan_metric = gr.HTML(
                            "<div class='gcp-metric-value'>-</div><div class='gcp-metric-label'>Orphaned Columns</div>"
                        )

                with gr.Row():
                    with gr.Column(elem_classes=["gcp-card"]):
                        gr.Markdown("### 🔍 Technical Description Gaps")
                        gr.Markdown(
                            "<small>Tables and columns lacking a documented description.</small>"
                        )
                        desc_output = gr.Dataframe(
                            headers=["Table", "Missing Descriptions"],
                            interactive=False,
                            wrap=True,
                        )
                    with gr.Column(elem_classes=["gcp-card"]):
                        gr.Markdown("### 📖 Business Glossary Gaps")
                        gr.Markdown(
                            "<small>Columns missing direct mapping to business glossary terms.</small>"
                        )
                        glossary_gap_output = gr.Dataframe(
                            headers=["Table", "Missing Glossary Mappings"],
                            interactive=False,
                            wrap=True,
                        )
                    with gr.Column(elem_classes=["gcp-card"]):
                        gr.Markdown("### ⚠️ Orphaned Assets")
                        gr.Markdown(
                            "<small>Columns missing both description and glossary mapping.</small>"
                        )
                        orphan_output = gr.Dataframe(
                            headers=["Table", "Orphaned Columns"],
                            interactive=False,
                            wrap=True,
                        )

                def dashboard_scan_wrapper(
                    project, loc, ds, cache_ds, cache_tbl, request: gr.Request
                ):
                    summary, d_agg, g_agg, o_agg, d_cnt, g_cnt, o_cnt = (
                        scan_dataset(
                            project, loc, ds, cache_ds, cache_tbl, request
                        )
                    )

                    d_html = f"<div class='gcp-metric-value'>{d_cnt}</div><div class='gcp-metric-label'>Description Gaps</div>"
                    g_html = f"<div class='gcp-metric-value'>{g_cnt}</div><div class='gcp-metric-label'>Glossary Gaps</div>"
                    o_html = f"<div class='gcp-metric-value'>{o_cnt}</div><div class='gcp-metric-label'>Orphaned Columns</div>"

                    return summary, d_agg, g_agg, o_agg, d_html, g_html, o_html

                scan_btn.click(
                    dashboard_scan_wrapper,
                    inputs=[
                        config_project,
                        config_location,
                        global_dataset,
                        config_cache_dataset,
                        config_cache_table,
                    ],
                    outputs=[
                        dash_summary,
                        desc_output,
                        glossary_gap_output,
                        orphan_output,
                        desc_metric,
                        gloss_metric,
                        orphan_metric,
                    ],
                )

            with gr.TabItem("Description Propagation"):
                with gr.Column(elem_classes=["gcp-card"]):
                    gr.Markdown("## 🧬 Analyze & Propagate Descriptions")
                    with gr.Row():
                        prop_table = gr.Textbox(
                            label="Target Table", value="transactions"
                        )

                    preview_btn = gr.Button(
                        "Analyze & Preview Description Propagation",
                        variant="primary",
                        elem_classes=["gr-button-primary"],
                    )

                    summary_output = gr.Markdown(
                        "Enter a table and click the button above to start analysis."
                    )
                    gr.Markdown(
                        "*(Optional: Click any cell in the **Proposed Description** column to refine it before applying)*"
                    )
                    preview_output = gr.Dataframe(
                        label="Propagation Candidates",
                        interactive=True,
                        wrap=True,
                        datatype=[
                            "bool",
                            "str",
                            "str",
                            "str",
                            "number",
                            "str",
                            "str",
                        ],
                    )

                    with gr.Row():
                        select_all_lineage_btn = gr.Button(
                            "Select All",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )
                        deselect_all_lineage_btn = gr.Button(
                            "Deselect All",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )

                    with gr.Row():
                        apply_btn = gr.Button(
                            "Apply Selection to BigQuery",
                            variant="primary",
                            elem_classes=["gr-button-primary"],
                        )

                    apply_result = gr.Textbox(
                        label="Apply Status", interactive=False
                    )

                select_all_lineage_btn.click(
                    select_all_lineage,
                    inputs=[preview_output],
                    outputs=[preview_output],
                )
                deselect_all_lineage_btn.click(
                    deselect_all_lineage,
                    inputs=[preview_output],
                    outputs=[preview_output],
                )

                preview_btn.click(lambda: "", outputs=[apply_result]).then(
                    analyze_and_preview,
                    inputs=[
                        config_project,
                        config_location,
                        global_dataset,
                        prop_table,
                        docs_state,
                        doc_checkbox_group,
                        doc_context_mode,
                        doc_force_refresh,
                        doc_fallback_to_llm,
                    ],
                    outputs=[summary_output, preview_output],
                )
                apply_btn.click(
                    apply_propagation_improved,
                    inputs=[
                        config_project,
                        config_location,
                        global_dataset,
                        prop_table,
                        preview_output,
                    ],
                    outputs=apply_result,
                )

            with gr.TabItem("Glossary Recommendations"):
                with gr.Column(elem_classes=["gcp-card"]):
                    gr.Markdown("## 📖 Business Glossary Mapping")
                    gr.Markdown(
                        "Recommends mappings of columns to business glossary terms across tables."
                    )

                    with gr.Row():
                        glossary_table = gr.Textbox(
                            label="Target Table", value="customers"
                        )
                        confidence_slider = gr.Slider(
                            minimum=0.0,
                            maximum=1.0,
                            value=0.5,
                            step=0.05,
                            label="Minimum Confidence Threshold",
                            info="Filter out weak recommendations",
                        )

                    recommend_btn = gr.Button(
                        "Get Glossary Recommendations",
                        variant="primary",
                        elem_classes=["gr-button-primary"],
                    )

                with gr.Column(elem_classes=["gcp-card"]):
                    glossary_summary_banner = gr.Markdown(
                        "ℹ️ Click **Get Glossary Recommendations** to analyze table columns."
                    )
                    recommendations_view = gr.Dataframe(
                        label="Glossary Recommendations",
                        interactive=True,
                        wrap=True,
                        datatype=[
                            "bool",
                            "str",
                            "str",
                            "str",
                            "str",
                            "number",
                            "str",
                            "str",
                        ],
                        column_widths=[
                            "7%",
                            "11%",
                            "15%",
                            "13%",
                            "11%",
                            "9%",
                            "18%",
                            "16%",
                        ],
                    )

                    with gr.Row():
                        select_all_glossary_btn = gr.Button(
                            "Select All",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )
                        deselect_all_glossary_btn = gr.Button(
                            "Deselect All",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )

                    with gr.Row():
                        apply_glossary_btn = gr.Button(
                            "Apply Selected Terms to Knowledge Catalog",
                            variant="primary",
                            elem_classes=["gr-button-primary"],
                        )

                    glossary_apply_result = gr.Textbox(
                        label="Apply Status", interactive=False
                    )

                select_all_glossary_btn.click(
                    select_all_glossary,
                    inputs=[recommendations_view],
                    outputs=[recommendations_view],
                )
                deselect_all_glossary_btn.click(
                    deselect_all_glossary,
                    inputs=[recommendations_view],
                    outputs=[recommendations_view],
                )

                recommend_btn.click(
                    lambda: "", outputs=[glossary_apply_result]
                ).then(
                    get_glossary_recommendations,
                    inputs=[
                        config_project,
                        config_location,
                        global_dataset,
                        glossary_table,
                        confidence_slider,
                        config_cache_dataset,
                        config_cache_table,
                        docs_state,
                        doc_checkbox_group,
                        doc_context_mode,
                    ],
                    outputs=[recommendations_view, glossary_summary_banner],
                )

                apply_glossary_btn.click(
                    apply_glossary_selections,
                    inputs=[
                        config_project,
                        config_location,
                        global_dataset,
                        glossary_table,
                        recommendations_view,
                        config_cache_dataset,
                        config_cache_table,
                    ],
                    outputs=glossary_apply_result,
                )

            with gr.TabItem("Policy Tag Propagation"):
                with gr.Column(elem_classes=["gcp-card"]):
                    gr.Markdown("## 🛡️ Policy Tag Propagation")
                    gr.Markdown(
                        "Recommends propagating policy tags based on lineage and transformation assessment."
                    )

                    with gr.Row():
                        policy_table = gr.Textbox(
                            label="Target Table", value="customers"
                        )

                    policy_recommend_btn = gr.Button(
                        "Get Policy Tag Recommendations",
                        variant="primary",
                        elem_classes=["gr-button-primary"],
                    )

                with gr.Column(elem_classes=["gcp-card"]):
                    policy_recommendations_view = gr.Dataframe(
                        label="Policy Tag Recommendations",
                        interactive=True,
                        wrap=True,
                        datatype=[
                            "bool",
                            "str",
                            "str",
                            "str",
                            "str",
                            "str",
                            "str",
                        ],
                    )

                    with gr.Row():
                        additional_readers_txt = gr.Textbox(
                            label="Additional Readers to add (Comma separated)",
                            placeholder="group:data-scientists@example.com, user:analyst@example.com",
                        )

                    with gr.Row():
                        select_all_policy_btn = gr.Button(
                            "Select All",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )
                        deselect_all_policy_btn = gr.Button(
                            "Deselect All",
                            size="sm",
                            elem_classes=["gr-button-secondary"],
                        )

                    with gr.Row():
                        apply_policy_btn = gr.Button(
                            "Apply Selected Tags to BigQuery",
                            variant="primary",
                            elem_classes=["gr-button-primary"],
                        )

                    policy_apply_result = gr.Textbox(
                        label="Apply Status", interactive=False
                    )

                select_all_policy_btn.click(
                    select_all_policy,
                    inputs=[policy_recommendations_view],
                    outputs=[policy_recommendations_view],
                )
                deselect_all_policy_btn.click(
                    deselect_all_policy,
                    inputs=[policy_recommendations_view],
                    outputs=[policy_recommendations_view],
                )

                policy_recommend_btn.click(
                    lambda: "", outputs=[policy_apply_result]
                ).then(
                    get_policy_tag_recommendations,
                    inputs=[
                        config_project,
                        config_location,
                        global_dataset,
                        policy_table,
                        docs_state,
                        doc_checkbox_group,
                        doc_context_mode,
                    ],
                    outputs=policy_recommendations_view,
                )

                apply_policy_btn.click(
                    apply_policy_tag_recommendations,
                    inputs=[
                        config_project,
                        config_location,
                        global_dataset,
                        policy_table,
                        policy_recommendations_view,
                        additional_readers_txt,
                    ],
                    outputs=policy_apply_result,
                )

            with gr.TabItem("Trust Center (DQ)"):
                with gr.Column(elem_classes=["gcp-card"]):
                    gr.Markdown("## 💎 Data Trust & Quality Propagation")
                    gr.Markdown(
                        "Visualizes derived trust scores for tables and views based on upstream quality and transformation logic."
                    )

                    with gr.Row():
                        dq_table = gr.Textbox(
                            label="Target Table/View", value="transactions"
                        )

                    dq_analyze_btn = gr.Button(
                        "Analyze Trust & Quality",
                        variant="primary",
                        elem_classes=["gr-button-primary"],
                    )

                with gr.Column(elem_classes=["gcp-card"]):
                    dq_results_view = gr.Dataframe(
                        label="Column Trust Metrics",
                        interactive=False,
                        wrap=True,
                    )

                    gr.Markdown("### 💡 Trust Logic")
                    gr.Markdown(
                        "- **Conservative Scoring**: Minimum quality of all upstream contributors.\n- **Remediation Bonus**: Automatic detection of `DISTINCT` or `COALESCE` improves the derived score.\n- **Trend Analysis**: Compares current score against the last 5 snapshots."
                    )

                dq_analyze_btn.click(
                    get_dq_propagation,
                    inputs=[
                        config_project,
                        config_location,
                        global_dataset,
                        dq_table,
                    ],
                    outputs=dq_results_view,
                )

    # Helper to check auth status (UI visibility only; authorization is
    # enforced server-side in every handler via get_token_from_session).
    def check_auth_status(request: gr.Request):
        # ADC mode must be requested explicitly. Missing OAuth client settings
        # are a misconfiguration, not an implicit opt-in to server credentials.
        if is_oauth_bypassed():
            logger.info(
                "BYPASS_OAUTH=true: skipping Google OAuth login screen (ADC mode)."
            )
            return gr.update(visible=False), gr.update(visible=True)

        if _session_token(request):
            return gr.update(visible=False), gr.update(visible=True)
        return gr.update(visible=True), gr.update(visible=False)

    demo.load(check_auth_status, outputs=[login_view, app_view])

def _oauth_client_configured() -> bool:
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    return bool(client_id and client_secret and "YOUR_CLIENT_ID" not in client_id)


# Endpoints that are only used by programmatic API clients or for file
# uploads, never by the login page. Unauthenticated requests to these are
# rejected up front. The browser UI (including the login page) talks to the
# backend through /gradio_api/queue/*, which must stay reachable so the
# "Login with Google" button and demo.load() work; those events are
# authorized inside each handler via get_token_from_session().
_SESSION_REQUIRED_PREFIXES = (
    "/gradio_api/upload",
    "/gradio_api/call/",
    "/gradio_api/run/",
    "/gradio_api/api/",
    "/upload",
    "/call/",
    "/run/",
    "/api/",
)


def create_app():
    """Builds the FastAPI app hosting the Gradio UI with OAuth enforcement."""
    import secrets

    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    if is_oauth_bypassed():
        logger.warning(
            "BYPASS_OAUTH=true: OAuth is disabled and ALL visitors will act with "
            "the server's Application Default Credentials. Only use this for "
            "local development or behind an authenticating proxy (e.g. IAP)."
        )
        require_oauth_globally(False)
    else:
        if not _oauth_client_configured():
            raise RuntimeError(
                "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and "
                "GOOGLE_CLIENT_SECRET, or explicitly set BYPASS_OAUTH=true to "
                "run in Application Default Credentials (ADC) mode."
            )
        # Fail closed everywhere in this process: no code path may fall back
        # to the server's ADC when a user token is missing.
        require_oauth_globally(True)

    main_app = FastAPI()

    @main_app.middleware("http")
    async def enforce_oauth_middleware(request: fastapi.Request, call_next):
        session = request.scope.get("session") or {}
        token_dict = (
            session.get("google_token") if isinstance(session, dict) else None
        )
        if not (isinstance(token_dict, dict) and token_dict.get("access_token")):
            token_dict = None
        # Expose the signed-session token to Gradio handlers. Queued events
        # lose request.session but keep request.state (see _session_token).
        # Always assigned, so it can only ever come from the signed cookie.
        request.state.google_token = token_dict

        if (
            not is_oauth_bypassed()
            and request.url.path.startswith(_SESSION_REQUIRED_PREFIXES)
            and token_dict is None
        ):
            return JSONResponse(
                status_code=401,
                content={
                    "detail": "Authentication required: valid Google OAuth session missing."
                },
            )
        return await call_next(request)

    session_secret = os.environ.get("SESSION_SECRET_KEY")
    if not session_secret:
        logger.warning(
            "SESSION_SECRET_KEY is not set; generating an ephemeral key. Sessions "
            "will not survive restarts or be shared across instances."
        )
        session_secret = secrets.token_urlsafe(32)
    # Added after the auth middleware so it wraps it (outermost) and the
    # session is populated before enforce_oauth_middleware runs.
    main_app.add_middleware(
        SessionMiddleware,
        secret_key=session_secret,
        session_cookie="steward_session",
    )

    @main_app.get("/google_login")
    async def login(request: fastapi.Request):
        redirect_uri = os.environ.get(
            "GOOGLE_REDIRECT_URI", "http://localhost:7860/google_callback"
        )
        client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
        logger.info(
            f"Initiating login: client_id={client_id[:10]}... redirect_uri={redirect_uri}"
        )
        return await oauth_config.google.authorize_redirect(
            request, redirect_uri
        )

    @main_app.get("/google_callback")
    async def auth_callback(request: fastapi.Request):
        try:
            token = await oauth_config.google.authorize_access_token(request)
            request.session["google_token"] = token
            logger.info("Successfully received token and stored in session.")
            return RedirectResponse(url="/")
        except Exception as e:
            logger.error(f"Auth callback failed: {e}")
            return RedirectResponse(url="/?error=auth_failed")

    @main_app.get("/logout")
    async def logout(request: fastapi.Request):
        request.session.pop("google_token", None)
        return RedirectResponse(url="/")

    return gr.mount_gradio_app(main_app, demo, path="/")


if __name__ == "__main__":
    import uvicorn

    app = create_app()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host=host, port=port)