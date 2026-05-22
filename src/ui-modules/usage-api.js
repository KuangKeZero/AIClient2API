import { CONFIG } from '../core/config-manager.js';
import logger from '../utils/logger.js';
import { serviceInstances, getServiceAdapter } from '../providers/adapter.js';
import { usageService } from '../services/usage-service.js';
import { readUsageCache, writeUsageCache, readProviderUsageCache, updateProviderUsageCache } from './usage-cache.js';
import { PROVIDER_MAPPINGS } from '../utils/provider-utils.js';
import { MODEL_PROVIDER } from '../utils/common.js';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

const CODEX_PLUS_PROVIDER = `${MODEL_PROVIDER.CODEX_API}-plus`;

const supportedProviders = [
    MODEL_PROVIDER.KIRO_API,
    MODEL_PROVIDER.GEMINI_CLI,
    MODEL_PROVIDER.ANTIGRAVITY,
    MODEL_PROVIDER.CODEX_API,
    CODEX_PLUS_PROVIDER,
    MODEL_PROVIDER.GROK_WEB
];

function clampPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(100, Math.max(0, numeric));
}

function getLocalUsageStatus(percent) {
    if (percent > 90) return 'danger';
    if (percent > 70) return 'warning';
    return 'normal';
}

function getLocalPlanClass(plan) {
    if (!plan) return 'plan-default';
    const normalized = String(plan).toLowerCase();
    if (normalized.includes('free')) return 'plan-free';
    if (normalized.includes('pro+') || normalized.includes('pro +')) return 'plan-pro-plus';
    if (normalized.includes('pro')) return 'plan-pro';
    if (normalized.includes('plus') || normalized.includes('+')) return 'plan-plus';
    if (normalized.includes('team') || normalized.includes('ent')) return 'plan-team';
    if (normalized.includes('basic')) return 'plan-basic';
    if (normalized.includes('super')) return 'plan-super';
    if (normalized.includes('heavy')) return 'plan-heavy';
    if (normalized.includes('standard')) return 'plan-standard';
    return 'plan-default';
}

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

function hasUsefulLedgerSignal(account) {
    if (!account) return false;
    if (account.lastRealUsagePercent !== null && account.lastRealUsagePercent !== undefined) return true;
    if (Number(account.estimatedUsagePercent || 0) > 0) return true;
    if (account.resetAt || account.disabledUntil || account.deletedAt) return true;
    if ((account.recent401 || []).length > 0 || (account.recent429 || []).length > 0) return true;
    return false;
}

function buildLedgerSnapshot(ledger, providerType, provider, now) {
    if (!ledger?.enabled || !provider?.uuid) return null;

    const account = ledger.getAccount(providerType, provider.uuid) || ledger.ensureAccount(providerType, provider, now);
    if (!account) return null;

    const decision = ledger.getRoutingDecision(providerType, provider, now);
    const threshold = ledger.getThresholdForAccount(account);
    const estimatedUsagePercent = clampPercent(account.estimatedUsagePercent);
    const lastRealUsagePercent = account.lastRealUsagePercent === null || account.lastRealUsagePercent === undefined
        ? null
        : clampPercent(account.lastRealUsagePercent);

    return {
        account,
        decision,
        threshold,
        estimatedUsagePercent,
        lastRealUsagePercent
    };
}

function buildActiveProviderKeySet(currentConfig, providerPoolManager) {
    const providerTypes = new Set([
        ...supportedProviders,
        ...Object.keys(providerPoolManager?.providerPools || {}),
        ...Object.keys(currentConfig?.providerPools || {})
    ]);
    const activeKeys = new Set();

    for (const providerType of providerTypes) {
        for (const provider of loadProviderList(providerType, currentConfig, providerPoolManager)) {
            if (provider?.uuid) activeKeys.add(`${providerType}:${provider.uuid}`);
        }
    }

    return activeKeys;
}

function getPendingRestoreAccounts(currentConfig, providerPoolManager, now = Date.now()) {
    const ledger = providerPoolManager?.accountQuotaLedger;
    if (!ledger?.enabled || typeof ledger.getPendingRestoreAccounts !== 'function') {
        return [];
    }

    const activeKeys = buildActiveProviderKeySet(currentConfig, providerPoolManager);
    return ledger
        .getPendingRestoreAccounts(null, now)
        .filter(account => activeKeys.size === 0 || activeKeys.has(`${account.providerType}:${account.uuid}`));
}

