# Codex CPA Plus Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Python script that recursively imports explicit Codex CPA JSON directories into `openai-codex-oauth-plus`.

**Architecture:** The script owns scanning, validation, dedupe, credential copy, and import orchestration. It uses the local AIClient2API UI API for live imports so provider pool memory and `configs/provider_pools.json` stay synchronized, and only allows direct file writes through an explicit offline mode.

**Tech Stack:** Python 3 standard library, AIClient2API local UI API on `127.0.0.1:3001`, existing `configs/provider_pools.json` provider shape.

---

### Task 1: Create The Import Script

**Files:**
- Create: `/home/kuangke/shell/import-codex-cpa-plus-to-aiclient2api.py`

- [ ] **Step 1: Write the script skeleton and CLI**

Create `/home/kuangke/shell/import-codex-cpa-plus-to-aiclient2api.py` with:

```python
#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import sys
import time
import uuid
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_APP_DIR = "/home/kuangke/ProjectNode/AIClient2API"
DEFAULT_LOCAL_API_URL = "http://127.0.0.1:3001"
DEFAULT_POOL = "openai-codex-oauth-plus"
DEFAULT_CHECK_MODEL = "gpt-5.2-codex"
DEFAULT_CRED_SUBDIR = "codex-plus"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Import Codex CPA JSON credentials into AIClient2API openai-codex-oauth-plus."
    )
    parser.add_argument("source_dir", help="Required source directory. Recursively scans *.json files.")
    parser.add_argument("--app-dir", default=DEFAULT_APP_DIR, help="AIClient2API app directory.")
    parser.add_argument("--local-api-url", default=DEFAULT_LOCAL_API_URL, help="Local AIClient2API base URL.")
    parser.add_argument("--local-api-token", default=os.environ.get("AICLIENT2API_UI_TOKEN", ""), help="UI bearer token.")
    parser.add_argument("--local-api-password", default=os.environ.get("AICLIENT2API_UI_PASSWORD", ""), help="UI password for login if no valid token exists.")
    parser.add_argument("--pool", default=DEFAULT_POOL, help="Target provider pool.")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing files or mutating the API.")
    parser.add_argument("--file-mode", action="store_true", help="Offline direct provider_pools.json import. Only use when the service is stopped.")
    args = parser.parse_args()
    source = Path(args.source_dir)
    if not source.exists() or not source.is_dir():
        raise SystemExit(f"source_dir must be an existing directory: {args.source_dir}")
    return args
```

- [ ] **Step 2: Add JSON scanning and CPA detection**

Add these functions below `parse_args()`:

```python
def load_json_file(path):
    with open(path, "rb") as f:
        raw = f.read().replace(b"\x00", b"").strip()
    if not raw:
        raise ValueError("empty JSON file")
    text = raw.decode("utf-8-sig")
    return json.loads(text)


def is_codex_cpa(data):
    return isinstance(data, dict) and data.get("type") == "codex"


def safe_name(value):
    value = str(value or "").strip()
    value = re.sub(r"[^A-Za-z0-9_.@+-]+", "-", value)
    value = value.strip(".-")
    return value[:90] or "codex-cpa"


def scan_cpa_files(source_dir):
    scanned = 0
    invalid = []
    skipped = []
    credentials = []
    for path in sorted(Path(source_dir).rglob("*.json")):
        scanned += 1
        try:
            data = load_json_file(path)
        except Exception as exc:
            invalid.append({"path": str(path), "error": str(exc)})
            continue
        if not is_codex_cpa(data):
            skipped.append({"path": str(path), "reason": "type_not_codex"})
            continue
        credentials.append({"path": path, "data": data})
    return {
        "scanned": scanned,
        "invalid": invalid,
        "skipped": skipped,
        "credentials": credentials,
    }
```

- [ ] **Step 3: Add pool state, dedupe, and provider config helpers**

Add:

