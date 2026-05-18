# Codex CPA Plus Batch Import Design

## Goal

Create a standalone import script for Codex CPA JSON files that imports accounts into the `openai-codex-oauth-plus` provider pool in the local AIClient2API service.

## Inputs

- The source directory is required at runtime. The script must not define or use a default source directory.
- The script recursively scans the provided directory for `*.json` files.
- A file is considered a Codex CPA credential only when its top-level JSON object has `"type": "codex"`.

## Target

- AIClient2API app directory defaults to `/home/kuangke/ProjectNode/AIClient2API`.
- Local API defaults to `http://127.0.0.1:3001`.
- Target provider pool is fixed by default to `openai-codex-oauth-plus`.
- New credential files are stored under `configs/codex-plus/`.

## Import Flow

1. Parse CLI arguments and require a source directory.
2. Recursively scan all JSON files under the source directory.
3. Parse valid JSON objects and select only objects with `type == "codex"`.
4. Read the current plus pool and linked credential files to detect duplicates by `refresh_token`, `account_id`, `email`, and credential path.
5. For each new credential, write a normalized credential file under `configs/codex-plus/` with `0600` permissions.
6. Add each new provider through the local API `POST /api/providers` with `providerType: openai-codex-oauth-plus`, so the running service updates both memory and `provider_pools.json`.
7. Query `GET /api/providers/openai-codex-oauth-plus` after import to report the final pool count.

## Safety Behavior

- `--dry-run` reports scan counts, CPA counts, duplicates, and planned imports without writing files or calling mutation APIs.
- If the local service is reachable but API authentication or import fails, the script stops and does not fall back to direct file edits.
- Optional explicit file mode can support offline imports, but it must be opt-in because direct file edits can be overwritten by a running service.
- Existing unrelated provider pools and credential files are left unchanged.

## Provider Config Shape

Each imported provider uses:

- `CODEX_OAUTH_CREDS_FILE_PATH`: relative path to the copied credential file.
- `uuid`: generated UUID.
- `checkModelName`: `gpt-5.2-codex`.
- `checkHealth`: `false`.
- `isHealthy`: `true`.
- `isDisabled`: `false`.
- usage and error counters initialized to the same shape as existing provider records.

## Verification

- Compile the script with `python3 -m py_compile`.
- Run `--dry-run` against a known CPA directory.
- Run a real import against the local service on port `3001`.
- Verify `GET /api/providers/openai-codex-oauth-plus` reports the expected `totalCount`.
