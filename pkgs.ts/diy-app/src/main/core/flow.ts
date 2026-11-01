// src/main/core/flow.ts — 工作流实例的**领域操作**（`diy flow` 域的业务层）
//
// 这一层的存在理由（##319 交付物）：内核（`@diy-agent/flow`）**不碰 fs**、**不取时间**、**不编人类文本** ——
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
//   4. **`done` 由宿主「宣布收尾」置位**（`finishFlow`，##319 review1 P2-B）：内核把 `done` 只交给
//      `runtime.step` 的终态分支（guard 全过 + 无 next 出边），而本版 guard 全是 `prompt:` ⇒ 那条分支走不到。
//      宿主于是把同一件事拆成两半：**结构那一半系统核**（必须真无 `next` 出边）、**guard 那一半宣布者担责**
//      （`prompt:` 不可观测，与 `declare` 同一立场）。仍是原地加标记，**不改内核**。
//
// 命令语义（比内核更严一档，避免「两条命令都能走同一条边」的模糊）：
//   `advance` 只走 `next` 边；`bounce` 只走 `bounce` 边。首次推进必须落到入口节点（内核 `invalid-entry`）。

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { TASK_URI_RE } from "../../shared/task-uri";
import {
    advance,
    callPlugin,
    createRuntime,
    paramsOf,
    parseFlowState,
    parseView,
    renderHint,
    type Art,
    type FlowState,
    type NodeDef,
    type ParamEntry,
    type PluginContext,
    type PluginRegistry,
    type View,
    type Visit,
    type WorkflowDef,
} from "@diy-agent/flow";
import { listWorkflows, workflowById, workflowIds, type WorkflowSummary } from "../workflows";
import { collectFacts, createHostRegistry, type CommandFact, type HostPluginDeps } from "../workflows/plugins";
import { diyHome, projectsRoot, taskDir, taskExists } from "./state";
import {
    appendAudit,
    appendPathRecord,
    appendPost,
    applyFinish,
    artifactFile,
    assertSnapshotMatches,
    flowDir,
    flowFile,
    readArtifacts,
    readAudit,
    readBinding,
    readPosts,
    readState,
    requirePostText,
    writeArtifact,
    writeBinding,
    writeState,
    type FlowBinding,
    type FlowPost,
    type FlowPostType,
} from "./flow-store";
import { localISOString } from "@diy-agent/time";

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
 * `prompt:`（不可观测）⇒ 节点恒为 `actor`（等人宣布），`system` 本版**不会出现**（要它得有
 * `pred:` / `action:` 插件，见 `workflows/dev.ts` 头注）。「系统在边上卡住」（guard 求值不过、
 * 又无可用的 bounce 边）是后续任务的事 —— 那时才会出现 `system` 模式与 `stuck`。
 */
