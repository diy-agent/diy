// src/main/services/local-blocks.ts
// 🎯 块协议 G（定稿）：区间即树，id 即节点
//
// 生命周期：start/stop 配对定义嵌套（parent 缺省 = 当前最深打开节点，允许交叉闭合）；
// 数据：delta 按声明类型累加（Text 追加 / List push），patch 按路径覆盖（Flag/重写）；
// 类型在 kind schema（本文件），wire 不携带类型；未知字段按 patch 接收并告警（前向兼容）。
//
// 同一份 Op 流 = 传输协议 = 存储格式（jsonl 重放）= UI 渲染输入。
// 纯函数模块：无 Node/Electron 依赖，main 与 renderer 共用。

// ─── 类型 ─────────────────────────────────────────────

export type JSONVal = string | number | boolean | null | JSONVal[] | { [k: string]: JSONVal };

export type BlockKind = "turn" | "step" | "text" | "think" | "tool" | "plan" | "error";

export type Op =
    | { op: "start"; id: string; kind: BlockKind; parent?: string; meta?: Record<string, JSONVal> }
    | { op: "delta"; id: string; fields: Record<string, JSONVal> }
    | { op: "patch"; id: string; fields: Record<string, JSONVal> }
    | { op: "stop"; id: string };

/** 运行时块：kind 声明字段的扁平容器 + 结构位 */
export interface Block {
    id: string;
    kind: BlockKind;
    parent?: string;
    children: string[];
    /** 收到 stop = 正常定稿；未收到 = 流断裂（interrupted 渲染态） */
    stopped: boolean;
    /** 最后被 op 触碰的序号（单调递增）：同一 turn 内"当前进度"= touched 最大的未 stop 块 */
    touched: number;
    [field: string]: unknown;
}

type FieldKind = "Text" | "List" | "Flag";

/** kind → 字段类型表。children 为结构位（start 自动维护），不接受 delta/patch。 */
const SCHEMA: Record<BlockKind, Record<string, FieldKind>> = {
    turn: { usage: "Flag", status: "Flag", notice: "Flag", reasoningEffort: "Flag", durationMs: "Flag" },
    step: { model: "Flag", usage: "Flag", status: "Flag" },
    // steer / steerId：用户"插嘴"写进对话流的标记（模式 next-step|next-turn，缺省 = 本轮开场的那次发言）
    // 与队列项 id（steer/N，回查用）。走 start 的 meta 落位（见 local-agent 的 steerBlockOps），
    // 声明在这里是给"它们是 text 块的合法字段"一个正式出处 —— 否则将来谁拿 patch 写它们会得到 issue。
    text: { role: "Flag", content: "Text", steer: "Flag", steerId: "Flag" },
    think: { content: "Text" },
    tool: {
        tool: "Flag",
        title: "Flag",
        status: "Flag",
        input: "Text",
        args: "Flag",
        output: "Text",
    },
    plan: { items: "List" },
    error: { source: "Flag", message: "Text" },
};

/**
 * 中断的 tool 调用写进 ops 的终态结果文案（唯一来源：UI 与发往 LLM 的 messages 共用）。
 *
 * 语意必须是「已结束的历史事实」，不能有一丝「待办」味道：
 * 旧文案是「该调用在上一轮中断前未完成，如有需要请重新发起」，agent 重载会话后看到
 * 这条历史，会把它当成未完成的任务而**重发**那条被杀断的命令 —— 任务 92 里被截断的
 * 正是 `kill -9 Electron`，于是「一次对话 = 一次自杀」，用户那向「千万别 kill」
 * 在 90 万 token 的历史里盖不过它。
 */
export const INTERRUPTED_TOOL_NOTICE =
    "[此调用已中断（上一轮未跑完），没有结果；这是已结束的历史记录，不要重试]";

/** 中断终态：收敛后才写进 ops；与 status 无关，未收 stop 也算（旧日志） */
export const INTERRUPTED_STATUS = "interrupted";

