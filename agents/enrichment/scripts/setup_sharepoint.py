"""Interactive first-time setup walkthrough for the SharePoint source.

The CLI analog of KC App's chat-driven `sharepoint-connect` skill
(experimental/kc_agent/backend/kc_agent/adk_skills/sharepoint-connect/
SKILL.md). Detects what's missing, prompts for credentials interactively
with validation, kicks off the OAuth flow once to populate the MSAL
token cache, then confirms by hitting two harmless Graph endpoints
(`/me` and `/sites/root`) to prove the token works against the user's
tenant.

After this script succeeds:
  * The cache at ~/.cache/kc_agent/microsoft_token_cache.json holds a
    refresh token good for ~90 days.
  * The agent silently refreshes access tokens from the cache on every
    SharePoint call — no more 1-hour cliff.
  * Re-running the agent (or running `mint_sharepoint_token.py`) does
    NOT need interactive sign-in until the refresh token actually
    expires or is revoked.

Modes:
  * `python setup_sharepoint.py`               — interactive walkthrough
                                                  (prompts for missing
                                                  values, runs device
                                                  flow, validates).
  * `python setup_sharepoint.py --doctor`     — checks current state
                                                  without prompting or
                                                  running OAuth; prints
                                                  a status report.
  * `python setup_sharepoint.py --re-auth`    — force a re-mint even
                                                  if the cache is still
                                                  valid (e.g. after
                                                  rotating an Entra
                                                  secret).

Run from a tty. Non-interactive (CI) callers should use the env-var
path: export MICROSOFT_ACCESS_TOKEN with a pre-minted Graph bearer.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
from pathlib import Path
from typing import Optional


# Same scopes the agent + mint_sharepoint_token.py request — must stay
# in sync across all three.
_GRAPH_SCOPES = [
    "https://graph.microsoft.com/Sites.Read.All",
    "https://graph.microsoft.com/Files.Read.All",
    "https://graph.microsoft.com/User.Read",
]

# Same cache path the mint script writes and the agent reads.
_CACHE_PATH = os.path.expanduser("~/.cache/kc_agent/microsoft_token_cache.json")

# Env file written when the user opts to persist client/tenant ids.
_ENV_FILE = os.path.expanduser("~/.config/kc_agent/microsoft.env")

# GUID validation — Entra IDs are standard UUIDs.
_GUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


# ---------------------------------------------------------------------------
# Output helpers — interactive script goes to stdout (not stderr like the
# mint script, since there's no $(…) capture in play).
# ---------------------------------------------------------------------------


def _say(msg: str) -> None:
  print(msg, flush=True)


def _ok(msg: str) -> None:
  print(f"\033[32m✓\033[0m {msg}", flush=True)


def _warn(msg: str) -> None:
  print(f"\033[33m⚠\033[0m {msg}", flush=True)


def _err(msg: str) -> None:
  print(f"\033[31m✗\033[0m {msg}", flush=True)


def _hr() -> None:
  print("─" * 60, flush=True)


# ---------------------------------------------------------------------------
# State detection
# ---------------------------------------------------------------------------


def _detect_state() -> dict:
  """Inspect env + filesystem and return a dict describing what's set."""
  state = {
      "client_id": os.environ.get("MICROSOFT_CLIENT_ID", "").strip(),
      "tenant_id": os.environ.get("MICROSOFT_TENANT_ID", "").strip(),
      "access_token_env": bool(
          os.environ.get("MICROSOFT_ACCESS_TOKEN", "").strip()
      ),
      "cache_exists": os.path.exists(_CACHE_PATH),
      "cache_has_account": False,
      "cache_account_username": None,
      "env_file_exists": os.path.exists(_ENV_FILE),
  }
  if state["cache_exists"]:
    try:
      import msal  # noqa: PLC0415
      cache = msal.SerializableTokenCache()
      with open(_CACHE_PATH, "r", encoding="utf-8") as f:
        cache.deserialize(f.read())
      # We can inspect accounts without an authority by constructing a
      # throwaway app — but only if we know client_id+tenant_id. If we
      # don't, just report that the cache exists.
      if state["client_id"] and state["tenant_id"]:
        authority = f"https://login.microsoftonline.com/{state['tenant_id']}"
        app = msal.PublicClientApplication(
            state["client_id"], authority=authority, token_cache=cache
        )
        accounts = app.get_accounts()
        if accounts:
          state["cache_has_account"] = True
          state["cache_account_username"] = accounts[0].get("username")
    except Exception:  # pylint: disable=broad-except
      pass  # leave the cache-derived fields as defaults
  return state


