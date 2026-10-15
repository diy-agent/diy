// src/main/core/flow.ts — 工作流实例的**领域操作**（`diy flow` 域的业务层）
//
// 这一层的存在理由（##319 交付物）：内核（`@diy/flow`）**不碰 fs**、**不取时间**、**不编人类文本** ——
// 于是「实例落在哪 / 现在几点 / 这条转移怎么说人话」全是宿主的活，本文件就是这三件的唯一落点。
//
// 三条口径（与内核对齐，别在别处另立）：
//   1. **正路是 `advance`**（`rule.domain-first`）：位置变更只走它，且**必须带 `params`**
//      （##333 review2 P1 —— 用正路落盘的状态要能读回同配置）。内核的 `step`/`declare`（guard 求值）
//      是第一版范围外：本版没有插件、guard 全是 `prompt:`，见 `workflows/dev.ts` 头注。
//   2. **参数值语义校验唯一闸门 = `createRuntime`**（读盘不校验，盘上可能脏）—— 故 `start` / `params set`
//      都过一遍 `createRuntime`，拿它合并缺省后的**全量**值去落盘（`rule.params-in-state`）。
//   3. **换参数值 = 另起一次运行**（内核同一立场）：已进入的实例不许改参数值，只允许「尚未进入」时改
//      —— 这正对应遗留观察 **O-1**（`position === null` 却带 `params` 的态）；本版据此实现，**不改内核**。
//
// 命令语义（比内核更严一档，避免「两条命令都能走同一条边」的模糊）：
//   `advance` 只走 `next` 边；`bounce` 只走 `bounce` 边。首次推进必须落到入口节点（内核 `invalid-entry`）。

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
    createRegistry,
    createRuntime,
    advance,
    paramsOf,
    parseFlowState,
    renderHint,
    type FlowState,
    type ParamEntry,
    type Visit,
    type WorkflowDef,
} from "@diy/flow";
import { listWorkflows, workflowById, workflowIds, type WorkflowSummary } from "../workflows";
import { projectsRoot, taskExists } from "./state";
import {
    appendAudit,
    appendPathRecord,
    assertSnapshotMatches,
    flowDir,
    flowFile,
    readAudit,
    readBinding,
    readState,
    writeBinding,
    writeState,
    type FlowBinding,
} from "./flow-store";

// ═══════════════════════════════════════════════════════════════
// 视图（RPC 出参形状；renderer 后续可复用同一份语义）
// ═══════════════════════════════════════════════════════════════

/** 一条出边（「卡在哪条边」的数据源：当前节点可走的边 + 各自的条件） */
export interface FlowEdgeView {
    readonly to: string;
    readonly toName: string;
    readonly kind: "next" | "bounce";
    readonly when: string | null;
}

/**
 * 「下一手是谁 / 有哪些路可走」。
 *
 * ⚠️ `mode` / `pending` 来自内核 `status()`（**只读分类，不调用插件**）：本版所有 guard 都是
 * `prompt:`（不可观测）⇒ 节点恒为 `actor`（等人宣布）。「系统在边上卡住」（guard 求值不过、
 * 又无可用的 bounce 边）是后续任务的事 —— 那时才会出现 `system` 模式与 `stuck`。
 */
export interface FlowNextView {
    readonly mode: "entry" | "system" | "actor";
    /** 等人宣布的 guard 原文（`prompt:xxx`）；内核 `status().pending` 给的是解析后的 `GuardRef`，这里取 `raw` */
    readonly pending: string[];
    readonly edges: FlowEdgeView[];
}

/** 实例视图（`diy flow show` 的载荷） */
export interface FlowView {
    readonly uri: string;
    readonly workflowId: string;
    readonly workflowName: string;
    readonly entry: string;
    /** 是否已进入工作流（`false` = 折线为空，位置尚未确定） */
    readonly entered: boolean;
    readonly position: string | null;
    readonly node: { readonly id: string; readonly name: string; readonly actor: string; readonly hint: string } | null;
    readonly done: boolean;
    /** 折线上已有的打回次数（内核 `status()` 的只读分类） */
    readonly bounces: number;
    readonly next: FlowNextView;
    /** 折线（append-only 的领域事实；次序看数组下标，别信 `at` —— 见内核 serialize.ts 立场） */
    readonly trajectory: Visit<string>[];
    readonly params: Record<string, unknown>;
    readonly paramsSchema: ParamEntry[];
    readonly files: { readonly dir: string; readonly instance: string; readonly state: string; readonly path: string; readonly events: string };
    /** 审计流里跳过（解析失败）的行数 —— 审计可坏，坏了只报数（不阻断运行） */
    readonly auditSkipped: number;
}

