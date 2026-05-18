# Codex Plus Usage Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `openai-codex-oauth-plus` to usage querying and show the currently active AccountQuotaLedger restore-pool rules on the usage page.

**Architecture:** The backend remains the source of truth for runtime quota rules. `usage-api.js` exposes `quotaRules` from the live `providerPoolManager.accountQuotaLedger.options`, while the existing Codex usage formatter handles the Plus provider through `UsageService.resolveSupportedProvider()`. The frontend renders a compact read-only rules banner from `quotaRules`.

**Tech Stack:** Node.js ESM, Jest, static browser JavaScript, existing AIClient2API usage API and AccountQuotaLedger.

---

## File Structure

- Modify `src/ui-modules/usage-api.js`: add the Plus usage provider and attach `quotaRules` to usage responses.
- Modify `tests/account-quota-ledger.test.js`: cover the supported provider list, runtime quota rule payload, disabled ledger payload, and Plus provider placeholder syncing.
- Modify `static/components/section-usage.html`: add a rules banner container.
- Modify `static/app/usage-manager.js`: render `quotaRules` and refresh it after each usage API success path.
- Modify `static/app/i18n.js`: add Chinese and English text for the rules banner.
- Modify `static/components/section-usage.css`: style the rules banner consistently with the existing usage info banner.

## Task 1: Backend Failing Tests

**Files:**
- Modify: `tests/account-quota-ledger.test.js`

- [ ] **Step 1: Add usage API imports**

In `tests/account-quota-ledger.test.js`, extend the existing import from `../src/ui-modules/usage-api.js` so it includes `handleGetSupportedProviders` and `handleGetUsage`:

```js
import {
    applyAccountQuotaLedgerToInstance,
    applyAccountQuotaLedgerToProviderUsage,
    buildProviderPoolUsageSyncStats,
    handleGetSupportedProviders,
    handleGetUsage,
    handleSyncProviderPoolUsage,
    syncProviderUsageWithProviderPool,
    syncUsageResultsWithProviderPools
} from '../src/ui-modules/usage-api.js';
```

- [ ] **Step 2: Add local response helper**

Add this helper before `describe('Usage API provider-pool synchronization', () => {`:

```js
function createJsonResponseMock() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead: jest.fn(function writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        }),
        end: jest.fn(function end(chunk = '') {
            this.body += chunk;
        })
    };
}
```

- [ ] **Step 3: Add failing usage rules tests**

Add this describe block before `describe('Usage API provider-pool synchronization', () => {`:

