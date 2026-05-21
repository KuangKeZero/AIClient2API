import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger.js';
import { atomicWriteFile, withFileLock } from '../utils/file-lock.js';

const LEDGER_VERSION = 1;
const DEFAULT_MANAGED_PROVIDER_PREFIXES = [
    'claude-kiro-oauth',
    'gemini-cli-oauth',
    'gemini-antigravity',
    'openai-codex-oauth',
    'grok-web'
];

const DEFAULT_OPTIONS = {
    enabled: true,
    autoLoad: true,
    filePath: 'configs/account_quota_ledger.json',
    saveDebounceMs: 1000,
    freeThresholdPercent: 70,
    plusThresholdPercent: 90,
    defaultThresholdPercent: 85,
    nearThresholdMarginPercent: 5,
    minConfidenceForNearThreshold: 0.65,
    realUsageConfidence: 1,
    estimateConfidenceDecay: 0.03,
    estimateConfidenceFloor: 0,
    tokensPerPercent: {
        free: 150000,
        plus: 250000,
        default: 250000
    },
    modelCostMultipliers: {
        'gpt-5-codex': 1,
        'gpt-5-codex-mini': 0.6,
        'gpt-5': 1.2,
        'gpt-5.4': 1.5,
        'gpt-5.4-mini': 0.8,
        'gpt-image': 5,
        image: 5
    },
    minPercentPerSuccessfulRequest: 0.02,
    shortCooldownMs: 30000,
    longCooldownMs: 6 * 60 * 60 * 1000,
    lowFrequencyVerificationMs: 60 * 60 * 1000,
    maxRetryAfterMs: 60 * 60 * 1000,
    recentWindowMs: 30 * 60 * 1000,
    maxRecentEvents: 10,
    authDeleteCount: 1,
    refreshThrottleMs: 5 * 60 * 1000,
    poolLowAvailableCount: 1,
    poolLowAvailableRatio: 0.2,
    managedProviderPrefixes: DEFAULT_MANAGED_PROVIDER_PREFIXES
};

function normalizeStringList(value, fallback = []) {
    if (value === undefined || value === null) return [...fallback];
    if (!Array.isArray(value)) return [...fallback];

    return value
        .map(item => String(item || '').trim())
        .filter(Boolean);
}

function normalizeOptions(options = {}) {
    const configured = options.ACCOUNT_QUOTA_LEDGER && typeof options.ACCOUNT_QUOTA_LEDGER === 'object'
        ? options.ACCOUNT_QUOTA_LEDGER
        : options;

    return {
        ...DEFAULT_OPTIONS,
        ...configured,
        tokensPerPercent: {
            ...DEFAULT_OPTIONS.tokensPerPercent,
            ...(configured.tokensPerPercent || {})
        },
        modelCostMultipliers: {
            ...DEFAULT_OPTIONS.modelCostMultipliers,
            ...(configured.modelCostMultipliers || {})
        },
        managedProviderPrefixes: normalizeStringList(
            configured.managedProviderPrefixes,
            DEFAULT_OPTIONS.managedProviderPrefixes
        ),
        autoLoad: options.autoLoad ?? configured.autoLoad ?? DEFAULT_OPTIONS.autoLoad,
        saveStore: options.saveStore || configured.saveStore
    };
}

function nowIso(now = Date.now()) {
    return new Date(now).toISOString();
}

function clampPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(100, Math.max(0, numeric));
}

function parseTimeMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const timestamp = value < 10000000000 ? value * 1000 : value;
        return timestamp;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

function toIsoOrNull(value) {
    const ms = parseTimeMs(value);
    return ms === null ? null : new Date(ms).toISOString();
}

function parseDurationMs(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.round(value));
    }

    const text = String(value).trim();
    if (!text) return null;

    const seconds = Number(text);
    if (Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1000));
    }

    const match = text.match(/^([\d.]+)\s*(ms|s|m|h)?$/i);
    if (match) {
        const amount = Number(match[1]);
        if (!Number.isFinite(amount)) return null;
        const unit = (match[2] || 'ms').toLowerCase();
        if (unit === 'h') return Math.round(amount * 60 * 60 * 1000);
        if (unit === 'm') return Math.round(amount * 60 * 1000);
        if (unit === 's') return Math.round(amount * 1000);
        return Math.round(amount);
    }

    const dateMs = Date.parse(text);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }

    return null;
}

