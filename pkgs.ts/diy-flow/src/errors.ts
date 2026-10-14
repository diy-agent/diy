// errors.ts — @diy/flow 统一错误类型
//
// 与 @diy/talk 同口径：**任何一条诊断都不允许降级为静默丢弃**。工作流是「位置 = 单指针」的容器，
// 一条非法的边 / 一个未知节点若被静默忽略，轨迹就会悄悄偏到另一条路径上 —— 而「偏了一步」
// 正是折线投影最难肉眼发现的失败形态（##166 §7.4 痛点 2：靠肉眼对齐会幻觉）。

/** 错误分类（UI / 测试 / 宿主按此判断处置方式） */
export type FlowErrorCode =
    /** 工作流定义非法：字段类型不对、缺必填、未知 actor / kind / renderer、art / params 形状不对 */
    | 'invalid-def'
    /** 节点 id 重复（边只能引用 id，id 必须唯一） */
    | 'duplicate-node'
    /** 边指向不存在的节点 id（打错字 / 指了泳道 —— 第一节唯一护栏的运行期兜底） */
    | 'dangling-edge'
    /** 同一条 (from, to) 出现多条边（无 guard 求值时无法确定走哪条，见 ##315） */
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
    | 'duplicate-event-id';

/** 本包唯一错误类型：带 `code`（机器判据）与 `path`（从根到字段的点路径，如 `edges[2].to`） */
export class FlowError extends Error {
    readonly code: FlowErrorCode;
    /** 出错位置的点路径；空串表示整体 */
    readonly path: string;

    constructor(code: FlowErrorCode, message: string, path = '') {
        super(path === '' ? `${code}: ${message}` : `${code} @ ${path}: ${message}`);
        this.name = 'FlowError';
        this.code = code;
        this.path = path;
    }
}