export interface FlowNextView {
    readonly mode: "entry" | "system" | "actor";
    /** 等人宣布的 guard 原文（`prompt:xxx`）；内核 `status().pending` 给的是解析后的 `GuardRef`，这里取 `raw` */
    readonly pending: string[];
    readonly edges: FlowEdgeView[];
    /**
     * **结构事实**：已进入、且当前位置**没有 `next` 出边** ⇒ 往前无路可走（`bounce` 边不算「下一步」）。
     *
     * 内核对「跑完」的判据就是这条结构事实（`execute.ts`：guard 全过 + 无 `next` 出边 ⇒ `done`）。
     * 本版 guard 全是 `prompt:`（不可观测）⇒ 内核那条判定走不到、`done` 不会自己亮，于是视图至少要把
     * 「结构上走到头了」说清楚（UI 靠它说「这条工作流到此收尾」，而不是照 `done` 撒谎）。
     * `false` = 要么还没进入，要么还能 `advance`。
     */
    readonly terminal: boolean;
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
    /**
     * 工作流是否已跑完（领域事实 `FlowState.done`）。
     *
     * 来源只有两个：内核 `runtime.step` 的终态分支（本版走不到 —— guard 全是 `prompt:`），
     * 与宿主 `diy flow finish`（**宣布收尾**，要求当前节点结构上确无 `next` 出边）。故 `done === true`
     * 与 `next.terminal === true` 在当前实现里同时成立；`terminal` 是**结构**、`done` 是**已宣布**。
     */
    readonly done: boolean;
    /** 折线上已有的打回次数（内核 `status()` 的只读分类） */
    readonly bounces: number;
    readonly next: FlowNextView;
    /**
     * **当前节点**声明的产物展示链（内核 `NodeDef.art`，##337）。
     *
     * 未进入（没有当前节点）/ 该节点没声明 ⇒ `null`。它是**声明**（「这一步的产物长什么样、给哪个
     * 渲染器」），不是产物本身；产物在袋里，译好后见下面的 `view`。
     */
    readonly art: Art | null;
    /**
     * 当前节点**当前驻留**（折线最后一条）的产物经 render 插件翻译后的结果（`View`：renderer + payload）。
     *
     * `null` = 该驻留没放产物（**正常态**：产物不是领域态，推进不产生它）。payload 是 `unknown`
     * —— 宿主**原样透传**，形状校验归 renderer 的消费者（UI 按 `renderer` 收窄）。
     * 产物路**坏**（袋不是合法 JSON / 不是数组 / 声明与翻译不一致）⇒ 仍是 `null`，并把话写进 `viewError`
     * （**不阻断本命令**：产物是派生数据，`show` 是泳道页唯一的数据源，见 `viewError`）。
     */
    readonly view: View | null;
    /**
     * **产物路的错误位**（##337 review1 P2-B）：`null` = 产物路没出错。
     *
     * 非空 = 袋坏了 / 声明与翻译不一致 —— 此时 `view` 仍是 `null`，但**位置 / 折线 / 参数照常可用**
     * （产物不是领域态，不许拖垮领域读）。消息里带**袋的路径与出路**（删掉它不影响推进）。
     * 「无」与「坏」照样分得清：`view === null && viewError === null` = 没放产物；
     * `viewError !== null` = 坏了。要**亮错**的场合（人在查产物）用 `diy flow view`（产物专读，仍抛）。
     */
    readonly viewError: string | null;
    /** 折线（append-only 的领域事实；次序看数组下标，别信 `at` —— 见内核 serialize.ts 立场） */
    readonly trajectory: Visit<string>[];
    readonly params: Record<string, unknown>;
    readonly paramsSchema: ParamEntry[];
    readonly files: {
        readonly dir: string;
        readonly instance: string;
        readonly state: string;
        readonly path: string;
        readonly events: string;
        /** 讨论流（##342）—— 旁注，可清可丢（删了不影响推进，只是线程里的发言没了） */
        readonly threads: string;
    };
    /** 审计流里跳过（解析失败）的行数 —— 审计可坏，坏了只报数（不阻断运行） */
    readonly auditSkipped: number;
    /**
     * **讨论流的错误位**（##342；`null` = 旁注没出错）。
     *
     * 与 `viewError` 同一立场（##337 review1 P2-B）：讨论流是**旁注 / 审计**（`rule.core-log`），
     * 读坏了**不许**拖垮领域读（泳道页唯一的数据源就是 `flow show`）—— 位置 / 折线 / 参数照常下发，
     * 只在这里说一句「讨论流有 N 行读不出，删掉 `flow/threads.jsonl` 即可」。
     * 要**看**讨论流本身的错，用 `diy flow thread list`（它另报 `skipped` 计数，同样不炸）。
     */
    readonly threadError: string | null;
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

/**
 * URI 形状闸门（##319 review1 P3-A）—— **单点**：`loadInstance`（读/推进/打回/参数）与 `requireTask`
 * （`start`）都先过它，别处不许再各自判。
 *
 * 两道判据，缺一不可：
 *   · **形状** —— `projects/<pid>/tasks/<tid>`，用 `shared/task-uri.ts` 的**唯一**正则（别处不重写；
 *     历史教训见该文件头注：两份正则口径不同 ⇒ 静默写到别的项目目录去）；
 *   · **落点仍在数据根之内** —— 光靠正则不够：`projects/../evil/tasks/1` 逐段都「非斜杠」⇒ 正则放行，
 *     而 `taskDir` 一 `join` 就逸出数据根（`flow/` 四份文件会被写/读在 `$DIY_HOME` 之外；
 *     review 的探针正是这么读到数据根外的）。故按**解析后的相对路径**再判一次：以 `..` 开头或绝对路径即拒。
 *
 * 本地 CLI 没有权限边界，所以这是 P3 不是 P2 —— 但「报错说 URI 不对、实际写到别处去」这种不一致，
 * 不值得留给下一个读 `did flow show ../../x` 的人去发现。
 */
function requireUriShape(uri: string): void {
    if (!uri) throw new Error("任务 URI 不能为空（形如 projects/<pid>/tasks/<tid>）");
    if (!TASK_URI_RE.test(uri)) {
        throw new Error(`任务 URI 形状应为 projects/<pid>/tasks/<tid>，实得 ${JSON.stringify(uri)}`);
    }
    const rel = relative(diyHome(), taskDir(uri));
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`任务 URI 解析后逸出数据根：${JSON.stringify(uri)} → ${taskDir(uri)}（数据根 ${diyHome()}）`);
    }
}