```js
describe('Usage API Codex Plus quota rules', () => {
    beforeEach(() => {
        readUsageCache.mockReset();
        writeUsageCache.mockReset();
    });

    test('supported providers include codex plus usage provider', async () => {
        const req = {
            method: 'GET',
            url: '/api/usage/supported-providers',
            headers: { host: 'localhost:3000' }
        };
        const res = createJsonResponseMock();

        const handled = await handleGetSupportedProviders(req, res);
        const providers = JSON.parse(res.body);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(providers).toContain('openai-codex-oauth');
        expect(providers).toContain('openai-codex-oauth-plus');
    });

    test('usage response exposes runtime quota rules and codex plus pool data', async () => {
        readUsageCache.mockResolvedValue(null);
        writeUsageCache.mockResolvedValue(undefined);

        const ledger = new AccountQuotaLedger({
            enabled: true,
            autoLoad: false,
            freeThresholdPercent: 72,
            plusThresholdPercent: 88,
            defaultThresholdPercent: 91,
            poolLowAvailableCount: 2,
            poolLowAvailableRatio: 0.35
        });
        const currentConfig = {
            providerPools: {
                'openai-codex-oauth-plus': [
                    {
                        uuid: 'plus-pool-1',
                        isDisabled: false,
                        plan: 'PLUS',
                        CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex-plus/plus-pool-1.json'
                    }
                ]
            }
        };
        const providerPoolManager = {
            providerPools: currentConfig.providerPools,
            accountQuotaLedger: ledger
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
        expect(res.statusCode).toBe(200);
        expect(body.quotaRules).toEqual({
            enabled: true,
            freeThresholdPercent: 72,
            plusThresholdPercent: 88,
            defaultThresholdPercent: 91,
            poolLowAvailableCount: 2,
            poolLowAvailableRatio: 0.35
        });
        expect(body.providers['openai-codex-oauth-plus'].instances[0]).toMatchObject({
            uuid: 'plus-pool-1',
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

    test('usage response marks quota rules disabled when ledger is disabled', async () => {
        readUsageCache.mockResolvedValue(null);
        writeUsageCache.mockResolvedValue(undefined);

        const ledger = new AccountQuotaLedger({
            enabled: false,
            autoLoad: false
        });
        const currentConfig = {
            providerPools: {}
        };
        const providerPoolManager = {
            providerPools: {},
            accountQuotaLedger: ledger
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
        expect(res.statusCode).toBe(200);
        expect(body.quotaRules).toEqual({ enabled: false });
    });
});
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: FAIL. The first failure should show that `openai-codex-oauth-plus` is missing or `body.quotaRules` is `undefined`.

## Task 2: Backend Implementation

**Files:**
- Modify: `src/ui-modules/usage-api.js`
- Test: `tests/account-quota-ledger.test.js`

- [ ] **Step 1: Add Codex Plus provider constant**

In `src/ui-modules/usage-api.js`, add this constant above `const supportedProviders = [`:

```js
const CODEX_PLUS_PROVIDER = `${MODEL_PROVIDER.CODEX_API}-plus`;
```

Then update `supportedProviders` to include it:

```js
const supportedProviders = [
    MODEL_PROVIDER.KIRO_API,
    MODEL_PROVIDER.GEMINI_CLI,
    MODEL_PROVIDER.ANTIGRAVITY,
    MODEL_PROVIDER.CODEX_API,
    CODEX_PLUS_PROVIDER,
    MODEL_PROVIDER.GROK_WEB
];
```

- [ ] **Step 2: Add quota rule summary builder**

In `src/ui-modules/usage-api.js`, add this function immediately after the closing brace of `function getLocalPlanClass(plan)` and before `function hasUsefulLedgerSignal(account)`:

```js
function buildQuotaRuleSummary(providerPoolManager) {
    try {
        const ledger = providerPoolManager?.accountQuotaLedger;
        if (!ledger?.enabled || !ledger.options) {
            return { enabled: false };
        }

        const options = ledger.options;
        return {
            enabled: true,
            freeThresholdPercent: Number(options.freeThresholdPercent),
            plusThresholdPercent: Number(options.plusThresholdPercent),
            defaultThresholdPercent: Number(options.defaultThresholdPercent),
            poolLowAvailableCount: Number(options.poolLowAvailableCount),
            poolLowAvailableRatio: Number(options.poolLowAvailableRatio)
        };
    } catch (error) {
        logger.warn(`[Usage API] Failed to build quota rule summary: ${error.message}`);
        return { enabled: false };
    }
}
```

- [ ] **Step 3: Attach quotaRules to full usage response**

In `handleGetUsage`, change `finalResults` to:

```js
const finalResults = {
    ...usageResults,
    quotaRules: buildQuotaRuleSummary(providerPoolManager),
    serverTime: new Date().toISOString()
};
```

- [ ] **Step 4: Attach quotaRules to sync response**

In `handleSyncProviderPoolUsage`, replace the final response payload that currently spreads `responseUsage` and sets `serverTime` with:

```js
res.end(JSON.stringify({
    ...responseUsage,
    quotaRules: buildQuotaRuleSummary(providerPoolManager),
    serverTime: new Date().toISOString()
}));
```

- [ ] **Step 5: Attach quotaRules to single instance response**

In `handleGetSingleInstanceUsage`, change `finalResults` to:

```js
const finalResults = {
    ...instanceResult,
    quotaRules: buildQuotaRuleSummary(providerPoolManager),
    serverTime: new Date().toISOString()
};
```

- [ ] **Step 6: Attach quotaRules to provider response**

In `handleGetProviderUsage`, change `finalResults` to:

```js
const finalResults = {
    ...usageResults,
    quotaRules: buildQuotaRuleSummary(providerPoolManager),
    serverTime: new Date().toISOString()
};
```

- [ ] **Step 7: Run backend tests**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 8: Commit backend changes**

Run:

```bash
git add src/ui-modules/usage-api.js tests/account-quota-ledger.test.js
git commit -m "feat: expose codex plus usage rules"
```

## Task 3: Frontend Rules Banner

**Files:**
- Modify: `static/components/section-usage.html`
- Modify: `static/app/usage-manager.js`
- Modify: `static/app/i18n.js`
- Modify: `static/components/section-usage.css`

- [ ] **Step 1: Add rules banner markup**

In `static/components/section-usage.html`, add this block immediately after the existing `.usage-info-banner` block:

```html
        <div class="usage-quota-rules" id="usageQuotaRules" hidden>
            <i class="fas fa-route"></i>
            <span id="usageQuotaRulesText"></span>
        </div>
```

- [ ] **Step 2: Add quota rules renderer**

In `static/app/usage-manager.js`, add these functions immediately after the closing brace of `function formatRecoveryDate(value)` and before `function clampPendingRestorePage(totalItems)`:

```js
function formatRulePercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '--';
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
}

function formatRuleRatioPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '--';
    const percent = numeric * 100;
    return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

function updateQuotaRulesInfo(data) {
    const container = document.getElementById('usageQuotaRules');
    const textEl = document.getElementById('usageQuotaRulesText');
    if (!container || !textEl) return;

    const rules = data?.quotaRules;
    if (!rules) {
        container.hidden = true;
        textEl.textContent = '';
        return;
    }

    container.hidden = false;
    if (rules.enabled === false) {
        container.classList.add('is-disabled');
        textEl.textContent = t('usage.rules.disabled');
        return;
    }

    container.classList.remove('is-disabled');
    textEl.textContent = t('usage.rules.summary', {
        free: formatRulePercent(rules.freeThresholdPercent),
        plus: formatRulePercent(rules.plusThresholdPercent),
        defaultThreshold: formatRulePercent(rules.defaultThresholdPercent),
        lowCount: Number(rules.poolLowAvailableCount || 0),
        lowRatio: formatRuleRatioPercent(rules.poolLowAvailableRatio)
    });
}
```

- [ ] **Step 3: Update rules after successful usage loads**

In `loadUsage()`, after `updateTimeInfo(data);`, add:

```js
        updateQuotaRulesInfo(data);
```

In `refreshUsage()`, after `updateTimeInfo(data);`, add:

```js
        updateQuotaRulesInfo(data);
```

In `syncProviderPoolUsage()`, after `updateTimeInfo(data);`, add:

```js
        updateQuotaRulesInfo(data);
```

In `refreshSingleInstanceUsage()`, after `updatePendingRestoreSection(data.pendingRestoreAccounts || []);`, add:

```js
            updateQuotaRulesInfo(data);
```

In `refreshProviderUsage()`, after `updateTimeInfo(data);`, add:

```js
            updateQuotaRulesInfo(data);
```

- [ ] **Step 4: Add Chinese i18n keys**

In the Chinese usage section of `static/app/i18n.js`, after `usage.supportedProvidersPrefix`, add:

```js
        'usage.rules.summary': '恢复池规则：Free >= {free}% 入恢复池，Plus/Pro >= {plus}% 入恢复池，其他 >= {defaultThreshold}%；可用账号 <= max({lowCount}, 总数 {lowRatio}%) 时触发恢复验证。',
        'usage.rules.disabled': '恢复池规则：本地额度账本未启用',