def _print_state(state: dict) -> None:
  """Pretty-print the current setup state."""
  _say("\nCurrent setup state:")
  _hr()

  if state["client_id"]:
    _ok(f"MICROSOFT_CLIENT_ID set ({state['client_id'][:8]}...{state['client_id'][-4:]})")
  else:
    _err("MICROSOFT_CLIENT_ID not set")

  if state["tenant_id"]:
    _ok(f"MICROSOFT_TENANT_ID set ({state['tenant_id'][:8]}...{state['tenant_id'][-4:]})")
  else:
    _err("MICROSOFT_TENANT_ID not set")

  if state["env_file_exists"]:
    _ok(f"Env file present at {_ENV_FILE}")
  else:
    _warn(f"Env file not present at {_ENV_FILE} (you'll need to re-export the IDs each shell session)")

  if state["cache_exists"] and state["cache_has_account"]:
    _ok(
        f"MSAL cache valid at {_CACHE_PATH}"
        f" (signed in as {state['cache_account_username']})"
    )
  elif state["cache_exists"]:
    _warn(
        f"MSAL cache file exists at {_CACHE_PATH} but no usable account"
        " — re-running interactive sign-in will fix it"
    )
  else:
    _err(f"MSAL cache not found at {_CACHE_PATH}")

  if state["access_token_env"]:
    _ok("MICROSOFT_ACCESS_TOKEN env is set (one-shot fallback path)")

  _hr()


# ---------------------------------------------------------------------------
# Interactive prompts
# ---------------------------------------------------------------------------


def _prompt(label: str, default: Optional[str] = None, validator=None) -> str:
  """Prompt with optional default + optional validator. Keeps asking
  until validator returns True (or value is non-empty if no validator)."""
  while True:
    prompt = f"{label}"
    if default:
      prompt += f" [{default[:8]}...{default[-4:]}]"
    prompt += ": "
    val = input(prompt).strip()
    if not val and default:
      val = default
    if not val:
      _err("Required.")
      continue
    if validator:
      err = validator(val)
      if err:
        _err(err)
        continue
    return val


def _validate_guid(s: str) -> Optional[str]:
  if not _GUID_RE.match(s):
    return "Not a valid GUID — expected 8-4-4-4-12 hex digits, e.g. 12345678-1234-1234-1234-123456789abc."
  return None


def _save_env_file(client_id: str, tenant_id: str) -> None:
  """Persist the IDs so the user doesn't have to re-export every shell.
  Conservative: chmod 600, even though these are not secrets per se —
  someone shouldn't be able to swap your client_id without noticing."""
  os.makedirs(os.path.dirname(_ENV_FILE), exist_ok=True)
  with open(_ENV_FILE, "w", encoding="utf-8") as f:
    f.write("# Generated by setup_sharepoint.py — `source` this in your shell\n")
    f.write("# profile to make the SharePoint integration work without\n")
    f.write("# re-exporting the IDs every session.\n")
    f.write(f"export MICROSOFT_CLIENT_ID='{client_id}'\n")
    f.write(f"export MICROSOFT_TENANT_ID='{tenant_id}'\n")
  try:
    os.chmod(_ENV_FILE, stat.S_IRUSR | stat.S_IWUSR)
  except OSError:
    pass


# ---------------------------------------------------------------------------
# OAuth + cache
# ---------------------------------------------------------------------------