function requireTask(uri: string): void {
    requireUriShape(uri);
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
    requireUriShape(uri);
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

/**
 * 宿主**完整**插件表（`render` 形状翻译 ⊕ `guard`/`action` 外部世界，##337 / ##341）。
 *
 * 为什么必须是完整的那份（而不是只有 render）：dev 定义里已经有 `pred:ci_green` / `action:pr_mergeable`，
 * 而内核在**组合期**就按名查注册表（`createRuntime` 的 `requirePlugin`）——少注册一个名字，
 * 连只读的 `flow show`（它也要建 runtime 取 `status`）都会当场 `unknown-plugin`。
 *
 * 这里的事实表是**空的**：只读路径（`show` / `view`）**从不调用插件**（`status` 是静态分类，
 * 见内核 `rule.no-side-effect`），故不需要预热。真求值的路径（`stepFlow`）自己带事实表建注册表。
 */
const REGISTRY = createHostRegistry();

/** 宿主侧的运行态（内核 `createRuntime` 的包装：注册表由宿主给，内核只按名解析） */
function runtimeOf(def: WorkflowDef<string>, params: Readonly<Record<string, unknown>> | undefined, registry: PluginRegistry = REGISTRY) {
    return createRuntime(def, { registry, params });
}

/** 交插件求值用的上下文（与内核 `createRuntime::contextOf` 同形 —— 它没导出，这里手搓同形字面量） */
function pluginContext(def: WorkflowDef<string>, node: NodeDef<string>, params: Readonly<Record<string, unknown>> | undefined, actor: string): PluginContext {
    return { workflow: def, node, params: params ?? {}, actor };
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
    // 产物（##337）：当前节点 + **当前驻留**（折线最后一条 = 现在这一步）那一份 raw 的翻译结果。
    // 未进入（没有当前节点 / 没有驻留）就没什么可译 —— 声明与结果都给 null（不猜）。
    // 走**容错版**：产物路坏了只说在 `viewError` 里（##337 review1 P2-B —— 派生数据不许拖垮领域读）。
    const current = currentVisit(state);
    const artifact = node && current ? tryArtifactAt(uri, def, node.id, current.seq) : EMPTY_ARTIFACT;
    // 终态判据 = **没有 `next` 出边**（与内核 execute.ts 的 `done` 判据同一条结构事实）；
    // 未进入时不算终态（`outEdges` 为空只是因为没位置，不代表走完）。
    const hasNext = status.outEdges.some((e) => e.kind === "next");
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
        next: { mode: status.mode, pending: status.pending.map((ref) => ref.raw), edges, terminal: state.position !== null && !hasNext },
        art: artifact.art,
        view: artifact.view,
        viewError: artifact.error,
        trajectory: [...state.path],
        params: { ...params },
        paramsSchema: [...paramsOf(def).schema],
        files: {
            dir: flowDir(uri),
            instance: flowFile(uri, "instance"),
            state: flowFile(uri, "state"),
            path: flowFile(uri, "path"),
            events: flowFile(uri, "events"),
            threads: flowFile(uri, "threads"),
        },
        auditSkipped: audit.skipped,
        threadError: threadErrorOf(uri),
    };
}

// ═══════════════════════════════════════════════════════════════
// 产物链（##337）：袋里的 raw → render 插件 → `View{ renderer, payload }`
// ═══════════════════════════════════════════════════════════════
//
// 三层归属（##311 §二「三层归属」）：
//   · **声明**（`NodeDef.art`，宿主定义里写）= 「这一步的产物长什么样、翻给哪个渲染器」；
//   · **数据**（产物袋 `flow/artifacts/<节点 id>.json`）= raw 本身。**不是领域态**（`rule.domain-first`）：
//     不进 `state.json`、不参与 `path.jsonl` 对账、删了不影响推进；
//   · **代码**（`render` 插件，`workflows/plugins.ts`）= 形状翻译。页面归 ##320。
//
// 内核**从不调用** `render` 槽（槽位与 `parseView` 是内核给的，调用是宿主的决定）——
// 全工程的调用点只有下面 `translateArtifact` 一处。

/**
 * 「当前节点 / 当前驻留的产物」四件套；没有可译的产物时前三件是 null / 空、`error` 也是 null。
 *
 * `error` 是**产物路的错误位**（##337 review1 P2-B）：产物不是领域态，它坏了**不许**把领域读
 * （`flow show` —— 泳道页唯一的数据源）一起拖瘫。故 `viewOf` 走容错版（`tryArtifactAt`）：
 * 出任何事只把话说在 `error` 里（`view: null`），位置 / 折线 / 参数照常下发；
 * 而**产物专读**命令（`diy flow view`）仍走严格版（`artifactAt`）**亮错** —— 「无」与「坏」照样分得清。
 */
interface ArtifactAt {
    readonly art: Art | null;
    readonly plugin: string | null;
    readonly view: View | null;
    /** 产物路的错（坏袋 / 声明与翻译不一致 / 插件抛）——`null` = 没错；见上面立场 */
    readonly error: string | null;
}

const EMPTY_ARTIFACT: ArtifactAt = { art: null, plugin: null, view: null, error: null };

/**
 * 讨论流的**错误位**（##342）：读得出 ⇒ `null`；读不出 / 有坏行 ⇒ 一句人话（**不外抛**）。
 *
 * 旁注坏了不该让领域读失败（与 `tryArtifactAt` 同一立场）；文件不在是**正常态**（还没人发过言）。
 */
function threadErrorOf(uri: string): string | null {
    try {
        const { skipped } = readPosts(uri);
        if (skipped === 0) return null;
        return `讨论流有 ${skipped} 行读不出（旁注坏了不影响推进 —— 删掉 ${flowFile(uri, "threads")} 即可）：` +
            "打回意见是旁注，驱动判据不读它";
    } catch (e) {
        return `讨论流读不出：${(e as Error).message}（旁注坏了不影响推进 —— 删掉 ${flowFile(uri, "threads")} 即可）`;
    }
}

