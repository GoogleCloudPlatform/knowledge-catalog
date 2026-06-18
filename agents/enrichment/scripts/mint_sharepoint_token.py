"""Mint a Microsoft Graph access token for the enrichment agent's SharePoint source.

Two ways the agent gets a Graph bearer token, in order of preference:

  1. **MSAL token cache at `~/.cache/kc_agent/microsoft_token_cache.json`**
     — written by this script and refreshed silently by the agent's
     httpx event hook on every Graph call. With `offline_access` in the
     requested scopes (which it is), MSAL issues a refresh token that's
     good for ~90 days; the agent can silently mint fresh access tokens
     from it without any interactive consent. **This is the recommended
     path** — set it up once and the agent stops complaining about
     expired tokens.
  2. **`MICROSOFT_ACCESS_TOKEN` env var** — a raw access token the agent
     uses as a Bearer header for ~1h, then 401s when it expires. Useful
     for CI / one-shot runs or when you don't want to write a cache to
     disk. Same contract as `GITHUB_PERSONAL_ACCESS_TOKEN` /
     `ATLASSIAN_API_TOKEN`.

This script runs the OAuth flow using MSAL (Microsoft Authentication
Library) in **device-code** mode: it prints a short code + a verification
URL to stderr, and you open that URL in a browser on ANY device (your
laptop, your phone), enter the code, sign in, and consent. The script
polls Microsoft until you complete the sign-in, then prints the access
token to stdout AND writes the cache to disk so the agent can silently
refresh thereafter.

Device-code is the default because it works in every environment (SSH
session, headless container, CI runner) — no local browser, no
http://localhost listener, no redirect URI involved at all. Pass
`--browser` to instead use the local-browser interactive flow (faster
when you ARE on a desktop machine).

Subsequent runs of this script are cheap: it tries `acquire_token_silent`
against the cache first, and only falls through to the interactive flow
if the cache is missing or its refresh token has been revoked / aged out.

Uses the public-client / PKCE flow, so no client secret is needed — just
the `client_id` (Application ID) and `tenant_id` (Directory ID) of the
Entra app you registered. See the "SharePoint Setup" tab of the project's
setup doc for the app-registration walkthrough.

Usage:
    export MICROSOFT_CLIENT_ID='<Application (client) ID from Entra>'
    export MICROSOFT_TENANT_ID='<Directory (tenant) ID from Entra>'
    pip install msal                    # one-time
    export MICROSOFT_ACCESS_TOKEN=$(python scripts/mint_sharepoint_token.py)

After the first successful run, the cache is populated and the agent
itself can refresh tokens silently — you only need to re-run this
script if the refresh token expires (~90 days) or is revoked.
"""

from __future__ import annotations

import argparse
import os
import stat
import sys


# These match the scopes the agent's sp_* tools actually need — same set the
# README documents and that you admin-consented on the Entra app's
# "API permissions" page.
_GRAPH_SCOPES = [
    "https://graph.microsoft.com/Sites.Read.All",
    "https://graph.microsoft.com/Files.Read.All",
    "https://graph.microsoft.com/User.Read",
]

# Where the MSAL token cache (containing the refresh token issued by
# `offline_access`) lives. Must match the path the agent's
# sharepoint_tools._MicrosoftAuthRefresher reads from — they are two
# halves of the same handshake.
_CACHE_PATH = os.path.expanduser("~/.cache/kc_agent/microsoft_token_cache.json")


def _stderr(msg: str) -> None:
  """Print to stderr (keeps stdout clean for $(...) substitution)."""
  print(msg, file=sys.stderr, flush=True)


def _load_cache():
  """Load the MSAL serializable token cache from disk, or return an empty
  one. Returns the cache object (the caller passes it to
  PublicClientApplication so subsequent acquires consult / mutate it)."""
  import msal  # noqa: PLC0415

  cache = msal.SerializableTokenCache()
  if os.path.exists(_CACHE_PATH):
    try:
      with open(_CACHE_PATH, "r", encoding="utf-8") as f:
        cache.deserialize(f.read())
    except (OSError, ValueError) as e:
      _stderr(
          f"WARNING: existing cache at {_CACHE_PATH} could not be loaded"
          f" ({type(e).__name__}: {e}); will treat as empty and re-mint."
      )
  return cache


def _save_cache(cache) -> None:
  """Write the cache back to disk if MSAL mutated it (refresh-token
  rotation, new account, etc.). chmod 600 so other users can't read the
  refresh token."""
  if not cache.has_state_changed:
    return
  os.makedirs(os.path.dirname(_CACHE_PATH), exist_ok=True)
  with open(_CACHE_PATH, "w", encoding="utf-8") as f:
    f.write(cache.serialize())
  try:
    os.chmod(_CACHE_PATH, stat.S_IRUSR | stat.S_IWUSR)
  except OSError:
    pass  # non-fatal — Windows / filesystems without POSIX perms


