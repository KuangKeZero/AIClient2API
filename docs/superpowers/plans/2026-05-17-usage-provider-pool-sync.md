# Usage Provider Pool Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Usage page button that synchronizes provider-pool accounts into the usage display/cache without querying real external usage, and make pending-restore accounts collapsed by default.

**Architecture:** Reuse the existing provider-pool-to-usage placeholder sync pipeline in `src/ui-modules/usage-api.js`. Add a local-only `POST /api/usage/sync-provider-pool` endpoint that reads cached usage or creates an empty snapshot, merges provider pool entries, writes cache, and returns sync stats plus the rendered usage payload. Add a frontend button in the Usage controls that calls the endpoint, re-renders existing usage UI, and reports the returned stats.

**Tech Stack:** Node.js ESM, built-in HTTP routing, Jest, browser static HTML/CSS/JS, existing `showToast`, `getAuthHeaders`, usage cache helpers, and provider pool sync helpers.

---

## File Structure

- Modify `src/ui-modules/usage-api.js`: export sync-stat helpers and add `handleSyncProviderPoolUsage`; do not call `usageService.getFormattedUsage` in the new path.
- Modify `src/services/ui-manager.js`: route `POST /api/usage/sync-provider-pool` before parameterized `/api/usage/:providerType` routes.
- Modify `static/components/section-usage.html`: add `syncProviderPoolUsageBtn` beside `refreshUsageBtn`.
- Modify `static/app/usage-manager.js`: bind the new button, add `syncProviderPoolUsage`, and default `pendingRestoreState.collapsed` to `true`.
- Modify `static/components/section-usage.css`: keep controls tidy with two left-side buttons and responsive wrapping.
- Modify `tests/account-quota-ledger.test.js`: add unit coverage for sync stats and disabled-skip behavior using existing exported sync functions.

---

### Task 1: Backend Sync Statistics Helper

**Files:**
- Modify: `src/ui-modules/usage-api.js`
- Test: `tests/account-quota-ledger.test.js`

- [ ] **Step 1: Add a failing test for sync stats and disabled skip accounting**

Append this test inside the existing `describe('Usage API provider-pool synchronization', () => { ... })` block in `tests/account-quota-ledger.test.js`:

```js
    test('reports provider-pool sync stats without counting disabled accounts as added', () => {
        const cachedUsage = {
            timestamp: '2030-01-01T00:00:00.000Z',
            providers: {
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    instances: [
                        {
                            uuid: 'cached-1',
                            name: 'cached-1',
                            isHealthy: true,
                            isDisabled: false,
                            success: true,
                            usage: {
                                summary: {
                                    usedPercent: 20,
                                    status: 'normal',
                                    plan: 'FREE',
                                    planClass: 'plan-free',
                                    unit: 'percent'
                                },
                                items: []
                            },
                            error: null
                        }
                    ]
                }
            }
        };

        const currentConfig = {
            providerPools: {
                'openai-codex-oauth': [
                    { uuid: 'cached-1', isDisabled: false, CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/cached.json' },
                    { uuid: 'new-1', isDisabled: false, CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/new.json' },
                    { uuid: 'disabled-1', isDisabled: true, CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/disabled.json' }
                ]
            }
        };

        const synced = syncUsageResultsWithProviderPools(cachedUsage, currentConfig, null);
        const stats = buildProviderPoolUsageSyncStats(cachedUsage, synced, currentConfig, null);

        expect(stats).toEqual({
            poolTotalCount: 3,
            activePoolCount: 2,
            disabledSkippedCount: 1,
            existingCount: 1,
            addedCount: 1,
            syncedCount: 2
        });
        expect(synced.providers['openai-codex-oauth'].instances.map(instance => instance.uuid)).toEqual([
            'cached-1',
            'new-1',
            'disabled-1'
        ]);
    });
```

Also update the import list from `../src/ui-modules/usage-api.js` at the top of the same test file so it includes `buildProviderPoolUsageSyncStats`:

