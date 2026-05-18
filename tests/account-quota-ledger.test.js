import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {},
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/usage-cache.js', () => ({
    readUsageCache: jest.fn(),
    writeUsageCache: jest.fn(),
    readProviderUsageCache: jest.fn(),
    updateProviderUsageCache: jest.fn()
}));

import {
    AccountQuotaLedger,
    extractTokenUsage,
    isQuotaLike429
} from '../src/providers/account-quota-ledger.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import {
    readProviderUsageCache,
    readUsageCache,
    updateProviderUsageCache,
    writeUsageCache
} from '../src/ui-modules/usage-cache.js';
import { serviceInstances } from '../src/providers/adapter.js';
import { formatCodexUsage } from '../src/services/usage-service.js';
import {
    applyAccountQuotaLedgerToInstance,
    applyAccountQuotaLedgerToProviderUsage,
    buildProviderPoolUsageSyncStats,
    handleGetSupportedProviders,
    handleGetSingleInstanceUsage,
    handleGetUsage,
    handleSyncProviderPoolUsage,
    syncProviderUsageWithProviderPool,
    syncUsageResultsWithProviderPools
} from '../src/ui-modules/usage-api.js';

const TEST_PROVIDER_POOLS_FILE_PATH = 'configs/provider_pools.test.missing.json';

describe('AccountQuotaLedger routing decisions', () => {
    test('skips free accounts at 70 percent and plus accounts at 90 percent', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });

        ledger.ensureAccount('openai-codex-oauth', { uuid: 'free-1' });
        ledger.applyRealUsage('openai-codex-oauth', 'free-1', {
            summary: {
                usedPercent: 69,
                plan: 'FREE',
                resetAt: '2030-01-01T00:00:00.000Z'
            }
        });
        expect(ledger.getRoutingDecision('openai-codex-oauth', { uuid: 'free-1' }).skip).toBe(false);

        ledger.recordEstimatedUsage('openai-codex-oauth', 'free-1', {
            model: 'gpt-5-codex',
            usage: { totalTokens: 300000 }
        });
        expect(ledger.getRoutingDecision('openai-codex-oauth', { uuid: 'free-1' })).toMatchObject({
            skip: true,
            reason: 'estimated_threshold'
        });

        ledger.ensureAccount('openai-codex-oauth', { uuid: 'plus-1' });
        ledger.applyRealUsage('openai-codex-oauth', 'plus-1', {
            summary: {
                usedPercent: 89,
                plan: 'PLUS',
                resetAt: '2030-01-01T00:00:00.000Z'
            }
        });
        ledger.recordEstimatedUsage('openai-codex-oauth', 'plus-1', {
            model: 'gpt-5-codex',
            usage: { totalTokens: 300000 }
        });
        expect(ledger.getRoutingDecision('openai-codex-oauth', { uuid: 'plus-1' })).toMatchObject({
            skip: true,
            reason: 'estimated_threshold'
        });
    });

    test('skips accounts while disabledUntil is in the future', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });

        ledger.ensureAccount('openai-codex-oauth', { uuid: 'cooling' });
        ledger.record429('openai-codex-oauth', 'cooling', {
            retryAfterMs: 30000,
            now: 1700000000000
        });

        expect(ledger.getRoutingDecision('openai-codex-oauth', { uuid: 'cooling' }, 1700000000001)).toMatchObject({
            skip: true,
            reason: 'cooldown'
        });
    });

    test('asks for reset confirmation when resetAt is reached before routing the account again', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });

        ledger.ensureAccount('openai-codex-oauth', { uuid: 'resetting' });
        ledger.applyRealUsage('openai-codex-oauth', 'resetting', {
            summary: {
                usedPercent: 100,
                plan: 'PLUS',
                resetAt: '2023-11-14T22:13:20.000Z'
            }
        });
        ledger.record429('openai-codex-oauth', 'resetting', {
            quotaLike: true,
            resetAt: '2023-11-14T22:13:20.000Z',
            now: 1700000000000
        });

        const decision = ledger.getRoutingDecision(
            'openai-codex-oauth',
            { uuid: 'resetting' },
            1700000000001
        );

        expect(decision).toMatchObject({
            skip: true,
            reason: 'awaiting_reset_refresh',
            refreshReason: 'reset_reached'
        });
    });
});