/**
 * 把会话里遗留的中断 tool 块收敛成显式终态（patch + stop），供 main 落盘。
 *
 * 为什么必须写进 ops 而不能投影时现造：
 *   1) 现在每次重建历史都现场合成一条「未完成」结果 → 重载后它重生，agent 重复重试；
 *   2) 投影造的数据在真相源（ops）里找不到对应物，UI 看不到（三处不一致）；
 *   3) 收敛后投影退化成纯翻译，将来补字段/换存储也不用改。
 * 幂等：已收敛（status=interrupted 或已 stop）的块不再返回。
 */
export function interruptedToolPatches(store: BlockStore): Op[] {
    const out: Op[] = [];
    for (const b of store.blocks.values()) {
        if (b.kind !== "tool") continue;
        const status = String(b.status ?? "");
        if (status === INTERRUPTED_STATUS) continue; // 已收敛
        if (status === "done" || status === "error") continue; // 业务终态
        if (b.stopped) continue; // 已正常定稿
        out.push({ op: "patch", id: b.id, fields: { status: INTERRUPTED_STATUS, output: INTERRUPTED_TOOL_NOTICE } });
        out.push({ op: "stop", id: b.id });
    }
    return out;
}

/**
 * 把**未收 stop 的块**补上 stop（崩溃/被杀留下的开口块），返回要落盘的 op。
 *
 * 与 interruptedToolPatches 的分工：
 *   · interruptedToolPatches 管 tool 块的**业务终态**（patch status + output + stop）；
 *   · 本函数管**结构闭合**：所有还没 stop 的块（turn / step / text / think / tool …）。
 * 会话加载时调用（幂等）：崩溃现场若停在半轮，不补 stop 就会让 UI 永远显示"本轮未完成"，
 * 且 append-only 的 llm 全量日志也没法给这一轮定稿（定稿判据 = turn 已 stop）。
 *
 * 顺序：倒序遍历（父块总先于子块创建）→ 子先父后，与 closeTurn 的收尾顺序一致。
 *
 * ⚠️ 只补**结构闭合**（stop），**不补 `durationMs`** —— 正常收尾的耗时由 closeTurn 写
 * （`local-agent.ts` 的 `durationMs = Date.now() - turnId 内嵌开始毫秒`），而崩溃/被杀那一刻
 * 进程已死，"这一轮跑到哪结束"无从得知，编一个数就是假事实。故这类轮次的头部**永远没有耗时位**，
 * 只显示「本轮未完成（流中断/崩溃恢复）」。这是有意为之，不是漏填。
 */
export function danglingStopPatches(store: BlockStore): Op[] {
    const out: Op[] = [];
    const ids = [...store.blocks.values()].filter((b) => !b.stopped).map((b) => b.id);
    for (const id of ids.reverse()) out.push({ op: "stop", id });
    return out;
}

// ─── fold：Op 流 → 块树 ───────────────────────────────

export interface FoldIssue {
    op: Op;
    reason: string;
}

export class BlockStore {
    readonly blocks = new Map<string, Block>();
    /** 当前最深打开节点（start 隐式 parent 用；允许非 LIFO 关闭） */
    private openStack: string[] = [];
    readonly issues: FoldIssue[] = [];
    private seq = 0;

    /** 标记块被触碰（所有成功落子的 op 共用出口） */
    private touch(id: string): void {
        const b = this.blocks.get(id);
        if (b) b.touched = ++this.seq;
    }