// ═══════════════════════════════════════════════════════════════
// 读侧：实例装载 + 对账
// ═══════════════════════════════════════════════════════════════

function requireDef(id: string): WorkflowDef<string> {
    const def = workflowById(id);
    if (!def) {
        throw new Error(`未知工作流 ${JSON.stringify(id)}（已注册：${workflowIds().join(" / ") || "（无）"}）`);
    }
    return def;
}

function requireTask(uri: string): void {
    if (!uri) throw new Error("任务 URI 不能为空（形如 projects/<pid>/tasks/<tid>）");
    if (!taskExists(uri)) throw new Error(`任务不存在：${uri}（先 \`diy task create <标题> <projectId>\`）`);
}

export interface LoadedInstance {
    readonly binding: FlowBinding;
    readonly def: WorkflowDef<string>;
    readonly state: FlowState<string>;
}

/**
 * 装载实例 = 读绑定 → 读快照（**唯一权威真源**）→ **对账**（`path.jsonl` 重建必须同形）。
 * 对账不通过 ⇒ 亮错（`assertSnapshotMatches` 抛），绝不拿一份可能分歧的状态继续跑。
 */
export function loadInstance(uri: string): LoadedInstance {
    const binding = readBinding(uri);
    if (!binding) {
        throw new Error(`任务 ${uri} 没有工作流实例（先 \`diy flow start ${uri} --workflow <id>\`）`);
    }
    const def = requireDef(binding.workflowId);
    const state = readState(uri);
    if (!state) {
        throw new Error(
            `实例绑定在 ${flowFile(uri, "instance")}，但唯一权威真源 ${flowFile(uri, "state")} 不在 —— ` +
                `实例已损坏，请人工核对（或清掉 ${flowDir(uri)} 重开）`,
        );
    }
    assertSnapshotMatches(def, uri, state);
    return { binding, def, state };
}

/** 宿主侧的运行态（内核 `createRuntime` 的包装：本版无插件，registry 恒空） */
function runtimeOf(def: WorkflowDef<string>, params: Readonly<Record<string, unknown>> | undefined) {
    return createRuntime(def, { registry: createRegistry(), params });
}

function nodeNameOf(def: WorkflowDef<string>, id: string | null): string {
    if (id === null) return "";
    return def.nodes.find((n) => n.id === id)?.name ?? id;
}

/** 组装实例视图（`show` / `advance` / `bounce` / `start` / `params set` 全走它 —— 回执形状只有一处） */
function viewOf(uri: string, def: WorkflowDef<string>, state: FlowState<string>): FlowView {
    const runtime = runtimeOf(def, state.params);
    const status = runtime.status(state);
    const params = (state.params ?? {}) as Record<string, unknown>;
    const node = status.node;
    const edges: FlowEdgeView[] = status.outEdges.map((e) => ({
        to: e.to,
        toName: nodeNameOf(def, e.to),
        kind: e.kind,
        when: e.when ?? null,
    }));
    const audit = readAudit(uri);
    return {
        uri,
        workflowId: def.id,
        workflowName: def.name,
        entry: def.entry,
        entered: state.position !== null,
        position: state.position,
        // hint 走内核 `renderHint`（`${节点 id.局部名}` 插值的内核实现）—— 宿主不自己拼字符串
        node: node ? { id: node.id, name: node.name, actor: node.actor, hint: renderHint(node, params) } : null,
        done: status.done,
        bounces: status.bounces,
        next: { mode: status.mode, pending: status.pending.map((ref) => ref.raw), edges },
        trajectory: [...state.path],
        params: { ...params },
        paramsSchema: [...paramsOf(def).schema],
        files: {
            dir: flowDir(uri),
            instance: flowFile(uri, "instance"),
            state: flowFile(uri, "state"),
            path: flowFile(uri, "path"),
            events: flowFile(uri, "events"),
        },
        auditSkipped: audit.skipped,
    };
}

// ═══════════════════════════════════════════════════════════════
// 参数值：CLI 字符串 → 纯 JSON（类型来自内核 schema）
// ═══════════════════════════════════════════════════════════════