/** 折线上最后一条驻留 = **现在这一步**；未进入（折线为空）⇒ null */
function currentVisit(state: FlowState<string>): Visit<string> | null {
    return state.path.length > 0 ? state.path[state.path.length - 1]! : null;
}

/** 节点声明的展示链（内核 `NodeDef.art`）；节点不存在或没声明 ⇒ null */
function artOf(def: WorkflowDef<string>, nodeId: string): Art | null {
    return def.nodes.find((n) => n.id === nodeId)?.art ?? null;
}

/**
 * 交给 render 插件的**锚点**：这条泳道的节点 id。
 *
 * 与内核执行器给事件用的 `nodeAnchor(to)` 同形（`@diy-agent/talk` 的 `Anchor` 的 `node` 分支）。
 * 这里只手搓同形字面量、**不 import `@diy-agent/talk`**：宿主不因一个只读锚点多一条包依赖；
 * 形状对不对由调用点的类型核对（`RenderPlugin` 的第二个参数）。
 */
function anchorOf(nodeId: string): { readonly type: "node"; readonly data: { readonly nodeId: string } } {
    return { type: "node", data: { nodeId } };
}

/**
 * 把袋里那份 raw 翻成 view（##337 的**唯一**调用点；导出只为单测能直接构造失配的 `art` ——
 * 宿主调用点只有本文件）。三条立场：
 *
 *   1. `raw` 缺（越界）或为 `null` ⇒ **无产物** ⇒ `null`。不是错：产物不是领域态，缺项是正常态。
 *   2. `art.plugin` 留空 ⇒ **直吃 raw**：`{ renderer: art.renderer, payload: raw }` —— 但这句话的**唯一**
 *      合法含义是「**raw 本身已经是该 renderer 的 data**」（##337 review1 P2-A）。宿主不替它包一层：
 *      纯文本 raw ≠ `doc` 的 data（`{ text }`），要包就**写成插件**（如 `text`），别指望消费侧兜。
 *   3. 挂了插件 ⇒ 内核 `resolve`（未注册即 `unknown-plugin`）+ `callPlugin`（宿主异常→`plugin-threw`）
 *      + `parseView`（形状不对即 `invalid-plugin-result`）；且结果**必须与声明的 renderer 一致**
 *      —— 声明是给 UI 预选渲染器的契约，不一致就是定义在撒谎，宁可当场炸。
 */
export function translateArtifact(uri: string, nodeId: string, art: Art, raw: unknown): View | null {
    if (raw === undefined || raw === null) return null;
    const pluginName = art.plugin ?? null;
    if (pluginName === null) return { renderer: art.renderer, payload: raw };
    const plugin = REGISTRY.resolve("render", pluginName);
    const view = callPlugin(`render 插件 ${pluginName}`, artifactFile(uri, nodeId), () =>
        parseView(plugin(raw, anchorOf(nodeId))),
    );
    if (view.renderer !== art.renderer) {
        throw new Error(
            `节点「${nodeId}」声明的 renderer 是 ${art.renderer}，render 插件 ${pluginName} 却返回了 ${view.renderer}` +
                `：声明与翻译不一致（UI 按声明选渲染器 ⇒ 会画错）—— 改 art.renderer 或换插件`,
        );
    }
    return view;
}

/**
 * 「节点 + 第 seq 次驻留」→ 四件套（`flow view` 走这条**严格版**：产物专读，有问题必须亮出来）。
 * 与 `tryArtifactAt` 是**同一条链**，只差「产物路的异常谁来接」——不另立一套翻译。
 */
function artifactAt(uri: string, def: WorkflowDef<string>, nodeId: string, seq: number): ArtifactAt {
    const art = artOf(def, nodeId);
    if (!art) return EMPTY_ARTIFACT;
    const raw = readArtifacts(uri, nodeId)[seq - 1];
    return { art, plugin: art.plugin ?? null, view: translateArtifact(uri, nodeId, art, raw), error: null };
}

/**
 * `artifactAt` 的**容错版**（`flow show` 走它，##337 review1 P2-B）：产物路出任何事都**不外抛**，
 * 降级成 `error` 位（`view: null`）。
 *
 * 理由：产物**不是领域态**（`rule.domain-first`）—— 一份派生数据不该让领域读命令失败。
 * 对照先例：审计流坏只报 `auditSkipped`（##319），`flow show` 照常出整张泳道页。
 */
function tryArtifactAt(uri: string, def: WorkflowDef<string>, nodeId: string, seq: number): ArtifactAt {
    try {
        return artifactAt(uri, def, nodeId, seq);
    } catch (e) {
        const art = artOf(def, nodeId);
        return { art, plugin: art?.plugin ?? null, view: null, error: (e as Error).message };
    }
}

/** 折线上某节点驻留过几次（= 它的最大 `seq`）；没驻留过 ⇒ 0 */
function residenciesOf(state: FlowState<string>, nodeId: string): number {
    return state.path.reduce((max, visit) => (visit.node === nodeId ? Math.max(max, visit.seq) : max), 0);
}