function statusFromError(error) {
    return Number(error?.response?.status || error?.status || error?.statusCode || error?.code || 0);
}

function getHeaderValue(headers, headerName) {
    if (!headers) return null;

    if (typeof headers.get === 'function') {
        return headers.get(headerName) || headers.get(headerName.toLowerCase());
    }

    const lowerName = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowerName) {
            return Array.isArray(value) ? value[0] : value;
        }
    }

    return null;
}

function getRetryAfterMs(error, explicitRetryAfterMs = null, now = Date.now()) {
    const explicit = parseDurationMs(explicitRetryAfterMs);
    if (explicit !== null) return explicit;

    const header = getHeaderValue(error?.response?.headers, 'retry-after');
    if (header !== null && header !== undefined) {
        const seconds = Number(String(header).trim());
        if (Number.isFinite(seconds)) {
            return Math.max(0, Math.round(seconds * 1000));
        }

        const dateMs = Date.parse(String(header));
        if (!Number.isNaN(dateMs)) {
            return Math.max(0, dateMs - now);
        }
    }

    return parseDurationMs(error?.retryAfterMs ?? error?.retryAfter);
}

function stringifyErrorBody(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function normalizeUsageBlock(block) {
    if (!block || typeof block !== 'object') return null;

    const promptTokens = Number(
        block.promptTokens ??
        block.prompt_tokens ??
        block.inputTokens ??
        block.input_tokens ??
        block.input_token_count ??
        0
    );
    const completionTokens = Number(
        block.completionTokens ??
        block.completion_tokens ??
        block.outputTokens ??
        block.output_tokens ??
        block.output_token_count ??
        0
    );
    const explicitTotal = Number(block.totalTokens ?? block.total_tokens ?? 0);
    const totalTokens = explicitTotal > 0 ? explicitTotal : promptTokens + completionTokens;
    const cachedTokens = Number(
        block.cachedTokens ??
        block.cached_tokens ??
        block.prompt_tokens_details?.cached_tokens ??
        block.input_tokens_details?.cached_tokens ??
        0
    );

    if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0 && cachedTokens <= 0) {
        return null;
    }

    return {
        promptTokens: Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0,
        completionTokens: Number.isFinite(completionTokens) ? Math.max(0, completionTokens) : 0,
        totalTokens: Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0,
        cachedTokens: Number.isFinite(cachedTokens) ? Math.max(0, cachedTokens) : 0
    };
}

function mergeUsage(baseUsage, nextUsage) {
    if (!nextUsage) return baseUsage;
    return {
        promptTokens: Math.max(baseUsage.promptTokens, nextUsage.promptTokens),
        completionTokens: Math.max(baseUsage.completionTokens, nextUsage.completionTokens),
        totalTokens: Math.max(baseUsage.totalTokens, nextUsage.totalTokens || nextUsage.promptTokens + nextUsage.completionTokens),
        cachedTokens: Math.max(baseUsage.cachedTokens, nextUsage.cachedTokens)
    };
}

function findUsage(candidate, depth = 0) {
    if (!candidate || depth > 4) return null;

    if (Array.isArray(candidate)) {
        return candidate.reduce((usage, item) => mergeUsage(usage, findUsage(item, depth + 1)), {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0
        });
    }

    if (typeof candidate !== 'object') return null;

    const direct = normalizeUsageBlock(candidate);
    if (direct) return direct;

    const commonChildren = [
        candidate.usage,
        candidate.response?.usage,
        candidate.response?.response?.usage,
        candidate.message?.usage,
        candidate.metadata?.usage,
        candidate.usage_metadata,
        candidate.usageMetadata
    ];

    return commonChildren.reduce((usage, child) => mergeUsage(usage, findUsage(child, depth + 1)), {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0
    });
}