function attachAccountQuotaLedgerSummary(target, currentConfig, providerPoolManager, now = Date.now()) {
    if (!target || !providerPoolManager?.accountQuotaLedger?.enabled) return target;

    const pendingRestoreAccounts = getPendingRestoreAccounts(currentConfig, providerPoolManager, now);
    target.pendingRestoreAccounts = pendingRestoreAccounts;
    target.pendingRestoreCount = pendingRestoreAccounts.length;
    return target;
}

/**
 * 将本地额度账本叠加到用量查询实例结果上。
 *
 * 用量页面展示 `usage.summary.usedPercent`，所以这里把显示值切到本地估算，
 * 同时保留真实查询的原始数据和 `lastRealUsagePercent` 供排查。
 */
export function applyAccountQuotaLedgerToInstance(instanceResult, providerType, provider, providerPoolManager, now = Date.now()) {
    const ledger = providerPoolManager?.accountQuotaLedger;
    const snapshot = buildLedgerSnapshot(ledger, providerType, provider, now);
    if (!snapshot) return instanceResult;

    const { account, decision, threshold, estimatedUsagePercent, lastRealUsagePercent } = snapshot;
    const recovery = ledger.getRecoveryInfo(account, now);
    const hiddenFromUsageList = !!decision.skip || !!account.deletedAt;
    const existingUsage = instanceResult.usage || null;
    const shouldCreateLocalUsage = !existingUsage && !provider?.isDisabled && hasUsefulLedgerSignal(account);
    const isProviderPoolPlaceholder = !!(
        instanceResult.localUsagePlaceholder ||
        existingUsage?.summary?.source === 'provider_pool_placeholder' ||
        existingUsage?.summary?.isPlaceholder
    );
    if (existingUsage && isProviderPoolPlaceholder && !hasUsefulLedgerSignal(account) && !decision.skip && !account.deletedAt) {
        return instanceResult;
    }
    if (!existingUsage && !shouldCreateLocalUsage) {
        instanceResult.localQuotaLedger = {
            estimatedUsagePercent,
            lastRealUsagePercent,
            thresholdPercent: threshold,
            confidence: Number(account.confidence || 0),
            resetAt: account.resetAt || null,
            disabledUntil: account.disabledUntil || null,
            recoveryAt: recovery.recoveryAt,
            recoverySource: recovery.recoverySource,
            routingSkipped: !!decision.skip,
            routingReason: decision.reason || null,
            hiddenFromUsageList
        };
        instanceResult.hiddenFromUsageList = hiddenFromUsageList;
        return instanceResult;
    }

    if (!existingUsage && shouldCreateLocalUsage) {
        instanceResult.realUsageError = instanceResult.error || null;
        instanceResult.error = null;
        instanceResult.success = true;
        instanceResult.usage = {
            summary: {},
            user: {},
            items: []
        };
    }

    const usage = instanceResult.usage || {};
    const existingSummary = usage.summary || {};
    const displayResetAt = account.resetAt || (
        account.refresh?.lastReason === 'reset_window_elapsed'
            ? null
            : existingSummary.resetAt || null
    );
    const plan = account.plan || existingSummary.plan || null;
    const localStatus = getLocalUsageStatus(estimatedUsagePercent);
    const ledgerSummary = {
        ...existingSummary,
        usedPercent: estimatedUsagePercent,
        localUsedPercent: estimatedUsagePercent,
        lastRealUsagePercent,
        confidence: Number(account.confidence || 0),
        thresholdPercent: threshold,
        resetAt: displayResetAt,
        disabledUntil: account.disabledUntil || null,
        recoveryAt: recovery.recoveryAt,
        recoverySource: recovery.recoverySource,
        routingSkipped: !!decision.skip,
        routingReason: decision.reason || null,
        hiddenFromUsageList,
        status: localStatus,
        plan,
        planClass: plan ? getLocalPlanClass(plan) : existingSummary.planClass || 'plan-default',
        unit: 'percent',
        source: 'local_ledger'
    };

    instanceResult.usage = {
        ...usage,
        summary: ledgerSummary,
        localQuotaLedger: {
            estimatedUsagePercent,
            lastRealUsagePercent,
            thresholdPercent: threshold,
            confidence: Number(account.confidence || 0),
            resetAt: account.resetAt || null,
            disabledUntil: account.disabledUntil || null,
            recoveryAt: recovery.recoveryAt,
            recoverySource: recovery.recoverySource,
            deletedAt: account.deletedAt || null,
            recent401Count: (account.recent401 || []).length,
            recent429Count: (account.recent429 || []).length,
            refresh: account.refresh || null,
            routingSkipped: !!decision.skip,
            routingReason: decision.reason || null,
            refreshReason: decision.refreshReason || null,
            hiddenFromUsageList
        }
    };

    instanceResult.localQuotaLedger = instanceResult.usage.localQuotaLedger;
    instanceResult.hiddenFromUsageList = hiddenFromUsageList;
    if (decision.skip || account.deletedAt) {
        instanceResult.isHealthy = false;
    }

    return instanceResult;
}

