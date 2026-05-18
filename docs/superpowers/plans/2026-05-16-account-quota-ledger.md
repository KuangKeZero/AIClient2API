# Account Quota Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local per-account quota ledger that estimates usage, limits real usage refreshes to specific confirmation moments, and routes away from exhausted, cooling, bad, or full accounts.

**Architecture:** Keep upgrade conflicts small by adding a standalone ledger module and touching only the provider-pool selection and request result hook points. The ledger persists to `configs/account_quota_ledger.json`, keyed by provider type and account UUID, while `provider_pools.json` remains the upstream-owned account list. Real refreshes reuse the existing `usageService` formatters and are scheduled asynchronously unless a request result demands immediate account state changes.

**Tech Stack:** Node.js ESM, Jest, existing `ProviderPoolManager`, existing `usageService`, existing file-lock utilities.

---

### Task 1: Ledger Unit Tests

**Files:**
- Create: `tests/account-quota-ledger.test.js`
- Create: `src/providers/account-quota-ledger.js`

- [x] **Step 1: Write failing tests for routing thresholds and cooldowns**

```javascript
import { AccountQuotaLedger } from '../src/providers/account-quota-ledger.js';

test('skips free accounts at 70 percent and plus accounts at 90 percent', () => {
  const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
  ledger.ensureAccount('openai-codex-oauth', { uuid: 'free-1' });
  ledger.applyRealUsage('openai-codex-oauth', 'free-1', {
    summary: { usedPercent: 69, plan: 'FREE', resetAt: '2030-01-01T00:00:00.000Z' }
  });
  expect(ledger.getRoutingDecision('openai-codex-oauth', { uuid: 'free-1' }).skip).toBe(false);
  ledger.recordEstimatedUsage('openai-codex-oauth', 'free-1', { usage: { totalTokens: 300000 }, model: 'gpt-5-codex' });
  expect(ledger.getRoutingDecision('openai-codex-oauth', { uuid: 'free-1' }).skip).toBe(true);

  ledger.ensureAccount('openai-codex-oauth', { uuid: 'plus-1' });
  ledger.applyRealUsage('openai-codex-oauth', 'plus-1', {
    summary: { usedPercent: 84, plan: 'PLUS', resetAt: '2030-01-01T00:00:00.000Z' }
  });
  ledger.recordEstimatedUsage('openai-codex-oauth', 'plus-1', { usage: { totalTokens: 300000 }, model: 'gpt-5-codex' });
  expect(ledger.getRoutingDecision('openai-codex-oauth', { uuid: 'plus-1' }).skip).toBe(true);
});

test('skips accounts while disabledUntil is in the future', () => {
  const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
  ledger.ensureAccount('openai-codex-oauth', { uuid: 'cooling' });
  ledger.record429('openai-codex-oauth', 'cooling', { retryAfterMs: 30000 });
  const decision = ledger.getRoutingDecision('openai-codex-oauth', { uuid: 'cooling' }, Date.now());
  expect(decision.skip).toBe(true);
  expect(decision.reason).toBe('cooldown');
});
```

- [x] **Step 2: Run tests and verify they fail because the module is missing**

Run: `npm test -- --runTestsByPath tests/account-quota-ledger.test.js`
Expected: FAIL with module not found or missing export.

### Task 2: Standalone Ledger Module

**Files:**
- Create: `src/providers/account-quota-ledger.js`
- Test: `tests/account-quota-ledger.test.js`

- [x] **Step 1: Implement ledger state shape**

Create `AccountQuotaLedger` with:
- `lastRealUsagePercent`
- `estimatedUsagePercent`
- `resetAt`
- `disabledUntil`
- `confidence`
- `recent429`
- `recent401`
- `plan`
- `refresh`

Use `ensureAccount(providerType, config)` to create entries without modifying the provider config object.

- [x] **Step 2: Implement real usage and estimate updates**

`applyRealUsage()` sets real and estimated percent to the formatted usage summary, stores plan/resetAt, and raises confidence.

`recordEstimatedUsage()` extracts prompt/completion/total tokens from OpenAI, Responses, Claude, Gemini, and Codex-shaped usage blocks, converts tokens to percent using configurable tokens-per-percent defaults, applies model multipliers, and lowers confidence a little.

- [x] **Step 3: Implement routing decisions**

`getRoutingDecision()` returns skip decisions for:
- `disabledUntil` in the future
- Free estimated usage >= 70
- Plus/pro/unknown estimated usage >= 85
- reset window reached but not yet confirmed

- [x] **Step 4: Implement 429 and 401 bookkeeping**

`record429()` stores bounded recent 429 events and sets `disabledUntil` from Retry-After when present.