export function extractTokenUsage(...candidates) {
    const merged = candidates.reduce((usage, candidate) => mergeUsage(usage, findUsage(candidate)), {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0
    });

    if (merged.totalTokens <= 0) {
        merged.totalTokens = merged.promptTokens + merged.completionTokens;
    }

    return merged;
}

export function isQuotaLike429(error) {
    if (statusFromError(error) !== 429) {
        return false;
    }

    const bodyText = stringifyErrorBody(error?.response?.data || error?.data || error?.body || error?.message).toLowerCase();
    if (!bodyText) return false;

    return /insufficient[_\s-]?quota|quota[_\s-]?exceeded|exceeded your current quota|usage limit|credits? exhausted|billing[_\s-]?hard[_\s-]?limit|out of quota/.test(bodyText);
}

function accountKey(providerType, uuid) {
    return `${providerType}:${uuid}`;
}

function planBucket(plan) {
    const normalized = String(plan || '').toLowerCase();
    if (normalized.includes('free')) return 'free';
    if (normalized.includes('plus') || normalized.includes('pro') || normalized.includes('team') || normalized.includes('ent')) {
        return 'plus';
    }
    return 'default';
}

export class AccountQuotaLedger {
    constructor(options = {}) {
        this.options = normalizeOptions(options);
        this.store = {
            version: LEDGER_VERSION,
            updatedAt: null,
            accounts: {}
        };
        this.saveTimer = null;
        this.loadingError = null;

        if (this.options.autoLoad) {
            this.load();
        }
    }

    get enabled() {
        return this.options.enabled !== false;
    }

    supportsProvider(providerType) {
        if (!this.enabled || !providerType) return false;

        const prefixes = normalizeStringList(this.options.managedProviderPrefixes, DEFAULT_MANAGED_PROVIDER_PREFIXES);
        if (prefixes.length === 0) return false;

        return prefixes.some(prefix => providerType === prefix || providerType.startsWith(`${prefix}-`));
    }

