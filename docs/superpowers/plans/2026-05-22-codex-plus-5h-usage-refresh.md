# Codex Plus 5h Usage Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Codex Plus usage summary show the 5-hour request quota and refresh stale Codex Plus 5h usage cache after its reset time passes.

**Architecture:** Keep Codex usage formatting as the source of rate-limit window metadata, then let `usage-api.js` decide whether cached `openai-codex-oauth-plus` data is still fresh before returning it. The frontend reads the primary-window metadata only for Codex Plus so the expanded summary label, percent, status, and reset time describe `Request Quota (5h)` while weekly usage remains in the breakdown.

**Tech Stack:** Node.js ESM, Jest, static browser JavaScript, existing Usage API/cache helpers, existing Codex formatter.

---

## File Structure

- Modify `src/services/usage-service.js`: add Codex primary-window summary metadata alongside existing `Request Quota (5h)` items.
- Modify `src/ui-modules/usage-api.js`: detect expired Codex Plus primary-window cache data for full, provider, and single-instance reads.
- Modify `static/app/usage-manager.js`: render the expanded Codex Plus summary from the primary 5h item while preserving default total usage rendering elsewhere.
- Modify `tests/account-quota-ledger.test.js`: cover Codex summary metadata and automatic stale-cache refresh paths with existing Usage API mocks.

## Task 1: Expose Codex 5h Summary Metadata

**Files:**
- Modify: `tests/account-quota-ledger.test.js`
- Modify: `src/services/usage-service.js`

- [ ] **Step 1: Extend the existing Codex formatter test with the 5h metadata contract**

In `tests/account-quota-ledger.test.js`, update the `formats codex plus weekly usage from the secondary rate-limit window` summary expectation to:

```js
        expect(usage.summary).toMatchObject({
            usedPercent: 26,
            plan: 'PLUS',
            planClass: 'plan-plus',
            displayLabel: 'Request Quota (5h)',
            primaryItemId: 'primary_window'
        });
```