```python
def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def normalize_rel_path(path):
    return str(path or "").replace("\\", "/").lstrip("./")


def rel_for_config(path):
    normalized = normalize_rel_path(path)
    return f"./{normalized}"


def collect_pool_state(app_dir, pool_name):
    pools_path = Path(app_dir) / "configs" / "provider_pools.json"
    pools = read_json(pools_path)
    pool = pools.get(pool_name, []) if isinstance(pools, dict) else []
    if not isinstance(pool, list):
        pool = []
    state = {
        "pools": pools if isinstance(pools, dict) else {},
        "pool": pool,
        "refresh_tokens": set(),
        "account_ids": set(),
        "emails": set(),
        "paths": set(),
    }
    for provider in pool:
        if not isinstance(provider, dict):
            continue
        rel = provider.get("CODEX_OAUTH_CREDS_FILE_PATH")
        if rel:
            state["paths"].add(normalize_rel_path(rel))
            cred = read_json(Path(app_dir) / normalize_rel_path(rel))
            if cred.get("refresh_token"):
                state["refresh_tokens"].add(cred["refresh_token"])
            if cred.get("account_id"):
                state["account_ids"].add(cred["account_id"])
            if cred.get("email"):
                state["emails"].add(cred["email"])
    return state


def credential_duplicate_reason(data, state):
    if data.get("refresh_token") and data["refresh_token"] in state["refresh_tokens"]:
        return "refresh_token"
    if data.get("account_id") and data["account_id"] in state["account_ids"]:
        return "account_id"
    if data.get("email") and data["email"] in state["emails"]:
        return "email"
    return None


def build_provider_config(rel_path):
    return {
        "CODEX_OAUTH_CREDS_FILE_PATH": rel_for_config(rel_path),
        "uuid": str(uuid.uuid4()),
        "checkModelName": DEFAULT_CHECK_MODEL,
        "checkHealth": False,
        "isHealthy": True,
        "isDisabled": False,
        "lastUsed": None,
        "usageCount": 0,
        "errorCount": 0,
        "lastErrorTime": None,
        "lastHealthCheckTime": None,
        "lastHealthCheckModel": None,
        "lastErrorMessage": None,
    }
```

- [ ] **Step 4: Add local API helpers**

Add:

```python
def http_json(method, url, data=None, token="", timeout=15):
    headers = {"Accept": "application/json"}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text) if text else {}


def local_api_is_reachable(args):
    try:
        http_json("GET", f"{args.local_api_url.rstrip('/')}/api/health", timeout=3)
        return True
    except Exception:
        return False


def find_valid_local_token(args):
    base_url = args.local_api_url.rstrip("/")
    token = args.local_api_token.strip()
    if token:
        try:
            http_json("GET", f"{base_url}/api/providers", token=token, timeout=5)
            return token
        except Exception:
            pass
    token_store = Path(args.app_dir) / "configs" / "token-store.json"
    store = read_json(token_store)
    tokens = store.get("tokens", {}) if isinstance(store, dict) else {}
    now_ms = int(time.time() * 1000)
    for candidate, info in tokens.items():
        if not isinstance(info, dict) or info.get("expiryTime", 0) <= now_ms:
            continue
        try:
            http_json("GET", f"{base_url}/api/providers", token=candidate, timeout=5)
            return candidate
        except Exception:
            continue
    if args.local_api_password:
        result = http_json("POST", f"{base_url}/api/login", {"password": args.local_api_password}, timeout=10)
        token = result.get("token", "")
        if token:
            return token
    raise RuntimeError("no valid local UI token found; pass --local-api-token or --local-api-password")
```

- [ ] **Step 5: Add planning and import execution**

Add:

```python
def build_import_plan(args, scan_result, state):
    cred_dir = Path(args.app_dir) / "configs" / DEFAULT_CRED_SUBDIR
    planned = []
    duplicates = []
    seen_source = set()
    paths = set(state["paths"])
    for item in scan_result["credentials"]:
        data = item["data"]
        source_key = data.get("refresh_token") or data.get("account_id") or data.get("email") or str(item["path"])
        if source_key in seen_source:
            duplicates.append({"path": str(item["path"]), "reason": "duplicate_in_source"})
            continue
        seen_source.add(source_key)
        reason = credential_duplicate_reason(data, state)
        if reason:
            duplicates.append({"path": str(item["path"]), "email": data.get("email"), "reason": reason})
            continue
        file_key = safe_name(data.get("email") or data.get("account_id") or item["path"].stem)
        filename = f"codex-plus-{file_key}.json"
        rel_path = f"configs/{DEFAULT_CRED_SUBDIR}/{filename}"
        counter = 2
        while normalize_rel_path(rel_path) in paths or (cred_dir / filename).exists():
            filename = f"codex-plus-{file_key}-{counter}.json"
            rel_path = f"configs/{DEFAULT_CRED_SUBDIR}/{filename}"
            counter += 1
        paths.add(normalize_rel_path(rel_path))
        planned.append({"source": item["path"], "data": data, "relPath": rel_path, "providerConfig": build_provider_config(rel_path)})
    return planned, duplicates


def write_credential(target_path, data):
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with open(target_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.chmod(target_path, 0o600)


def run_api_import(args, planned):
    token = find_valid_local_token(args)
    base_url = args.local_api_url.rstrip("/")
    added = []
    failed = []
    for item in planned:
        try:
            write_credential(Path(args.app_dir) / item["relPath"], item["data"])
            result = http_json(
                "POST",
                f"{base_url}/api/providers",
                {"providerType": args.pool, "providerConfig": item["providerConfig"]},
                token=token,
                timeout=30,
            )
            if result.get("success"):
                added.append({"path": item["relPath"], "email": item["data"].get("email")})
            else:
                failed.append({"path": str(item["source"]), "error": result})
        except Exception as exc:
            failed.append({"path": str(item["source"]), "error": str(exc)})
    provider_result = http_json("GET", f"{base_url}/api/providers/{args.pool}", token=token, timeout=20)
    return added, failed, provider_result


def run_file_import(args, planned, state):
    pools_path = Path(args.app_dir) / "configs" / "provider_pools.json"
    backup = f"{pools_path}.bak-codex-cpa-plus-import-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    shutil.copy2(pools_path, backup)
    pool = state["pools"].setdefault(args.pool, [])
    for item in planned:
        write_credential(Path(args.app_dir) / item["relPath"], item["data"])
        pool.append(item["providerConfig"])
    with open(pools_path, "w", encoding="utf-8") as f:
        json.dump(state["pools"], f, ensure_ascii=False, indent=2)
        f.write("\n")
    return backup
```

