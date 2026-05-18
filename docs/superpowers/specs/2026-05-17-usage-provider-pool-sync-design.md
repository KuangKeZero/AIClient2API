# 用量查询账号池同步设计

## 背景

账号可能通过批量添加或脚本导入进入 provider pool。用户需要在用量查询页面点击一个按钮后，立即核对 provider pool 与用量查询展示数据，把用量查询中缺少的账号补出来，方便确认多少账号已经进入使用状态。

现有代码已经有展示同步基础：`src/ui-modules/usage-api.js` 中的 `syncUsageResultsWithProviderPools` 会把 provider pool 中存在但用量缓存里缺少的账号补成用量占位实例。业务请求是否会使用账号不由用量页面决定，而由 `ProviderPoolManager` 的调度、健康状态、本地额度账本和冷却规则决定。

## 目标

- 在用量查询页面顶部新增“同步账号池”按钮，放在“刷新用量”旁边。
- 点击后只同步本地展示数据，不批量查询真实用量，不访问外部提供商。
- 同步后页面立即显示 provider pool 中缺少的账号，占位账号继续显示本地账本或未知用量状态。
- 返回并展示统计：新增账号数、已存在账号数、跳过禁用账号数、池内账号总数。
- 保持真实业务请求和计费用量规则不变。账号第一次被实际业务请求选中后，继续按现有健康检查、额度账本、阈值、冷却和真实用量刷新规则运行。
- 用量查询中的“待恢复”账号列表默认收缩。

## 非目标

- 不在同步按钮中调用 `usageService.getFormattedUsage`。
- 不新增后台真实用量查询队列。
- 不改变 provider pool 选择账号的策略。
- 不改变账号健康检查、删除 401/403 账号、本地额度估算或冷却规则。

## 用户体验

用量查询页面的操作区新增一个次级按钮：`同步账号池`。点击后按钮进入禁用/加载状态，并显示同步中的提示。接口成功返回后，前端重新渲染用量数据，并显示类似提示：

`同步完成：新增 12 个，已存在 88 个，跳过禁用 3 个`

如果 provider pool 为空，返回 0 统计并提示没有可同步账号。接口失败时显示后端错误信息，页面保留原数据。

“待恢复”账号列表初始为收缩状态。用户在当前页面手动展开或收缩后，继续使用现有内存状态。

## 后端设计

新增接口：

`POST /api/usage/sync-provider-pool`

接口流程：

1. 读取当前 usage cache；如果不存在，使用空 providers 快照。
2. 基于当前 provider pool 统计账号：
   - `poolTotalCount`：provider pool 中所有支持用量查询的账号数量。
   - `activePoolCount`：未禁用账号数量。
   - `disabledSkippedCount`：禁用账号数量。
   - `existingCount`：同步前用量展示中已经存在的未禁用账号数量。
3. 调用现有 `syncUsageResultsWithProviderPools` 合并 provider pool 与用量展示数据。
4. 计算 `addedCount`，即同步后比同步前新增的未禁用账号数量。
5. 叠加本地额度账本摘要，让占位账号仍能显示估算、冷却、待恢复等本地状态。
6. 写回 usage cache。
7. 返回同步后的完整用量数据和统计字段。

接口只处理本地文件和内存状态，不触发外部账号真实用量查询。

## 前端设计

修改用量页面组件和管理脚本：

- 在 `static/components/section-usage.html` 的 `.usage-controls` 中增加 `syncProviderPoolUsageBtn`。
- 在 `static/app/usage-manager.js` 中初始化按钮事件。
- 新增 `syncProviderPoolUsage` 方法，调用 `POST /api/usage/sync-provider-pool`。
- 成功后调用现有 `renderUsageData` 和 `updateTimeInfo`。
- 同步按钮和刷新按钮独立禁用，不阻塞用户后续手动刷新真实用量。
- 将 `pendingRestoreState.collapsed` 初始值改为 `true`。

必要时补充 i18n key；若现有 i18n 结构较重，可先使用与当前用量页一致的中文默认文本和英文/日文回退。

## 数据流

```mermaid
flowchart LR
    A["用户点击同步账号池"] --> B["POST /api/usage/sync-provider-pool"]
    B --> C["读取 usage cache 或空快照"]
    B --> D["读取 provider pool"]
    C --> E["syncUsageResultsWithProviderPools"]
    D --> E
    E --> F["叠加本地额度账本摘要"]
    F --> G["写回 usage cache"]
    G --> H["返回用量数据和统计"]
    H --> I["前端重新渲染用量页"]
```

## 错误处理

- provider pool 管理器未初始化时，接口仍尝试从当前配置读取 pool；若没有可用数据，返回空同步结果。
- usage cache 读取失败时，记录日志并从空快照开始同步。
- usage cache 写入失败时返回 500，避免用户误以为同步已持久化。
- 前端接口失败时显示 toast，并不清空当前页面。

## 测试计划

- 单元测试或轻量服务测试覆盖：缓存为空时同步 provider pool 会生成占位账号。
- 覆盖已有缓存缺少部分账号时，新增数量统计正确。
- 覆盖禁用账号不会显示为可用用量实例，且计入跳过统计。
- 前端手动检查按钮能触发同步、页面新增账号、toast 显示统计。
- 检查“待恢复”列表默认收缩。
