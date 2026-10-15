// errors.ts — @diy/flow 统一错误类型
//
// 与 @diy/talk 同口径：**任何一条诊断都不允许降级为静默丢弃**。工作流是「位置 = 单指针」的容器，
// 一条非法的边 / 一个未知节点若被静默忽略，轨迹就会悄悄偏到另一条路径上 —— 而「偏了一步」
// 正是折线投影最难肉眼发现的失败形态（##166 §7.4 痛点 2：靠肉眼对齐会幻觉）。

/** 错误分类（UI / 测试 / 宿主按此判断处置方式） */
export type FlowErrorCode =
    /** 工作流定义非法：字段类型不对、缺必填、未知 actor / kind / renderer、art / params 声明形状不对 */
    | 'invalid-def'
    /** 节点 id 重复（边只能引用 id，id 必须唯一） */
    | 'duplicate-node'
    /** 边指向不存在的节点 id（打错字 / 指了泳道 —— 第一节唯一护栏的运行期兜底） */
    | 'dangling-edge'
    /** 同一条 (from, to) 出现多条边（「走哪条」必须唯一：消歧只看 kind + when，见 eval.ts 的 selectEdge） */
    | 'duplicate-edge'
    /** 找不到入口节点（没有任何一条边指向的节点） */
    | 'no-entry'
    /** 入口节点不唯一 */
    | 'multiple-entry'
    /** 事件非法：锚点不是 `node` 类型（位置变更只能锚在泳道节点上） */
    | 'invalid-event'
    /** 事件指向工作流里不存在的节点 */
    | 'unknown-node'
    /** 当前节点到目标节点之间没有边（不允许跳步） */
    | 'no-edge'
    /** 首个事件没有进入入口节点 */
    | 'invalid-entry'
    /** 事件流里 id 重复（事件是事实，id 必须唯一） */
    | 'duplicate-event-id'
    /** guard 引用不合法：缺前缀 / 未知前缀 / 缺名字（形状：`pred:` / `action:` / `prompt:` + 名字） */
    | 'invalid-guard'
    /** 注册插件时槽位 / 名字 / 函数非法 */
    | 'invalid-plugin'
    /** 同一槽位同名插件重复注册（不静默覆盖） */
    | 'duplicate-plugin'
    /** 引用了未注册的插件（**不许静默降级**：打错一个字会静默把工作流推成另一条路径） */
    | 'unknown-plugin'
    /** 插件返回值形状不对（缺必填字段 / 类型错） */
    | 'invalid-plugin-result'
    /** actor 宣布推进，但可观测 guard 未过 */
    | 'guard-failed'
    /** 节点的 guard 全可观测（系统节点），只能由系统推 —— actor 不得宣布 */
    | 'not-declarable'
    /** 同种出边多条、`when` 命中数不为 1（不替作者掷骰子） */
    | 'ambiguous-edge'
    /** 打回次数超过上限（死循环护栏） */
    | 'bounce-limit'
    /** 运行期选项 / 调用入参形状不对（未知字段 —— 如把 `maxBounces` 拼成 `maxBounce`） */
    | 'invalid-option'
    /** 宣布非法：`author` 空 / 冒用内核保留字 `system` / 宣布请求形状不对 */
    | 'invalid-declare'
    /** 宣布走一条边，但那条边的 `when`（**边的条件**）此刻不成立 —— 这条边此刻不可用 */
    | 'edge-unavailable'
    /** 参数值 / 序列化快照非法：类型不对、enum 不在候选、number 越界、非纯 JSON、defaults 与 schema 不一致 */
    | 'invalid-param'
    /** 参数名不在声明里（未知节点 / 未知局部名）—— 与 `unknown-plugin` 同型：绝不静默忽略 */
    | 'unknown-param'
    /** 插件函数自己抛了异常（宿主边界：统一包装成 FlowError；`cause` 保留原异常） */
    | 'plugin-threw';

/** 本包唯一错误类型：带 `code`（机器判据）与 `path`（从根到字段的点路径，如 `edges[2].to`） */
export class FlowError extends Error {
    readonly code: FlowErrorCode;
    /** 出错位置的点路径；空串表示整体 */
    readonly path: string;
    /** 原始异常（仅 `plugin-threw` 之类「包了个下层的错」时有值） */
    readonly cause?: unknown;

    constructor(code: FlowErrorCode, message: string, path = '', cause?: unknown) {
        super(path === '' ? `${code}: ${message}` : `${code} @ ${path}: ${message}`);
        this.name = 'FlowError';
        this.code = code;
        this.path = path;
        if (cause !== undefined) this.cause = cause;
    }
}