/** 定目标节点：给了 `--node` 就按定义校验；没给 ⇒ 当前节点（尚未进入则无从取，报错给下一步） */
function resolveNode(uri: string, def: WorkflowDef<string>, state: FlowState<string>, nodeId?: string): string {
    if (nodeId !== undefined && nodeId !== "") {
        if (!def.nodes.some((n) => n.id === nodeId)) {
            throw new Error(`未知节点 ${JSON.stringify(nodeId)}（本工作流「${def.id}」的节点：${def.nodes.map((n) => n.id).join(" / ")}）`);
        }
        return nodeId;
    }
    if (state.position === null) {
        throw new Error(
            `实例尚未进入工作流（${uri}）：没有「当前节点」可当缺省 —— 先 \`diy flow advance\`，或显式给 \`--node <节点 id>\``,
        );
    }
    return state.position;
}

/**
 * 定目标驻留（1-based）。缺省 = 该节点**最后一次**驻留（手工放产物时人在的就是那一次）；
 * 显式 `--seq` 越界 ⇒ 拒（**产物属于已经发生过的驻留**：给还没到的驻留占位是假数据）。
 */
function resolveSeq(uri: string, state: FlowState<string>, nodeId: string, seq?: number): number {
    const max = residenciesOf(state, nodeId);
    if (max === 0) {
        throw new Error(`节点「${nodeId}」在 ${uri} 上还没驻留过：产物属于某一次驻留 —— 先 advance / bounce 到它`);
    }
    if (seq === undefined) return max;
    if (!Number.isInteger(seq) || seq < 1 || seq > max) {
        throw new Error(`节点「${nodeId}」只驻留过 ${max} 次：第 ${seq} 次驻留不存在（可取 1..${max}）`);
    }
    return seq;
}

/**
 * 一份产物视图（`diy flow view <uri> [--node <id>] [--seq <n>]` 的载荷，##337）。
 *
 * 为什么要有这条只读命令（而不只让 `show` 带上当前节点的）：**UI 要点折线上任意一步看图**
 * （`##320` 的「产物 view」区）—— 那一步既不是当前节点、也可能不是最后一次驻留。
 */
export interface FlowArtifactView {
    readonly uri: string;
    readonly node: string;
    readonly nodeName: string;
    /** 目标驻留序号（1-based = 折线上该节点第几次驻留，与 `Visit.seq` 同一口径） */
    readonly seq: number;
    /** 该节点声明的展示链（没声明 ⇒ null） */
    readonly art: Art | null;
    /** 实际用到的 render 插件名（`null` = 直吃 raw / 没声明 art） */
    readonly plugin: string | null;
    /** 翻译结果；该驻留没有产物 ⇒ null */
    readonly view: View | null;
    /** 产物袋文件（诊断 / UI 指路用；**不存在也是正常态**） */
    readonly bag: string;
}

/** 取任意节点、任意驻留的产物视图（只读；含实例对账） */
export function viewArtifact(uri: string, nodeId?: string, seq?: number): FlowArtifactView {
    const { def, state } = loadInstance(uri);
    const target = resolveNode(uri, def, state, nodeId);
    const at = resolveSeq(uri, state, target, seq);
    const { art, plugin, view } = artifactAt(uri, def, target, at);
    return { uri, node: target, nodeName: nodeNameOf(def, target), seq: at, art, plugin, view, bag: artifactFile(uri, target) };
}

/**
 * `--file` 的内容 → 袋里的 raw：**能当 JSON 解析就是那个值，否则原样当字符串**。
 *
 * 为什么是这个约定（而不加 `--json` 开关）：写侧要**最小** —— 一段 diff / 一段 CI 日志本来就是文本，
 * 清单 / 表格类产物本来就是 JSON，两种都直接扔进来最省事。判定只看**整体**能不能 parse：
 * 半截 JSON（`{a:1}` 这种非标写法）落到「当字符串」那一支，再由插件当场拒掉 ——
 * 不会静默塞进一个半新半旧的值里。
 */
function parseArtifactContent(content: string): unknown {
    if (content.trim() === "") {
        throw new Error("产物内容为空（`--file` 读到 0 字节）：不写空产物 —— 要么给内容，要么别放");
    }
    try {
        return JSON.parse(content);
    } catch {
        return content;
    }
}

/**
 * 放一份产物 raw 进袋（`diy flow artifact put`，##337 的**写侧最小入口**：给人和后续 agent 用，
 * 不做批量、不做校验研究 —— raw 对不对由 render 插件在**读**的时候认）。
 *
 * `seq` 缺省 = 该节点最后一次驻留；给 `--seq` 可回填更早的驻留（越界的 seq 一律拒，见 `resolveSeq`）。
 *
 * **写之前先试译一次**（该节点声明了 art 就译）：译不出来就**一个字节都不写** ——
 * 免得留下「命令报错、袋里却多了个谁也译不出的 raw」的半成品（下一次 `flow view` 才炸）。
 */