`record401()` stores bounded recent 401 events and returns `shouldDelete: true` once the count reaches 3.

- [x] **Step 5: Run ledger tests**

Run: `npm test -- --runTestsByPath tests/account-quota-ledger.test.js`
Expected: PASS.

### Task 3: Provider Pool Integration

**Files:**
- Modify: `src/providers/provider-pool-manager.js`
- Modify: `src/services/service-manager.js`
- Test: `tests/account-quota-ledger.test.js`

- [x] **Step 1: Instantiate the ledger**

In `ProviderPoolManager` constructor, create `this.accountQuotaLedger` from global config.

- [x] **Step 2: Ensure accounts during initialization**

Call `ensureAccount(providerType, providerConfig)` while building `providerStatus`. New accounts should be queued for a first real usage refresh after adapters are initialized.

- [x] **Step 3: Filter during routing**

Before model filtering and scoring, exclude accounts whose ledger decision says skip and exclude accounts whose active concurrency is already at the account limit.

- [x] **Step 4: Refresh only at allowed moments**

Add pool-manager methods that schedule ledger usage refreshes for:
- first-seen account
- near threshold with low confidence
- resetAt reached before restore
- available pool nearly exhausted
- suspected quota 429

Use dynamic import of `usageService` to avoid circular imports.

- [x] **Step 5: Delete bad accounts after 3 consecutive 401s**

Add `removeProvider(providerType, uuid, reason)` to remove the pool entry, invalidate the adapter, save the pool file, and mark the ledger entry deleted.

### Task 4: Request Result Hooks

**Files:**
- Modify: `src/utils/common.js`
- Modify: `src/services/api-manager.js`

- [x] **Step 1: Record successful unary usage**

After a successful unary response and before marking the provider healthy, pass model, native/client usage, and success status into the pool manager ledger hook.

- [x] **Step 2: Record successful stream usage**

Aggregate usage from stream chunks, then pass it into the pool manager ledger hook when the stream completes.

- [x] **Step 3: Record failed attempts**

In unary/stream/image error paths, call the pool manager ledger hook with status code, Retry-After, error body, model, and uuid.

- [x] **Step 4: Avoid same-account retry for 429**

At the outer request layer, any 429 marks/cools the current account before credential-switch retry, so the next retry selection cannot pick the same UUID while it is cooling or quota-disabled.

### Task 5: Config and Docs

**Files:**
- Modify: `src/core/config-manager.js`
- Modify: `configs/config.json.example`
- Modify: `README-ZH.md`

- [x] **Step 1: Add conservative defaults**

Add `ACCOUNT_QUOTA_LEDGER` config defaults:
- `enabled: true`
- `filePath: configs/account_quota_ledger.json`
- thresholds and confidence values
- short/long cooldown durations
- tokens-per-percent defaults

- [x] **Step 2: Document behavior**

Describe the local ledger, when real refresh happens, route skipping, and 401 deletion behavior in the Chinese README near the 429 FAQ.

### Task 6: Verification

**Files:**
- All changed files

- [x] **Step 1: Run targeted tests**

Run: `npm test -- --runTestsByPath tests/account-quota-ledger.test.js`
Expected: PASS.

- [x] **Step 2: Run existing integration tests if targeted tests pass**

Run: `npm test -- --runTestsByPath tests/api-integration.test.js`
Expected: PASS or report pre-existing/network-dependent failures with output.

- [x] **Step 3: Inspect diff**

Run: `git diff -- src/providers/account-quota-ledger.js src/providers/provider-pool-manager.js src/utils/common.js src/services/service-manager.js src/services/api-manager.js src/core/config-manager.js configs/config.json.example README-ZH.md tests/account-quota-ledger.test.js`
Expected: Only scoped ledger, hook, config, doc, and test changes.

Verification note: `npm test -- --runTestsByPath tests/account-quota-ledger.test.js`, `node --check` on changed JS files, and `git diff --check` passed on 2026-05-16. `npm test -- --runTestsByPath tests/api-integration.test.js` was executed, but all 24 cases failed because the configured test server `http://192.168.1.232:3000` was unreachable (`EHOSTUNREACH`).

---

## Self-Review

Spec coverage: the plan covers local ledger fields, estimated consumption after real requests, constrained real refresh triggers, routing skip rules, 3x401 deletion, and 429 cooldown/quota handling.

Placeholder scan: no implementation task is left as TBD; each task names exact files and behaviors.

Type consistency: ledger public methods are named consistently across tasks: `ensureAccount`, `applyRealUsage`, `recordEstimatedUsage`, `getRoutingDecision`, `record429`, `record401`, and pool-manager hook methods.