```js
import {
    applyAccountQuotaLedgerToInstance,
    applyAccountQuotaLedgerToProviderUsage,
    buildProviderPoolUsageSyncStats,
    syncProviderUsageWithProviderPool,
    syncUsageResultsWithProviderPools
} from '../src/ui-modules/usage-api.js';
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: FAIL with an export/import error for `buildProviderPoolUsageSyncStats`.

- [ ] **Step 3: Export provider-pool counting helpers**

In `src/ui-modules/usage-api.js`, add these helper functions after `syncUsageResultsWithProviderPools` and before `getAllProvidersUsage`:

```js
function collectActiveUsageKeys(usageResults = {}) {
    const keys = new Set();
    const providers = usageResults.providers || {};

    for (const [providerType, providerUsage] of Object.entries(providers)) {
        const instances = Array.isArray(providerUsage?.instances) ? providerUsage.instances : [];
        for (const instance of instances) {
            if (!instance?.uuid || instance.isDisabled) continue;
            keys.add(`${providerType}:${instance.uuid}`);
        }
    }

    return keys;
}

function collectProviderPoolKeys(currentConfig, providerPoolManager) {
    const stats = {
        allKeys: new Set(),
        activeKeys: new Set(),
        disabledKeys: new Set()
    };

    for (const providerType of supportedProviders) {
        for (const provider of loadProviderList(providerType, currentConfig, providerPoolManager)) {
            if (!provider?.uuid) continue;
            const key = `${providerType}:${provider.uuid}`;
            stats.allKeys.add(key);
            if (provider.isDisabled) {
                stats.disabledKeys.add(key);
            } else {
                stats.activeKeys.add(key);
            }
        }
    }

    return stats;
}