export function putArtifact(uri: string, nodeId: string, content: string, seq?: number): FlowArtifactView {
    const { def, state } = loadInstance(uri);
    const target = resolveNode(uri, def, state, nodeId);
    const at = resolveSeq(uri, state, target, seq);
    const raw = parseArtifactContent(content);
    const art = artOf(def, target);
    if (art) translateArtifact(uri, target, art, raw); // 试译（译不出就抛，袋不动）
    writeArtifact(uri, target, at - 1, raw);
    return viewArtifact(uri, target, at);
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

/**
 * 内核**领域操作**：落盘（权威先落 → 重建材料 → 审计）+ 回执视图。
 *
 * `author` 是「谁能代表哪个 actor」这条**宿主知识**（内核 `rule.author` 不管本版路径）的落点：
 * 人 / CLI 宣布记 `cli`（缺省，与 ##319 一致），**节点执行器起的 agent 轮次记该 agent 的标识**
 * （##341）—— 审计流因此答得出「这一跳是谁推的」。
 */
function commit(
    uri: string,
    def: WorkflowDef<string>,
    state: FlowState<string>,
    to: string,
    kind: "entry" | "next" | "bounce",
    ref: Readonly<Record<string, string>>,
    note?: string,
    author = "cli",
): FlowView {
    const at = localISOString();
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
        author,
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
                `任务 ${uri} 已有实例且已进入工作流（position = ${prior.position}）：` +
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
        at: localISOString(),
        kind: "start",
        from: null,
        to: null,
        author: "cli",
        content: `建实例：工作流「${def.name}」（${def.id}），入口「${def.entry}」`,
        ref: { taskUri: uri },
    });
    return viewOf(uri, def, state);
}

/** 推进：走 `next` 边（首次 = 进入入口节点）。`author` 缺省 `cli`（节点执行器会传 agent 标识） */
export function advanceFlow(uri: string, to: string, refArgs: readonly string[] = [], note?: string, author = "cli"): FlowView {
    const { def, state } = loadInstance(uri);
    requireEdge(def, state.position, to, "next");
    const ref = { taskUri: uri, ...parseRefArgs(refArgs) };
    const kind: "entry" | "next" = state.position === null ? "entry" : "next";
    return commit(uri, def, state, to, kind, ref, note, author);
}

/** 打回：走 `bounce` 边（目标节点再驻留一次，`Visit.seq` 递增 —— 不新建节点） */
export function bounceFlow(uri: string, to: string, refArgs: readonly string[] = [], note?: string, author = "cli"): FlowView {
    const { def, state } = loadInstance(uri);
    requireEdge(def, state.position, to, "bounce");
    const ref = { taskUri: uri, ...parseRefArgs(refArgs) };
    return commit(uri, def, state, to, "bounce", ref, note, author);
}

/**
 * 给**刚发生的那次打回**挂一条发言（##342 的写侧；`diy flow bounce --opinion` 与驱动环的自动打回共用它）。
 *
 * 锚点从**回执折线**里取（`{from: 打回前位置, to: 落点节点, seq: 落点那次 Visit.seq}`）——
 * 不另算一遍、也不接受调用方传进来的「想挂哪就挂哪」：一次 bounce 恰创生一次驻留，
 * 该三元组唯一标识这条打回边的一次穿越（同节点二次打回自然各是各的，##320 P1-1 的教训）。
 *
 * `at` 用**那次驻留自己的时间戳**（不是「现在」）：这条发言属于那次打回，不是另起一条时间线。
 * 落盘失败**外抛**（调用方决定怎么办）：CLI 显名要求带意见时该响亮报错；
 * 驱动环无人值守，自己 catch 后只警告（旁注坏了不打断推进，`rule.core-log`）。
 *
 * **空正文一律拒**（##342 review1 P2-1）：闸门是 `flow-store.ts::requirePostText`（与 CLI 面板的
 * `postThread` **同一处真源**）。这里必须装 —— 驱动环的结论行合法地可以只写「结论：打回」（无原因），
 * 放行就等于往留痕里落一条**没有任何内容的争议发言**。驱动环侧已有 catch ⇒ 自动降级为「不写 + warn」，
 * 审计那半照旧记 `打回`（审计与讨论口径不同是对的）。
 */
export function appendBounceOpinion(
    uri: string,
    view: FlowView,
    text: string,
    author: string,
    type: FlowPostType = "note",
): FlowPost {
    requirePostText(text);
    const landing = view.trajectory[view.trajectory.length - 1];
    const source = view.trajectory[view.trajectory.length - 2];
    if (!landing || !source || landing.kind !== "bounce") {
        throw new Error(
            `只接**打回**的回执（折线最后一条应是 kind:'bounce'）：${uri} 实得 ${landing ? `${landing.node}#${landing.seq}/${landing.kind}` : "（空折线）"}`,
        );
    }
    const post: FlowPost = {
        id: randomUUID(),
        at: landing.at,
        author,
        type,
        anchor: { from: source.node, to: landing.node, seq: landing.seq },
        text,
    };
    appendPost(uri, post);
    return post;
}