describe('AccountQuotaLedger request accounting', () => {
    test('extracts token usage from common response shapes', () => {
        expect(extractTokenUsage({
            usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
                prompt_tokens_details: { cached_tokens: 3 }
            }
        })).toEqual({
            promptTokens: 10,
            completionTokens: 20,
            totalTokens: 30,
            cachedTokens: 3
        });

        expect(extractTokenUsage({
            response: {
                usage: {
                    input_tokens: 11,
                    output_tokens: 22,
                    total_tokens: 33
                }
            }
        })).toEqual({
            promptTokens: 11,
            completionTokens: 22,
            totalTokens: 33,
            cachedTokens: 0
        });
    });

    test('counts three recent 401s as a deletion signal and resets after success', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
        ledger.ensureAccount('openai-codex-oauth', { uuid: 'bad-auth' });

        expect(ledger.record401('openai-codex-oauth', 'bad-auth', { now: 1000 }).shouldDelete).toBe(false);
        expect(ledger.record401('openai-codex-oauth', 'bad-auth', { now: 2000 }).shouldDelete).toBe(false);
        expect(ledger.record401('openai-codex-oauth', 'bad-auth', { now: 3000 }).shouldDelete).toBe(true);

        ledger.recordEstimatedUsage('openai-codex-oauth', 'bad-auth', {
            model: 'gpt-5-codex',
            usage: { totalTokens: 1 }
        });

        expect(ledger.getAccount('openai-codex-oauth', 'bad-auth').recent401).toHaveLength(0);
    });

    test('detects quota-like 429 errors from status and body content', () => {
        expect(isQuotaLike429({
            status: 429,
            response: {
                data: {
                    error: {
                        code: 'insufficient_quota',
                        message: 'You exceeded your current quota.'
                    }
                }
            }
        })).toBe(true);

        expect(isQuotaLike429({
            status: 429,
            response: {
                data: {
                    error: {
                        message: 'Slow down; retry later.'
                    }
                }
            }
        })).toBe(false);
    });

    test('prefers specific model multipliers over broad model prefixes', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
        const account = ledger.ensureAccount('openai-codex-oauth', {
            uuid: 'specific-model',
            plan: 'FREE'
        });

        expect(ledger.estimateUsagePercent(account, 'gpt-5-codex', { totalTokens: 300000 })).toBeCloseTo(2);
        expect(ledger.estimateUsagePercent(account, 'gpt-5.4-mini', { totalTokens: 300000 })).toBeCloseTo(1.6);
    });
});

describe('AccountQuotaLedger persistence hooks', () => {
    test('debounces saves when mutating account state', async () => {
        const save = jest.fn();
        const ledger = new AccountQuotaLedger({
            enabled: true,
            autoLoad: false,
            saveDebounceMs: 1,
            saveStore: save
        });

        ledger.ensureAccount('openai-codex-oauth', { uuid: 'persisted' });
        ledger.recordEstimatedUsage('openai-codex-oauth', 'persisted', {
            model: 'gpt-5-codex',
            usage: { totalTokens: 1 }
        });

        await new Promise(resolve => setTimeout(resolve, 5));
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0].accounts['openai-codex-oauth:persisted']).toBeTruthy();
    });
});