    apply(op: Op): void {
        switch (op.op) {
            case "start": {
                if (this.blocks.has(op.id)) {
                    this.issues.push({ op, reason: `重复 start: ${op.id}` });
                    return;
                }
                // turn 是会话的顶层容器：一律不挂 parent。
                // 否则隐式 parent（openStack 顶部）会把新 turn 挂到上一轮**未闭合**的
                // step/tool 块下面（被打断的调用收不到 stop），UI 只渲染 root turn
                // → 整轮内容直接从界面消失（实测任务 92：26 轮里有 13 轮被藏起来，
                // 包括最新那轮，用户因此“看不到最后一句”）。
                const parent =
                    op.kind === "turn" ? undefined : (op.parent ?? this.openStack[this.openStack.length - 1]);
                if (parent !== undefined && !this.blocks.has(parent)) {
                    this.issues.push({ op, reason: `parent 不存在: ${parent}` });
                }
                const b: Block = { id: op.id, kind: op.kind, children: [], stopped: false, touched: 0 };
                if (parent !== undefined && this.blocks.has(parent)) {
                    b.parent = parent;
                    this.blocks.get(parent)!.children.push(op.id);
                }
                for (const [k, v] of Object.entries(op.meta ?? {})) {
                    if (k === "children" || k === "id" || k === "kind") continue; // 结构位保留字
                    (b as Record<string, unknown>)[k] = v;
                }
                this.blocks.set(op.id, b);
                this.openStack.push(op.id);
                this.touch(op.id);
                return;
            }
            case "stop": {
                const b = this.blocks.get(op.id);
                if (!b) {
                    this.issues.push({ op, reason: `stop 未知块: ${op.id}` });
                    return;
                }
                b.stopped = true;
                this.touch(op.id);
                // 弹栈：从栈顶找该 id（允许交叉闭合，非 LIFO 时只清它之上的）
                const i = this.openStack.lastIndexOf(op.id);
                if (i >= 0) this.openStack.length = i;
                return;
            }
            case "delta":
            case "patch": {
                const b = this.blocks.get(op.id);
                if (!b) {
                    this.issues.push({ op, reason: `${op.op} 未知块: ${op.id}` });
                    return;
                }
                for (const [path, val] of Object.entries(op.fields ?? {})) {
                    const decl = path === "children" ? undefined : SCHEMA[b.kind]?.[path];
                    if (op.op === "patch") {
                        if (path.includes(".")) setPath(b, path, val);
                        else (b as Record<string, unknown>)[path] = val;
                        continue;
                    }
                    // delta：必须有类型声明，未知字段降级为 patch（前向兼容，记 issue）
                    if (decl === undefined) {
                        this.issues.push({
                            op,
                            reason: `未知字段 ${b.kind}.${path}，delta 降级为 patch`,
                        });
                        setPath(b, path, val);
                        continue;
                    }
                    if (decl === "Flag") {
                        this.issues.push({
                            op,
                            reason: `Flag 字段 ${b.kind}.${path} 不接受 delta，忽略`,
                        });
                        continue;
                    }
                    const cur = path.includes(".")
                        ? getPath(b, path)
                        : (b as Record<string, unknown>)[path];
                    if (decl === "Text") {
                        const next = `${typeof cur === "string" ? cur : ""}${typeof val === "string" ? val : JSON.stringify(val)}`;
                        if (path.includes(".")) setPath(b, path, next);
                        else (b as Record<string, unknown>)[path] = next;
                    } else {
                        // List：值本身是数组则逐元素追加，否则作为单元素 push
                        const arr = Array.isArray(cur) ? [...cur] : [];
                        if (Array.isArray(val)) arr.push(...(val as JSONVal[]));
                        else arr.push(val);
                        (b as Record<string, unknown>)[path] = arr;
                    }
                }
                this.touch(op.id);
                return;
            }
        }
    }

    /** 应用剩余 op 后，把所有未闭合块标记 interrupted 语义（stopped=false 即中断） */
    roots(): Block[] {
        return [...this.blocks.values()].filter((b) => b.parent === undefined);
    }
}

/** 从持久化 Op 日志重建块树（重放入口） */
export function replay(ops: Op[]): BlockStore {
    const s = new BlockStore();
    for (const op of ops) s.apply(op);
    return s;
}

// ─── 点分路径读写（'usage.in' / 'plan.items'）─────────

function getPath(obj: unknown, path: string): unknown {
    let cur: unknown = obj;
    for (const seg of path.split(".")) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

function setPath(obj: unknown, path: string, val: unknown): void {
    const segs = path.split(".");
    let cur = obj as Record<string, unknown>;
    for (const s of segs.slice(0, -1)) {
        if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = {};
        cur = cur[s] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1]!] = val;
}

// ─── 树导出（调试/CLI 用，JSONML 形）──────────────────

export interface BlockNode {
    tag: string;
    id: string;
    /** 定稿态（stop 已到）；false = 直播中或中断残留 */
    stopped: boolean;
    /** 最后触碰序号：turn 内"当前进度"= touched 最大的未 stop 块 */
    touched: number;
    attrs: Record<string, unknown>;
    children: BlockNode[];
}

