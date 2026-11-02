import contextvars
import logging
import os
import threading

import google.auth
import google.oauth2.credentials

logger = logging.getLogger(__name__)

_oauth_token = contextvars.ContextVar("oauth_token", default=None)
_oauth_token_set = contextvars.ContextVar("oauth_token_set", default=False)
_cached_adc_creds = None
_adc_lock = threading.Lock()

# Process-wide enforcement flag. Set by the web server at startup so that
# every code path in the process (including worker threads that do not
# inherit contextvars) refuses to fall back to Application Default Credentials.
_oauth_required_globally = False


def is_oauth_bypassed() -> bool:
    """True only when ADC mode is explicitly requested via BYPASS_OAUTH=true."""
    return os.environ.get("BYPASS_OAUTH", "").strip().lower() == "true"


def require_oauth_globally(required: bool = True):
    """Enables (or disables) process-wide OAuth enforcement."""
    global _oauth_required_globally
    _oauth_required_globally = required


def is_oauth_enabled() -> bool:
    """
    Returns True when OAuth authentication is active and ADC fallback must be blocked.
    OAuth is active (unless BYPASS_OAUTH=true) when either:
    - the process has enabled enforcement via require_oauth_globally() (web server), or
    - set_oauth_token() has been invoked in the current execution context.
    """
    if is_oauth_bypassed():
        return False
    return _oauth_required_globally or bool(_oauth_token_set.get())


def set_oauth_token(token: str | dict | None):
    """Sets the OAuth token for the current context and marks OAuth enforcement active."""
    _oauth_token.set(token)
    _oauth_token_set.set(True)


def reset_oauth_context():
    """Resets the OAuth context variables to their initial state."""
    _oauth_token.set(None)
    _oauth_token_set.set(False)


def get_oauth_token() -> str | None:
    """Gets the OAuth access token string from the current context."""
    val = _oauth_token.get()
    if isinstance(val, dict):
        return val.get("access_token")
    return val


def get_credentials(quota_project_id: str):
    """
    Returns Google Credentials object.
    When OAuth is enabled (or set_oauth_token was called without BYPASS_OAUTH=true),
    strictly requires a valid user OAuth token and NEVER falls back to Server
    Application Default Credentials (ADC).
    """
    bypass_oauth = is_oauth_bypassed()
    token_data = _oauth_token.get()

    if not bypass_oauth and token_data:
        if isinstance(token_data, dict):
            access_token = token_data.get("access_token")
            refresh_token = token_data.get("refresh_token")
            client_id = os.environ.get("GOOGLE_CLIENT_ID")
            client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")

            if access_token:
                if refresh_token and client_id and client_secret:
                    return google.oauth2.credentials.Credentials(
                        token=access_token,
                        refresh_token=refresh_token,
                        token_uri="https://oauth2.googleapis.com/token",
                        client_id=client_id,
                        client_secret=client_secret,
                        quota_project_id=quota_project_id,
                    )
                return google.oauth2.credentials.Credentials(
                    token=access_token,
                    quota_project_id=quota_project_id,
                )
        elif isinstance(token_data, str) and token_data.strip():
            return google.oauth2.credentials.Credentials(
                token=token_data.strip(),
                quota_project_id=quota_project_id,
            )

    if is_oauth_enabled():
        logger.error(
            "Authentication required: missing or invalid OAuth token. "
            "Refusing to fall back to Application Default Credentials (ADC)."
        )
        raise PermissionError(
            "Authentication required: missing or invalid OAuth token. "
            "Fallback to Application Default Credentials (ADC) is disabled."
        )

    global _cached_adc_creds
    if not _cached_adc_creds:
        with _adc_lock:
            if not _cached_adc_creds:
                logger.info(
                    "Loading Application Default Credentials (ADC)..."
                )
                try:
                    _cached_adc_creds, _ = google.auth.default(
                        quota_project_id=quota_project_id
                    )
                except Exception as e:
                    logger.error(
                        f"Failed to load Application Default Credentials: {e}"
                    )
                    _cached_adc_creds = None

    return _cached_adc_creds


def resolve_default_project() -> str | None:
    """
    Returns the Google Cloud project to use when none is passed explicitly.

    Uses GOOGLE_CLOUD_PROJECT (from the environment or .env) if set, otherwise
    the project associated with Application Default Credentials, e.g. the
    gcloud default project locally or the service's project on Cloud Run.
    Returns None when no project can be determined.
    """
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    if project:
        return project
    try:
        _, project = google.auth.default()
    except Exception as e:
        logger.debug(f"Could not determine a project from ADC: {e}")
        return None
    return project or None

