// 用量管理模块

import { showToast, bindOnce } from './utils.js';
import { getAuthHeaders } from './auth.js';
import { t, getCurrentLanguage } from './i18n.js';

// 提供商配置缓存
let currentProviderConfigs = null;
let usagePageDataPromise = null;
const pendingRestoreState = {
    page: 1,
    pageSize: 20,
    collapsed: true
};

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

function formatPendingReason(reason) {
    const keyMap = {
        cooldown: 'usage.pending.reason.cooldown',
        estimated_threshold: 'usage.pending.reason.estimated_threshold',
        waiting_reset: 'usage.pending.reason.waiting_reset',
        awaiting_reset_refresh: 'usage.pending.reason.awaiting_reset_refresh',
        refresh_pending: 'usage.pending.reason.refresh_pending',
        low_frequency_verify: 'usage.pending.reason.low_frequency_verify'
    };

    return t(keyMap[reason] || 'usage.pending.reason.unknown');
}

function formatRecoveryDate(value) {
    if (!value) return t('usage.pending.recoveryUnknown');
    return formatDate(value);
}

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
        container.classList.remove('is-disabled');
        textEl.textContent = '';
        textEl.removeAttribute('data-i18n');
        textEl.removeAttribute('data-i18n-params');
        return;
    }

    container.hidden = false;
    if (rules.enabled === false) {
        container.classList.add('is-disabled');
        textEl.textContent = t('usage.rules.disabled');
        textEl.setAttribute('data-i18n', 'usage.rules.disabled');
        textEl.removeAttribute('data-i18n-params');
        return;
    }

    container.classList.remove('is-disabled');
    const params = {
        free: formatRulePercent(rules.freeThresholdPercent),
        plus: formatRulePercent(rules.plusThresholdPercent),
        defaultThreshold: formatRulePercent(rules.defaultThresholdPercent),
        lowCount: Number(rules.poolLowAvailableCount || 0),
        lowRatio: formatRuleRatioPercent(rules.poolLowAvailableRatio)
    };
    textEl.textContent = t('usage.rules.summary', params);
    textEl.setAttribute('data-i18n', 'usage.rules.summary');
    textEl.setAttribute('data-i18n-params', JSON.stringify(params));
}

function clampPendingRestorePage(totalItems) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pendingRestoreState.pageSize));
    pendingRestoreState.page = Math.min(Math.max(1, pendingRestoreState.page), totalPages);
    return totalPages;
}

function getPendingRestorePageSlice(pendingAccounts) {
    const totalPages = clampPendingRestorePage(pendingAccounts.length);
    const startIndex = (pendingRestoreState.page - 1) * pendingRestoreState.pageSize;
    const endIndex = Math.min(startIndex + pendingRestoreState.pageSize, pendingAccounts.length);
    return {
        totalPages,
        startIndex,
        endIndex,
        accounts: pendingAccounts.slice(startIndex, endIndex)
    };
}