describe('ProviderPoolManager account quota integration', () => {
    function createPoolManager(providerPools) {
        return new ProviderPoolManager(providerPools, {
            globalConfig: {
                PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
                ACCOUNT_QUOTA_LEDGER: {
                enabled: true,
                autoLoad: false,
                saveDebounceMs: 1,
                poolLowAvailableCount: 0,
                poolLowAvailableRatio: 0,
                saveStore: jest.fn()
            }
            },
            saveDebounceTime: 3600000
        });
    }

    test('routes around accounts skipped by the local quota ledger', () => {
        const manager = createPoolManager({
            'openai-codex-oauth': [
                { uuid: 'exhausted', isHealthy: true, isDisabled: false },
                { uuid: 'available', isHealthy: true, isDisabled: false }
            ]
        });

        manager.accountQuotaLedger.applyRealUsage('openai-codex-oauth', 'exhausted', {
            summary: { usedPercent: 70, plan: 'FREE', resetAt: '2030-01-01T00:00:00.000Z' }
        });
        manager.accountQuotaLedger.applyRealUsage('openai-codex-oauth', 'available', {
            summary: { usedPercent: 10, plan: 'FREE', resetAt: '2030-01-01T00:00:00.000Z' }
        });

        const selected = manager._doSelectProvider('openai-codex-oauth', null, { skipUsageCount: true });

        expect(selected.uuid).toBe('available');
    });

    test('routes around accounts whose concurrency is already full', () => {
        const manager = createPoolManager({
            'openai-codex-oauth': [
                { uuid: 'busy', isHealthy: true, isDisabled: false, concurrencyLimit: 1 },
                { uuid: 'idle', isHealthy: true, isDisabled: false, concurrencyLimit: 1 }
            ]
        });

        manager.accountQuotaLedger.applyRealUsage('openai-codex-oauth', 'busy', {
            summary: { usedPercent: 10, plan: 'PLUS', resetAt: '2030-01-01T00:00:00.000Z' }
        });
        manager.accountQuotaLedger.applyRealUsage('openai-codex-oauth', 'idle', {
            summary: { usedPercent: 10, plan: 'PLUS', resetAt: '2030-01-01T00:00:00.000Z' }
        });
        manager.providerStatus['openai-codex-oauth'][0].state.activeCount = 1;

        const selected = manager._doSelectProvider('openai-codex-oauth', null, { skipUsageCount: true });

        expect(selected.uuid).toBe('idle');
    });

    test('removes an account from the pool after three recent auth failures', () => {
        const manager = createPoolManager({
            'openai-codex-oauth': [
                { uuid: 'bad-auth', isHealthy: true, isDisabled: false }
            ]
        });

        const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
        manager.recordAccountRequestFailure('openai-codex-oauth', 'bad-auth', authError);
        manager.recordAccountRequestFailure('openai-codex-oauth', 'bad-auth', authError);
        const result = manager.recordAccountRequestFailure('openai-codex-oauth', 'bad-auth', authError);

        expect(result.deleted).toBe(true);
        expect(manager.providerStatus['openai-codex-oauth']).toHaveLength(0);
        expect(manager.providerPools['openai-codex-oauth']).toHaveLength(0);
    });

    test('marks providers unhealthy when real usage reaches the quota threshold', () => {
        const manager = createPoolManager({
            'openai-codex-oauth': [
                { uuid: 'over-quota', isHealthy: true, isDisabled: false }
            ]
        });

        const account = manager.accountQuotaLedger.applyRealUsage('openai-codex-oauth', 'over-quota', {
            summary: {
                usedPercent: 76,
                plan: 'FREE',
                resetAt: '2030-01-01T00:00:00.000Z'
            }
        });

        manager._syncProviderWithAccountQuota(
            'openai-codex-oauth',
            manager.providerStatus['openai-codex-oauth'][0].config,
            account,
            'test'
        );

        expect(manager.providerStatus['openai-codex-oauth'][0].config).toMatchObject({
            isHealthy: false,
            scheduledRecoveryTime: '2030-01-01T00:00:00.000Z'
        });
    });

    test('counts auth failures from refresh paths toward account deletion', () => {
        const manager = createPoolManager({
            'openai-codex-oauth': [
                { uuid: 'bad-refresh', isHealthy: true, isDisabled: false }
            ]
        });

        const refreshError = new Error('Failed to refresh Codex token. Please re-authenticate.');
        manager._recordAccountAuthFailure('openai-codex-oauth', 'bad-refresh', refreshError, 'token_refresh');
        manager._recordAccountAuthFailure('openai-codex-oauth', 'bad-refresh', refreshError, 'token_refresh');
        const result = manager._recordAccountAuthFailure('openai-codex-oauth', 'bad-refresh', refreshError, 'token_refresh');

        expect(result.shouldDelete).toBe(true);
        expect(manager.providerStatus['openai-codex-oauth']).toHaveLength(0);
        expect(manager.providerPools['openai-codex-oauth']).toHaveLength(0);
    });

    test('does not mark quota-skipped providers healthy after a health check', () => {
        const manager = createPoolManager({
            'openai-codex-oauth': [
                { uuid: 'still-over', isHealthy: false, isDisabled: false }
            ]
        });

        manager.accountQuotaLedger.applyRealUsage('openai-codex-oauth', 'still-over', {
            summary: {
                usedPercent: 100,
                plan: 'FREE',
                resetAt: '2030-01-01T00:00:00.000Z'
            }
        });

        manager.markProviderHealthy('openai-codex-oauth', { uuid: 'still-over' }, true);

        expect(manager.providerStatus['openai-codex-oauth'][0].config.isHealthy).toBe(false);
        expect(manager.providerStatus['openai-codex-oauth'][0].config.lastErrorMessage).toContain('AccountQuotaLedger');
    });
});