def main() -> int:
  parser = argparse.ArgumentParser(
      description=(
          "Mint a Microsoft Graph access token for the SharePoint source."
      )
  )
  parser.add_argument(
      "--client-id",
      default=os.environ.get("MICROSOFT_CLIENT_ID", "").strip(),
      help=(
          "Application (client) ID from your Entra app registration."
          " Defaults to $MICROSOFT_CLIENT_ID."
      ),
  )
  parser.add_argument(
      "--tenant-id",
      default=os.environ.get("MICROSOFT_TENANT_ID", "").strip(),
      help=(
          "Directory (tenant) ID from your Entra app registration."
          " Defaults to $MICROSOFT_TENANT_ID."
      ),
  )
  parser.add_argument(
      "--browser",
      action="store_true",
      help=(
          "Use the local-browser interactive flow (requires a desktop"
          " session with a working browser + http://localhost listener)."
          " Default is device-code flow, which works over SSH / headless."
      ),
  )
  args = parser.parse_args()

  if not args.client_id:
    _stderr(
        "ERROR: missing client_id. Set $MICROSOFT_CLIENT_ID or pass"
        " --client-id."
    )
    return 2
  if not args.tenant_id:
    _stderr(
        "ERROR: missing tenant_id. Set $MICROSOFT_TENANT_ID or pass"
        " --tenant-id."
    )
    return 2

  try:
    import msal  # noqa: PLC0415  (imported lazily — only needed by this script)
  except ImportError:
    _stderr("ERROR: msal not installed. Run: pip install msal")
    return 2

  authority = f"https://login.microsoftonline.com/{args.tenant_id}"
  cache = _load_cache()
  app = msal.PublicClientApplication(
      args.client_id, authority=authority, token_cache=cache
  )

  # Step 1: try silent acquire first. If the cache holds a valid refresh
  # token, this returns a fresh access token without any browser
  # interaction — the common case on every run after the first.
  result = None
  accounts = app.get_accounts()
  if accounts:
    silent = app.acquire_token_silent(_GRAPH_SCOPES, account=accounts[0])
    if silent and "access_token" in silent:
      _stderr(
          f"Reusing cached refresh token from {_CACHE_PATH}"
          f" (account: {accounts[0].get('username', '?')})."
          " No interactive sign-in needed."
      )
      result = silent

  # Step 2: if silent failed (first run, cache empty, or refresh token
  # expired/revoked), fall through to interactive sign-in.
  if result is None:
    if args.browser:
      _stderr(
          "Using local-browser interactive flow. A browser should open"
          " automatically; if not, visit the URL MSAL prints below."
      )
      # Transient listener on http://localhost:<port> + auth-code
      # exchange. Requires that the Entra app has http://localhost in
      # its allowed redirect URIs.
      result = app.acquire_token_interactive(scopes=_GRAPH_SCOPES)
    else:
      # Device-code flow: print a short user_code + verification URL,
      # poll Microsoft until the user signs in on any device. Works in
      # SSH / headless / container / CI — no local browser, no redirect.
      flow = app.initiate_device_flow(scopes=_GRAPH_SCOPES)
      if "user_code" not in flow:
        _stderr(
            "ERROR: device flow init failed:"
            f" {flow.get('error')} — {flow.get('error_description')}"
        )
        return 1
      # The `message` field is human-readable text from Microsoft, e.g.
      # "To sign in, use a web browser to open the page
      #  https://microsoft.com/devicelogin and enter the code ABC123XY ..."
      _stderr("")
      _stderr(flow["message"])
      _stderr("")
      _stderr(
          "Waiting for sign-in... (this script will hang here until you"
          " complete the consent in your browser; Ctrl+C to abort)"
      )
      result = app.acquire_token_by_device_flow(flow)  # blocks

  if "access_token" not in result:
    _stderr(
        "ERROR: token acquisition failed:"
        f" {result.get('error')} — {result.get('error_description')}"
    )
    return 1

  # Persist the cache (writes the refresh token on first run, rotates on
  # subsequent ones). The agent's sharepoint_tools._MicrosoftAuthRefresher
  # reads from this same path to do silent refreshes mid-agent-run.
  _save_cache(cache)

  # The token only — no newline-trailing prose — so $(...) captures the
  # raw JWT cleanly.
  sys.stdout.write(result["access_token"])
  sys.stdout.flush()
  _stderr(
      "\nToken minted. Access-token lifetime ~1 hour; refresh-token"
      f" lifetime ~90 days. Cache written to {_CACHE_PATH} — the agent"
      " will silently refresh from it during long runs."
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