function createPendingRestoreRow(account) {
    const row = document.createElement('div');
    row.className = 'usage-pending-row';
    row.setAttribute('data-provider', account.providerType || '');
    row.setAttribute('data-uuid', account.uuid || '');

    const displayName = account.customName || account.name || account.uuid || t('usage.pending.unnamed');
    const planClass = getLocalPlanClass(account.plan);
    const estimated = Number(account.estimatedUsagePercent || 0);
    const threshold = Number(account.thresholdPercent || 0);
    const confidence = Math.max(0, Math.min(1, Number(account.confidence || 0)));
    const usageLabel = t('usage.pending.usage', {
        used: estimated.toFixed(1),
        threshold: threshold.toFixed(0)
    });
    const recoveryLabel = t('usage.pending.recoveryAt', {
        time: formatRecoveryDate(account.recoveryAt)
    });
    const reasonLabel = formatPendingReason(account.reason || account.refreshReason);
    const providerLabel = account.providerType ? getProviderDisplayName(account.providerType) : t('usage.pending.unnamed');
    const confidenceLabel = t('usage.pending.confidence', { value: Math.round(confidence * 100) });
    const refreshTitle = t('usage.pending.refresh');

    row.innerHTML = `
        <div class="usage-pending-main">
            <div class="usage-pending-name-line">
                <i class="fas fa-clock usage-pending-icon"></i>
                <span class="usage-pending-name" title="${displayName}">${displayName}</span>
                ${account.plan ? `<span class="usage-pending-plan ${planClass}">${account.plan}</span>` : ''}
            </div>
            <div class="usage-pending-meta">
                <span class="usage-pending-chip">${providerLabel}</span>
                <span class="usage-pending-chip">${usageLabel}</span>
                <span class="usage-pending-chip">${recoveryLabel}</span>
                <span class="usage-pending-chip">${reasonLabel}</span>
                <span class="usage-pending-chip">${confidenceLabel}</span>
                ${account.recent401Count > 0 ? `<span class="usage-pending-chip">${t('usage.pending.recent401', { count: account.recent401Count })}</span>` : ''}
                ${account.recent429Count > 0 ? `<span class="usage-pending-chip">${t('usage.pending.recent429', { count: account.recent429Count })}</span>` : ''}
            </div>
        </div>
        <div class="usage-pending-row-actions">
            <button class="btn-pending-refresh" title="${refreshTitle}" aria-label="${refreshTitle}">
                <i class="fas fa-sync-alt"></i>
            </button>
        </div>
    `;

    row.querySelector('.btn-pending-refresh').onclick = (e) => {
        e.stopPropagation();
        refreshSingleInstanceUsage(account.providerType, account.uuid, displayName);
    };

    return row;
}

function createPendingRestoreSection(pendingAccounts) {
    const section = document.createElement('div');
    section.className = 'usage-pending-section';
    section.setAttribute('data-section', 'pending-restore');

    const { totalPages, startIndex, endIndex, accounts } = getPendingRestorePageSlice(pendingAccounts);

    section.innerHTML = `
        <div class="usage-pending-header">
            <div class="usage-pending-title">
                <button class="btn-pending-toggle" type="button" title="${pendingRestoreState.collapsed ? t('usage.pending.expand') : t('usage.pending.collapse')}" aria-label="${pendingRestoreState.collapsed ? t('usage.pending.expand') : t('usage.pending.collapse')}">
                    <i class="fas ${pendingRestoreState.collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>
                </button>
                <i class="fas fa-hourglass-half"></i>
                <span>${t('usage.pending.title')}</span>
                <span class="usage-pending-count">${t('usage.pending.count', { count: pendingAccounts.length })}</span>
            </div>
            <div class="usage-pending-header-actions">
                <button class="btn-pending-verify-all" type="button" title="${t('usage.pending.verifyAll')}" aria-label="${t('usage.pending.verifyAll')}">
                    <i class="fas fa-stethoscope"></i>
                    <span>${t('usage.pending.verifyAll')}</span>
                </button>
            </div>
        </div>
        <div class="usage-pending-body ${pendingRestoreState.collapsed ? 'is-collapsed' : ''}">
            <div class="usage-pending-list"></div>
            <div class="usage-pending-footer">
                <div class="usage-pending-page-info">
                    <span data-i18n="pagination.showing" data-i18n-params='{"start":"${pendingAccounts.length === 0 ? 0 : startIndex + 1}","end":"${endIndex}","total":"${pendingAccounts.length}"}'>${t('pagination.showing', { start: pendingAccounts.length === 0 ? 0 : startIndex + 1, end: endIndex, total: pendingAccounts.length })}</span>
                </div>
                <div class="usage-pending-pagination">
                    <button class="btn-pending-page btn-pending-prev" type="button" ${pendingRestoreState.page <= 1 ? 'disabled' : ''} title="${t('usage.pending.prevPage')}" aria-label="${t('usage.pending.prevPage')}">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <span class="usage-pending-page-label">${t('usage.pending.page', { page: pendingRestoreState.page, pages: totalPages })}</span>
                    <button class="btn-pending-page btn-pending-next" type="button" ${pendingRestoreState.page >= totalPages ? 'disabled' : ''} title="${t('usage.pending.nextPage')}" aria-label="${t('usage.pending.nextPage')}">
                        <i class="fas fa-chevron-right"></i>
                    </button>
                    <label class="usage-pending-page-size-label">
                        <span>${t('usage.pending.pageSize')}</span>
                        <select class="usage-pending-page-size" aria-label="${t('usage.pending.pageSize')}">
                            ${[10, 20, 50, 100].map(size => `<option value="${size}" ${size === pendingRestoreState.pageSize ? 'selected' : ''}>${size}</option>`).join('')}
                        </select>
                    </label>
                </div>
            </div>
        </div>
    `;

    const list = section.querySelector('.usage-pending-list');
    accounts.forEach(account => list.appendChild(createPendingRestoreRow(account)));

    const toggleBtn = section.querySelector('.btn-pending-toggle');
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        pendingRestoreState.collapsed = !pendingRestoreState.collapsed;
        updatePendingRestoreSection(pendingAccounts);
    };

    const verifyBtn = section.querySelector('.btn-pending-verify-all');
    verifyBtn.onclick = async (e) => {
        e.stopPropagation();
        verifyBtn.disabled = true;
        try {
            await refreshUsage();
        } finally {
            if (verifyBtn.isConnected) verifyBtn.disabled = false;
        }
    };

    const prevBtn = section.querySelector('.btn-pending-prev');
    if (prevBtn) {
        prevBtn.onclick = (e) => {
            e.stopPropagation();
            if (pendingRestoreState.page > 1) {
                pendingRestoreState.page -= 1;
                updatePendingRestoreSection(pendingAccounts);
            }
        };
    }

    const nextBtn = section.querySelector('.btn-pending-next');
    if (nextBtn) {
        nextBtn.onclick = (e) => {
            e.stopPropagation();
            if (pendingRestoreState.page < totalPages) {
                pendingRestoreState.page += 1;
                updatePendingRestoreSection(pendingAccounts);
            }
        };
    }

    const pageSizeSelect = section.querySelector('.usage-pending-page-size');
    if (pageSizeSelect) {
        pageSizeSelect.onchange = (e) => {
            pendingRestoreState.pageSize = Math.max(1, Number(e.target.value) || 20);
            pendingRestoreState.page = 1;
            updatePendingRestoreSection(pendingAccounts);
        };
    }

    return section;
}