/**
 * 树导出的**身份缓存**（按 store 隔离，store 被换掉即随 GC 走）。
 *
 * 为什么必须做（任务 236 的根因）：UI 的 `<For each={trees}>` 在 Solid 里**按引用 diff**。
 * 原来的实现每次返回全新对象 → 每帧刷新都把**每一轮**的 TurnView/LeafView 销毁重建
 * （连带全量 Markdown re-parse）→ 三个实测症状：折叠态被清、点击像没反应、长回答卡顿。
 * 这里让「没有任何 op 触碰过的子树」返回**同一对象**，于是重建退化成"只有变化的那一轮更新"。
 *
 * 判据（为什么这样判是完备的）：
 *   · 块内字段的一切写入都走 `touch()`（start/stop/delta/patch 四条路径），
 *     故 `touched` 不变 ⇒ 该块自身字段不变；
 *   · 子节点数量变化（新增/减少）由 `children` 长度比较捕捉 —— 新子块挂上去时
 *     **父块的 touched 不会变**（`start` 只 push 到父的 children），漏了这条会丢掉新内容；
 *   · 子孙里的变化会让某个祖先的 children 或 touched 不同 → 递归比较能逐层发现。
 */
interface TreeCache {
    node: BlockNode;
}
const treeCaches = new WeakMap<BlockStore, Map<string, TreeCache>>();

function cacheOf(store: BlockStore): Map<string, TreeCache> {
    let c = treeCaches.get(store);
    if (!c) {
        c = new Map();
        treeCaches.set(store, c);
    }
    return c;
}