- [ ] **Step 2: Run the focused formatter test to verify it fails**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand -t "formats codex plus weekly usage"
```

Expected: FAIL because `usage.summary.displayLabel` and `usage.summary.primaryItemId` do not exist yet.

- [ ] **Step 3: Add the primary-window metadata to the Codex formatter**

In `src/services/usage-service.js`, add these constants immediately before `export function formatCodexUsage(usageData) {`:

```js
const CODEX_PRIMARY_WINDOW_ID = 'primary_window';
const CODEX_PRIMARY_WINDOW_LABEL = 'Request Quota (5h)';
```

In the primary-window item emitted by `formatCodexUsage()`, replace the literal `id` and `label` values with:

```js
            id: CODEX_PRIMARY_WINDOW_ID,
            label: CODEX_PRIMARY_WINDOW_LABEL,
```

Then extend the returned `summary` object with:

```js
            displayLabel: CODEX_PRIMARY_WINDOW_LABEL,
            primaryItemId: CODEX_PRIMARY_WINDOW_ID
```

The completed `summary` tail should read:

```js
            resetAt: formatTimestamp(worstResetAtTimestamp),
            plan,
            planClass: getPlanClass(plan),
            unit: 'percent',
            displayLabel: CODEX_PRIMARY_WINDOW_LABEL,
            primaryItemId: CODEX_PRIMARY_WINDOW_ID
```

- [ ] **Step 4: Re-run the focused formatter test**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand -t "formats codex plus weekly usage"
```

Expected: PASS.

- [ ] **Step 5: Commit the formatter contract**

```bash
git add tests/account-quota-ledger.test.js src/services/usage-service.js
git commit -m "feat: expose codex 5h usage summary metadata"
```

## Task 2: Refresh Expired Codex Plus Full Usage Cache

**Files:**
- Modify: `tests/account-quota-ledger.test.js`
- Modify: `src/ui-modules/usage-api.js`

- [ ] **Step 1: Add reusable Codex Plus cache fixtures for stale-cache tests**

Inside the existing `describe('Usage API Codex Plus quota rules', () => {` block in `tests/account-quota-ledger.test.js`, add these helpers after the `beforeEach` block:

```js
    function buildCodexPlusRawUsage(primaryPercent, primaryResetAt) {
        return {
            account: 'plus@example.com',
            plan_type: 'PLUS',
            rate_limit: {
                primary_window: {
                    used_percent: primaryPercent,
                    reset_at: primaryResetAt
                },
                secondary_window: {
                    used_percent: 4,
                    reset_at: '2030-01-08T00:00:00.000Z'
                }
            }
        };
    }

    function buildCachedCodexPlusUsage(providerType, uuid, rawUsage) {
        return {
            timestamp: '2026-05-22T00:00:00.000Z',
            providers: {
                [providerType]: {
                    providerType,
                    instances: [
                        {
                            uuid,
                            name: 'cached-plus',
                            isHealthy: true,
                            isDisabled: false,
                            success: true,
                            usage: formatCodexUsage(rawUsage),
                            error: null
                        }
                    ],
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0
                }
            }
        };
    }
```

- [ ] **Step 2: Add failing full-cache refresh coverage**

Add these tests in the same Codex Plus describe block after the existing quota-rule response tests:

```js
    test('refreshes full usage when cached codex plus 5h quota has reset', async () => {
        const providerType = 'openai-codex-oauth-plus';
        const uuid = 'plus-stale-full';
        const freshRawUsage = buildCodexPlusRawUsage(12, '2030-01-01T05:00:00.000Z');

        readUsageCache.mockResolvedValue(buildCachedCodexPlusUsage(
            providerType,
            uuid,
            buildCodexPlusRawUsage(91, '2020-01-01T05:00:00.000Z')
        ));
        writeUsageCache.mockResolvedValue(undefined);
        serviceInstances[`${providerType}${uuid}`] = {
            getUsageLimits: jest.fn().mockResolvedValue(freshRawUsage)
        };

        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
            providerPools: {
                [providerType]: [{ uuid, isDisabled: false }]
            }
        };
        const providerPoolManager = {
            providerPools: currentConfig.providerPools
        };
        const req = {
            method: 'GET',
            url: '/api/usage',
            headers: { host: 'localhost:3000' }
        };
        const res = createJsonResponseMock();

        const handled = await handleGetUsage(req, res, currentConfig, providerPoolManager);
        const body = JSON.parse(res.body);

        expect(handled).toBe(true);
        expect(serviceInstances[`${providerType}${uuid}`].getUsageLimits).toHaveBeenCalledTimes(1);
        expect(writeUsageCache).toHaveBeenCalledTimes(1);
        expect(body.fromCache).toBeUndefined();
        expect(body.providers[providerType].instances[0].usage.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'primary_window', percent: 12 })
        ]));
    });

    test('keeps full usage cache when codex plus 5h quota is still active', async () => {
        const providerType = 'openai-codex-oauth-plus';
        const uuid = 'plus-fresh-full';

        readUsageCache.mockResolvedValue(buildCachedCodexPlusUsage(
            providerType,
            uuid,
            buildCodexPlusRawUsage(26, '2030-01-01T05:00:00.000Z')
        ));
        writeUsageCache.mockResolvedValue(undefined);

        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
            providerPools: {
                [providerType]: [{ uuid, isDisabled: false }]
            }
        };
        const providerPoolManager = {
            providerPools: currentConfig.providerPools
        };
        const req = {
            method: 'GET',
            url: '/api/usage',
            headers: { host: 'localhost:3000' }
        };
        const res = createJsonResponseMock();

        const handled = await handleGetUsage(req, res, currentConfig, providerPoolManager);
        const body = JSON.parse(res.body);

        expect(handled).toBe(true);
        expect(body.fromCache).toBe(true);
        expect(writeUsageCache).not.toHaveBeenCalled();
        expect(body.providers[providerType].instances[0].usage.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'primary_window', percent: 26 })
        ]));
    });
```

- [ ] **Step 3: Run the new full-cache tests to verify the stale path fails**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand -t "full usage"
```

Expected: FAIL because stale full-cache reads still return `fromCache: true` and never call the live Codex adapter.

- [ ] **Step 4: Add Codex Plus cache freshness helpers**

In `src/ui-modules/usage-api.js`, add these helpers after `buildProviderPoolUsageSyncStats()` and before `getAllProvidersUsage()`:

```js
function getCodexPlusPrimaryUsageItem(usage) {
    const primaryItemId = usage?.summary?.primaryItemId || 'primary_window';
    const items = Array.isArray(usage?.items) ? usage.items : [];
    return items.find(item => item?.id === primaryItemId) || null;
}

function hasExpiredResetAt(resetAt, now = Date.now()) {
    const resetAtMs = Date.parse(resetAt);
    return Number.isFinite(resetAtMs) && resetAtMs <= now;
}

function hasExpiredCodexPlusInstanceUsage(providerType, instance, now = Date.now()) {
    if (providerType !== CODEX_PLUS_PROVIDER) return false;

    const primaryItem = getCodexPlusPrimaryUsageItem(instance?.usage);
    return hasExpiredResetAt(primaryItem?.resetAt, now);
}

function hasExpiredCodexPlusProviderUsage(providerType, providerUsage, now = Date.now()) {
    const instances = Array.isArray(providerUsage?.instances) ? providerUsage.instances : [];
    return instances.some(instance => hasExpiredCodexPlusInstanceUsage(providerType, instance, now));
}

function hasExpiredCodexPlusUsageResults(usageResults, now = Date.now()) {
    return hasExpiredCodexPlusProviderUsage(
        CODEX_PLUS_PROVIDER,
        usageResults?.providers?.[CODEX_PLUS_PROVIDER],
        now
    );
}
```

- [ ] **Step 5: Reject expired Codex Plus data in the full cached usage branch**

In `handleGetUsage()` in `src/ui-modules/usage-api.js`, replace the cached-data body:

```js
            if (cachedData) {
                logger.info('[Usage API] Returning cached usage data');
                usageResults = { ...cachedData, fromCache: true };
                // 使用最新的格式化逻辑处理缓存的原始数据
                reformatUsageResults(usageResults);
                usageResults = syncUsageResultsWithProviderPools(usageResults, currentConfig, providerPoolManager);
                applyAccountQuotaLedgerToUsageResults(usageResults, currentConfig, providerPoolManager);
            } else {
```

with:

```js
            if (cachedData) {
                let cachedUsageResults = { ...cachedData, fromCache: true };
                // 使用最新的格式化逻辑处理缓存的原始数据
                reformatUsageResults(cachedUsageResults);
                cachedUsageResults = syncUsageResultsWithProviderPools(cachedUsageResults, currentConfig, providerPoolManager);

                if (hasExpiredCodexPlusUsageResults(cachedUsageResults)) {
                    logger.info('[Usage API] Codex Plus 5h usage cache has reset; fetching fresh usage data');
                } else {
                    logger.info('[Usage API] Returning cached usage data');
                    usageResults = cachedUsageResults;
                    applyAccountQuotaLedgerToUsageResults(usageResults, currentConfig, providerPoolManager);
                }
            } else {
```

- [ ] **Step 6: Re-run the full-cache tests**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand -t "full usage"
```

Expected: PASS.

- [ ] **Step 7: Commit the full-cache refresh behavior**

```bash
git add tests/account-quota-ledger.test.js src/ui-modules/usage-api.js
git commit -m "fix: refresh stale codex plus usage cache"
```

## Task 3: Refresh Expired Provider and Instance Cache Reads

**Files:**
- Modify: `tests/account-quota-ledger.test.js`
- Modify: `src/ui-modules/usage-api.js`

- [ ] **Step 1: Import the provider usage handler for direct provider-cache coverage**

In the `../src/ui-modules/usage-api.js` import list in `tests/account-quota-ledger.test.js`, add `handleGetProviderUsage`:

```js
    handleGetProviderUsage,
```

- [ ] **Step 2: Add failing provider and single-instance stale-cache tests**

Add these tests in the existing Codex Plus describe block after the full-cache tests:

```js
    test('refreshes provider usage when cached codex plus 5h quota has reset', async () => {
        const providerType = 'openai-codex-oauth-plus';
        const uuid = 'plus-stale-provider';
        const cachedProviderUsage = buildCachedCodexPlusUsage(
            providerType,
            uuid,
            buildCodexPlusRawUsage(92, '2020-01-01T05:00:00.000Z')
        ).providers[providerType];

        readProviderUsageCache.mockResolvedValue(cachedProviderUsage);
        updateProviderUsageCache.mockResolvedValue(undefined);
        serviceInstances[`${providerType}${uuid}`] = {
            getUsageLimits: jest.fn().mockResolvedValue(
                buildCodexPlusRawUsage(18, '2030-01-01T05:00:00.000Z')
            )
        };

        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
            providerPools: {
                [providerType]: [{ uuid, isDisabled: false }]
            }
        };
        const providerPoolManager = {
            providerPools: currentConfig.providerPools
        };
        const req = {
            method: 'GET',
            url: `/api/usage/${providerType}`,
            headers: { host: 'localhost:3000' }
        };
        const res = createJsonResponseMock();

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        const body = JSON.parse(res.body);

        expect(handled).toBe(true);
        expect(serviceInstances[`${providerType}${uuid}`].getUsageLimits).toHaveBeenCalledTimes(1);
        expect(updateProviderUsageCache).toHaveBeenCalledTimes(1);
        expect(body.fromCache).toBeUndefined();
        expect(body.instances[0].usage.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'primary_window', percent: 18 })
        ]));
    });

    test('refreshes single usage when cached codex plus 5h quota has reset', async () => {
        const providerType = 'openai-codex-oauth-plus';
        const uuid = 'plus-stale-instance';
        const cachedProviderUsage = buildCachedCodexPlusUsage(
            providerType,
            uuid,
            buildCodexPlusRawUsage(93, '2020-01-01T05:00:00.000Z')
        ).providers[providerType];

        readProviderUsageCache.mockResolvedValue(cachedProviderUsage);
        readUsageCache.mockResolvedValue(null);
        updateProviderUsageCache.mockResolvedValue(undefined);
        serviceInstances[`${providerType}${uuid}`] = {
            getUsageLimits: jest.fn().mockResolvedValue(
                buildCodexPlusRawUsage(19, '2030-01-01T05:00:00.000Z')
            )
        };

        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
            providerPools: {
                [providerType]: [{ uuid, isDisabled: false }]
            }
        };
        const providerPoolManager = {
            providerPools: currentConfig.providerPools
        };
        const req = {
            method: 'GET',
            url: `/api/usage/${providerType}/${uuid}`,
            headers: { host: 'localhost:3000' }
        };
        const res = createJsonResponseMock();

        const handled = await handleGetSingleInstanceUsage(
            req,
            res,
            currentConfig,
            providerPoolManager,
            providerType,
            uuid
        );
        const body = JSON.parse(res.body);

        expect(handled).toBe(true);
        expect(serviceInstances[`${providerType}${uuid}`].getUsageLimits).toHaveBeenCalledTimes(1);
        expect(updateProviderUsageCache).toHaveBeenCalledTimes(1);
        expect(body.fromCache).toBeUndefined();
        expect(body.usage.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'primary_window', percent: 19 })
        ]));
    });
```

- [ ] **Step 3: Run the provider and single-instance tests to verify they fail**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand -t "cached codex plus 5h quota has reset"
```

Expected: FAIL for the provider and single-instance default-read cases because they still return cached usage.

- [ ] **Step 4: Reject expired Codex Plus provider cache reads**

In `handleGetProviderUsage()` in `src/ui-modules/usage-api.js`, replace the current cached-provider branch with:

```js
            if (cachedData) {
                let cachedProviderUsage = { ...cachedData, fromCache: true };

                // 包装成 reformatUsageResults 期待的结构并重新格式化
                const tempResults = { providers: { [providerType]: cachedProviderUsage } };
                reformatUsageResults(tempResults);
                cachedProviderUsage = tempResults.providers[providerType];
                cachedProviderUsage = syncProviderUsageWithProviderPool(
                    providerType,
                    cachedProviderUsage,
                    currentConfig,
                    providerPoolManager
                );

                if (hasExpiredCodexPlusProviderUsage(providerType, cachedProviderUsage)) {
                    logger.info(`[Usage API] Codex Plus 5h usage cache has reset for ${providerType}; fetching fresh usage data`);
                } else {
                    logger.info(`[Usage API] Returning cached usage data for ${providerType}`);
                    usageResults = cachedProviderUsage;
                    applyAccountQuotaLedgerToProviderUsage(providerType, usageResults, currentConfig, providerPoolManager);
                    attachAccountQuotaLedgerSummary(usageResults, currentConfig, providerPoolManager);
                }
            } else {
```

- [ ] **Step 5: Fetch fresh single-instance usage when its cached primary window is expired**

In `handleGetSingleInstanceUsage()` in `src/ui-modules/usage-api.js`, replace the current `if (!refresh) { ... } else { ... }` cached/fresh branch with:

```js
        let shouldFetchFreshUsage = refresh;

        if (!shouldFetchFreshUsage) {
            const cachedData = await readProviderUsageCache(providerType);
            if (cachedData) {
                const syncedCachedData = syncProviderUsageWithProviderPool(
                    providerType,
                    { ...cachedData, fromCache: true },
                    currentConfig,
                    providerPoolManager
                );
                const cachedInstance = syncedCachedData.instances.find(item => item.uuid === uuid)
                    || createProviderPoolUsagePlaceholder(providerType, provider);

                if (hasExpiredCodexPlusInstanceUsage(providerType, cachedInstance)) {
                    logger.info(`[Usage API] Codex Plus 5h usage cache has reset for ${providerType}:${uuid}; fetching fresh usage data`);
                    shouldFetchFreshUsage = true;
                } else {
                    instanceResult = cachedInstance;
                    instanceResult.fromCache = true;
                    attachAccountQuotaLedgerSummary(syncedCachedData, currentConfig, providerPoolManager);
                    if (syncedCachedData.pendingRestoreAccounts) {
                        instanceResult.pendingRestoreAccounts = syncedCachedData.pendingRestoreAccounts;
                        instanceResult.pendingRestoreCount = syncedCachedData.pendingRestoreCount;
                    }
                }
            } else {
                instanceResult = createProviderPoolUsagePlaceholder(providerType, provider);
                attachAccountQuotaLedgerSummary(instanceResult, currentConfig, providerPoolManager);
                instanceResult.fromLocalProviderPool = true;
            }
        }

        if (shouldFetchFreshUsage) {
            logger.info(`[Usage API] Fetching fresh usage data for ${providerType}:${uuid}`);

            const providerKey = providerType + (provider.uuid || '');
            let adapter = serviceInstances[providerKey];

            if (provider.isDisabled) {
                instanceResult.error = 'Provider is disabled';
            } else {
                if (!adapter) {
                    try {
                        const serviceConfig = {
                            ...CONFIG,
                            ...provider,
                            MODEL_PROVIDER: providerType
                        };
                        adapter = getServiceAdapter(serviceConfig);
                    } catch (initError) {
                        instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                    }
                }

                if (adapter && !instanceResult.error) {
                    try {
                        const usage = await usageService.getFormattedUsage(providerType, provider.uuid);
                        instanceResult.success = true;
                        instanceResult.usage = usage;
                        if (providerPoolManager?.accountQuotaLedger?.enabled) {
                            providerPoolManager.accountQuotaLedger.applyRealUsage(providerType, provider.uuid, usage);
                        }
                        await updateSingleInstanceUsageCache(providerType, provider, instanceResult, currentConfig, providerPoolManager);
                    } catch (error) {
                        instanceResult.error = error.message;
                        const failure = providerPoolManager?.recordAccountRequestFailure?.(providerType, provider.uuid, error, {
                            source: 'usage_query'
                        });
                        if (failure?.handled && (failure.status === 401 || failure.status === 403) && !failure.deleted) {
                            providerPoolManager.removeProvider?.(providerType, provider.uuid, `usage query ${failure.status}`);
                        }
                    }
                }
            }
        }
```

Immediately below that replacement, change the global-cache update guard from:

```js
        if (refresh && instanceResult.success && instanceResult.usage) {
```

to:

```js
        if (shouldFetchFreshUsage && instanceResult.success && instanceResult.usage) {
```

- [ ] **Step 6: Re-run the provider and single-instance tests**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand -t "cached codex plus 5h quota has reset"
```

Expected: PASS.

- [ ] **Step 7: Commit the provider and instance cache behavior**

```bash
git add tests/account-quota-ledger.test.js src/ui-modules/usage-api.js
git commit -m "fix: refresh codex plus 5h instance cache"
```

## Task 4: Render Codex Plus Expanded Summary From the 5h Window

**Files:**
- Modify: `static/app/usage-manager.js`

- [ ] **Step 1: Add a summary-display resolver for Codex Plus**

In `static/app/usage-manager.js`, add this helper immediately before `function renderUsageDetails(usage) {`:

```js
function resolveUsageSummaryDisplay(usage, providerType) {
    const summary = usage?.summary || {};
    const fallback = {
        ...summary,
        label: t('usage.card.totalUsage')
    };

    if (providerType !== 'openai-codex-oauth-plus' || !summary.displayLabel) {
        return fallback;
    }

    const primaryItemId = summary.primaryItemId || 'primary_window';
    const primaryItem = Array.isArray(usage?.items)
        ? usage.items.find(item => item?.id === primaryItemId)
        : null;

    if (!primaryItem || primaryItem.percent === undefined) {
        return fallback;
    }

    return {
        ...summary,
        label: summary.displayLabel,
        usedPercent: primaryItem.percent,
        status: primaryItem.status || summary.status,
        resetAt: primaryItem.resetAt || summary.resetAt
    };
}
```

- [ ] **Step 2: Pass provider type into the detail renderer**

In `createInstanceUsageCard()`, replace:

```js
        contentArea.appendChild(renderUsageDetails(instance.usage));
```

with:

```js
        contentArea.appendChild(renderUsageDetails(instance.usage, providerType));
```

- [ ] **Step 3: Render the expanded summary label and values from the resolver**

Change the detail renderer signature and summary initialization from:

```js
function renderUsageDetails(usage) {
    const container = document.createElement('div');
    container.className = 'usage-details';

    const { summary, items } = usage;
```

to:

```js
function renderUsageDetails(usage, providerType) {
    const container = document.createElement('div');
    container.className = 'usage-details';

    const { items } = usage;
    const summary = resolveUsageSummaryDisplay(usage, providerType);
```

Then replace the fixed summary label:

```js
                <span class="total-label"><i class="fas fa-chart-pie"></i> <span>${t('usage.card.totalUsage')}</span></span>
```

with:

```js
                <span class="total-label"><i class="fas fa-chart-pie"></i> <span>${summary.label}</span></span>
```

- [ ] **Step 4: Syntax-check the frontend file**

Run:

```bash
node --check static/app/usage-manager.js
```

Expected: no output and exit code `0`.

- [ ] **Step 5: Commit the frontend summary rendering**

```bash
git add static/app/usage-manager.js
git commit -m "fix: show codex plus 5h usage summary"
```

## Task 5: Verify the Integrated Usage Flow

**Files:**
- Verify: `src/services/usage-service.js`
- Verify: `src/ui-modules/usage-api.js`
- Verify: `static/app/usage-manager.js`
- Verify: `tests/account-quota-ledger.test.js`

- [ ] **Step 1: Run the focused regression suite**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 2: Syntax-check the changed JavaScript modules**

Run:

```bash
node --check src/services/usage-service.js
```

Expected: no output and exit code `0`.

Run:

```bash
node --check src/ui-modules/usage-api.js
```

Expected: no output and exit code `0`.

Run:

```bash
node --check static/app/usage-manager.js
```

Expected: no output and exit code `0`.

- [ ] **Step 3: Restart the local service so verification loads the changed code**

Run:

```bash
aiclient2api.sh restart
```

Expected: the worker/service restarts successfully for the local `3001` instance.

- [ ] **Step 4: Verify the Usage page at the project port**

Open `http://localhost:3001`, navigate to the Usage page, and verify:

1. Expanding an `OpenAI Codex OAuth (plus)` card shows `Request Quota (5h)` in the top summary section.
2. The same expanded card still shows the `Weekly Limit` breakdown row.
3. Expanding a non-Plus provider card still shows the localized total-usage title.
4. A Codex Plus record whose cached 5h `resetAt` is already in the past refreshes from the Usage API instead of staying on the old cached primary-window percent.

- [ ] **Step 5: Inspect the final diff before delivery**

Run:

```bash
git diff HEAD~3..HEAD -- src/services/usage-service.js src/ui-modules/usage-api.js static/app/usage-manager.js tests/account-quota-ledger.test.js
```

Expected: only the Codex 5h metadata, Codex Plus cache freshness checks, frontend summary selection, and their regression coverage are present.