def _run_device_flow(client_id: str, tenant_id: str) -> bool:
  """Run the device-code flow and persist the cache. Returns True on
  success."""
  try:
    import msal  # noqa: PLC0415
  except ImportError:
    _err("msal not installed. Run: pip install msal")
    return False

  authority = f"https://login.microsoftonline.com/{tenant_id}"
  cache = msal.SerializableTokenCache()
  # Preserve any existing cache contents — if the user already has a
  # session for a different account in the same tenant, we want to keep
  # it.
  if os.path.exists(_CACHE_PATH):
    try:
      with open(_CACHE_PATH, "r", encoding="utf-8") as f:
        cache.deserialize(f.read())
    except (OSError, ValueError):
      pass
  app = msal.PublicClientApplication(
      client_id, authority=authority, token_cache=cache
  )

  flow = app.initiate_device_flow(scopes=_GRAPH_SCOPES)
  if "user_code" not in flow:
    _err(
        f"Device flow init failed: {flow.get('error')}"
        f" — {flow.get('error_description')}"
    )
    return False
  _say("")
  _say(flow["message"])
  _say("")
  _say("Waiting for sign-in...")
  result = app.acquire_token_by_device_flow(flow)
  if "access_token" not in result:
    _err(
        f"Token acquisition failed: {result.get('error')}"
        f" — {result.get('error_description')}"
    )
    return False

  # Persist the cache (refresh token now lives in it).
  if cache.has_state_changed:
    os.makedirs(os.path.dirname(_CACHE_PATH), exist_ok=True)
    with open(_CACHE_PATH, "w", encoding="utf-8") as f:
      f.write(cache.serialize())
    try:
      os.chmod(_CACHE_PATH, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
      pass
  _ok(f"Token cache written to {_CACHE_PATH}")
  return True


# ---------------------------------------------------------------------------
# Validation probes — confirm the token actually works against Graph
# ---------------------------------------------------------------------------


def _validate_token_against_graph(client_id: str, tenant_id: str) -> bool:
  """Acquire a silent token from the cache and hit /me + /sites/root.
  Returns True iff both calls succeed."""
  try:
    import msal  # noqa: PLC0415
    import urllib.request as _ur  # noqa: PLC0415
  except ImportError as e:
    _err(f"Validation skipped: {e}")
    return False

  cache = msal.SerializableTokenCache()
  with open(_CACHE_PATH, "r", encoding="utf-8") as f:
    cache.deserialize(f.read())
  authority = f"https://login.microsoftonline.com/{tenant_id}"
  app = msal.PublicClientApplication(
      client_id, authority=authority, token_cache=cache
  )
  accounts = app.get_accounts()
  if not accounts:
    _err("Cache has no account — re-run setup to sign in.")
    return False
  result = app.acquire_token_silent(_GRAPH_SCOPES, account=accounts[0])
  if not result or "access_token" not in result:
    _err("Silent token acquisition failed.")
    return False
  token = result["access_token"]

  def _probe(url: str, label: str) -> bool:
    try:
      req = _ur.Request(url, headers={"Authorization": f"Bearer {token}"})
      with _ur.urlopen(req, timeout=15) as resp:
        if resp.status == 200:
          _ok(f"{label} → 200 OK")
          return True
        _err(f"{label} → HTTP {resp.status}")
        return False
    except Exception as e:  # pylint: disable=broad-except
      _err(f"{label} → {type(e).__name__}: {e}")
      return False

  ok1 = _probe("https://graph.microsoft.com/v1.0/me", "/me probe")
  ok2 = _probe("https://graph.microsoft.com/v1.0/sites/root", "/sites/root probe")
  return ok1 and ok2


# ---------------------------------------------------------------------------
# Walkthrough
# ---------------------------------------------------------------------------


def _walkthrough() -> int:
  """The full interactive walkthrough."""
  state = _detect_state()
  _print_state(state)

  # Step 1: collect client_id + tenant_id if missing.
  if not state["client_id"] or not state["tenant_id"]:
    _say(
        "\nWe need your Entra app's Application (client) ID and Directory"
        " (tenant) ID. Get them from"
        " https://entra.microsoft.com → Identity → Applications → App"
        " registrations → <your app> → Overview."
    )
    _say(
        "If you haven't registered the app yet, see the 'SharePoint"
        " Setup' tab of the project doc — it's ~5 minutes."
    )
    client_id = _prompt(
        "Application (client) ID",
        default=state["client_id"] or None,
        validator=_validate_guid,
    )
    tenant_id = _prompt(
        "Directory (tenant) ID",
        default=state["tenant_id"] or None,
        validator=_validate_guid,
    )
  else:
    client_id = state["client_id"]
    tenant_id = state["tenant_id"]

  # Step 2: persist the IDs to an env file. The agent_runner.py
  # auto-sources this file on startup AND immediately after running
  # this setup script as a subprocess via the trigger gate, so the
  # gate-spawned flow works even without the user re-sourcing their
  # shell rc. Writing is unconditional now — if you don't want it,
  # `rm ~/.config/kc_agent/microsoft.env` after this script finishes.
  try:
    _save_env_file(client_id, tenant_id)
    _ok(
        f"Wrote {_ENV_FILE}"
        " (the agent auto-sources this on startup — no shell rc edits"
        " required)."
    )
  except OSError as e:
    _warn(
        f"Could not write {_ENV_FILE} ({type(e).__name__}: {e})."
        " You'll need to re-export MICROSOFT_CLIENT_ID and"
        " MICROSOFT_TENANT_ID in each shell session, or pass them via"
        " env on every agent run."
    )

  # Step 3: device-code flow.
  _say("\nStarting Microsoft sign-in. Choose 'device code' if SSH/remote,")
  _say("'browser' if you're at a desktop with a working browser.")
  mode = input("Use [d]evice-code or [b]rowser? [D/b]: ").strip().lower() or "d"
  if mode.startswith("b"):
    _err("Browser mode not implemented in setup_sharepoint.py yet — use")
    _err("scripts/mint_sharepoint_token.py --browser if you need it.")
    return 1
  if not _run_device_flow(client_id, tenant_id):
    return 1

  # Step 4: validate against Graph.
  _say("\nValidating the token against Microsoft Graph...")
  os.environ["MICROSOFT_CLIENT_ID"] = client_id
  os.environ["MICROSOFT_TENANT_ID"] = tenant_id
  if _validate_token_against_graph(client_id, tenant_id):
    _ok("Setup complete. The agent will silently refresh tokens from now on.")
    _say(
        "\nIDs persisted to {0} (the agent auto-sources this on every"
        " run — no shell rc edits required). Refresh-token cache at"
        " {1} is valid for ~90 days before another sign-in is needed.".format(
            _ENV_FILE, _CACHE_PATH
        )
    )
    return 0
  _err(
      "Validation failed. The token was minted but Graph rejected it."
      " Most likely cause: admin consent not granted for the four"
      " delegated scopes (Sites.Read.All, Files.Read.All, User.Read,"
      " offline_access) on your Entra app. Go to entra.microsoft.com →"
      " your app → API permissions → Grant admin consent."
  )
  return 1


def _doctor() -> int:
  """Read-only state check — no prompts, no OAuth, no writes."""
  state = _detect_state()
  _print_state(state)
  if state["cache_exists"] and state["cache_has_account"]:
    _say("\nSetup looks healthy. To force a re-mint: --re-auth.")
    return 0
  _say(
      "\nSetup is incomplete. Run without --doctor to walk through it"
      " interactively."
  )
  return 1


def _re_auth() -> int:
  """Force a fresh device-code dance even if the cache is valid."""
  client_id = os.environ.get("MICROSOFT_CLIENT_ID", "").strip()
  tenant_id = os.environ.get("MICROSOFT_TENANT_ID", "").strip()
  if not client_id or not tenant_id:
    _err(
        "MICROSOFT_CLIENT_ID and MICROSOFT_TENANT_ID must be set for"
        " --re-auth. Run setup_sharepoint.py without flags for the full"
        " walkthrough."
    )
    return 2
  if os.path.exists(_CACHE_PATH):
    try:
      Path(_CACHE_PATH).unlink()
      _ok(f"Removed old cache at {_CACHE_PATH}")
    except OSError as e:
      _warn(f"Could not remove old cache: {e}")
  if not _run_device_flow(client_id, tenant_id):
    return 1
  return 0 if _validate_token_against_graph(client_id, tenant_id) else 1


def main() -> int:
  parser = argparse.ArgumentParser(
      description=(
          "Interactive first-time setup for the SharePoint source."
          " Run without flags for the full walkthrough."
      )
  )
  parser.add_argument(
      "--doctor",
      action="store_true",
      help="Read-only state check — print what's set without prompting.",
  )
  parser.add_argument(
      "--re-auth",
      action="store_true",
      help="Force a fresh device-code dance even if the cache is valid.",
  )
  args = parser.parse_args()
  if args.doctor:
    return _doctor()
  if args.re_auth:
    return _re_auth()
  if not sys.stdin.isatty():
    _err(
        "setup_sharepoint.py needs an interactive terminal. For CI /"
        " non-interactive use, set MICROSOFT_ACCESS_TOKEN directly with"
        " a pre-minted Graph bearer."
    )
    return 2
  return _walkthrough()


if __name__ == "__main__":
  raise SystemExit(main())