/** 两串子节点是否逐一同引用（同引用 ⇒ 那一支整棵未变，可整块复用） */
function sameNodes(a: readonly BlockNode[], b: readonly BlockNode[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function buildNode(store: BlockStore, rootId: string, cache: Map<string, TreeCache>): BlockNode {
    const b = store.blocks.get(rootId);
    if (!b) {
        // 原实现用 `!` 断言。此处显式兜底：ops 是 append-only 的史书，读侧不该因
        // 一条悬挂引用（理论上不该出现）整棵树崩掉 —— 给一个最小的占位节点并出声。
        console.warn(`[local-blocks] toTree：块不存在 ${rootId}`);
        return { tag: "error", id: rootId, stopped: true, touched: 0, attrs: {}, children: [] };
    }
    const children = b.children.map((c) => buildNode(store, c, cache));
    const prev = cache.get(rootId)?.node;
    // 自身未变（touched/stopped）且子节点逐个同引用 → 整棵复用（**不新建任何对象**）
    if (prev && prev.touched === b.touched && prev.stopped === b.stopped && sameNodes(prev.children, children)) {
        return prev;
    }
    const { id, kind, children: _kids, stopped, touched, ...attrs } = b;
    delete (attrs as Record<string, unknown>).parent; // parent 由 children 树表达，不进 attrs
    const node: BlockNode = {
        tag: kind,
        id,
        stopped,
        touched,
        attrs: { ...attrs, ...(stopped ? {} : { interrupted: true }) },
        children,
    };
    cache.set(rootId, { node });
    return node;
}

/**
 * 导出块树。**同一次未变的子树返回同一对象**（见上方 TreeCache 的理由），
 * 调用方可安全用引用相等做 diff。
 */
export function toTree(store: BlockStore, rootId: string): BlockNode {
    return buildNode(store, rootId, cacheOf(store));
}

/**
 * 导出全部根（turn）树。与逐个 `toTree` 等价，只是把「取根」这一步也收进来，
 * 免得调用方各自 `roots().map(...)`（两处写法就会有两套缓存语义）。
 */
export function toForest(store: BlockStore): BlockNode[] {
    const cache = cacheOf(store);
    return store.roots().map((r) => buildNode(store, r.id, cache));
}

// ─── 块 ↔ ModelMessage（历史重建，供 LLM 续聊）────────
//
// 约定（与 local-agent adapter 对齐）：
//  - text 块 meta.role='user'|'assistant'；content 为 Text 字段
//  - think 块不回传给模型（推理是 agent 的内部产物）
//  - tool 块 id = toolCallId；args=定稿入参对象，output=结果文本，status ∈ running|done|error
//  - 每个 turn 的 step 子节点按序产出 assistant 消息（text+tool-call）与 tool 结果消息

// 与 @ai-sdk 的 ModelMessage 结构对齐的最小类型（避免本模块依赖 ai 包）
export interface LocalTextPart {
    type: "text";
    text: string;
}
export interface LocalToolCallPart {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: JSONVal;
}
/**
 * 工具结果的**来源**（自证位）：`output.value` 一个槽三义共用，靠它才分得清。
 *   "tool"        —— 工具真实产出（唯一允许被裁剪的东西）
 *   "interrupted" —— 本地补的中断终态文案（契约文本，永不裁剪；见 INTERRUPTED_TOOL_NOTICE）
 *   "empty"       —— 工具跑完但没有输出（占位"（空结果）"）
 * 只写在**落盘/投递的序列化产物**里（`withOrigin`）；真发 provider 前剥掉（原生 part 形状不变）。
 */
export type ToolResultOrigin = "tool" | "interrupted" | "empty";

export interface LocalToolResultPart {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text"; value: string };
    /** 自证位（仅 withOrigin 时写；投递默认不带 —— 见 ToolResultOrigin） */
    origin?: ToolResultOrigin;
}
export interface LocalModelMessage {
    role: "user" | "assistant" | "tool";
    content: string | Array<LocalTextPart | LocalToolCallPart | LocalToolResultPart>;
    /**
     * 索引位（仅 withIndex 时写；**落盘日志用**，投递不带）：这条消息属于哪一轮？
     * 只有 turn 是**必填** —— 开场 user 块（含插话）的 parent 就是 turn，不属于任何 step
     * （实测 tasks_100：888 条可投递消息里 54 条无 step，全是每轮的开场 user）。
     */
    turn?: string;
    /** 属于哪一步（`<turnId>_s<n>`）；开场 user 与插话没有它 */
    step?: string;
}

/**
 * 投递选项（**压缩能力的落点**）。
 *
 * 为什么裁剪必须落在这里、而不是工具 execute 里：
 *   执行时裁 = 原文当场丢（UI 也看不到全量）、且新输出也一起被裁；
 *   投递时裁 = 块树/UI/落盘全是原文，只有「发给模型的那一份」被裁 —— 用户随时能看全量，
 *              原文还能另存一份供模型回取（见 clipToolResult 的 origPath）。
 * 两者作用阶段不同，可与 execute 侧的 clip()（错误路径 6000 字符）并存。
 */
export interface DeliveryOpts {
    /**
     * 【新·目标式预算】历史消息可占字节上限（不含固定开支）。**有它就按纵向优先级阶梯选择**，
     * 忽略 `sinceTurnId`/`content`（旧的轮边界口径）—— 见 selectHistoryByBudget。
     */
    budgetBytes?: number;
    /** 只投递从这个 turn 起的块（压缩边界）；null = 一个都不投（全部清零）；缺省 = 全投 */
    sinceTurnId?: string | null;
    /**
     * 工具结果渲染（由 main 注入：同一份纯函数既算预览也算真发，见 shared/context/compaction）。
     * **不带 title**：渲染只需要「谁的输出、输出是什么」，title 是 UI 的东西（曾经传了但没人用，
     * 留着等于撒谎说渲染依赖它）。
     */
    transformToolResult?: (b: { id: string; tool: string; output: string }) => string;
    /**
     * 写 tool-result 的 `origin` 自证位（缺省 false = 原生形状，用于**真发**）。
     * 落盘（llm.jsonl 全量日志）时置 true —— 于是"这条 value 是工具给的还是本地补的"
     * 不再靠比对字符串，压缩统计/UI 标记/索引 why 都能程序化取。
     */
    withOrigin?: boolean;
    /**
     * 写消息级 `turn`/`step` 索引位（缺省 false = 原生形状，用于**真发**）。
     * 落盘时置 true：llm.jsonl 的行号因此能反查「这条消息属于哪轮哪步」，
     * 压缩索引才能给出「第 1~74 行 = 第 1~2 轮」这种可回取的概念（而不是字节偏移）。
     */
    withIndex?: boolean;
}

// ─── 投影 = 选择 + 渲染（**两段分离**）──────────────────────────────
//
// 为什么必须分开（##269 D3b）：
//   · **选择**（投什么）是纯下标运算 —— 压缩注记要给模型「哪些行被省了」，那是**行号**，
//     只有把选择做成"在全量投影上取/舍哪些下标"才说得清；把选择与裁剪揉在 walk 里，
//     注记就只能靠"另算一份"（两份判据必然分叉，##227 的老教训）。
//   · **渲染**（怎么呈现）才涉及工具结果裁剪/origin 自证位等形状问题。
// 于是：全量投影（= llm.jsonl 每行）→ 选择 → 渲染。预览与真发共用同一条链。

import { utf8Bytes } from "../../shared/context/compaction";
// 选择算法（元件库 + 装配器）—— 见 compaction-plan.ts 头注。此处**转出**旧公开名以保持兼容。
import { runPlan, defaultBudgetPlan, HISTORY_LADDER, type BudgetSelection, type HistoryRank } from "./compaction-plan";
export { HISTORY_LADDER, type HistoryRank, type BudgetSelection };

/**
 * **全量投影**：块树 → 消息（不做任何选择、不裁剪工具结果）。
 * 它是「原文的消息形态」= llm.jsonl 的每一行 —— 所以**数组下标 + 1 = 行号**，
 * 压缩注记给模型的行号就是它。
 *
 * `turn`/`step`/`origin` 一律算出来（选择与渲染都要用），是否**写进**结果由
 * `blocksToMessages` 按 opts 剥掉。
 */
export function projectAll(store: BlockStore): LocalModelMessage[] {
    const out: LocalModelMessage[] = [];
    const walk = (id: string, turnId?: string, stepId?: string) => {
        const b = store.blocks.get(id)!;
        // turn 只认 turn 块自己；step 只认 step 块自己 —— 之后的叶块一路继承下来
        // （开场 user 的 parent 是 turn、assistant/tool 的 parent 是 step，继承即如实反映）
        const turn = b.kind === "turn" ? b.id : turnId;
        const step = b.kind === "step" ? b.id : stepId;
        if (b.kind === "text") {
            const role = (b.role as string) ?? "user";
            const text = (b.content as string) ?? "";
            if (!text) return;
            if (role === "user") out.push({ role: "user", content: text, turn, ...(step ? { step } : {}) });
            else {
                // assistant 文本并入最近的 assistant 消息（若上一条正是纯文本 assistant 则拼接）
                const last = out[out.length - 1];
                if (
                    last?.role === "assistant" &&
                    typeof last.content !== "string" &&
                    !last.content.some((p) => p.type === "tool-call")
                ) {
                    (last.content as LocalTextPart[]).push({ type: "text", text });
                } else {
                    out.push({ role: "assistant", content: [{ type: "text", text }], turn, ...(step ? { step } : {}) });
                }
            }
            return;
        }
        if (b.kind === "tool") {
            // 指令不全的 tool 调用不投影进 LLM 历史 —— 这是**废弃的半截消息**。
            // args 是 Flag 字段，只有 ai-sdk 的 tool-call 事件（入参流式完成）才会 patch 它；
            // args 为空 ⇒ tool-call 从未到达 ⇒ 停止按钮 / 断流 / 进程被杀发生在「模型正在
            // 流式吐入参」的途中。此时这条指令既没下达完成、也没有执行，无从恢复：
            //   · 硬发只能带 input:{} 的假指令，模型会以为「我下过一条空命令」并据此推理；
            //   · 残缺的 input（Text 字段，delta 拼到一半）不是合法入参，也没有可靠补全方式。
            // 与 tool-result 同处一个分支整体跳过，不破坏「每个 tool-call 必有 tool-result」铁律。
            // UI 侧不受影响：中断态由 interruptedToolPatches 落进 ops，渲染走 toTree 块树，
            // 用户照旧看得到「这条被截断了」——只是它不再进入发给模型的上下文。
            // 对照组（必须保留）：args 有值但没跑完 = 指令已下达、命令可能真的执行过，
            // 这时靠下面的 INTERRUPTED_TOOL_NOTICE 钉死「已结束、别重试」（任务 92 的教训）。
            if (b.args == null) return;
            out.push({
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: b.id,
                        toolName: String(b.tool ?? "bash"),
                        // 上面已挡住 args 为空的半截指令，这里不再兜底成 {}：
                        // 兜底正是「空指令混进历史」的元凶，留着它等于把 bug 藏起来
                        input: b.args as JSONVal,
                    },
                ],
                turn,
                ...(step ? { step } : {}),
            });
            // 配对铁律：每个 tool-call 必有 tool-result，否则下一轮 provider 拒整个历史。
            // （只适用于走到这里的块 —— 指令已下达；半截指令在上面整体跳过了。）
            const status = String(b.status ?? "");
            // ⚠️ 「中断」必须由 **status** 判定，不能由「output 是否非空」判定 ——
            //    interruptedToolPatches 收敛时会往 output 写上同一句契约文案，于是收敛后
            //    output 变非空，旧判据（typeof b.output === "string" && b.output）就会把它
            //    当成工具真实输出送去裁剪：callpath 模式把它换成「[输出已省略（只留调用）…]」，
            //    并指向一个**根本不存在的** toolout/<id>.txt。同一份历史，投递结果取决于
            //    "这块有没有被收敛过" —— 是 bug（本地补的错误信息被当作历史投递）。
            const interrupted = status === INTERRUPTED_STATUS;
            const realOut = typeof b.output === "string" && b.output !== "";
            const doneish = status === "done" || status === "error";
            const raw = interrupted
                ? INTERRUPTED_TOOL_NOTICE
                : realOut
                  ? (b.output as string)
                  : doneish
                    ? "（空结果）"
                    : INTERRUPTED_TOOL_NOTICE;
            const origin: ToolResultOrigin =
                interrupted || (!realOut && !doneish) ? "interrupted" : realOut ? "tool" : "empty";
            out.push({
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: b.id,
                        toolName: String(b.tool ?? "bash"),
                        output: { type: "text", value: raw },
                        origin,
                    },
                ],
                turn,
                ...(step ? { step } : {}),
            });
            return;
        }
        for (const c of b.children) walk(c, turn, step);
    };
    for (const r of store.roots()) walk(r.id);
    return out;
}