/**
 * 收尾：**宣布**这个实例已走完（置 `FlowState.done`）—— `diy flow finish <uri>`。
 *
 * 为什么需要它（##319 review1 P2-B）：`done` 只由内核 `runtime.step` 的终态分支置位，而本版节点
 * guard **全是 `prompt:`（不可观测）** ⇒ `step` 在①分类即返回 `awaiting-actor`，那条分支**永不进入**
 * ⇒ 走到终端节点后 `done` 恒 false、也没有任何命令能表达「走完」，而 `show` 仍报 `mode: 'actor'`
 * —— 对外契约（`FlowView.done` / api-def 的 `done: z.boolean()`）等于撒谎。二选一里取「补终态语义」。
 *
 * 两半各自归位（**不改内核**）：
 *   · **结构那一半由系统核** —— 判据与内核同一条结构事实：当前位置**没有 `next` 出边**。还有 next 出边
 *     就不是终端节点，「走完」在那儿是假话 ⇒ 直接拒（先 `advance` / `bounce` 走到终端）。
 *   · **guard 那一半由宣布者担责** —— `prompt:` 不可观测，谁能断言它成立？与 `declare` 同一立场：
 *     宣布者。本版唯一操作入口是 CLI，审计里记 `author = "cli"`。
 *
 * 不做的事：不重跑 `action:`（本版没有插件）、不改位置（`done` 不是位置变更 —— 内核自己也是原地加标记）、
 * 不动 `params`（收尾不改运行配置）。
 */
export function finishFlow(uri: string, note?: string): FlowView {
    const { def, state } = loadInstance(uri);
    if (state.position === null) {
        throw new Error(`实例尚未进入工作流（${uri}）：没跑过就无所谓「走完」—— 先 \`diy flow advance ${uri} --to <入口节点>\``);
    }
    if (state.done === true) {
        throw new Error(`实例已收尾（done = true，位置 = ${state.position}）：重复收尾没有意义`);
    }
    const outs = def.edges.filter((e) => e.from === state.position);
    const nextEdges = outs.filter((e) => e.kind === "next");
    if (nextEdges.length > 0) {
        throw new Error(
            `节点「${nodeNameOf(def, state.position)}」（${state.position}）还有 next 出边：` +
                `${nextEdges.map((e) => e.to).join(" / ")} —— 不是终端节点，「走完」在这里是假话` +
                `（先 \`diy flow advance\` 到终端节点，或 \`diy flow bounce\`）`,
        );
    }
    const at = localISOString();
    const next = applyFinish(state);
    // 与 commit 同一落盘次序：先权威快照、再重建材料、最后审计（中途崩最坏是「快照多一条增量少一条」⇒ 对账亮错）
    writeState(uri, next);
    appendPathRecord(uri, { op: "finish", at });
    const tail = note && note.trim() !== "" ? `（${note.trim()}）` : "";
    appendAudit(uri, {
        id: randomUUID(),
        at,
        kind: "finish",
        from: state.position,
        to: state.position,
        author: "cli",
        content: `收尾：节点「${nodeNameOf(def, state.position)}」没有 next 出边，宣布工作流走完${tail}`,
        ref: { taskUri: uri },
    });
    return viewOf(uri, def, next);
}

// ═══════════════════════════════════════════════════════════════
// 系统推（##341）：把内核 `runtime.step` 接到落盘上
// ═══════════════════════════════════════════════════════════════
//
// 为什么需要它（##341 交付物 3/4）：`commit` 走的是**宣布**那条路（container `advance`，不评价 guard）
// —— 那正是 `prompt:` 节点的正确语义（转移本身就是一条发言）。但 `actor: 'system'` 节点问的是
// 「**外部世界**现在允许往前走吗」（CI 绿没绿 / PR 可不可合），只有内核 `runtime.step` 会去求值
// （`pred:` / `action:` 插件），」自动推「也只在它那里。本函数就是那条路的**唯一落盘口**。
//
// 三条口径与 `commit` 对齐（别在别处另立）：
//   · 落盘次序：**先权威快照 → 再重建材料 → 最后审计**（中途崩最坏是「快照多一条、增量少一条」⇒ 对账亮错）；
//   · 审计正文归宿主（内核不编人类文本）—— 复用同一个 `moveText`；
//   · 位置变更一律落 `path.jsonl` 的 `advance` 记录、终态落 `finish` 记录（重建材料，见 flow-store 头注）。
//
// 与 `diy flow finish` 的分工：走 `step` 走到底的实例，`done` 由**内核自己**置位（终态分支），
// 不需要人再宣布一次；`finish` 只服务「guard 全是 `prompt:`、内核那条分支走不到」的老定义。

/**
 * 一次系统推的结果（判别联合的**扁平版**：调用方是驱动环，逐字段读比层层解包好用）。
 *
 * `facts` = 这次求值**预热**的外部世界事实（键 = 插件名）—— 驱动方据此把「命令输出」落进产物袋
 * （`ci` 节点的 CI 日志就这么来的）；纯 `prompt:` 节点 / 入口推进时是空表。
 */