export function applyAccountQuotaLedgerToProviderUsage(providerType, providerUsage, currentConfig, providerPoolManager, now = Date.now()) {
    if (!providerUsage?.instances || !providerPoolManager?.accountQuotaLedger?.enabled) {
        return providerUsage;
    }

    const providers = loadProviderList(providerType, currentConfig, providerPoolManager);
    const providerByUuid = new Map(providers.map(provider => [provider.uuid, provider]));
    const visibleInstances = [];
    const hiddenInstances = [];

    for (const instance of providerUsage.instances) {
        const provider = providerByUuid.get(instance.uuid) || { uuid: instance.uuid };
        applyAccountQuotaLedgerToInstance(instance, providerType, provider, providerPoolManager, now);
        if (instance.hiddenFromUsageList || instance.localQuotaLedger?.hiddenFromUsageList) {
            hiddenInstances.push(instance);
        } else {
            visibleInstances.push(instance);
        }
    }

    providerUsage.instances = visibleInstances;
    providerUsage.visibleCount = visibleInstances.length;
    providerUsage.hiddenCount = hiddenInstances.length;
    providerUsage.pendingRestoreAccounts = providerPoolManager.accountQuotaLedger
        .getPendingRestoreAccounts(providerType, now)
        .filter(account => providerByUuid.has(account.uuid));
    providerUsage.pendingRestoreCount = providerUsage.pendingRestoreAccounts.length;
    providerUsage.successCount = visibleInstances.filter(instance => instance.success).length;
    providerUsage.errorCount = visibleInstances.filter(instance => !instance.success).length;
    return providerUsage;
}

function applyAccountQuotaLedgerToUsageResults(usageResults, currentConfig, providerPoolManager) {
    if (!usageResults?.providers || !providerPoolManager?.accountQuotaLedger?.enabled) {
        return usageResults;
    }

    const now = Date.now();
    for (const [providerType, providerUsage] of Object.entries(usageResults.providers)) {
        applyAccountQuotaLedgerToProviderUsage(providerType, providerUsage, currentConfig, providerPoolManager, now);
    }
    attachAccountQuotaLedgerSummary(usageResults, currentConfig, providerPoolManager, now);
    return usageResults;
}

function cloneUsagePayload(payload) {
    if (typeof structuredClone === 'function') {
        return structuredClone(payload);
    }

    return JSON.parse(JSON.stringify(payload));
}

function getProviderCredentialMetadata(provider, providerType) {
    const configFilePath = getProviderConfigFilePath(provider, providerType);
    if (!configFilePath) return {};

    const absolutePath = path.isAbsolute(configFilePath)
        ? configFilePath
        : path.join(process.cwd(), configFilePath);

    try {
        if (!existsSync(absolutePath)) return {};
        const credential = JSON.parse(readFileSync(absolutePath, 'utf-8'));
        return {
            email: credential.email || credential.account || null,
            accountId: credential.account_id || credential.accountId || null,
            plan: credential.plan_type || credential.planType || credential.plan || null
        };
    } catch (error) {
        logger.warn(`[Usage API] Failed to read credential metadata for ${providerType}: ${error.message}`);
        return {};
    }
}

function createProviderPoolUsagePlaceholder(providerType, provider) {
    const metadata = getProviderCredentialMetadata(provider, providerType);
    const plan = provider.plan || provider.planType || metadata.plan || null;
    const email = provider.email || provider.CODEX_EMAIL || metadata.email || null;

    return {
        uuid: provider.uuid || 'unknown',
        name: email || getProviderDisplayName(provider, providerType),
        configFilePath: getProviderConfigFilePath(provider, providerType),
        isHealthy: provider.isHealthy !== false,
        isDisabled: provider.isDisabled === true,
        success: true,
        usage: {
            summary: {
                usedPercent: 0,
                status: 'normal',
                resetAt: null,
                plan,
                planClass: plan ? getLocalPlanClass(plan) : 'plan-default',
                unit: 'percent',
                source: 'provider_pool_placeholder',
                isPlaceholder: true
            },
            user: {
                email,
                accountId: metadata.accountId || provider.accountId || provider.account_id || null
            },
            items: [],
            raw: null
        },
        error: null,
        localUsagePlaceholder: true
    };
}