function updatePendingRestoreSection(pendingAccounts) {
    const container = document.getElementById('usageContent');
    if (!container) return;

    const existing = container.querySelector('[data-section="pending-restore"]');
    if (!Array.isArray(pendingAccounts) || pendingAccounts.length === 0) {
        if (existing) existing.remove();
        return;
    }

    const section = createPendingRestoreSection(pendingAccounts);
    if (existing) {
        container.replaceChild(section, existing);
    } else {
        container.insertBefore(section, container.firstChild);
    }
}

/**
 * 更新提供商配置
 * @param {Array} configs - 提供商配置列表
 */
export function updateUsageProviderConfigs(configs) {
    currentProviderConfigs = configs;
}

/**
 * 初始化用量管理功能
 */
export function initUsageManager() {
    const refreshBtn = document.getElementById('refreshUsageBtn');
    const syncBtn = document.getElementById('syncProviderPoolUsageBtn');
    bindOnce(refreshBtn, 'click', refreshUsage, 'refreshUsage');
    bindOnce(syncBtn, 'click', syncProviderPoolUsage, 'syncProviderPoolUsage');
}

/**
 * 加载页面数据
 */
export function loadUsagePageData() {
    if (usagePageDataPromise) {
        return usagePageDataPromise;
    }

    usagePageDataPromise = Promise.all([
        loadUsage(),
        loadSupportedProviders()
    ]).finally(() => {
        usagePageDataPromise = null;
    });

    return usagePageDataPromise;
}

/**
 * 加载支持用量查询的提供商列表
 */