/** 消息的内容类别（**只看结构，不解析文本** —— 文本是用户数据，格式不可控） */
export type MessageKind = "user" | "assistant-text" | "tool-chain";

export function kindOfMessage(m: LocalModelMessage): MessageKind {
    if (m.role === "user") return "user";
    if (m.role === "tool") return "tool-chain";
    const parts = Array.isArray(m.content) ? m.content : [];
    return parts.some((p) => p.type === "tool-call") ? "tool-chain" : "assistant-text";
}

/** 选择结果：全量投影里的下标（升序）——**行号 = 下标 + 1** */
export interface HistorySelection {
    kept: number[];
    dropped: number[];
}

/**
 * **选择**：全量投影 + 策略 → 保留哪些下标（纯函数，与渲染无关）。
 *
 * ① 轮级边界（`sinceTurnId`）：
 *      · 缺省      → 全投（与历史行为逐字一致）
 *      · `null`    → 一条不投（全部清零）
 *      · 指向某轮  → 该轮及其后投；**找不到该轮时退化为全投**（宁可多给，也别让用户
 *                    面对一个空白会话 —— 日志被换/跨机器时会遇到）
 * ② 内容级（`content`）：**整条丢** tool 链路（tool-call 与 tool-result 同批丢 ⇒ 配对铁律
 *    天然不破）；`conclusion` 再在每轮只留**最后一条**助手文本（省掉"我先看看…"过程文本）。
 */