function refreshCachedInstanceProviderFields(instance, providerType, provider) {
    return {
        ...instance,
        name: instance.name || getProviderDisplayName(provider, providerType),
        configFilePath: getProviderConfigFilePath(provider, providerType) || instance.configFilePath || null,
        isHealthy: provider.isHealthy !== false,
        isDisabled: provider.isDisabled === true
    };
}

function updateProviderUsageCounts(providerUsage) {
    const instances = Array.isArray(providerUsage.instances) ? providerUsage.instances : [];
    providerUsage.totalCount = instances.length;
    providerUsage.successCount = instances.filter(instance => instance.success).length;
    providerUsage.errorCount = instances.filter(instance => !instance.success).length;
    providerUsage.localPlaceholderCount = instances
        .filter(instance => instance.localUsagePlaceholder || instance.usage?.summary?.isPlaceholder)
        .length;
    return providerUsage;
}

async function updateSingleInstanceUsageCache(providerType, provider, instanceResult, currentConfig, providerPoolManager) {
    if (!instanceResult?.success || !instanceResult.usage || !provider?.uuid) return;

    try {
        const cachedData = await readProviderUsageCache(providerType);
        const providerUsageInput = {
            ...(cachedData || {}),
            providerType,
            instances: Array.isArray(cachedData?.instances)
                ? cloneUsagePayload(cachedData.instances)
                : []
        };
        delete providerUsageInput.fromCache;
        delete providerUsageInput.cachedAt;

        const providerUsage = syncProviderUsageWithProviderPool(
            providerType,
            providerUsageInput,
            currentConfig,
            providerPoolManager
        );

        const refreshedInstance = {
            uuid: provider.uuid,
            name: getProviderDisplayName(provider, providerType),
            configFilePath: getProviderConfigFilePath(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            success: true,
            usage: instanceResult.usage,
            error: null
        };

        const instanceIndex = providerUsage.instances.findIndex(instance => instance.uuid === provider.uuid);
        if (instanceIndex >= 0) {
            providerUsage.instances[instanceIndex] = refreshedInstance;
        } else {
            providerUsage.instances.push(refreshedInstance);
        }

        await updateProviderUsageCache(providerType, updateProviderUsageCounts(providerUsage));
    } catch (error) {
        logger.warn(`[Usage API] Failed to update usage cache for ${providerType}:${provider.uuid}: ${error.message}`);
    }
}

export function syncProviderUsageWithProviderPool(providerType, providerUsage = {}, currentConfig, providerPoolManager) {
    const providers = loadProviderList(providerType, currentConfig, providerPoolManager);
    const existingInstances = Array.isArray(providerUsage.instances) ? providerUsage.instances : [];

    if (providers.length === 0) {
        providerUsage.providerType = providerUsage.providerType || providerType;
        providerUsage.instances = existingInstances;
        return updateProviderUsageCounts(providerUsage);
    }

    const existingByUuid = new Map(
        existingInstances
            .filter(instance => instance?.uuid)
            .map(instance => [instance.uuid, instance])
    );

    let placeholderCount = 0;
    providerUsage.providerType = providerUsage.providerType || providerType;
    providerUsage.instances = providers.map(provider => {
        const existing = provider.uuid ? existingByUuid.get(provider.uuid) : null;
        if (existing) {
            return refreshCachedInstanceProviderFields(existing, providerType, provider);
        }

        placeholderCount++;
        return createProviderPoolUsagePlaceholder(providerType, provider);
    });

    providerUsage.localPlaceholderCount = providerUsage.instances
        .filter(instance => instance.localUsagePlaceholder || instance.usage?.summary?.isPlaceholder)
        .length;
    providerUsage.addedPlaceholderCount = placeholderCount;
    providerUsage.syncedFromProviderPool = true;
    return updateProviderUsageCounts(providerUsage);
}

export function syncUsageResultsWithProviderPools(usageResults = {}, currentConfig, providerPoolManager, options = {}) {
    const providerTypes = options.providerTypes || supportedProviders;
    const syncedResults = {
        ...usageResults,
        cachedTimestamp: usageResults.cachedTimestamp || usageResults.timestamp || null,
        timestamp: new Date().toISOString(),
        providers: {
            ...(usageResults.providers || {})
        }
    };

    let totalAddedPlaceholders = 0;
    for (const providerType of providerTypes) {
        const existingProviderUsage = syncedResults.providers[providerType];
        const providers = loadProviderList(providerType, currentConfig, providerPoolManager);
        if (!existingProviderUsage && providers.length === 0) continue;

        const providerUsageInput = existingProviderUsage
            ? {
                ...existingProviderUsage,
                instances: Array.isArray(existingProviderUsage.instances)
                    ? [...existingProviderUsage.instances]
                    : []
            }
            : { providerType, instances: [] };
        const providerUsage = syncProviderUsageWithProviderPool(
            providerType,
            providerUsageInput,
            currentConfig,
            providerPoolManager
        );

        totalAddedPlaceholders += providerUsage.addedPlaceholderCount || 0;
        syncedResults.providers[providerType] = providerUsage;
    }

    syncedResults.syncedFromProviderPool = true;
    syncedResults.localPlaceholderCount = Object.values(syncedResults.providers)
        .reduce((sum, providerUsage) => sum + Number(providerUsage.localPlaceholderCount || 0), 0);
    syncedResults.addedPlaceholderCount = totalAddedPlaceholders;

    return syncedResults;
}

function collectActiveUsageKeys(usageResults = {}) {
    const activeKeys = new Set();

    for (const [providerType, providerUsage] of Object.entries(usageResults.providers || {})) {
        const instances = Array.isArray(providerUsage?.instances) ? providerUsage.instances : [];
        for (const instance of instances) {
            if (instance?.uuid && instance.isDisabled !== true) {
                activeKeys.add(`${providerType}:${instance.uuid}`);
            }
        }
    }

    return activeKeys;
}

function collectProviderPoolKeys(currentConfig, providerPoolManager) {
    const allKeys = new Set();
    const activeKeys = new Set();
    const disabledKeys = new Set();

    for (const providerType of supportedProviders) {
        for (const provider of loadProviderList(providerType, currentConfig || {}, providerPoolManager)) {
            if (!provider?.uuid) continue;

            const key = `${providerType}:${provider.uuid}`;
            allKeys.add(key);
            if (provider.isDisabled === true) {
                disabledKeys.add(key);
            } else {
                activeKeys.add(key);
            }
        }
    }

    return { allKeys, activeKeys, disabledKeys };
}

export function buildProviderPoolUsageSyncStats(beforeUsage, afterUsage, currentConfig, providerPoolManager) {
    const beforeActiveUsageKeys = collectActiveUsageKeys(beforeUsage);
    const afterActiveUsageKeys = collectActiveUsageKeys(afterUsage);
    const { allKeys, activeKeys, disabledKeys } = collectProviderPoolKeys(currentConfig, providerPoolManager);

    let existingCount = 0;
    let syncedCount = 0;

    for (const key of activeKeys) {
        if (beforeActiveUsageKeys.has(key)) existingCount++;
        if (afterActiveUsageKeys.has(key)) syncedCount++;
    }

    return {
        poolTotalCount: allKeys.size,
        activePoolCount: activeKeys.size,
        disabledSkippedCount: disabledKeys.size,
        existingCount,
        addedCount: Math.max(0, syncedCount - existingCount),
        syncedCount
    };
}

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


/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
async function getAllProvidersUsage(currentConfig, providerPoolManager, options = {}) {
    const results = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    // 并发获取所有提供商的用量数据
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, options);
            return { providerType, data: providerUsage, success: true };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    instances: []
                },
                success: false
            };
        }
    });

    // 等待所有并发请求完成
    const usageResults = await Promise.all(usagePromises);

    // 将结果整合到 results.providers 中
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
    }

    return results;
}