async function loadSupportedProviders() {
    const listEl = document.getElementById('supportedProvidersList');
    if (!listEl) return;

    try {
        const response = await fetch('/api/usage/supported-providers', {
            method: 'GET',
            headers: getAuthHeaders()
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const providers = await response.json();
        
        listEl.innerHTML = '';
        const displayOrder = currentProviderConfigs ? currentProviderConfigs.map(c => c.id) : providers;

        displayOrder.forEach(providerId => {
            if (!providers.includes(providerId)) return;
            if (currentProviderConfigs) {
                const config = currentProviderConfigs.find(c => c.id === providerId);
                if (config && config.visible === false) return;
            }

            const tag = document.createElement('span');
            tag.className = 'provider-tag';
            tag.textContent = getProviderDisplayName(providerId);
            tag.title = t('usage.doubleClickToRefresh');
            tag.addEventListener('dblclick', () => refreshProviderUsage(providerId));
            listEl.appendChild(tag);
        });
    } catch (error) {
        console.error('获取支持的提供商列表失败:', error);
        listEl.innerHTML = `<span class="error-text">${t('usage.failedToLoad')}</span>`;
    }
}

/**
 * 加载用量数据
 */
export async function loadUsage() {
    const loadingEl = document.getElementById('usageLoading');
    const errorEl = document.getElementById('usageError');
    const contentEl = document.getElementById('usageContent');

    if (loadingEl) loadingEl.style.display = 'block';
    if (errorEl) errorEl.style.display = 'none';

    try {
        const response = await fetch('/api/usage', { method: 'GET', headers: getAuthHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        
        if (loadingEl) loadingEl.style.display = 'none';
        renderUsageData(data, contentEl);
        updateTimeInfo(data);
        updateQuotaRulesInfo(data);
    } catch (error) {
        console.error('获取用量数据失败:', error);
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            errorEl.style.display = 'block';
            document.getElementById('usageErrorMessage').textContent = error.message;
        }
    }
}

/**
 * 刷新全部用量
 */
export async function refreshUsage() {
    const refreshBtn = document.getElementById('refreshUsageBtn');
    if (refreshBtn) refreshBtn.disabled = true;

    try {
        // 使用更明显的反馈：显示加载中的 Toast
        showToast(t('usage.loading'), 'info');
        
        const response = await fetch('/api/usage?refresh=true', { method: 'GET', headers: getAuthHeaders() });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // 渲染数据
        renderUsageData(data, document.getElementById('usageContent'));
        updateTimeInfo(data);
        updateQuotaRulesInfo(data);
        
        // 成功提示
        showToast(t('common.refresh.success'), 'success');
    } catch (error) {
        console.error('刷新用量失败:', error);
        showToast(t('common.error'), error.message || t('common.requestFailed'), 'error');
    } finally {
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

/**
 * 同步账号池用量
 */
export async function syncProviderPoolUsage() {
    const syncBtn = document.getElementById('syncProviderPoolUsageBtn');
    if (syncBtn) syncBtn.disabled = true;

    try {
        showToast(t('usage.syncProviderPoolLoading'), 'info');

        const response = await fetch('/api/usage/sync-provider-pool', {
            method: 'POST',
            headers: getAuthHeaders()
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || errorData.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        renderUsageData(data, document.getElementById('usageContent'));
        updateTimeInfo(data);
        updateQuotaRulesInfo(data);

        const syncStats = data?.syncStats || {};
        const added = Number(syncStats.addedCount || 0);
        const existing = Number(syncStats.existingCount || 0);
        const skipped = Number(syncStats.disabledSkippedCount || 0);
        showToast(t('common.success'), t('usage.syncProviderPoolSuccess', { added, existing, skipped }), 'success');
    } catch (error) {
        console.error('同步账号池失败:', error);
        showToast(error.message || t('common.requestFailed'), 'error');
    } finally {
        if (syncBtn) syncBtn.disabled = false;
    }
}

/**
 * 刷新单个实例
 */
export async function refreshSingleInstanceUsage(providerType, uuid, displayName) {
    try {
        showToast(t('usage.refreshingInstance', { name: displayName }), 'info');
        const response = await fetch(`/api/usage/${providerType}/${uuid}?refresh=true`, { 
            method: 'GET', 
            headers: getAuthHeaders() 
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // 局部更新该实例的卡片
        if (data && data.uuid) {
            const updated = updateSingleInstanceCard(providerType, data);
            updatePendingRestoreSection(data.pendingRestoreAccounts || []);
            updateQuotaRulesInfo(data);
            if (!updated) {
                await loadUsage();
            }
            showToast(t('common.refresh.success'), 'success');
        } else {
            await loadUsage();
        }
    } catch (error) {
        console.error('刷新单个实例用量失败:', error);
        showToast(error.message || t('common.requestFailed'), 'error');
    }
}

/**
 * 更新单个实例卡片 (局部更新 DOM)
 */
function updateSingleInstanceCard(providerType, instanceData) {
    const container = document.getElementById('usageContent');
    if (!container) return false;

    const group = container.querySelector(`.usage-provider-group[data-provider="${providerType}"]`);
    if (!group) return false;

    const grid = group.querySelector('.usage-cards-grid');
    if (!grid) return false;

    // 找到该实例的卡片。卡片本身没有 data-uuid 属性，我们需要通过内部的 span 查找或添加它
    // 在 createInstanceUsageCard 中，我们可以为卡片添加 data-uuid
    const cards = grid.querySelectorAll('.usage-instance-card');
    let targetCard = null;
    
    for (const card of cards) {
        if (card.getAttribute('data-uuid') === instanceData.uuid) {
            targetCard = card;
            break;
        }
    }

    if (targetCard) {
        const isCollapsed = targetCard.classList.contains('collapsed');
        const newCard = createInstanceUsageCard(instanceData, providerType);
        newCard.classList.toggle('collapsed', isCollapsed);
        grid.replaceChild(newCard, targetCard);
        return true;
    }

    return false;
}

/**
 * 刷新单个提供商
 */
export async function refreshProviderUsage(providerType) {
    try {
        showToast(t('usage.refreshingProvider', { name: getProviderDisplayName(providerType) }), 'info');
        const response = await fetch(`/api/usage/${providerType}?refresh=true`, { method: 'GET', headers: getAuthHeaders() });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        const data = await response.json();
        
        // 如果返回了全量数据或该提供商的数据，尝试局部更新
        if (data.providers && data.providers[providerType]) {
            updateSingleProviderGroup(providerType, data.providers[providerType]);
            updatePendingRestoreSection(data.pendingRestoreAccounts || []);
            updateTimeInfo(data);
            updateQuotaRulesInfo(data);
        } else {
            await loadUsage();
        }
        
        showToast(t('common.refresh.success'), 'success');
    } catch (error) {
        console.error('刷新提供商用量失败:', error);
        showToast(error.message || t('common.requestFailed'), 'error');
    }
}

/**
 * 更新单个提供商分组 (局部更新 DOM)
 */
function updateSingleProviderGroup(providerType, providerData) {
    const container = document.getElementById('usageContent');
    if (!container) return;

    const existingGroup = container.querySelector(`.usage-provider-group[data-provider="${providerType}"]`);
    const instances = (providerData.instances || []).filter(i => !i.isDisabled && !i.error?.includes('not initialized') && !i.hiddenFromUsageList && !i.localQuotaLedger?.hiddenFromUsageList);
    
    if (instances.length === 0) {
        if (existingGroup) existingGroup.remove();
        if (container.children.length === 0) {
            renderUsageData({ providers: {} }, container);
        }
        return;
    }

    const newGroup = createProviderGroup(providerType, instances);
    if (existingGroup) {
        // 保留展开/折叠状态
        if (!existingGroup.classList.contains('collapsed')) {
            newGroup.classList.remove('collapsed');
        }
        container.replaceChild(newGroup, existingGroup);
    } else {
        // 如果原本没有，则按顺序插入或直接追加
        container.appendChild(newGroup);
        // 这里简化处理，实际可能需要根据 displayOrder 重新排序
    }
}

/**
 * 更新时间相关信息
 */
function updateTimeInfo(data) {
    if (data.serverTime) {
        const el = document.getElementById('serverTimeValue');
        if (el) el.textContent = new Date(data.serverTime).toLocaleString(getCurrentLanguage());
    }
    
    const lastUpdateEl = document.getElementById('usageLastUpdate');
    if (lastUpdateEl) {
        const timeStr = new Date(data.timestamp || Date.now()).toLocaleString(getCurrentLanguage());
        const key = data.fromCache ? 'usage.lastUpdateCache' : 'usage.lastUpdate';
        lastUpdateEl.textContent = t(key, { time: timeStr });
        // 恢复国际化属性以便动态切换语言
        lastUpdateEl.setAttribute('data-i18n', key);
        lastUpdateEl.setAttribute('data-i18n-params', JSON.stringify({ time: timeStr }));
    }
}

/**
 * 渲染数据
 */
function renderUsageData(data, container) {
    if (!container) return;
    container.innerHTML = '';

    const pendingAccounts = Array.isArray(data?.pendingRestoreAccounts) ? data.pendingRestoreAccounts : [];

    if ((!data?.providers || Object.keys(data.providers).length === 0) && pendingAccounts.length === 0) {
        container.innerHTML = `<div class="usage-empty"><p>${t('usage.noData')}</p></div>`;
        return;
    }

    const groupedInstances = {};
    for (const [type, pData] of Object.entries(data.providers || {})) {
        if (currentProviderConfigs?.find(c => c.id === type)?.visible === false) continue;
        const valid = (pData.instances || []).filter(i => !i.isDisabled && !i.error?.includes('not initialized') && !i.hiddenFromUsageList && !i.localQuotaLedger?.hiddenFromUsageList);
        if (valid.length > 0) groupedInstances[type] = valid;
    }

    if (pendingAccounts.length > 0) {
        container.appendChild(createPendingRestoreSection(pendingAccounts));
    }

    const displayOrder = currentProviderConfigs ? currentProviderConfigs.map(c => c.id) : Object.keys(groupedInstances);
    displayOrder.forEach(type => {
        if (groupedInstances[type]) container.appendChild(createProviderGroup(type, groupedInstances[type]));
    });
}

/**
 * 创建分组
 */
function createProviderGroup(providerType, instances) {
    const group = document.createElement('div');
    group.className = 'usage-provider-group collapsed';
    group.setAttribute('data-provider', providerType);
    
    const successCount = instances.filter(i => i.success).length;
    group.innerHTML = `
        <div class="usage-group-header">
            <div class="usage-group-title">
                <i class="fas fa-chevron-right toggle-icon"></i>
                <i class="${getProviderIcon(providerType)} provider-icon"></i>
                <span class="provider-name">${getProviderDisplayName(providerType)}</span>
                <span class="instance-count">${t('usage.group.instances', { count: instances.length })}</span>
                <span class="success-count ${successCount === instances.length ? 'all-success' : ''}">${t('usage.group.success', { count: successCount, total: instances.length })}</span>
            </div>
            <div class="usage-group-actions">
                <button class="btn-toggle-cards"><i class="fas fa-expand-alt"></i></button>
            </div>
        </div>
        <div class="usage-group-content"><div class="usage-cards-grid"></div></div>
    `;
    
    group.querySelector('.usage-group-title').onclick = () => group.classList.toggle('collapsed');
    
    const toggleBtn = group.querySelector('.btn-toggle-cards');
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        const cards = group.querySelectorAll('.usage-instance-card');
        const allCollapsed = Array.from(cards).every(card => card.classList.contains('collapsed'));
        cards.forEach(card => card.classList.toggle('collapsed', !allCollapsed));
        const icon = toggleBtn.querySelector('i');
        icon.className = allCollapsed ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
    };
    
    const grid = group.querySelector('.usage-cards-grid');
    instances.forEach(inst => grid.appendChild(createInstanceUsageCard(inst, providerType)));

    return group;
}

/**
 * 创建实例卡片 (全面适配新结构)
 */
function createInstanceUsageCard(instance, providerType) {
    const card = document.createElement('div');
    card.className = `usage-instance-card ${instance.success ? 'success' : 'error'} collapsed`;
    card.setAttribute('data-uuid', instance.uuid);

    const usage = instance.usage || {};
    const summary = usage.summary || { usedPercent: 0, status: 'normal' };
    const user = usage.user || {};
    const displayName = user.email || instance.name || instance.uuid;

    // 使用后端返回的 planClass，如果缺失则兜底
    const planClass = summary.planClass || 'plan-default';

    card.innerHTML = `
        <div class="usage-card-collapsed-summary">
            <div class="collapsed-summary-row collapsed-summary-name-row">
                <i class="fas fa-chevron-right usage-toggle-icon"></i>
                <span class="collapsed-name" title="${displayName} ${t('usage.clickToManage')}" onclick="event.stopPropagation(); window.jumpToProviderNode('${providerType}', '${instance.uuid}', event)">${displayName}</span>
                ${summary.plan ? `<span class="collapsed-plan-badge ${planClass}">${summary.plan}</span>` : ''}
                ${instance.success ? '<i class="fas fa-check-circle status-success"></i>' : '<i class="fas fa-times-circle status-error"></i>'}
            </div>
            ${instance.success ? `
            <div class="collapsed-summary-row collapsed-summary-usage-row">
                <div class="collapsed-progress-bar ${summary.status}"><div class="progress-fill" style="width: ${summary.usedPercent}%"></div></div>
                <span class="collapsed-percent">
                    ${summary.unit === 'percent' 
                        ? `${summary.usedPercent.toFixed(1)}%` 
                        : `${formatNumber(summary.totalUsed || 0)} / ${formatNumber(summary.totalLimit || 0)}`
                    }
                </span>
            </div>
            ` : (instance.error ? `<div class="collapsed-summary-row collapsed-summary-usage-row"><span class="collapsed-error">${t('common.error')}</span></div>` : '')}
        </div>
        <div class="usage-card-expanded-content">
            <div class="usage-instance-header">
                <div class="instance-header-top">
                    <div class="instance-provider-type"><i class="${getProviderIcon(providerType)}"></i><span>${getProviderDisplayName(providerType)}</span></div>
                    <div class="instance-status-badges">
                        ${instance.configFilePath ? `<button class="btn-download-config" title="${t('usage.card.downloadConfig')}"><i class="fas fa-download"></i></button>` : ''}
                        <button class="btn-refresh-usage" title="${t('usage.card.refresh')}"><i class="fas fa-sync-alt"></i></button>
                        ${instance.isDisabled ? `<span class="badge badge-disabled">${t('usage.card.status.disabled')}</span>` : `<span class="badge ${instance.isHealthy ? 'badge-healthy' : 'badge-unhealthy'}">${t(instance.isHealthy ? 'usage.card.status.healthy' : 'usage.card.status.unhealthy')}</span>`}
                    </div>
                </div>
                <div class="instance-name"><span class="instance-name-text" title="${displayName}">${displayName}</span></div>
                <div class="instance-user-info">
                    ${user.label ? `<span class="user-email"><i class="fas fa-envelope"></i> ${user.label}</span>` : ''}
                </div>
            </div>
            <div class="usage-instance-content"></div>
        </div>
    `;

    card.querySelector('.usage-card-collapsed-summary').onclick = () => card.classList.toggle('collapsed');
    
    if (instance.configFilePath) {
        card.querySelector('.btn-download-config').onclick = (e) => { e.stopPropagation(); downloadConfigFile(instance.configFilePath); };
    }
    
    card.querySelector('.btn-refresh-usage').onclick = (e) => { 
        e.stopPropagation(); 
        refreshSingleInstanceUsage(providerType, instance.uuid, displayName); 
    };

    const contentArea = card.querySelector('.usage-instance-content');
    if (instance.error) {
        contentArea.innerHTML = `<div class="usage-error-message"><i class="fas fa-exclamation-triangle"></i> <span>${instance.error}</span></div>`;
    } else if (instance.usage) {
        contentArea.appendChild(renderUsageDetails(instance.usage, providerType));
    }

    return card;
}

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

/**
 * 渲染用量详情 (全面适配新结构)
 */
function renderUsageDetails(usage, providerType) {
    const container = document.createElement('div');
    container.className = 'usage-details';

    const { items } = usage;
    const summary = resolveUsageSummaryDisplay(usage, providerType);
    
    if (summary?.usedPercent !== undefined) {
        const total = document.createElement('div');
        total.className = 'usage-section total-usage';
        total.innerHTML = `
            <div class="total-usage-header">
                <span class="total-label"><i class="fas fa-chart-pie"></i> <span>${summary.label}</span></span>
                <span class="total-value">${summary.usedPercent.toFixed(1)}%</span>
            </div>
            <div class="progress-bar ${summary.status}"><div class="progress-fill" style="width: ${summary.usedPercent}%"></div></div>
            <div class="total-footer">
                ${summary.resetAt ? `<div class="total-reset-info"><i class="fas fa-history"></i> ${t('usage.card.resetAt', { time: formatDate(summary.resetAt) })}</div>` : ''}
            </div>
        `;
        container.appendChild(total);
    }

    if (items?.length > 0) {
        const breakdown = document.createElement('div');
        breakdown.className = 'usage-section usage-breakdown-compact';
        items.forEach(item => {
            const val = item.unit === 'percent' ? `${item.percent.toFixed(1)}%` : `${formatNumber(item.used)} / ${formatNumber(item.limit)}`;
            const itemEl = document.createElement('div');
            itemEl.className = 'breakdown-item-compact';
            itemEl.innerHTML = `
                <div class="breakdown-header-compact"><span class="breakdown-name">${item.label}</span><span class="breakdown-usage">${val}</span></div>
                <div class="progress-bar-small ${item.status}"><div class="progress-fill" style="width: ${item.percent}%"></div></div>
                ${item.resetAt ? `<div class="extra-usage-info reset-time"><i class="fas fa-history"></i> ${formatDate(item.resetAt)}</div>` : ''}
            `;
            breakdown.appendChild(itemEl);
        });
        container.appendChild(breakdown);
    }

    return container;
}

function getProviderDisplayName(type) {
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === type);
        if (config?.name) return config.name;
    }
    const names = { 'claude-kiro-oauth': 'Claude Kiro', 'gemini-cli-oauth': 'Gemini CLI', 'gemini-antigravity': 'Antigravity', 'openai-codex-oauth': 'Codex', 'grok-cli-oauth': 'Grok CLI', 'grok-web': 'Grok Web' };
    return names[type] || type;
}

function getProviderIcon(type) {
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === type);
        if (config?.icon) return config.icon.startsWith('fa-') ? `fas ${config.icon}` : config.icon;
    }
    const icons = { 'claude-kiro-oauth': 'fas fa-robot', 'gemini-cli-oauth': 'fas fa-gem', 'gemini-antigravity': 'fas fa-rocket', 'openai-codex-oauth': 'fas fa-terminal', 'grok-cli-oauth': 'fas fa-terminal', 'grok-web': 'fas fa-brain' };
    return icons[type] || 'fas fa-server';
}

async function downloadConfigFile(path) {
    try {
        const response = await fetch(`/api/upload-configs/download/${encodeURIComponent(path)}`, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = path.split(/[/\\]/).pop();
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToast(t('common.success'), t('usage.card.downloadSuccess'), 'success');
    } catch (error) {
        showToast(t('common.error'), t('usage.card.downloadFailed') + ': ' + error.message, 'error');
    }
}

function formatNumber(num) {
    if (num === null || num === undefined) return '0.00';
    return (Math.ceil(num * 100) / 100).toFixed(2);
}

function formatDate(str) {
    if (!str) return '--';
    try {
        return new Date(str).toLocaleString(getCurrentLanguage(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return str;
    }
}