export function buildProviderPoolUsageSyncStats(beforeUsage, afterUsage, currentConfig, providerPoolManager) {
    const poolKeys = collectProviderPoolKeys(currentConfig, providerPoolManager);
    const beforeKeys = collectActiveUsageKeys(beforeUsage);
    const afterKeys = collectActiveUsageKeys(afterUsage);

    let existingCount = 0;
    let addedCount = 0;
    let syncedCount = 0;

    for (const key of poolKeys.activeKeys) {
        if (beforeKeys.has(key)) existingCount++;
        if (afterKeys.has(key)) syncedCount++;
        if (!beforeKeys.has(key) && afterKeys.has(key)) addedCount++;
    }

    return {
        poolTotalCount: poolKeys.allKeys.size,
        activePoolCount: poolKeys.activeKeys.size,
        disabledSkippedCount: poolKeys.disabledKeys.size,
        existingCount,
        addedCount,
        syncedCount
    };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: PASS for `reports provider-pool sync stats without counting disabled accounts as added` and no regressions in the file.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add src/ui-modules/usage-api.js tests/account-quota-ledger.test.js
git commit -m "test: cover usage provider pool sync stats"
```

---

### Task 2: Backend Sync Endpoint

**Files:**
- Modify: `src/ui-modules/usage-api.js`
- Modify: `src/services/ui-manager.js`
- Test: `tests/account-quota-ledger.test.js`

- [ ] **Step 1: Add a direct handler test with mocked response objects**

Update the import list from `../src/ui-modules/usage-api.js` in `tests/account-quota-ledger.test.js` so it includes `handleSyncProviderPoolUsage`:

```js
import {
    applyAccountQuotaLedgerToInstance,
    applyAccountQuotaLedgerToProviderUsage,
    buildProviderPoolUsageSyncStats,
    handleSyncProviderPoolUsage,
    syncProviderUsageWithProviderPool,
    syncUsageResultsWithProviderPools
} from '../src/ui-modules/usage-api.js';
```

Append this test inside `describe('Usage API provider-pool synchronization', () => { ... })`:

```js
    test('sync endpoint returns local placeholder data and does not query real usage', async () => {
        const req = {
            method: 'POST',
            url: '/api/usage/sync-provider-pool',
            headers: { host: 'localhost:3000' }
        };
        const chunks = [];
        const res = {
            statusCode: null,
            headers: null,
            writeHead(statusCode, headers) {
                this.statusCode = statusCode;
                this.headers = headers;
            },
            end(chunk) {
                if (chunk) chunks.push(chunk);
            }
        };
        const currentConfig = {
            providerPools: {
                'openai-codex-oauth': [
                    { uuid: 'pool-only-1', isDisabled: false, plan: 'PLUS', CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/pool-only.json' }
                ]
            }
        };

        const handled = await handleSyncProviderPoolUsage(req, res, currentConfig, null);
        const body = JSON.parse(chunks.join(''));

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(body.syncStats).toMatchObject({
            poolTotalCount: 1,
            activePoolCount: 1,
            disabledSkippedCount: 0,
            existingCount: 0,
            addedCount: 1,
            syncedCount: 1
        });
        expect(body.providers['openai-codex-oauth'].instances[0]).toMatchObject({
            uuid: 'pool-only-1',
            success: true,
            localUsagePlaceholder: true,
            usage: {
                summary: {
                    plan: 'PLUS',
                    source: 'provider_pool_placeholder'
                }
            }
        });
    });
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: FAIL with an export/import error for `handleSyncProviderPoolUsage`.

- [ ] **Step 3: Implement `handleSyncProviderPoolUsage`**

In `src/ui-modules/usage-api.js`, add this exported function after `handleGetUsage` and before `handleGetSingleInstanceUsage`:

```js
/**
 * 将 provider pool 中的账号同步到用量查询缓存和展示数据。
 * 该接口只做本地合并，不查询真实外部用量。
 */
export async function handleSyncProviderPoolUsage(req, res, currentConfig, providerPoolManager) {
    try {
        const cachedData = await readUsageCache();
        const baseUsage = cachedData
            ? { ...cachedData, fromCache: true }
            : {
                timestamp: new Date().toISOString(),
                providers: {},
                fromLocalProviderPool: true
            };

        if (cachedData) {
            reformatUsageResults(baseUsage);
        }

        const syncedUsage = syncUsageResultsWithProviderPools(baseUsage, currentConfig, providerPoolManager);
        applyAccountQuotaLedgerToUsageResults(syncedUsage, currentConfig, providerPoolManager);
        const syncStats = buildProviderPoolUsageSyncStats(baseUsage, syncedUsage, currentConfig, providerPoolManager);

        syncedUsage.syncedAt = new Date().toISOString();
        syncedUsage.syncStats = syncStats;
        await writeUsageCache(syncedUsage);

        const finalResults = {
            ...syncedUsage,
            serverTime: new Date().toISOString()
        };

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to sync provider pool usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to sync provider pool usage: ' + error.message
            }
        }));
        return true;
    }
}
```

- [ ] **Step 4: Register the route before parameterized usage routes**

In `src/services/ui-manager.js`, add this block immediately after the existing `/api/usage/supported-providers` route and before `const usageProviderMatch = pathParam.match(/^\/api\/usage\/([^\/]+)$/);`:

```js
    // Sync provider-pool accounts into usage display cache without querying real usage
    if (method === 'POST' && pathParam === '/api/usage/sync-provider-pool') {
        return await usageApi.handleSyncProviderPoolUsage(req, res, currentConfig, providerPoolManager);
    }
```

- [ ] **Step 5: Run the focused backend tests**

Run:

```bash
npm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src/ui-modules/usage-api.js src/services/ui-manager.js tests/account-quota-ledger.test.js
git commit -m "feat: add usage provider pool sync endpoint"
```

---

### Task 3: Usage Page Button And Default Pending Collapse

**Files:**
- Modify: `static/components/section-usage.html`
- Modify: `static/app/usage-manager.js`
- Modify: `static/components/section-usage.css`

- [ ] **Step 1: Add the sync button beside refresh**

In `static/components/section-usage.html`, replace the opening part of `.usage-controls`:

```html
        <div class="usage-controls">
            <button class="btn btn-primary" id="refreshUsageBtn" aria-label="Refresh Usage" data-i18n-aria-label="usage.refresh">
                <i class="fas fa-sync-alt"></i> <span data-i18n="usage.refresh">刷新用量</span>
            </button>
            <span class="usage-last-update" id="usageLastUpdate" data-i18n="usage.lastUpdate" data-i18n-params='{"time":"--"}'>上次更新: --</span>
```

with:

```html
        <div class="usage-controls">
            <div class="usage-control-actions">
                <button class="btn btn-primary" id="refreshUsageBtn" aria-label="Refresh Usage" data-i18n-aria-label="usage.refresh">
                    <i class="fas fa-sync-alt"></i> <span data-i18n="usage.refresh">刷新用量</span>
                </button>
                <button class="btn btn-secondary" id="syncProviderPoolUsageBtn" aria-label="Sync Provider Pool">
                    <i class="fas fa-link"></i> <span>同步账号池</span>
                </button>
            </div>
            <span class="usage-last-update" id="usageLastUpdate" data-i18n="usage.lastUpdate" data-i18n-params='{"time":"--"}'>上次更新: --</span>
```

- [ ] **Step 2: Bind the button and collapse pending restore by default**

In `static/app/usage-manager.js`, change `pendingRestoreState.collapsed` from `false` to `true`:

```js
const pendingRestoreState = {
    page: 1,
    pageSize: 20,
    collapsed: true
};
```

Then update `initUsageManager()` to bind the new button:

```js
export function initUsageManager() {
    const refreshBtn = document.getElementById('refreshUsageBtn');
    bindOnce(refreshBtn, 'click', refreshUsage, 'refreshUsage');

    const syncBtn = document.getElementById('syncProviderPoolUsageBtn');
    bindOnce(syncBtn, 'click', syncProviderPoolUsage, 'syncProviderPoolUsage');
}
```

- [ ] **Step 3: Add the frontend sync action**

In `static/app/usage-manager.js`, add this function after `refreshUsage()` and before `refreshSingleInstanceUsage()`:

```js
/**
 * 同步账号池到用量查询展示，不触发真实用量查询。
 */
export async function syncProviderPoolUsage() {
    const syncBtn = document.getElementById('syncProviderPoolUsageBtn');
    if (syncBtn) syncBtn.disabled = true;

    try {
        showToast('正在同步账号池...', 'info');

        const response = await fetch('/api/usage/sync-provider-pool', {
            method: 'POST',
            headers: getAuthHeaders()
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        renderUsageData(data, document.getElementById('usageContent'));
        updateTimeInfo(data);

        const stats = data.syncStats || {};
        const added = Number(stats.addedCount || 0);
        const existing = Number(stats.existingCount || 0);
        const skipped = Number(stats.disabledSkippedCount || 0);
        showToast(`同步完成：新增 ${added} 个，已存在 ${existing} 个，跳过禁用 ${skipped} 个`, 'success');
    } catch (error) {
        console.error('同步账号池失败:', error);
        showToast(error.message || t('common.requestFailed'), 'error');
    } finally {
        if (syncBtn) syncBtn.disabled = false;
    }
}
```

- [ ] **Step 4: Keep usage controls aligned and responsive**

In `static/components/section-usage.css`, replace the existing `.usage-controls` rule:

```css
.usage-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
}
```

with:

```css
.usage-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
}

.usage-control-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
}
```

- [ ] **Step 5: Run a static syntax/import smoke check**

Run:

```bash
node --check src/ui-modules/usage-api.js && node --check src/services/ui-manager.js
```

Expected: no output and exit code 0.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add static/components/section-usage.html static/app/usage-manager.js static/components/section-usage.css
git commit -m "feat: add usage provider pool sync button"
```

---

### Task 4: Verification

**Files:**
- Verify only; no planned edits.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
npm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run syntax checks for changed JS modules**

Run:

```bash
node --check src/ui-modules/usage-api.js
node --check src/services/ui-manager.js
node --check static/app/usage-manager.js
```

Expected: each command exits 0 with no syntax errors.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --stat HEAD~3..HEAD
git diff HEAD~3..HEAD -- src/ui-modules/usage-api.js src/services/ui-manager.js static/components/section-usage.html static/app/usage-manager.js static/components/section-usage.css tests/account-quota-ledger.test.js
```

Expected: diff shows only the sync endpoint, tests, button, pending default collapse, and responsive controls.

- [ ] **Step 4: Commit verification fixes only if needed**

If Step 1 or Step 2 finds a failure, fix the smallest affected code block, rerun the failing command, then commit:

```bash
git add <fixed-files>
git commit -m "fix: stabilize usage provider pool sync"
```

If all verification passes with no edits, do not create an empty commit.

---

## Self-Review

- Spec coverage: Task 2 implements local-only sync endpoint and cache write; Task 3 implements button and pending restore default collapse; Task 1 covers stats; Task 4 covers verification.
- Placeholder scan: no TBD/TODO/fill-later items remain. The word “placeholder” refers to the existing usage-display placeholder feature.
- Type consistency: sync stats use `poolTotalCount`, `activePoolCount`, `disabledSkippedCount`, `existingCount`, `addedCount`, and `syncedCount` consistently in tests, endpoint, and frontend toast.