/**
 * 把 CLI 的 `--param 节点 id.局部名=值` 解析成内核要的嵌套值 `{ 节点: { 局部名: 值 } }`。
 *
 * 只做**字符串 → 纯 JSON** 的还原（值语义校验归内核 `createRuntime`）；
 * 必须写**全限定名**（本版 CLI 没有「当前节点」上下文，裸名无从归属）。
 * `list` 用 `,` 分隔、元素一律按字符串给（内核只要求「list 装标量」，元素类型不在声明里）。
 */
export function parseParamArgs(schema: readonly ParamEntry[], args: readonly string[]): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const arg of args) {
        const eq = arg.indexOf("=");
        if (eq <= 0) throw new Error(`参数写法应为 节点 id.局部名=值，实得 ${JSON.stringify(arg)}`);
        const key = arg.slice(0, eq).trim();
        const raw = arg.slice(eq + 1);
        const entry = schema.find((e) => e.path === key);
        if (!entry) {
            throw new Error(
                `未知参数 ${JSON.stringify(key)}（本工作流的参数：${schema.map((e) => e.path).join(" / ") || "（无）"}）`,
            );
        }
        (out[entry.node] ??= {})[entry.name] = coerceParam(entry, raw);
    }
    return out;
}

function coerceParam(entry: ParamEntry, raw: string): unknown {
    switch (entry.type) {
        case "number": {
            if (raw.trim() === "") throw new Error(`参数 ${entry.path} 应为数字，实得空串`);
            const n = Number(raw);
            if (!Number.isFinite(n)) throw new Error(`参数 ${entry.path} 应为数字，实得 ${JSON.stringify(raw)}`);
            return n;
        }
        case "boolean": {
            if (raw === "true" || raw === "1") return true;
            if (raw === "false" || raw === "0") return false;
            throw new Error(`参数 ${entry.path} 应为 true/false（或 1/0），实得 ${JSON.stringify(raw)}`);
        }
        case "list":
            return raw.trim() === "" ? [] : raw.split(",").map((s) => s.trim());
        default:
            // string / enum：原样交给内核（enum 候选校验归 `resolveParams`）
            return raw;
    }
}

// ═══════════════════════════════════════════════════════════════
// 写侧：领域操作
// ═══════════════════════════════════════════════════════════════

/** 宿主渲染的审计正文（**内核不编人类文本**：`Transition.move` 给结构化语义，文案归宿主） */
function moveText(def: WorkflowDef<string>, kind: "entry" | "next" | "bounce", from: string | null, to: string, note?: string): string {
    const toName = nodeNameOf(def, to);
    const tail = note && note.trim() !== "" ? `（${note.trim()}）` : "";
    if (kind === "entry") return `进入入口节点「${toName}」${tail}`;
    const fromName = nodeNameOf(def, from);
    return kind === "bounce" ? `打回：「${fromName}」→「${toName}」${tail}` : `前进：「${fromName}」→「${toName}」${tail}`;
}

/** 内核**领域操作**：落盘（权威先落 → 重建材料 → 审计）+ 回执视图 */
function commit(
    uri: string,
    def: WorkflowDef<string>,
    state: FlowState<string>,
    to: string,
    kind: "entry" | "next" | "bounce",
    ref: Readonly<Record<string, string>>,
    note?: string,
): FlowView {
    const at = new Date().toISOString();
    // 正路必须带 params（##333 review2 P1）：交回状态自己那份 —— 内核据此保证「读回同配置」
    const request = state.params === undefined
        ? { to, at, ref }
        : { to, at, ref, params: state.params };
    const next = advance(def, state, request).state;
    // 先落权威快照，再落重建材料与审计：中途崩掉最坏是「快照多一条、增量少一条」⇒ 对账亮错
    // （绝不静默择一）；反过来先落增量则会留下「增量多一条」，同样是亮错，但那时权威快照反倒是旧的。
    writeState(uri, next);
    appendPathRecord(uri, { op: "advance", to, at, ...(Object.keys(ref).length > 0 ? { ref } : {}) });
    appendAudit(uri, {
        id: randomUUID(),
        at,
        kind,
        from: state.position,
        to,
        // 谁能代表哪个 actor 是宿主知识（内核 `rule.author` 不管本版路径）—— 本版只有一个操作入口：CLI
        author: "cli",
        content: moveText(def, kind, state.position, to, note),
        ref,
    });
    return viewOf(uri, def, next);
}