/**
 * 加载提供商池数据（从内存或文件）
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Array} 提供商列表
 */
function loadProviderList(providerType, currentConfig, providerPoolManager) {
    // 优先从内存获取
    const managerPools = providerPoolManager?.providerPools;
    const configPools = currentConfig?.providerPools;
    if (managerPools && Object.prototype.hasOwnProperty.call(managerPools, providerType)) {
        return providerPoolManager.providerPools[providerType];
    }
    if (configPools && Object.prototype.hasOwnProperty.call(configPools, providerType)) {
        return currentConfig.providerPools[providerType];
    }

    // Fallback: 从文件读取
    const filePath = currentConfig?.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            if (poolsData[providerType] && poolsData[providerType].length > 0) {
                logger.info(`[Usage API] Loaded ${poolsData[providerType].length} providers for ${providerType} from file fallback`);
                return poolsData[providerType];
            }
        }
    } catch (fileError) {
        logger.warn(`[Usage API] Failed to load provider pools from file: ${fileError.message}`);
    }
    return [];
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 提供商用量信息
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager, options = {}) {
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // 获取提供商池中的所有实例（使用统一的加载函数）
    const providers = loadProviderList(providerType, currentConfig, providerPoolManager);

    result.totalCount = providers.length;

    // 遍历所有提供商实例获取用量
    for (const provider of providers) {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];
        
        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            configFilePath: getProviderConfigFilePath(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            success: false,
            usage: null,
            error: null
        };

        // First check if disabled, skip initialization for disabled providers
        if (provider.isDisabled) {
            instanceResult.error = 'Provider is disabled';
            result.errorCount++;
        } else if (!adapter) {
            // Service instance not initialized, try auto-initialization
            try {
                logger.info(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
                // Build configuration object
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                logger.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                result.errorCount++;
            }
        }
        
        // If adapter exists (including just initialized), and no error, try to get usage
        if (adapter && !instanceResult.error) {
            try {
                const usage = await usageService.getFormattedUsage(providerType, provider.uuid);
                instanceResult.success = true;
                instanceResult.usage = usage;
                if (options.recordRealUsage && providerPoolManager?.accountQuotaLedger?.enabled) {
                    providerPoolManager.accountQuotaLedger.applyRealUsage(providerType, provider.uuid, usage);
                }
                result.successCount++;
            } catch (error) {
                instanceResult.error = error.message;
                const failure = providerPoolManager?.recordAccountRequestFailure?.(providerType, provider.uuid, error, {
                    source: 'usage_query'
                });
                if (options.deleteAuthFailures && failure?.handled && (failure.status === 401 || failure.status === 403) && !failure.deleted) {
                    providerPoolManager.removeProvider?.(providerType, provider.uuid, `usage query ${failure.status}`);
                }
                result.errorCount++;
            }
        }

        result.instances.push(instanceResult);
    }

    return result;
}

