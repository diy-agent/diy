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
    turn: { usage: "Flag", status: "Flag", notice: "Flag" },
    step: { model: "Flag", usage: "Flag", status: "Flag" },
    text: { role: "Flag", content: "Text" },
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
 * 落在协议上的「中断」信号：tool 块未收到 stop = 流断裂（SIGKILL/取消/断连）。
 * 与 status 无关 —— status 可能停在 running，但 stopped 才是权威定稿标记。
 */
export function isInterruptedTool(b: { kind: BlockKind; stopped: boolean }): boolean {
    return b.kind === "tool" && !b.stopped;
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

export function toTree(store: BlockStore, rootId: string): BlockNode {
    const b = store.blocks.get(rootId)!;
    const { id, kind, children, stopped, touched, ...attrs } = b;
    delete (attrs as Record<string, unknown>).parent; // parent 由 children 树表达，不进 attrs
    return {
        tag: kind,
        id,
        stopped,
        touched,
        attrs: { ...attrs, ...(stopped ? {} : { interrupted: true }) },
        children: children.map((c) => toTree(store, c)),
    };
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
export interface LocalToolResultPart {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text"; value: string };
}
export interface LocalModelMessage {
    role: "user" | "assistant" | "tool";
    content: string | Array<LocalTextPart | LocalToolCallPart | LocalToolResultPart>;
}

/** 块树 → ModelMessage[]（跳过 turn/step 容器与 think） */
export function blocksToMessages(store: BlockStore): LocalModelMessage[] {
    const out: LocalModelMessage[] = [];
    const walk = (id: string) => {
        const b = store.blocks.get(id)!;
        if (b.kind === "text") {
            const role = (b.role as string) ?? "user";
            const text = (b.content as string) ?? "";
            if (!text) return;
            if (role === "user") out.push({ role: "user", content: text });
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
                    out.push({ role: "assistant", content: [{ type: "text", text }] });
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
            });
            // 配对铁律：每个 tool-call 必有 tool-result，否则下一轮 provider 拒整个历史。
            // （只适用于走到这里的块 —— 指令已下达；半截指令在上面整体跳过了。）
            //
            // 优先用块自己的 output：中断块在「新一轮开始」时已被 main 收敛成显式终态
            // （interruptedToolPatches 写入 ops），所以这里绝大多数情况是**纯翻译**。
            // 兼容分支（工具正在跑但历史已要发出）仍拿 INTERRUPTED_TOOL_NOTICE 兜底，
            // 不另写文案 —— 保证 UI 与请求永远同源。
            const status = String(b.status ?? "");
            const doneish =
                status === "done" || status === "error" || status === INTERRUPTED_STATUS;
            const value =
                typeof b.output === "string" && b.output
                    ? b.output
                    : doneish
                      ? "（空结果）"
                      : INTERRUPTED_TOOL_NOTICE;
            out.push({
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: b.id,
                        toolName: String(b.tool ?? "bash"),
                        output: { type: "text", value },
                    },
                ],
            });
            return;
        }
        for (const c of b.children) walk(c);
    };
    for (const r of store.roots()) walk(r.id);
    return out;
}


/** ModelMessage[] → Op 流（启动时从旧日志恢复内存 messages 的双向一致性自检也可用） */
export function messagesToOps(msgs: LocalModelMessage[]): Op[] {
    const ops: Op[] = [];
    let n = 0;
    for (const m of msgs) {
        if (m.role === "user") {
            const id = `h_u_${n++}`;
            ops.push({ op: "start", id, kind: "text", meta: { role: "user" } });
            ops.push({
                op: "delta",
                id,
                fields: { content: typeof m.content === "string" ? m.content : "" },
            });
            ops.push({ op: "stop", id });
            continue;
        }
        if (m.role === "assistant" && typeof m.content === "string") {
            const id = `h_a_${n++}`;
            ops.push({ op: "start", id, kind: "text", meta: { role: "assistant" } });
            ops.push({ op: "delta", id, fields: { content: m.content } });
            ops.push({ op: "stop", id });
            continue;
        }
        if (m.role === "assistant" && Array.isArray(m.content)) {
            for (const p of m.content) {
                if (p.type === "text") {
                    const id = `h_a_${n++}`;
                    ops.push({ op: "start", id, kind: "text", meta: { role: "assistant" } });
                    ops.push({ op: "delta", id, fields: { content: p.text } });
                    ops.push({ op: "stop", id });
                } else if (p.type === "tool-call") {
                    ops.push({
                        op: "start",
                        id: p.toolCallId,
                        kind: "tool",
                        meta: { tool: p.toolName },
                    });
                    ops.push({
                        op: "patch",
                        id: p.toolCallId,
                        fields: { args: p.input, status: "done" },
                    });
                    ops.push({ op: "stop", id: p.toolCallId });
                }
            }
            continue;
        }
        if (m.role === "tool" && Array.isArray(m.content)) {
            for (const p of m.content) {
                if (p.type === "tool-result") {
                    ops.push({ op: "delta", id: p.toolCallId, fields: { output: p.output.value } });
                    ops.push({ op: "stop", id: p.toolCallId });
                }
            }
        }
    }
    return ops;
}
