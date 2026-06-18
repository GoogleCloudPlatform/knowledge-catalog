# SharePoint integration — setup walkthrough

End-to-end setup for the enrichment agent's SharePoint source: register
an Entra (Azure AD) application, grant the right Microsoft Graph
permissions, run the one-time setup script, and ingest SharePoint files
into your Knowledge Catalog entries.

The agent reads SharePoint files via the Microsoft Graph API.

Total time the first time you do this: ~20–30 minutes (most of it the
Entra app registration). Subsequent runs are zero-touch — the agent
silently refreshes access tokens from a local cache.

---

## Prerequisites

- A Microsoft 365 tenant with SharePoint Online and admin rights on
  the tenant. If you don't have one, a 30-day free
  [Microsoft 365 Business Basic trial](https://www.microsoft.com/microsoft-365/business/microsoft-365-business-basic)
  works and includes everything you need.
- Python 3.11+ with the enrichment agent's deps installed (see the
  top-level [README](../../../README.md) Setup section).
- A site in SharePoint with content you want enriched. Any team site
  with a Documents library works. The Communication site that ships
  with a fresh tenant works too.

---

## Part 1 — Register an Entra application

The agent uses **delegated OAuth**, so we register an Entra app the
user will sign in to.

1. Open [entra.microsoft.com](https://entra.microsoft.com) as a tenant
   administrator.
2. Left rail → **Identity** → **Applications** → **App registrations**
   → **+ New registration**.
3. Fill in:
   - **Name**: something like `kc-enrichment-agent` (any human-readable
     name).
   - **Supported account types**: *Accounts in this organizational
     directory only (Single tenant)*. Multi-tenant works too but
     single-tenant is the simplest demo path.
   - **Redirect URI**: pick **Public client/native (mobile & desktop)**
     and enter `http://localhost`.
4. **Register**.

### Capture the IDs

From the app's Overview page, copy these two GUIDs:

- **Application (client) ID** → this becomes `MICROSOFT_CLIENT_ID`.
- **Directory (tenant) ID** → this becomes `MICROSOFT_TENANT_ID`.

### Enable public-client flows

The agent's setup script uses MSAL's public-client device-code flow,
which requires this toggle:

1. Left rail of your app → **Authentication**.
2. Under **Advanced settings**, set **Allow public client flows** to
   **Yes**.
3. **Save**.

Without this, you'll get `AADSTS7000218: The request body must contain
... client_secret` when the setup script tries to sign in.

---

## Part 2 — Grant Microsoft Graph permissions

The agent needs four delegated scopes:

| Scope | Why |
|---|---|
| `Sites.Read.All` | Read all SharePoint site collections |
| `Files.Read.All` | Read all files in SharePoint and OneDrive |
| `User.Read` | Read the signed-in user's profile |
| `offline_access` | Issue a refresh token so the agent can silently mint new access tokens |

1. App registration → **API permissions** → **+ Add a permission**.
2. **Microsoft Graph** → **Delegated permissions**.
3. Tick all four of the scopes above.
4. **Add permissions**.

### Grant admin consent

The scopes need a tenant admin to consent on behalf of all users:

1. Back on the **API permissions** page, click **Grant admin consent
   for `<your tenant>`** at the top.
2. Confirm. Each scope's status flips to ✅ *Granted for `<tenant>`*.

This is the most common silent-failure step — if you skip it, the
OAuth flow succeeds but every Graph call returns
`http_403: Insufficient privileges`.

---

## Part 3 — Run the setup script

The repo ships an interactive walkthrough that detects what's
configured, prompts for what's missing, runs OAuth, and validates the
result.

From the repo root:

```bash
python3 toolbox/enrichment/scripts/setup_sharepoint.py
```

What it does, in order:

1. Prints current state (env vars, MSAL cache, env file). On first run
   everything should show ✗.
2. Prompts for `MICROSOFT_CLIENT_ID` and `MICROSOFT_TENANT_ID` (the two
   GUIDs from Part 1).
3. Persists them to `~/.config/kc_agent/microsoft.env`. The agent
   auto-sources this file on startup — no shell rc edits required.
4. Asks whether to use **device-code** (works over SSH / headless;
   default) or **browser** (faster when you're at a desktop).
5. Prints a short user code + URL. Open the URL on any device, paste
   the code, sign in with the tenant admin account, consent to the
   four Graph scopes.
6. Persists the resulting token cache (containing the refresh token)
   to `~/.cache/kc_agent/microsoft_token_cache.json` (chmod 600).
7. Validates by hitting `/me` and `/sites/root` on Graph. Both should
   come back ✅.

After this succeeds:

- The MSAL cache holds a refresh token good for ~90 days.
- The agent silently mints fresh access tokens from it on every Graph
  call — no manual re-mint, no 1-hour cliff.
- Re-running the setup script or the mint helper isn't needed until
  the refresh token actually expires or is revoked.

### Other setup-script modes

```bash
# Read-only state check — no prompts, no OAuth.
python3 toolbox/enrichment/scripts/setup_sharepoint.py --doctor

# Force a fresh device-code sign-in even if the cache is still valid
# (e.g. after rotating an Entra secret or changing accounts).
python3 toolbox/enrichment/scripts/setup_sharepoint.py --re-auth
```

---

## Part 4 — Run the agent against your SharePoint site

Two flag shapes for pointing the agent at SharePoint content:

```bash
# (a) Pass full SharePoint URLs in --folders (or --docs). Any URL on a
#     site that starts with /sites/<NAME>/... gets recognized and the
#     agent walks that site's default library.
python3 toolbox/enrichment/src/agent_runner.py \
  --mode=doc \
  --topic="Order pipeline metadata" \
  --folders="https://<tenant>.sharepoint.com/sites/<NAME>/SitePages/Home.aspx" \
  --entry_group=<project>.<location>.<entryGroupId> \
  --project=<gcp_project> --model=<vertex_model> --output_dir=<local_out>

# (b) Or pass them explicitly via the typed --sharepoint_* flags.
python3 toolbox/enrichment/src/agent_runner.py \
  --mode=doc \
  --topic="Order pipeline metadata" \
  --sharepoint_sites="https://<tenant>.sharepoint.com/sites/<NAME>" \
  --sharepoint_search="orders pipeline runbook" \
  --entry_group=<project>.<location>.<entryGroupId> \
  --project=<gcp_project> --model=<vertex_model> --output_dir=<local_out>
```

If you run the agent **without** completing setup, it prints a friendly
pointer back to `setup_sharepoint.py` and (when on a tty) offers to
launch the walkthrough inline.

---

## File-type coverage

Files are extracted based on type:

| File type | Extractor | Notes |
|---|---|---|
| `.md`, `.txt`, `.json`, `.xml`, `.yaml` | UTF-8 decode | Read in full |
| `.docx` | `python-docx` | Paragraph text |
| `.xlsx` | `openpyxl` (read-only) | Per-sheet CSV-shaped dump of populated cells |
| `.pptx` | `python-pptx` | Per-slide text from shapes + notes |
| `.pdf` | `pypdf` | Per-page text extraction |
| Other binaries (images, archives, legacy `.doc`/`.xls`/`.ppt`) | None | The file is still cited in the catalog entry via its `web_url`, but the content isn't text-extracted |

Files are capped at 5 MB to keep the LLM context bounded; larger files
are reported with their `web_url` so they're still cited.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `AADSTS7000218: The request body must contain ... client_secret` | "Allow public client flows" not enabled on the Entra app | Re-do Part 1's "Enable public-client flows" step |
| `AADSTS50011: The redirect URI specified in the request does not match` | Entra app's redirect URI list doesn't include `http://localhost` | Edit Authentication → Web/Public client → add `http://localhost` |
| `http_403: Insufficient privileges` from the SharePoint integration | Admin consent missing on the API permissions page | Re-do Part 2's "Grant admin consent" step |
| Agent prints `⚠️ No Microsoft credentials available — skipping SharePoint source` despite running setup | `~/.config/kc_agent/microsoft.env` couldn't be written (permissions) | Setup script will have shown a warning; check the file path is writable |
| `http_401 / token_expired` from the SharePoint integration | Refresh token has been revoked or aged past ~90 days | Re-run `setup_sharepoint.py --re-auth` |
| `http_500 SearchPlatformResolutionFailed` from `/search/query` | Tenant's search backend hasn't finished provisioning (can take up to 24h after first SharePoint sign-in) | Use `--sharepoint_sites=<URL>` instead of `--sharepoint_search=<query>` until search comes online |
| Cards exist but content looks like a placeholder ("Binary content not extracted") | File type doesn't have a local extractor (legacy Office or unsupported binary) | The card still cites the file's `web_url`; for legacy Office, save the file as `.docx`/`.xlsx`/`.pptx` |

`setup_sharepoint.py --doctor` is the fastest way to inspect current
state without running OAuth — useful when something fails and you want
to know which piece is missing.