    load() {
        if (!this.enabled) return;
        const filePath = this.options.filePath;
        if (!filePath || !fs.existsSync(filePath)) return;

        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            this.store = {
                version: data.version || LEDGER_VERSION,
                updatedAt: data.updatedAt || null,
                accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {}
            };
        } catch (error) {
            this.loadingError = error;
            logger.warn(`[AccountQuotaLedger] Failed to load ${filePath}: ${error.message}`);
        }
    }

    toJSON() {
        return JSON.parse(JSON.stringify(this.store));
    }

    _scheduleSave() {
        if (!this.enabled) return;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }

        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.save().catch(error => {
                logger.warn(`[AccountQuotaLedger] Failed to save ledger: ${error.message}`);
            });
        }, this.options.saveDebounceMs);
        this.saveTimer.unref?.();
    }

    async save() {
        if (!this.enabled) return;
        const snapshot = this.toJSON();
        snapshot.updatedAt = new Date().toISOString();
        this.store.updatedAt = snapshot.updatedAt;

        if (typeof this.options.saveStore === 'function') {
            await this.options.saveStore(snapshot);
            return;
        }

        if (!this.options.filePath) return;

        const filePath = this.options.filePath;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        await withFileLock(filePath, async () => {
            await atomicWriteFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
        });
    }

    ensureAccount(providerType, providerConfig = {}, now = Date.now()) {
        if (!this.supportsProvider(providerType) || !providerConfig?.uuid) return null;

        const key = accountKey(providerType, providerConfig.uuid);
        const existing = this.store.accounts[key];
        if (existing) {
            existing.providerType = providerType;
            existing.uuid = providerConfig.uuid;
            existing.customName = providerConfig.customName || existing.customName || null;
            if (existing.deletedAt) {
                existing.deletedAt = null;
                existing.refresh = {
                    ...(existing.refresh || {}),
                    requestedReasons: ['first_seen'],
                    needsFirstRefresh: true
                };
            }
            existing.updatedAt = nowIso(now);
            return existing;
        }

        const account = {
            providerType,
            uuid: providerConfig.uuid,
            customName: providerConfig.customName || null,
            plan: providerConfig.plan || null,
            lastRealUsagePercent: null,
            estimatedUsagePercent: 0,
            resetAt: null,
            disabledUntil: null,
            confidence: 0,
            recent429: [],
            recent401: [],
            refresh: {
                pending: false,
                needsFirstRefresh: true,
                needsResetConfirm: false,
                requestedReasons: ['first_seen'],
                lastAttemptAt: null,
                lastSuccessAt: null,
                lastReason: 'first_seen',
                nextVerifyAt: null
            },
            createdAt: nowIso(now),
            updatedAt: nowIso(now),
            deletedAt: null
        };

        this.store.accounts[key] = account;
        this._scheduleSave();
        return account;
    }

    getAccount(providerType, uuid) {
        if (!this.supportsProvider(providerType) || !uuid) return null;
        return this.store.accounts[accountKey(providerType, uuid)] || null;
    }

    getAccountsForProvider(providerType) {
        if (!this.supportsProvider(providerType)) return [];
        return Object.values(this.store.accounts).filter(account => account.providerType === providerType && !account.deletedAt);
    }

    getRecoveryInfo(account, now = Date.now()) {
        if (!account) {
            return { recoveryAt: null, recoverySource: null };
        }

        const recoveryCandidates = [
            ['disabledUntil', account.disabledUntil],
            ['resetAt', account.resetAt],
            ['nextVerifyAt', account.refresh?.nextVerifyAt]
        ];

        for (const [source, value] of recoveryCandidates) {
            const ms = parseTimeMs(value);
            if (ms && ms > now) {
                return {
                    recoveryAt: new Date(ms).toISOString(),
                    recoverySource: source
                };
            }
        }

        return { recoveryAt: null, recoverySource: null };
    }

    _getPendingRestoreReason(account, now = Date.now()) {
        if (!account || account.deletedAt) return null;

        const refresh = account.refresh || {};
        const resetAtMs = parseTimeMs(account.resetAt);
        const disabledUntilMs = parseTimeMs(account.disabledUntil);
        const nextVerifyMs = parseTimeMs(refresh.nextVerifyAt);
        const threshold = this.getThresholdForAccount(account);
        const estimated = clampPercent(account.estimatedUsagePercent);

        if (refresh.pending) return 'refresh_pending';
        if (refresh.needsResetConfirm && resetAtMs && resetAtMs > now) return 'waiting_reset';
        if (refresh.needsResetConfirm) return 'awaiting_reset_refresh';
        if (disabledUntilMs && disabledUntilMs > now) return 'cooldown';
        if (estimated >= threshold) return 'estimated_threshold';
        if (nextVerifyMs && nextVerifyMs > now) return 'low_frequency_verify';
        return null;
    }

    getPendingRestoreAccounts(providerType = null, now = Date.now()) {
        const pendingAccounts = Object.values(this.store.accounts || {})
            .filter(account => this.supportsProvider(account.providerType))
            .filter(account => !providerType || account.providerType === providerType)
            .map(account => {
                const reason = this._getPendingRestoreReason(account, now);
                if (!reason) return null;

                const threshold = this.getThresholdForAccount(account);
                const estimatedUsagePercent = clampPercent(account.estimatedUsagePercent);
                const lastRealUsagePercent = account.lastRealUsagePercent === null || account.lastRealUsagePercent === undefined
                    ? null
                    : clampPercent(account.lastRealUsagePercent);
                const recovery = this.getRecoveryInfo(account, now);

                return {
                    providerType: account.providerType,
                    uuid: account.uuid,
                    name: account.customName || account.uuid,
                    customName: account.customName || null,
                    plan: account.plan || null,
                    lastRealUsagePercent,
                    estimatedUsagePercent,
                    thresholdPercent: threshold,
                    confidence: Number(account.confidence || 0),
                    resetAt: account.resetAt || null,
                    disabledUntil: account.disabledUntil || null,
                    nextVerifyAt: account.refresh?.nextVerifyAt || null,
                    recoveryAt: recovery.recoveryAt,
                    recoverySource: recovery.recoverySource,
                    reason,
                    refreshReason: account.refresh?.lastReason || null,
                    refreshPending: !!account.refresh?.pending,
                    recent429Count: (account.recent429 || []).length,
                    recent401Count: (account.recent401 || []).length,
                    hiddenFromUsageList: true,
                    updatedAt: account.updatedAt || null
                };
            })
            .filter(Boolean);

        return pendingAccounts.sort((a, b) => {
            const aRecoveryMs = parseTimeMs(a.recoveryAt) || Number.POSITIVE_INFINITY;
            const bRecoveryMs = parseTimeMs(b.recoveryAt) || Number.POSITIVE_INFINITY;
            if (aRecoveryMs !== bRecoveryMs) return aRecoveryMs - bRecoveryMs;
            if (a.estimatedUsagePercent !== b.estimatedUsagePercent) {
                return b.estimatedUsagePercent - a.estimatedUsagePercent;
            }
            return `${a.providerType}:${a.uuid}`.localeCompare(`${b.providerType}:${b.uuid}`);
        });
    }

    getThresholdForAccount(account) {
        const bucket = planBucket(account?.plan);
        if (bucket === 'free') return this.options.freeThresholdPercent;
        if (bucket === 'plus') return this.options.plusThresholdPercent;
        return this.options.defaultThresholdPercent;
    }

    _recoverExpiredResetWindow(account, now = Date.now()) {
        if (!account || account.deletedAt) return false;

        const resetAtMs = parseTimeMs(account.resetAt);
        const disabledUntilMs = parseTimeMs(account.disabledUntil);
        const resetReached = resetAtMs && resetAtMs <= now;
        const disabledReached = disabledUntilMs && disabledUntilMs <= now;

        const refresh = account.refresh || {};
        if (!resetReached && !(refresh.needsResetConfirm && disabledReached)) return false;

        account.lastRealUsagePercent = null;
        account.estimatedUsagePercent = 0;
        account.resetAt = null;
        account.disabledUntil = null;
        account.confidence = this.options.estimateConfidenceFloor;
        account.recent429 = [];
        account.refresh = {
            ...refresh,
            pending: false,
            needsFirstRefresh: false,
            needsResetConfirm: false,
            requestedReasons: [],
            lastReason: 'reset_window_elapsed',
            nextVerifyAt: null
        };
        account.updatedAt = nowIso(now);
        this._scheduleSave();
        return true;
    }

    applyRealUsage(providerType, uuid, formattedUsage, now = Date.now()) {
        const account = this.ensureAccount(providerType, { uuid }, now);
        if (!account) return null;

        const summary = formattedUsage?.summary || formattedUsage || {};
        const usedPercent = clampPercent(summary.usedPercent ?? summary.percent ?? summary.used_percent ?? 0);
        const resetAt = toIsoOrNull(summary.resetAt ?? summary.reset_at);

        account.lastRealUsagePercent = usedPercent;
        account.estimatedUsagePercent = usedPercent;
        account.resetAt = resetAt;
        account.plan = summary.plan || account.plan || null;
        account.confidence = this.options.realUsageConfidence;
        account.recent401 = [];
        account.refresh = {
            ...(account.refresh || {}),
            pending: false,
            needsFirstRefresh: false,
            needsResetConfirm: false,
            lastSuccessAt: nowIso(now),
            lastReason: account.refresh?.lastReason || 'real_usage',
            requestedReasons: [],
            nextVerifyAt: null
        };

        const threshold = this.getThresholdForAccount(account);
        if (usedPercent >= threshold) {
            const resetMs = parseTimeMs(resetAt);
            account.disabledUntil = resetMs && resetMs > now
                ? new Date(resetMs).toISOString()
                : new Date(now + this.options.longCooldownMs).toISOString();
            account.refresh.needsResetConfirm = true;
            if (!resetMs || resetMs <= now) {
                account.refresh.nextVerifyAt = new Date(now + this.options.lowFrequencyVerificationMs).toISOString();
            }
        } else {
            account.disabledUntil = null;
        }

        account.updatedAt = nowIso(now);
        this._scheduleSave();
        return account;
    }

    _getTokensPerPercent(account) {
        const bucket = planBucket(account?.plan);
        return Number(this.options.tokensPerPercent[bucket] || this.options.tokensPerPercent.default || DEFAULT_OPTIONS.tokensPerPercent.default);
    }

    _getModelMultiplier(model = '') {
        const normalized = String(model || '').toLowerCase();
        let bestMatch = {
            length: -1,
            multiplier: 1
        };

        for (const [pattern, value] of Object.entries(this.options.modelCostMultipliers || {})) {
            const normalizedPattern = String(pattern || '').toLowerCase();
            if (!normalizedPattern || !normalized.includes(normalizedPattern)) {
                continue;
            }

            const candidateMultiplier = Number(value) || 1;
            if (
                normalizedPattern.length > bestMatch.length ||
                (normalizedPattern.length === bestMatch.length && candidateMultiplier > bestMatch.multiplier)
            ) {
                bestMatch = {
                    length: normalizedPattern.length,
                    multiplier: candidateMultiplier
                };
            }
        }

        return bestMatch.multiplier;
    }

    estimateUsagePercent(account, model, usage) {
        const normalizedUsage = usage?.totalTokens !== undefined ? usage : extractTokenUsage(usage);
        const totalTokens = Number(normalizedUsage?.totalTokens || 0);
        const billableTokens = Math.max(0, totalTokens - Number(normalizedUsage?.cachedTokens || 0) * 0.75);

        if (billableTokens <= 0) {
            return this.options.minPercentPerSuccessfulRequest * this._getModelMultiplier(model);
        }

        const tokensPerPercent = Math.max(1, this._getTokensPerPercent(account));
        const rawPercent = (billableTokens / tokensPerPercent) * this._getModelMultiplier(model);
        return Math.max(this.options.minPercentPerSuccessfulRequest, rawPercent);
    }

    recordEstimatedUsage(providerType, uuid, details = {}, now = Date.now()) {
        const account = this.ensureAccount(providerType, { uuid }, now);
        if (!account) return null;
        this._recoverExpiredResetWindow(account, now);

        const usage = details.usage?.totalTokens !== undefined
            ? details.usage
            : extractTokenUsage(details.usage, details.nativeResponse, details.clientResponse);
        const increment = this.estimateUsagePercent(account, details.model, usage);

        account.estimatedUsagePercent = clampPercent(Number(account.estimatedUsagePercent || 0) + increment);
        account.confidence = Math.max(
            this.options.estimateConfidenceFloor,
            Number(account.confidence || 0) - this.options.estimateConfidenceDecay
        );
        account.recent401 = [];
        account.updatedAt = nowIso(now);

        const decision = this.getRoutingDecision(providerType, { uuid }, now);
        if (decision.refreshReason) {
            this.requestRefresh(providerType, uuid, decision.refreshReason, now);
        }

        this._scheduleSave();
        return {
            account,
            usage,
            increment,
            decision
        };
    }

    _pruneRecent(events, now) {
        const windowStart = now - this.options.recentWindowMs;
        return (events || [])
            .filter(event => parseTimeMs(event.at) >= windowStart)
            .slice(-this.options.maxRecentEvents);
    }

    record429(providerType, uuid, details = {}, now = details.now || Date.now()) {
        const account = this.ensureAccount(providerType, { uuid }, now);
        if (!account) return null;

        const retryAfterMs = getRetryAfterMs(details.error, details.retryAfterMs ?? details.retryAfter, now);
        const quotaLike = details.quotaLike ?? isQuotaLike429(details.error);
        const resetAt = toIsoOrNull(details.resetAt || account.resetAt);

        account.recent429 = this._pruneRecent(account.recent429, now);
        account.recent429.push({
            at: nowIso(now),
            status: 429,
            quotaLike: !!quotaLike,
            retryAfterMs: retryAfterMs ?? null
        });
        account.recent429 = account.recent429.slice(-this.options.maxRecentEvents);
        account.confidence = Math.max(0, Number(account.confidence || 0) - 0.15);

        let shouldRefresh = false;
        let refreshReason = null;

        if (retryAfterMs !== null) {
            const cooldown = Math.min(retryAfterMs, this.options.maxRetryAfterMs);
            account.disabledUntil = new Date(now + cooldown).toISOString();
            if (quotaLike) {
                shouldRefresh = true;
                refreshReason = 'quota_429';
            }
        } else if (quotaLike) {
            shouldRefresh = true;
            refreshReason = 'quota_429';
            if (resetAt) {
                const resetAtMs = parseTimeMs(resetAt);
                account.resetAt = resetAt;
                account.refresh = {
                    ...(account.refresh || {}),
                    needsResetConfirm: true
                };
                account.disabledUntil = resetAtMs && resetAtMs > now ? resetAt : null;
            } else {
                account.disabledUntil = new Date(now + this.options.longCooldownMs).toISOString();
                account.refresh = {
                    ...(account.refresh || {}),
                    needsResetConfirm: true,
                    nextVerifyAt: new Date(now + this.options.lowFrequencyVerificationMs).toISOString()
                };
            }
        } else {
            account.disabledUntil = new Date(now + this.options.shortCooldownMs).toISOString();
        }

        if (shouldRefresh && refreshReason) {
            this.requestRefresh(providerType, uuid, refreshReason, now, { force: true });
        }

        account.updatedAt = nowIso(now);
        this._scheduleSave();
        return {
            account,
            shouldRefresh,
            refreshReason,
            retryAfterMs,
            quotaLike
        };
    }

    record401(providerType, uuid, details = {}, now = details.now || Date.now()) {
        const account = this.ensureAccount(providerType, { uuid }, now);
        if (!account) return { shouldDelete: false, account: null };
        const status = Number(details.status || 401);

        account.recent401 = this._pruneRecent(account.recent401, now);
        account.recent401.push({
            at: nowIso(now),
            status,
            message: details.message || null
        });
        account.recent401 = account.recent401.slice(-this.options.maxRecentEvents);
        account.updatedAt = nowIso(now);
        this._scheduleSave();

        return {
            account,
            shouldDelete: status === 401 || account.recent401.length >= this.options.authDeleteCount
        };
    }

    requestRefresh(providerType, uuid, reason, now = Date.now(), options = {}) {
        const account = this.ensureAccount(providerType, { uuid }, now);
        if (!account) return null;

        const refresh = account.refresh || {};
        const lastAttemptMs = parseTimeMs(refresh.lastAttemptAt) || 0;
        if (!options.force && refresh.pending) {
            return { queued: false, throttled: true, account };
        }
        if (!options.force && lastAttemptMs && now - lastAttemptMs < this.options.refreshThrottleMs) {
            if (!Array.isArray(refresh.requestedReasons)) refresh.requestedReasons = [];
            if (!refresh.requestedReasons.includes(reason)) {
                refresh.requestedReasons.push(reason);
            }
            account.refresh = refresh;
            account.updatedAt = nowIso(now);
            this._scheduleSave();
            return { queued: false, throttled: true, account };
        }

        account.refresh = {
            ...refresh,
            pending: true,
            lastAttemptAt: nowIso(now),
            lastReason: reason,
            requestedReasons: [reason],
            nextVerifyAt: reason === 'low_frequency_verify' ? null : refresh.nextVerifyAt
        };
        account.updatedAt = nowIso(now);
        this._scheduleSave();

        return { queued: true, throttled: false, account };
    }

    markRefreshFailed(providerType, uuid, reason, errorMessage = null, now = Date.now()) {
        const account = this.ensureAccount(providerType, { uuid }, now);
        if (!account) return null;

        account.refresh = {
            ...(account.refresh || {}),
            pending: false,
            lastReason: reason || account.refresh?.lastReason || 'unknown',
            lastErrorAt: nowIso(now),
            lastErrorMessage: errorMessage,
            nextVerifyAt: reason === 'low_frequency_verify'
                ? new Date(now + this.options.lowFrequencyVerificationMs).toISOString()
                : account.refresh?.nextVerifyAt
        };
        account.updatedAt = nowIso(now);
        this._scheduleSave();
        return account;
    }

    markDeleted(providerType, uuid, reason = null, now = Date.now()) {
        const account = this.ensureAccount(providerType, { uuid }, now);
        if (!account) return null;

        account.deletedAt = nowIso(now);
        account.deleteReason = reason;
        account.disabledUntil = null;
        account.updatedAt = nowIso(now);
        this._scheduleSave();
        return account;
    }

    getRoutingDecision(providerType, providerConfig = {}, now = Date.now()) {
        if (!this.supportsProvider(providerType)) {
            return { skip: false, reason: null };
        }

        const account = this.getAccount(providerType, providerConfig.uuid) || this.ensureAccount(providerType, providerConfig, now);
        if (!account) {
            return { skip: false, reason: null };
        }

        if (account.deletedAt) {
            return { skip: true, reason: 'deleted', account };
        }

        this._recoverExpiredResetWindow(account, now);

        const nextVerifyMs = parseTimeMs(account.refresh?.nextVerifyAt);
        if (account.refresh?.needsResetConfirm && nextVerifyMs && nextVerifyMs <= now) {
            return {
                skip: true,
                reason: 'awaiting_reset_refresh',
                refreshReason: 'low_frequency_verify',
                account
            };
        }

        const disabledUntilMs = parseTimeMs(account.disabledUntil);
        if (disabledUntilMs && disabledUntilMs > now) {
            return {
                skip: true,
                reason: 'cooldown',
                disabledUntil: account.disabledUntil,
                account
            };
        }

        const resetAtMs = parseTimeMs(account.resetAt);
        if (account.refresh?.needsResetConfirm && (!resetAtMs || resetAtMs <= now)) {
            return {
                skip: true,
                reason: 'awaiting_reset_refresh',
                refreshReason: 'reset_reached',
                account
            };
        }

        if (account.refresh?.needsResetConfirm && disabledUntilMs && disabledUntilMs <= now) {
            return {
                skip: true,
                reason: 'awaiting_reset_refresh',
                refreshReason: 'reset_reached',
                account
            };
        }

        const threshold = this.getThresholdForAccount(account);
        const estimated = clampPercent(account.estimatedUsagePercent);
        if (estimated >= threshold) {
            const lowConfidence = Number(account.confidence || 0) < this.options.minConfidenceForNearThreshold;
            return {
                skip: true,
                reason: 'estimated_threshold',
                refreshReason: lowConfidence ? 'near_threshold_low_confidence' : null,
                threshold,
                estimatedUsagePercent: estimated,
                account
            };
        }

        const nearThreshold = estimated >= threshold - this.options.nearThresholdMarginPercent;
        const lowConfidence = Number(account.confidence || 0) < this.options.minConfidenceForNearThreshold;
        if (nearThreshold && lowConfidence) {
            return {
                skip: false,
                reason: null,
                refreshReason: 'near_threshold_low_confidence',
                threshold,
                estimatedUsagePercent: estimated,
                account
            };
        }

        if (account.refresh?.needsFirstRefresh) {
            return {
                skip: false,
                reason: null,
                refreshReason: 'first_seen',
                account
            };
        }

        if (nextVerifyMs && nextVerifyMs <= now) {
            return {
                skip: true,
                reason: 'awaiting_reset_refresh',
                refreshReason: 'low_frequency_verify',
                account
            };
        }

        return { skip: false, reason: null, account };
    }

    shouldRefreshForPoolPressure(totalCount, availableCount) {
        if (!this.enabled || totalCount <= 0) return false;
        const ratioLimit = Math.ceil(totalCount * this.options.poolLowAvailableRatio);
        const minimum = Math.max(this.options.poolLowAvailableCount, ratioLimit);
        return availableCount <= minimum;
    }
}

export default AccountQuotaLedger;