export interface StepOutcome {
    readonly status: "moved" | "done" | "stuck" | "awaiting-actor";
    /** 走到了哪（`moved` 时有值） */
    readonly to: string | null;
    /** 怎么走的（`entry` = 进入入口 / `next` / `bounce`） */
    readonly kind: "entry" | "next" | "bounce" | null;
    /** `stuck` / `awaiting-actor` 的原因（其余状态为空串） */
    readonly reason: string;
    readonly facts: Readonly<Record<string, CommandFact>>;
    readonly view: FlowView;
}

/**
 * 系统推**一步**：当前位置的 guard 全可观测 ⇒ 求值并自动转移（过 → `next` / 不过 → 打回或停在边上）；
 * 尚未进入 ⇒ 进入入口节点。含 `prompt:` 的节点**一步都不推**（内核的分类，见 `rule.observable-split`）。
 *
 * 「两步走」：**先异步取事实**（`collectFacts` 真跑命令），**再同步求值**（内核插件接口是同步的）。
 * 少了这一步，跑 `./sha.sh check` 会把主进程堵死几十秒（见 `workflows/plugins.ts` 头注）。
 */
export async function stepFlow(uri: string, deps: HostPluginDeps = {}): Promise<StepOutcome> {
    const { def, state } = loadInstance(uri);
    const params = state.params;
    // 只读分类（零插件、零副作用）：先回答「这一步到底该谁推」
    const status = runtimeOf(def, params).status(state);
    const noFacts: Readonly<Record<string, CommandFact>> = {};

    if (status.done) {
        return { status: "done", to: null, kind: null, reason: "", facts: noFacts, view: viewOf(uri, def, state) };
    }
    if (status.position !== null && status.mode === "actor") {
        const pending = status.pending.map((ref) => ref.raw).join(" / ");
        return {
            status: "awaiting-actor",
            to: null,
            kind: null,
            reason: `节点「${nodeNameOf(def, status.position)}」含不可观测 guard（${pending}）：系统判不了，只能由它的 actor 宣布`,
            facts: noFacts,
            view: viewOf(uri, def, state),
        };
    }

    // 事实**先取后用**：异步 I/O 全在这里做完（入口推进没有 guard，故没有要取的事实）
    const node = status.node;
    const prepared = node ? await collectFacts(pluginContext(def, node, params, "system"), deps) : [];
    const facts: Record<string, CommandFact> = {};
    for (const item of prepared) facts[item.name] = item.fact;

    const registry = createHostRegistry({ ...deps, facts });
    // ⚠️ `at` **只取一次**：内核把它写进 `Visit.at`（权威快照），宿主又把它写进 `path.jsonl`（重建材料）
    // —— 两边各取一次时间会差几毫秒，而两份必须**逐字同形**（`assertSnapshotMatches`），于是下一次读
    // 就亮「重建不出快照」的错。这不是洁癖：对账/NTP 对时下 `at` 本来就不单调（见内核 rule.state-serialize）。
    const at = localISOString();
    const result = runtimeOf(def, params, registry).step(state, { at, ref: { taskUri: uri } });

    if (result.status === "moved") {
        const { move } = result.transition;
        const next = result.transition.state;
        persistMove(uri, def, next, move.kind, move.from, move.to, result.transition.reason, at);
        return { status: "moved", to: move.to, kind: move.kind, reason: result.transition.reason, facts, view: viewOf(uri, def, next) };
    }
    if (result.status === "done") {
        writeState(uri, result.state);
        appendPathRecord(uri, { op: "finish", at });
        appendAudit(uri, {
            id: randomUUID(),
            at,
            kind: "finish",
            from: state.position,
            to: state.position,
            author: "system",
            content: `收尾：系统求值全过且节点「${nodeNameOf(def, state.position)}」没有 next 出边，工作流走完`,
            ref: { taskUri: uri },
        });
        return { status: "done", to: null, kind: null, reason: "", facts, view: viewOf(uri, def, result.state) };
    }
    if (result.status === "stuck") {
        return { status: "stuck", to: null, kind: null, reason: result.reason, facts, view: viewOf(uri, def, state) };
    }
    return {
        status: "awaiting-actor",
        to: null,
        kind: null,
        reason: `内核判为等 actor 宣布（${result.pending.map((ref) => ref.raw).join(" / ")}）`,
        facts,
        view: viewOf(uri, def, state),
    };
}

/** 一次系统推的落盘（与 `commit` 同一次序；`note` 用内核给的求值原因） */
function persistMove(
    uri: string,
    def: WorkflowDef<string>,
    next: FlowState<string>,
    kind: "entry" | "next" | "bounce",
    fromNode: string | null,
    to: string,
    reason: string,
    at: string,
): void {
    const ref = { taskUri: uri };
    writeState(uri, next);
    appendPathRecord(uri, { op: "advance", to, at, ref });
    appendAudit(uri, {
        id: randomUUID(),
        at,
        kind,
        from: fromNode,
        to,
        author: "system",
        content: moveText(def, kind, fromNode, to, reason === "" ? undefined : reason),
        ref,
    });
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
        at: localISOString(),
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