/**
 * 获取提供商显示名称

 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function resolveProviderMapping(providerType) {
    return PROVIDER_MAPPINGS.find(mapping => mapping.providerType === providerType)
        || PROVIDER_MAPPINGS.find(mapping =>
            typeof providerType === 'string' && providerType.startsWith(`${mapping.providerType}-`)
        )
        || null;
}

function getProviderDisplayName(provider, providerType) {
    // 1. 优先使用自定义名称
    if (provider.customName) {
        return provider.customName;
    }

    // 2. 尝试从凭据文件路径提取名称（自动从文件名识别账号）
    const mapping = resolveProviderMapping(providerType);
    const credPathKey = mapping ? mapping.credPathKey : null;

    // 只有当键名包含 'PATH' 或 'FILE' 时，才将其视为文件路径进行解析
    if (credPathKey && provider[credPathKey] && (credPathKey.includes('PATH') || credPathKey.includes('FILE'))) {
        const filePath = provider[credPathKey];
        // 提取文件名（不含扩展名）作为显示名称，例如 account-a.json -> account-a
        const fileName = path.basename(filePath, path.extname(filePath));
        if (fileName) return fileName;
    }

    // 3. 兜底显示 UUID
    if (provider.uuid) {
        return provider.uuid;
    }

    return 'Unnamed';
}

/**
 * 获取提供商配置文件路径
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string|null} 配置文件路径
 */
function getProviderConfigFilePath(provider, providerType) {
    const mapping = resolveProviderMapping(providerType);
    const credPathKey = mapping ? mapping.credPathKey : null;

    // 只有当键名包含 'PATH' 或 'FILE' 时，才返回路径
    if (credPathKey && provider[credPathKey] && (credPathKey.includes('PATH') || credPathKey.includes('FILE'))) {
        return provider[credPathKey];
    }
    return null;
}

/**
 * 重新格式化用量结果（基于保存的原始数据）
 * 确保即使格式化逻辑改变，缓存数据也能以最新格式返回
 * @param {Object} results - 用量结果对象
 */