describe('Usage API local ledger overlay', () => {
    test('hides pending restore accounts from the visible provider list and exposes them separately', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
        ledger.applyRealUsage('openai-codex-oauth', 'hidden-1', {
            summary: {
                usedPercent: 69,
                plan: 'FREE',
                resetAt: '2030-01-02T00:00:00.000Z'
            }
        });
        ledger.recordEstimatedUsage('openai-codex-oauth', 'hidden-1', {
            model: 'gpt-5-codex',
            usage: { totalTokens: 300000 }
        });
        ledger.applyRealUsage('openai-codex-oauth', 'visible-1', {
            summary: {
                usedPercent: 10,
                plan: 'FREE',
                resetAt: '2030-01-02T00:00:00.000Z'
            }
        });

        const providerUsage = {
            instances: [
                {
                    uuid: 'hidden-1',
                    name: 'hidden-1',
                    isHealthy: true,
                    isDisabled: false,
                    success: true,
                    usage: {
                        summary: {
                            usedPercent: 69,
                            status: 'normal',
                            plan: 'FREE',
                            planClass: 'plan-free',
                            resetAt: '2030-01-02T00:00:00.000Z'
                        },
                        items: []
                    }
                },
                {
                    uuid: 'visible-1',
                    name: 'visible-1',
                    isHealthy: true,
                    isDisabled: false,
                    success: true,
                    usage: {
                        summary: {
                            usedPercent: 10,
                            status: 'normal',
                            plan: 'FREE',
                            planClass: 'plan-free',
                            resetAt: '2030-01-02T00:00:00.000Z'
                        },
                        items: []
                    }
                }
            ],
            totalCount: 2,
            successCount: 2,
            errorCount: 0
        };

        applyAccountQuotaLedgerToProviderUsage(
            'openai-codex-oauth',
            providerUsage,
            {
                providerPools: {
                    'openai-codex-oauth': [
                        { uuid: 'hidden-1', plan: 'FREE' },
                        { uuid: 'visible-1', plan: 'FREE' }
                    ]
                }
            },
            {
                providerPools: {
                    'openai-codex-oauth': [
                        { uuid: 'hidden-1', plan: 'FREE' },
                        { uuid: 'visible-1', plan: 'FREE' }
                    ]
                },
                accountQuotaLedger: ledger
            }
        );

        expect(providerUsage.instances).toHaveLength(1);
        expect(providerUsage.instances[0].uuid).toBe('visible-1');
        expect(providerUsage.pendingRestoreAccounts).toHaveLength(1);
        expect(providerUsage.pendingRestoreAccounts[0]).toMatchObject({
            providerType: 'openai-codex-oauth',
            uuid: 'hidden-1',
            reason: 'estimated_threshold',
            recoveryAt: '2030-01-02T00:00:00.000Z'
        });
    });

    test('overrides displayed usage with the local estimate', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
        ledger.applyRealUsage('openai-codex-oauth', 'view-1', {
            summary: {
                usedPercent: 64,
                plan: 'FREE',
                resetAt: '2030-01-01T00:00:00.000Z'
            }
        });
        ledger.recordEstimatedUsage('openai-codex-oauth', 'view-1', {
            model: 'custom-model',
            usage: { totalTokens: 1500000 }
        });

        const instanceResult = {
            uuid: 'view-1',
            name: 'view-1',
            isHealthy: true,
            isDisabled: false,
            success: true,
            usage: {
                summary: {
                    usedPercent: 64,
                    status: 'normal',
                    plan: 'FREE',
                    planClass: 'plan-free',
                    resetAt: '2030-01-01T00:00:00.000Z'
                },
                items: []
            },
            error: null
        };

        applyAccountQuotaLedgerToInstance(
            instanceResult,
            'openai-codex-oauth',
            { uuid: 'view-1', plan: 'FREE' },
            { accountQuotaLedger: ledger }
        );

        expect(instanceResult.success).toBe(true);
        expect(instanceResult.error).toBeNull();
        expect(instanceResult.isHealthy).toBe(false);
        expect(instanceResult.usage.summary).toMatchObject({
            usedPercent: 74,
            localUsedPercent: 74,
            lastRealUsagePercent: 64,
            thresholdPercent: 70,
            routingSkipped: true,
            routingReason: 'estimated_threshold',
            source: 'local_ledger'
        });
        expect(instanceResult.localQuotaLedger).toMatchObject({
            estimatedUsagePercent: 74,
            lastRealUsagePercent: 64,
            thresholdPercent: 70
        });
    });

    test('hides deleted ledger accounts from the visible usage list', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
        ledger.ensureAccount('openai-codex-oauth', { uuid: 'deleted-1' });
        ledger.markDeleted('openai-codex-oauth', 'deleted-1', 'auth error');

        const providerUsage = {
            instances: [
                {
                    uuid: 'deleted-1',
                    name: 'deleted-1',
                    isHealthy: false,
                    isDisabled: false,
                    success: false,
                    usage: null,
                    error: 'Unauthorized'
                }
            ],
            totalCount: 1,
            successCount: 0,
            errorCount: 1
        };

        applyAccountQuotaLedgerToProviderUsage(
            'openai-codex-oauth',
            providerUsage,
            {
                providerPools: {
                    'openai-codex-oauth': [
                        { uuid: 'deleted-1', plan: 'FREE' }
                    ]
                }
            },
            {
                providerPools: {
                    'openai-codex-oauth': [
                        { uuid: 'deleted-1', plan: 'FREE' }
                    ]
                },
                accountQuotaLedger: ledger
            }
        );

        expect(providerUsage.instances).toHaveLength(0);
        expect(providerUsage.pendingRestoreAccounts).toHaveLength(0);
    });

    test('builds a synthetic local usage view when the real query fails', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
        ledger.applyRealUsage('openai-codex-oauth', 'view-2', {
            summary: {
                usedPercent: 100,
                plan: 'FREE',
                resetAt: '2030-01-01T00:00:00.000Z'
            }
        });

        const instanceResult = {
            uuid: 'view-2',
            name: 'view-2',
            isHealthy: true,
            isDisabled: false,
            success: false,
            usage: null,
            error: 'adapter query failed'
        };

        applyAccountQuotaLedgerToInstance(
            instanceResult,
            'openai-codex-oauth',
            { uuid: 'view-2', plan: 'FREE' },
            { accountQuotaLedger: ledger }
        );

        expect(instanceResult.success).toBe(true);
        expect(instanceResult.error).toBeNull();
        expect(instanceResult.realUsageError).toBe('adapter query failed');
        expect(instanceResult.usage.summary).toMatchObject({
            usedPercent: 100,
            status: 'danger',
            routingSkipped: true,
            routingReason: 'cooldown',
            source: 'local_ledger'
        });
    });

    test('still overlays real usage when the ledger has no useful signal', () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
        ledger.ensureAccount('openai-codex-oauth', { uuid: 'fresh-1', plan: 'FREE' });

        const instanceResult = {
            uuid: 'fresh-1',
            name: 'fresh-1',
            isHealthy: true,
            isDisabled: false,
            success: true,
            usage: {
                summary: {
                    usedPercent: 42,
                    status: 'normal',
                    plan: 'FREE'
                },
                items: []
            },
            error: null
        };

        applyAccountQuotaLedgerToInstance(
            instanceResult,
            'openai-codex-oauth',
            { uuid: 'fresh-1', plan: 'FREE' },
            { accountQuotaLedger: ledger }
        );

        expect(instanceResult.usage.summary).toMatchObject({
            usedPercent: 0,
            lastRealUsagePercent: null,
            source: 'local_ledger'
        });
    });
});

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