/** 结构闸门：这条边存在吗、是 `next` 还是 `bounce`、首次是不是入口（跳步一律拒） */
function requireEdge(def: WorkflowDef<string>, from: string | null, to: string, want: "next" | "bounce"): void {
    if (from === null) {
        if (to !== def.entry) {
            throw new Error(
                `首次推进只能进入入口节点「${def.entry}」（${nodeNameOf(def, def.entry)}），实得「${to}」（内核 invalid-entry：不许从半路开始）`,
            );
        }
        if (want === "bounce") throw new Error(`尚未进入工作流，无从打回（首次推进只能是 \`advance\` 到入口节点）`);
        return;
    }
    const edge = def.edges.find((e) => e.from === from && e.to === to);
    if (!edge) {
        const outs = def.edges.filter((e) => e.from === from).map((e) => `${e.to}(${e.kind})`);
        throw new Error(
            `不存在从「${from}」到「${to}」的边（内核 no-edge：不许跳步）。当前节点的出边：${outs.join(" / ") || "（无）"}`,
        );
    }
    if (edge.kind !== want) {
        throw new Error(
            `「${from}」→「${to}」是 ${edge.kind} 边，` +
                (want === "next" ? "请用 `diy flow bounce`（打回）" : "请用 `diy flow advance`（推进）"),
        );
    }
}

/** 解析 `--ref k=v`（内核 `Visit.ref` 是字符串 → 字符串的开放袋） */
function parseRefArgs(args: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const arg of args) {
        const eq = arg.indexOf("=");
        if (eq <= 0) throw new Error(`--ref 写法应为 k=v，实得 ${JSON.stringify(arg)}`);
        out[arg.slice(0, eq).trim()] = arg.slice(eq + 1);
    }
    return out;
}

/**
 * 建实例：绑定工作流 + 参数值过内核闸门 + 落**尚未进入**的初始态。
 *
 * 为什么不自动进入入口节点：「先定配置、再开跑」需要一个**尚未进入**的窗口 ——
 * `params set` 只在那个窗口合法（换配置 = 另起一次运行，内核同一立场；见遗留观察 O-1）。
 * 进入入口 = 第一次 `diy flow advance <uri> --to <entry>`。
 */
export function startFlow(uri: string, workflowId: string, paramArgs: readonly string[] = []): FlowView {
    requireTask(uri);
    const def = requireDef(workflowId);
    const existing = readBinding(uri);
    if (existing) {
        const prior = readState(uri);
        if (prior && prior.position !== null) {
            throw new Error(
                `任务 ${uri} 已有实例且**已进入**工作流（position = ${prior.position}）：` +
                    `换工作流 / 换参数值 = 另起一次运行，本版不提供重建命令 —— 要重来请清掉 ${flowDir(uri)}（先确认不再需要这份轨迹）`,
            );
        }
    }
    const declared = parseParamArgs(paramsOf(def).schema, paramArgs);
    // 参数值语义校验 + 合并缺省：唯一闸门是内核 `createRuntime`（本文件不重写校验）
    const params = runtimeOf(def, declared).params;
    const state = parseFlowState<string>({ position: null, path: [], params });
    writeState(uri, state);
    // 参数值是领域态的一部分，必须有重建来源（见 flow-store 的 FlowPathRecord 头注）
    appendPathRecord(uri, { op: "config", params });
    writeBinding(uri, { workflowId: def.id, params, ref: { taskUri: uri } });
    appendAudit(uri, {
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: "start",
        from: null,
        to: null,
        author: "cli",
        content: `建实例：工作流「${def.name}」（${def.id}），入口「${def.entry}」`,
        ref: { taskUri: uri },
    });
    return viewOf(uri, def, state);
}

/** 推进：走 `next` 边（首次 = 进入入口节点） */
export function advanceFlow(uri: string, to: string, refArgs: readonly string[] = [], note?: string): FlowView {
    const { def, state } = loadInstance(uri);
    requireEdge(def, state.position, to, "next");
    const ref = { taskUri: uri, ...parseRefArgs(refArgs) };
    const kind: "entry" | "next" = state.position === null ? "entry" : "next";
    return commit(uri, def, state, to, kind, ref, note);
}

/** 打回：走 `bounce` 边（目标节点再驻留一次，`Visit.seq` 递增 —— 不新建节点） */
export function bounceFlow(uri: string, to: string, refArgs: readonly string[] = [], note?: string): FlowView {
    const { def, state } = loadInstance(uri);
    requireEdge(def, state.position, to, "bounce");
    const ref = { taskUri: uri, ...parseRefArgs(refArgs) };
    return commit(uri, def, state, to, "bounce", ref, note);
}