function reformatUsageResults(results) {
    if (!results || !results.providers) return;
    
    for (const [providerType, providerData] of Object.entries(results.providers)) {
        if (providerData.instances && Array.isArray(providerData.instances)) {
            for (const instance of providerData.instances) {
                // 如果有原始数据（保存在 usage.raw 中），重新执行格式化
                if (instance.success && instance.usage && instance.usage.raw) {
                    try {
                        instance.usage = usageService.formatUsage(providerType, instance.usage.raw);
                    } catch (err) {
                        logger.error(`[Usage API] Failed to re-format cached data for ${providerType}:`, err.message);
                    }
                }
            }
        }
    }
}

/**
 * 获取支持用量查询的提供商列表
 */
export async function handleGetSupportedProviders(req, res) {
    try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(supportedProviders));
        return true;
    } catch (error) {
        logger.error('[Usage API] Failed to get supported providers:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get supported providers: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取所有提供商的用量限制
 */
export async function handleGetUsage(req, res, currentConfig, providerPoolManager) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        
        let usageResults;
        
        if (!refresh) {
            // 优先读取缓存
            const cachedData = await readUsageCache();
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
                logger.info('[Usage API] No usage cache found; returning local provider-pool snapshot');
                usageResults = syncUsageResultsWithProviderPools(
                    {
                        timestamp: new Date().toISOString(),
                        providers: {},
                        fromLocalProviderPool: true
                    },
                    currentConfig,
                    providerPoolManager
                );
                applyAccountQuotaLedgerToUsageResults(usageResults, currentConfig, providerPoolManager);
            }
        }
        
        if (!usageResults) {
            // 缓存不存在或需要刷新，重新查询
            logger.info('[Usage API] Fetching fresh usage data');
            usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager, {
                recordRealUsage: true,
                deleteAuthFailures: true
            });
            // 写入缓存
            await writeUsageCache(usageResults);
            applyAccountQuotaLedgerToUsageResults(usageResults, currentConfig, providerPoolManager);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            quotaRules: buildQuotaRuleSummary(providerPoolManager),
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
        logger.error('[UI API] Failed to get usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get usage info: ' + error.message
            }
        }));
        return true;
    }
}