```

- [ ] **Step 5: Add English i18n keys**

In the English usage section of `static/app/i18n.js`, after `usage.supportedProvidersPrefix`, add:

```js
        'usage.rules.summary': 'Restore rules: Free >= {free}%, Plus/Pro >= {plus}%, others >= {defaultThreshold}%; recovery verification is triggered when available accounts <= max({lowCount}, {lowRatio}% of total).',
        'usage.rules.disabled': 'Restore rules: local quota ledger is disabled',
```

- [ ] **Step 6: Add banner CSS**

In `static/components/section-usage.css`, add this block immediately after the existing `.usage-info-banner i` rule:

```css
.usage-quota-rules {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    margin: -0.75rem 0 1.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
}

.usage-quota-rules[hidden] {
    display: none;
}

.usage-quota-rules i {
    color: var(--primary-color);
}

.usage-quota-rules.is-disabled i {
    color: var(--warning-color);
}
```

- [ ] **Step 7: Commit frontend changes**

Run:

```bash
git add static/components/section-usage.html static/app/usage-manager.js static/app/i18n.js static/components/section-usage.css
git commit -m "feat: show usage restore rules"
```

## Task 4: Final Verification

**Files:**
- Verify: `src/ui-modules/usage-api.js`
- Verify: `static/app/usage-manager.js`
- Verify: `static/components/section-usage.html`
- Verify: `static/components/section-usage.css`
- Verify: `static/app/i18n.js`

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run full Jest suite**

Run:

```bash
pnpm test -- --runInBand
```

Expected: PASS.

- [ ] **Step 3: Restart service on local port 3001**

If `.aiclient2api.pid` points to a running process, stop it first:

```bash
if [ -f .aiclient2api.pid ] && kill -0 "$(cat .aiclient2api.pid)" 2>/dev/null; then kill "$(cat .aiclient2api.pid)"; sleep 2; fi
```

Then start the service in a long-running terminal:

```bash
pnpm start
```

Expected: service listens on `http://localhost:3001` according to the local project configuration.

- [ ] **Step 4: Get a UI auth token for API verification**

Log in once through `http://localhost:3001`, then run:

```bash
TOKEN=$(node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('configs/token-store.json','utf8'));const token=Object.keys(data.tokens||{}).find(k=>data.tokens[k].expiryTime>Date.now());if(!token){throw new Error('No valid UI token found; log in through the browser first.')}console.log(token)")
```

Expected: command prints nothing except setting `TOKEN`; `echo ${#TOKEN}` prints a positive number.

- [ ] **Step 5: Verify supported providers API**

Run:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/usage/supported-providers
```

Expected output includes both:

```json
"openai-codex-oauth"
"openai-codex-oauth-plus"
```

- [ ] **Step 6: Verify quota rules API payload**

Run:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/usage | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log(JSON.stringify(j.quotaRules,null,2));})"
```

Expected default output shape:

```json
{
  "enabled": true,
  "freeThresholdPercent": 70,
  "plusThresholdPercent": 90,
  "defaultThresholdPercent": 85,
  "poolLowAvailableCount": 1,
  "poolLowAvailableRatio": 0.2
}
```

If local `configs/config.json` overrides these values, expect the configured values instead.

- [ ] **Step 7: Verify UI manually**

Open:

```text
http://localhost:3001
```

Navigate to the usage page and verify:

- The supported providers row includes `Codex (plus)` or the configured display name for `openai-codex-oauth-plus`.
- The rules banner displays runtime values, for example `Free >= 70%`, `Plus/Pro >= 90%`, and `max(1, 总数 20%)`.
- The existing refresh, sync provider pool, pending restore, and instance cards still render.

- [ ] **Step 8: Commit any verification-only fixes**

If Task 4 required small fixes, commit them:

```bash
git add src/ui-modules/usage-api.js tests/account-quota-ledger.test.js static/components/section-usage.html static/app/usage-manager.js static/app/i18n.js static/components/section-usage.css
git commit -m "fix: polish codex plus usage rules"
```

If no fixes were needed, do not create an empty commit.