/** 看参数值（`state.json` 是权威；schema 来自定义，供表单/文档渲染） */
export function paramsGet(uri: string): {
    uri: string;
    workflowId: string;
    workflowName: string;
    authority: string;
    entered: boolean;
    values: Record<string, unknown>;
    schema: ParamEntry[];
    defaults: Record<string, unknown>;
} {
    const { def, state } = loadInstance(uri);
    const spec = paramsOf(def);
    return {
        uri,
        workflowId: def.id,
        workflowName: def.name,
        authority: flowFile(uri, "state"),
        entered: state.position !== null,
        values: { ...(state.params ?? {}) },
        schema: [...spec.schema],
        defaults: { ...(spec.defaults as Record<string, unknown>) },
    };
}

/**
 * 改参数值：**只允许尚未进入时**（`position === null`）。
 *
 * 已进入还改 = 折线上早先的驻留拿旧配置跑、状态里却记着新配置 —— 内核把这种「混配状态」判为
 * 「另起一次运行」并拒（`rule.params-in-state` ③），宿主侧因此必须在更早的地方拦住它。
 */
export function paramsSet(uri: string, paramArgs: readonly string[]): FlowView {
    const { def, state } = loadInstance(uri);
    if (state.position !== null) {
        throw new Error(
            `实例已进入工作流（position = ${state.position}），参数值不可改：换参数值 = 另起一次运行` +
                `（内核同一立场，见 rule.params-in-state）—— 要换配置请清掉 ${flowDir(uri)} 重建实例`,
        );
    }
    const declared = parseParamArgs(paramsOf(def).schema, paramArgs);
    const params = runtimeOf(def, declared).params;
    const next = parseFlowState<string>({ position: null, path: [], params });
    writeState(uri, next);
    appendPathRecord(uri, { op: "config", params });
    const binding = readBinding(uri);
    if (binding) writeBinding(uri, { ...binding, params });
    appendAudit(uri, {
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: "params",
        from: null,
        to: null,
        author: "cli",
        content: `改参数值（尚未进入）：${Object.entries(params)
            .map(([node, bag]) => Object.entries(bag as Record<string, unknown>).map(([k, v]) => `${node}.${k}=${JSON.stringify(v)}`).join(", "))
            .join("; ")}`,
        ref: { taskUri: uri },
    });
    return viewOf(uri, def, next);
}

/** 看实例（当前节点 + 折线 + 卡在哪条边 + 参数值）；含对账（不一致即抛） */
export function showFlow(uri: string): FlowView {
    const { def, state } = loadInstance(uri);
    return viewOf(uri, def, state);
}

/** 可用工作流定义清单（`diy flow list` 缺省输出） */
export function listFlowDefinitions(): WorkflowSummary[] {
    return listWorkflows();
}

/** 扫盘找实例（`diy flow list --instances`）——只认 `projects/<pid>/tasks/<tid>/flow/instance.json` */
export function listFlowInstances(): Array<{ uri: string; workflowId: string; position: string | null; error?: string }> {
    const out: Array<{ uri: string; workflowId: string; position: string | null; error?: string }> = [];
    const root = projectsRoot();
    if (!existsSync(root)) return out;
    for (const proj of readdirSync(root, { withFileTypes: true })) {
        if (!proj.isDirectory() || !/^\d+$/.test(proj.name)) continue;
        const tasksDir = join(root, proj.name, "tasks");
        if (!existsSync(tasksDir)) continue;
        for (const task of readdirSync(tasksDir, { withFileTypes: true })) {
            if (!task.isDirectory() || !/^\d+$/.test(task.name)) continue;
            const uri = `projects/${proj.name}/tasks/${task.name}`;
            if (!existsSync(flowFile(uri, "instance"))) continue;
            try {
                const binding = readBinding(uri);
                const state = readState(uri);
                const def = binding ? workflowById(binding.workflowId) : null;
                if (binding && state && def) assertSnapshotMatches(def, uri, state);
                if (!binding || !state || !def) {
                    out.push({ uri, workflowId: binding?.workflowId ?? "?", position: state?.position ?? null, error: "实例不完整（绑定 / 快照 / 定义三者缺一）" });
                } else {
                    out.push({ uri, workflowId: binding.workflowId, position: state.position });
                }
            } catch (e) {
                out.push({ uri, workflowId: "?", position: null, error: e instanceof Error ? e.message : String(e) });
            }
        }
    }
    return out;
}