/** **轮边界选择**（旧机制，仅 `selectForDelivery` 在无 budgetBytes 时兜底用；投递主路径走预算） */
export function selectHistory(
    all: readonly LocalModelMessage[],
    opts: Pick<DeliveryOpts, "sinceTurnId"> = {},
): HistorySelection {
    const since = "sinceTurnId" in opts ? opts.sinceTurnId : undefined;
    const n = all.length;
    const keep = new Array<boolean>(n).fill(true);
    if (since === null) {
        keep.fill(false);
    } else if (since !== undefined) {
        const i = all.findIndex((m) => m.turn === since);
        if (i >= 0) for (let k = 0; k < i; k++) keep[k] = false;
    }
    const kept: number[] = [];
    const dropped: number[] = [];
    for (let k = 0; k < n; k++) (keep[k] ? kept : dropped).push(k);
    return { kept, dropped };
}

// ─── 预算驱动的历史选择（用户 2026-10-07：目标式压缩）──────────────────
//
// 选择算法已抽到 `compaction-plan.ts`（**元件库 + 装配器**，用户 2026-10-08）：把「排序 / 配对 /
// 预算累加」拆成可组合的**挑选元件**，默认管道 `defaultBudgetPlan` 复刻既有纵向阶梯行为。
// 本函数是投递侧的**稳定入口**（真发 / 预览 / 记账共用），内部委托默认管道 ⇒ 行为逐字节不变。
//
// 为什么是**纵向**（用户 2026-10-07 纠正「逐轮降解」）：**主干 > 细节**。用户发言是他
// 记得、认为重要的主干，不管多旧都应优先保留；工具结果只是可回取的细节。按轮（横向）
// 会把前面重要的用户消息整轮陪葬 —— 后几轮工具垃圾一爆，前面的用户发言就没了。