describe('Usage API Codex Plus quota rules', () => {
    beforeEach(() => {
        readProviderUsageCache.mockReset();
        readUsageCache.mockReset();
        updateProviderUsageCache.mockReset();
        writeUsageCache.mockReset();
        for (const key of Object.keys(serviceInstances)) {
            delete serviceInstances[key];
        }
    });

    test('formats codex plus weekly usage from the secondary rate-limit window', () => {
        const usage = formatCodexUsage({
            account: 'plus@example.com',
            plan_type: 'PLUS',
            rate_limit: {
                primary_window: {
                    used_percent: 26,
                    reset_at: '2030-01-01T05:00:00.000Z'
                },
                secondary_window: {
                    used_percent: 4,
                    reset_at: '2030-01-08T00:00:00.000Z'
                }
            }
        });

        expect(usage.summary).toMatchObject({
            usedPercent: 26,
            plan: 'PLUS',
            planClass: 'plan-plus'
        });
        expect(usage.items).toEqual([
            expect.objectContaining({
                id: 'primary_window',
                label: 'Request Quota (5h)',
                percent: 26,
                unit: 'percent'
            }),
            expect.objectContaining({
                id: 'secondary_window',
                label: 'Weekly Limit',
                percent: 4,
                resetAt: '2030-01-08T00:00:00.000Z',
                unit: 'percent'
            })
        ]);
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
        const tempDir = mkdtempSync(join(tmpdir(), 'aiclient2api-codex-plus-'));
        const credentialPath = join(tempDir, 'codex-plus-creds.json');
        writeFileSync(credentialPath, JSON.stringify({
            email: 'plus@example.com',
            account_id: 'acct-plus',
            plan_type: 'PLUS'
        }));

        try {
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
                PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
                providerPools: {
                    'openai-codex-oauth-plus': [
                        {
                            uuid: 'plus-pool-1',
                            isDisabled: false,
                            CODEX_OAUTH_CREDS_FILE_PATH: credentialPath
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
                name: 'plus@example.com',
                configFilePath: credentialPath,
                success: true,
                localUsagePlaceholder: true,
                usage: {
                    summary: {
                        plan: 'PLUS',
                        source: 'provider_pool_placeholder'
                    },
                    user: {
                        email: 'plus@example.com',
                        accountId: 'acct-plus'
                    }
                }
            });
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('usage response marks quota rules disabled when ledger is disabled', async () => {
        readUsageCache.mockResolvedValue(null);
        writeUsageCache.mockResolvedValue(undefined);

        const ledger = new AccountQuotaLedger({
            enabled: false,
            autoLoad: false
        });
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
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

    test('single codex plus refresh stores real weekly usage in provider cache', async () => {
        const providerType = 'openai-codex-oauth-plus';
        const uuid = 'plus-1';
        const rawUsage = {
            account: 'plus@example.com',
            plan_type: 'PLUS',
            rate_limit: {
                primary_window: {
                    used_percent: 26,
                    reset_at: '2030-01-01T05:00:00.000Z'
                },
                secondary_window: {
                    used_percent: 4,
                    reset_at: '2030-01-08T00:00:00.000Z'
                }
            }
        };

        readProviderUsageCache.mockResolvedValue({
            providerType,
            instances: [
                {
                    uuid,
                    name: 'plus-placeholder',
                    isHealthy: true,
                    isDisabled: false,
                    success: true,
                    usage: {
                        summary: {
                            usedPercent: 0,
                            source: 'provider_pool_placeholder',
                            isPlaceholder: true
                        },
                        items: [],
                        raw: null
                    },
                    error: null,
                    localUsagePlaceholder: true
                }
            ]
        });
        updateProviderUsageCache.mockResolvedValue(undefined);
        serviceInstances[`${providerType}${uuid}`] = {
            getUsageLimits: jest.fn().mockResolvedValue(rawUsage)
        };

        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
            providerPools: {
                [providerType]: [
                    {
                        uuid,
                        isDisabled: false,
                        CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex-plus/plus-1.json'
                    }
                ]
            }
        };
        const providerPoolManager = {
            providerPools: currentConfig.providerPools
        };
        const req = {
            method: 'GET',
            url: `/api/usage/${providerType}/${uuid}?refresh=true`,
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
        expect(res.statusCode).toBe(200);
        expect(body.usage.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'secondary_window', label: 'Weekly Limit', percent: 4 })
        ]));
        expect(updateProviderUsageCache).toHaveBeenCalledTimes(1);
        expect(updateProviderUsageCache.mock.calls[0][0]).toBe(providerType);

        const cachedProviderUsage = updateProviderUsageCache.mock.calls[0][1];
        const cachedInstance = cachedProviderUsage.instances.find(instance => instance.uuid === uuid);
        expect(cachedProviderUsage).toMatchObject({
            providerType,
            totalCount: 1,
            successCount: 1,
            errorCount: 0,
            localPlaceholderCount: 0
        });
        expect(cachedInstance.localUsagePlaceholder).toBeUndefined();
        expect(cachedInstance).toMatchObject({
            uuid,
            success: true,
            usage: {
                raw: rawUsage
            }
        });
        expect(cachedInstance.usage.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'secondary_window',
                label: 'Weekly Limit',
                percent: 4
            })
        ]));
    });
});