export async function handleSyncProviderPoolUsage(req, res, currentConfig, providerPoolManager) {
    try {
        const cachedData = await readUsageCache();
        let baseUsage;

        if (cachedData) {
            baseUsage = { ...cachedData, fromCache: true };
            reformatUsageResults(baseUsage);
        } else {
            baseUsage = {
                timestamp: new Date().toISOString(),
                providers: {},
                fromLocalProviderPool: true
            };
        }

        const cacheUsage = syncUsageResultsWithProviderPools(baseUsage, currentConfig, providerPoolManager);

        const syncStats = buildProviderPoolUsageSyncStats(baseUsage, cacheUsage, currentConfig, providerPoolManager);
        cacheUsage.syncedAt = new Date().toISOString();
        cacheUsage.syncStats = syncStats;

        await writeUsageCache(cacheUsage);

        const responseUsage = cloneUsagePayload(cacheUsage);
        applyAccountQuotaLedgerToUsageResults(responseUsage, currentConfig, providerPoolManager);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(JSON.stringify({
            ...responseUsage,
            quotaRules: buildQuotaRuleSummary(providerPoolManager),
            serverTime: new Date().toISOString()
        }));
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

/**
 * 获取特定提供商实例的用量限制
 */
export async function handleGetSingleInstanceUsage(req, res, currentConfig, providerPoolManager, providerType, uuid) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';

        const providers = loadProviderList(providerType, currentConfig, providerPoolManager);
        const provider = providers.find(p => p.uuid === uuid);
        
        if (!provider) {
            throw new Error(`未找到指定的提供商实例: ${uuid}`);
        }

        let instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            configFilePath: getProviderConfigFilePath(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            success: false,
            usage: null,
            error: null
        };

        if (!refresh) {
            const cachedData = await readProviderUsageCache(providerType);
            if (cachedData) {
                const syncedCachedData = syncProviderUsageWithProviderPool(
                    providerType,
                    { ...cachedData, fromCache: true },
                    currentConfig,
                    providerPoolManager
                );
                instanceResult = syncedCachedData.instances.find(item => item.uuid === uuid) || createProviderPoolUsagePlaceholder(providerType, provider);
                instanceResult.fromCache = true;
                attachAccountQuotaLedgerSummary(syncedCachedData, currentConfig, providerPoolManager);
                if (syncedCachedData.pendingRestoreAccounts) {
                    instanceResult.pendingRestoreAccounts = syncedCachedData.pendingRestoreAccounts;
                    instanceResult.pendingRestoreCount = syncedCachedData.pendingRestoreCount;
                }
            } else {
                instanceResult = createProviderPoolUsagePlaceholder(providerType, provider);
                attachAccountQuotaLedgerSummary(instanceResult, currentConfig, providerPoolManager);
                instanceResult.fromLocalProviderPool = true;
            }
        } else {
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
        // 如果刷新成功且有全局缓存，建议更新全局缓存（可选，这里先只返回单个结果）
        if (refresh && instanceResult.success && instanceResult.usage) {
            try {
                const cache = await readUsageCache();
                if (cache && cache.providers && cache.providers[providerType]) {
                    const providerCache = cache.providers[providerType];
                    if (providerCache.instances && Array.isArray(providerCache.instances)) {
                        const idx = providerCache.instances.findIndex(inst => inst.uuid === uuid);
                        if (idx !== -1) {
                            providerCache.instances[idx] = instanceResult;
                        } else {
                            providerCache.instances.push(instanceResult);
                        }
                        // 重新计算 count
                        let successCount = 0;
                        let errorCount = 0;
                        providerCache.instances.forEach(inst => {
                            if (inst.success) {
                                successCount++;
                            } else {
                                errorCount++;
                            }
                        });
                        providerCache.successCount = successCount;
                        providerCache.errorCount = errorCount;
                        providerCache.totalCount = providerCache.instances.length;

                        cache.timestamp = new Date().toISOString();
                        await writeUsageCache(cache);
                        logger.info(`[Usage API] Updated global usage cache for single instance ${providerType}:${uuid}`);
                    }
                }
            } catch (cacheError) {
                logger.warn(`[Usage API] Failed to update global usage cache for single instance:`, cacheError.message);
            }
        }

        applyAccountQuotaLedgerToInstance(instanceResult, providerType, provider, providerPoolManager, Date.now());
        attachAccountQuotaLedgerSummary(instanceResult, currentConfig, providerPoolManager);
        const finalResults = {
            ...instanceResult,
            quotaRules: buildQuotaRuleSummary(providerPoolManager),
            serverTime: new Date().toISOString()
        };

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to get usage for ${providerType}:${uuid}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to get usage info for ${providerType}:${uuid}: ` + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取特定提供商类型的用量限制
 */
export async function handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        
        let usageResults;
        
        if (!refresh) {
            // Prefer reading from cache
            const cachedData = await readProviderUsageCache(providerType);
            if (cachedData) {
                logger.info(`[Usage API] Returning cached usage data for ${providerType}`);
                usageResults = { ...cachedData, fromCache: true };
                
                // 包装成 reformatUsageResults 期待的结构并重新格式化
                const tempResults = { providers: { [providerType]: usageResults } };
                reformatUsageResults(tempResults);
                usageResults = tempResults.providers[providerType];
                usageResults = syncProviderUsageWithProviderPool(providerType, usageResults, currentConfig, providerPoolManager);
                applyAccountQuotaLedgerToProviderUsage(providerType, usageResults, currentConfig, providerPoolManager);
                attachAccountQuotaLedgerSummary(usageResults, currentConfig, providerPoolManager);
            } else {
                logger.info(`[Usage API] No usage cache found for ${providerType}; returning local provider-pool snapshot`);
                usageResults = syncProviderUsageWithProviderPool(
                    providerType,
                    {
                        providerType,
                        instances: [],
                        fromLocalProviderPool: true
                    },
                    currentConfig,
                    providerPoolManager
                );
                applyAccountQuotaLedgerToProviderUsage(providerType, usageResults, currentConfig, providerPoolManager);
                attachAccountQuotaLedgerSummary(usageResults, currentConfig, providerPoolManager);
            }
        }
        
        if (!usageResults) {
            // Cache does not exist or refresh required, re-query
            logger.info(`[Usage API] Fetching fresh usage data for ${providerType}`);
            usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, {
                recordRealUsage: true,
                deleteAuthFailures: true
            });
            // 更新缓存
            await updateProviderUsageCache(providerType, usageResults);
            applyAccountQuotaLedgerToProviderUsage(providerType, usageResults, currentConfig, providerPoolManager);
            attachAccountQuotaLedgerSummary(usageResults, currentConfig, providerPoolManager);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            quotaRules: buildQuotaRuleSummary(providerPoolManager),
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
        logger.error(`[UI API] Failed to get usage for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to get usage info for ${providerType}: ` + error.message
            }
        }));
        return true;
    }
}