- [ ] **Step 6: Add main output and safety branching**

Add:

```python
def main():
    args = parse_args()
    if args.pool != DEFAULT_POOL:
        raise SystemExit(f"this script is intended for {DEFAULT_POOL}; got {args.pool}")
    scan_result = scan_cpa_files(args.source_dir)
    state = collect_pool_state(args.app_dir, args.pool)
    planned, duplicates = build_import_plan(args, scan_result, state)
    summary = {
        "sourceDir": str(Path(args.source_dir).resolve()),
        "pool": args.pool,
        "dryRun": args.dry_run,
        "scannedJson": scan_result["scanned"],
        "codexCpaFound": len(scan_result["credentials"]),
        "invalidJson": len(scan_result["invalid"]),
        "skippedNonCodex": len(scan_result["skipped"]),
        "duplicates": len(duplicates),
        "plannedImports": len(planned),
        "poolTotalBefore": len(state["pool"]),
        "plannedExamples": [{"source": str(x["source"]), "target": x["relPath"], "email": x["data"].get("email")} for x in planned[:10]],
        "duplicateExamples": duplicates[:10],
        "invalidExamples": scan_result["invalid"][:5],
    }
    if args.dry_run:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return
    if not planned:
        summary["added"] = 0
        summary["poolTotalAfter"] = len(state["pool"])
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return
    reachable = local_api_is_reachable(args)
    if reachable:
        added, failed, provider_result = run_api_import(args, planned)
        summary.update({
            "method": "local-api",
            "added": len(added),
            "failed": len(failed),
            "poolTotalAfter": provider_result.get("totalCount"),
            "healthyCount": provider_result.get("healthyCount"),
            "failedExamples": failed[:10],
        })
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if failed:
            raise SystemExit(1)
        return
    if not args.file_mode:
        raise SystemExit("local service is not reachable; start port 3001 or rerun with --file-mode for offline direct file import")
    backup = run_file_import(args, planned, state)
    summary.update({
        "method": "file",
        "backup": backup,
        "added": len(planned),
        "poolTotalAfter": len(state["pool"]),
    })
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: Make script executable**

Run:

```bash
chmod +x /home/kuangke/shell/import-codex-cpa-plus-to-aiclient2api.py
```

Expected: exit code 0.

### Task 2: Verify And Import

**Files:**
- Verify: `/home/kuangke/shell/import-codex-cpa-plus-to-aiclient2api.py`
- Runtime data: `/home/kuangke/Downloads/2`
- Runtime data: `/home/kuangke/ProjectNode/AIClient2API/configs/provider_pools.json`

- [ ] **Step 1: Compile the script**

Run:

```bash
python3 -m py_compile /home/kuangke/shell/import-codex-cpa-plus-to-aiclient2api.py
```

Expected: exit code 0.

- [ ] **Step 2: Verify help requires a source directory**

Run:

```bash
python3 /home/kuangke/shell/import-codex-cpa-plus-to-aiclient2api.py --help
```

Expected: usage shows required `source_dir` positional argument and no default source directory.

- [ ] **Step 3: Dry-run against the user-provided directory**

Run:

```bash
python3 /home/kuangke/shell/import-codex-cpa-plus-to-aiclient2api.py /home/kuangke/Downloads/2 --dry-run
```

Expected: JSON output reports `codexCpaFound` greater than 0, `pool` as `openai-codex-oauth-plus`, and `plannedImports` equal to the number of new non-duplicate CPA files.

- [ ] **Step 4: Run the real import**

Run:

```bash
python3 /home/kuangke/shell/import-codex-cpa-plus-to-aiclient2api.py /home/kuangke/Downloads/2
```

Expected: JSON output reports `method: local-api`, `failed: 0`, and `poolTotalAfter` increased by the number of imported CPA files.

- [ ] **Step 5: Verify the service sees the plus pool**

Run a token-authenticated check using the same token discovery logic or inspect via the script output. If using curl manually, use a valid token from `configs/token-store.json`:

```bash
curl -s http://127.0.0.1:3001/api/providers/openai-codex-oauth-plus \
  -H "Authorization: Bearer <valid-token>" | jq '{totalCount, healthyCount}'
```

Expected: `totalCount` equals the script's `poolTotalAfter`.