/**
 * **预算选择**：全量投影 + 预算 → 保留哪些下标（纯函数）。
 * 内部委托 `runPlan` + 默认管道（= 纵向阶梯 + 计入预算）；实现见 `compaction-plan.ts`。
 */
export function selectHistoryByBudget(
    all: readonly LocalModelMessage[],
    budgetBytes: number,
    opts: Pick<DeliveryOpts, "transformToolResult"> = {},
): BudgetSelection {
    return runPlan(all, defaultBudgetPlan(budgetBytes), {
        // 成本 = **投递**口径（渲染后字节；工具结果已按策略裁剪）
        costOf: (m) => utf8Bytes(JSON.stringify(renderMessage(m, opts))),
    });
}

/**
 * **渲染**：保留下来的消息 → 可发/可落盘的形状。
 * 两件事：① 工具结果裁剪（只作用于**真实输出**，见 origin）；② 按 opts 决定写不写
 * `turn`/`step`/`origin` 自证位（真发不带，落盘带）。
 */
function renderMessage(m: LocalModelMessage, opts: DeliveryOpts): LocalModelMessage {
    const out: LocalModelMessage = { role: m.role, content: m.content };
    if (opts.withIndex) {
        if (m.turn !== undefined) out.turn = m.turn;
        if (m.step !== undefined) out.step = m.step;
    }
    if (m.role !== "tool") return out;
    const transform = opts.transformToolResult;
    const parts = (m.content as LocalToolResultPart[]).map((p) => {
        const part: LocalToolResultPart = {
            type: "tool-result",
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            output: {
                type: "text",
                // 裁剪只作用于**工具真实输出**（origin="tool"）—— 中断契约文本与占位文案动了
                // 就误导模型（用户 2026-10-06：本地补的错误信息不许当历史投递）
                value:
                    transform && p.origin === "tool"
                        ? transform({ id: p.toolCallId, tool: p.toolName, output: p.output.value })
                        : p.output.value,
            },
        };
        if (opts.withOrigin && p.origin) part.origin = p.origin;
        return part;
    });
    out.content = parts;
    return out;
}

/**
 * **选择分派**（唯一入口）：预算口径（新）与轮边界口径（旧）二选一。
 * ⚠️ 所有需要"投递了哪些消息"的地方都必须走这里 —— 直接调 `selectHistory` 会漏掉预算
 * （实测 bug：sizeOfOps 曾直接调 selectHistory，清零/预算下 after.turns 数错）。
 */
export function selectForDelivery(
    all: readonly LocalModelMessage[],
    opts: DeliveryOpts = {},
): { kept: number[]; dropped: number[] } {
    return opts.budgetBytes !== undefined
        ? selectHistoryByBudget(all, opts.budgetBytes, opts)
        : selectHistory(all, opts);
}

/** 块树 → 可发/可落盘的消息（选择 + 渲染；跳过 turn/step 容器与 think） */
export function blocksToMessages(store: BlockStore, opts?: DeliveryOpts): LocalModelMessage[] {
    const o = opts ?? {};
    const all = projectAll(store);
    const sel = selectForDelivery(all, o);
    return sel.kept.map((i) => renderMessage(all[i]!, o));
}