describe('Usage API provider-pool synchronization', () => {
    beforeEach(() => {
        readUsageCache.mockReset();
        writeUsageCache.mockReset();
    });

    test('sync endpoint returns local placeholder data and does not query real usage', async () => {
        readUsageCache.mockResolvedValue(null);
        writeUsageCache.mockResolvedValue(undefined);

        const req = {
            method: 'POST',
            url: '/api/usage/sync-provider-pool',
            headers: { host: 'localhost:3000' }
        };
        const res = {
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
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
            providerPools: {
                'openai-codex-oauth': [
                    {
                        uuid: 'pool-only-1',
                        isDisabled: false,
                        plan: 'PLUS',
                        CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/pool-only.json'
                    }
                ]
            }
        };

        const handled = await handleSyncProviderPoolUsage(req, res, currentConfig, null);
        const body = JSON.parse(res.body);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(body.syncStats).toEqual({
            poolTotalCount: 1,
            activePoolCount: 1,
            disabledSkippedCount: 0,
            existingCount: 0,
            addedCount: 1,
            syncedCount: 1
        });
        expect(body.quotaRules).toEqual({ enabled: false });
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

    test('sync endpoint writes unfiltered cache while applying ledger overlay only to response', async () => {
        const ledger = new AccountQuotaLedger({ enabled: true, autoLoad: false });
        ledger.applyRealUsage('openai-codex-oauth', 'hidden-1', {
            summary: {
                usedPercent: 69,
                plan: 'FREE',
                resetAt: '2030-01-02T00:00:00.000Z'
            }
        });
        ledger.recordEstimatedUsage('openai-codex-oauth', 'hidden-1', {
            model: 'gpt-5-codex',
            usage: { totalTokens: 300000 }
        });
        ledger.applyRealUsage('openai-codex-oauth', 'visible-1', {
            summary: {
                usedPercent: 10,
                plan: 'FREE',
                resetAt: '2030-01-02T00:00:00.000Z'
            }
        });

        const cachedUsage = {
            timestamp: '2030-01-01T00:00:00.000Z',
            providers: {
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    instances: [
                        {
                            uuid: 'hidden-1',
                            name: 'hidden-1',
                            isHealthy: true,
                            isDisabled: false,
                            success: true,
                            usage: {
                                summary: {
                                    usedPercent: 69,
                                    status: 'normal',
                                    plan: 'FREE',
                                    planClass: 'plan-free',
                                    resetAt: '2030-01-02T00:00:00.000Z'
                                },
                                items: []
                            },
                            error: null
                        },
                        {
                            uuid: 'visible-1',
                            name: 'visible-1',
                            isHealthy: true,
                            isDisabled: false,
                            success: true,
                            usage: {
                                summary: {
                                    usedPercent: 10,
                                    status: 'normal',
                                    plan: 'FREE',
                                    planClass: 'plan-free',
                                    resetAt: '2030-01-02T00:00:00.000Z'
                                },
                                items: []
                            },
                            error: null
                        }
                    ]
                }
            }
        };
        readUsageCache.mockResolvedValue(cachedUsage);
        writeUsageCache.mockResolvedValue(undefined);

        const req = {
            method: 'POST',
            url: '/api/usage/sync-provider-pool',
            headers: { host: 'localhost:3000' }
        };
        const res = {
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
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
            providerPools: {
                'openai-codex-oauth': [
                    { uuid: 'hidden-1', isDisabled: false, plan: 'FREE' },
                    { uuid: 'visible-1', isDisabled: false, plan: 'FREE' }
                ]
            }
        };
        const providerPoolManager = {
            providerPools: currentConfig.providerPools,
            accountQuotaLedger: ledger
        };

        await handleSyncProviderPoolUsage(req, res, currentConfig, providerPoolManager);

        const cachedPayload = writeUsageCache.mock.calls[0][0];
        const cachedUuids = cachedPayload.providers['openai-codex-oauth'].instances.map(instance => instance.uuid);
        const body = JSON.parse(res.body);
        const visibleUuids = body.providers['openai-codex-oauth'].instances.map(instance => instance.uuid);

        expect(cachedUuids).toEqual(['hidden-1', 'visible-1']);
        expect(visibleUuids).toEqual(['visible-1']);
        expect(body.providers['openai-codex-oauth'].pendingRestoreAccounts[0]).toMatchObject({
            providerType: 'openai-codex-oauth',
            uuid: 'hidden-1',
            reason: 'estimated_threshold'
        });
    });

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
                                    usedPercent: 12,
                                    status: 'normal',
                                    plan: 'FREE',
                                    planClass: 'plan-free',
                                    unit: 'percent'
                                },
                                user: { email: 'cached@example.com' },
                                items: []
                            },
                            error: null
                        }
                    ]
                }
            }
        };
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
            providerPools: {
                'openai-codex-oauth': [
                    { uuid: 'cached-1', isDisabled: false },
                    { uuid: 'new-1', isDisabled: false },
                    { uuid: 'disabled-1', isDisabled: true }
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

    test('adds local placeholder usage entries for provider-pool nodes missing from cache', () => {
        const providerUsage = {
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
                            usedPercent: 12,
                            status: 'normal',
                            plan: 'FREE',
                            planClass: 'plan-free',
                            unit: 'percent'
                        },
                        user: { email: 'cached@example.com' },
                        items: []
                    },
                    error: null
                }
            ]
        };

        const synced = syncProviderUsageWithProviderPool(
            'openai-codex-oauth',
            providerUsage,
            {
                providerPools: {
                    'openai-codex-oauth': [
                        { uuid: 'cached-1', CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/cached.json' },
                        { uuid: 'new-1', CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/new.json' }
                    ]
                }
            },
            null
        );

        expect(synced.instances).toHaveLength(2);
        expect(synced.totalCount).toBe(2);
        expect(synced.successCount).toBe(2);
        expect(synced.localPlaceholderCount).toBe(1);
        expect(synced.instances[0]).toMatchObject({
            uuid: 'cached-1',
            success: true
        });
        expect(synced.instances[1]).toMatchObject({
            uuid: 'new-1',
            success: true,
            localUsagePlaceholder: true,
            usage: {
                summary: {
                    usedPercent: 0,
                    source: 'provider_pool_placeholder',
                    isPlaceholder: true
                }
            }
        });
    });

    test('builds a local usage snapshot from provider pools when no usage cache exists', () => {
        const synced = syncUsageResultsWithProviderPools(
            {
                timestamp: '2030-01-01T00:00:00.000Z',
                providers: {}
            },
            {
                PROVIDER_POOLS_FILE_PATH: TEST_PROVIDER_POOLS_FILE_PATH,
                providerPools: {
                    'openai-codex-oauth': [
                        {
                            uuid: 'pool-only-1',
                            CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/pool-only.json',
                            plan: 'PLUS'
                        }
                    ]
                }
            },
            null
        );

        expect(synced.providers['openai-codex-oauth'].instances).toHaveLength(1);
        expect(synced.providers['openai-codex-oauth'].instances[0]).toMatchObject({
            uuid: 'pool-only-1',
            success: true,
            localUsagePlaceholder: true,
            usage: {
                summary: {
                    usedPercent: 0,
                    plan: 'PLUS',
                    planClass: 'plan-plus',
                    source: 'provider_pool_placeholder'
                }
            }
        });
        expect(synced.syncedFromProviderPool).toBe(true);
        expect(synced.localPlaceholderCount).toBe(1);
    });
});
