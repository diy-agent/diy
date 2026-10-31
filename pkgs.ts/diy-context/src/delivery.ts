// src/shared/context/delivery.ts
// 🎯 一轮请求的**投递内容**（真发与预览的唯一构造入口，纯函数）。
//
// 为什么必须同源：预览的全部价值就是"看到的就是会发出去的"。真发（local-agent 的 runTurn）
// 与预览（ctxlab 页）都调本文件 —— 同一份 globals、同一份 system 名单、同一套渲染，
// 于是两边逐字节相同；任何"预览另算一份"的写法都会让两边慢慢漂移。
//
// 两个容器（144 的结论，实现上就是两段文本 + 两种投递位置）：
//   system  —— 每次请求**全量重建**，放 streamText 的 system 参数（不进消息历史，故天然无补丁）
//   runtime —— 易变部分，作为**尾部 user 消息**投递（不进块树/llm 历史，每轮现拼，故不会累积）
//
// 划分只声明 **system 名单**：没进名单的自动归 runtime（不是两套表，避免两边打架）。

import { project as projectTree } from "./projection.js";
import { applyFacts, createTree, setPlacement, setPlaces } from "./reducer.js";
import { controlDeltaEnvelope, runtimeDiffEnvelope, systemDataText, systemEnvelope, runtimeEnvelope } from "./envelope.js";
import { hashValue } from "./hash.js";
import { WIRE_VERSION } from "./wire.js";
import { isPlainObject } from "./tree.js";
import type { ContextFact, ContextPath, ContextTreeState } from "./types.js";
import { TASK_HEAD_FIELDS, type TaskHeadField } from "./schema/task-head.js";
import { emptyCursor } from "./projection.js";

/** 候选投递单元（规则表里可选的行；不重叠） */
export interface PlaceCandidate {
    path: ContextPath;
    /** 默认是否归 system */
    system: boolean;
    /** 稳定性判断（也就是"为什么"） */
    reason: string;
    /**
     * 是否进**变更历史**（`changelog` / 上下文树的"变化步骤"）。缺省 `true`。
     *
     * 为什么允许为 `false`：变更历史回答的是「**上下文为什么变了**」，它的读者是"要判断
     * 有没有东西该重看"的人和 agent。而 `self` 是**仪表盘**（花了多少钱 / 窗口多满），
     * 每步必变 —— 让它进变更历史，等于每一步都落一条 `changed`，真实变化被淹掉
     * （##5 早报过"变化步骤一堆空的"，反过来"每步都有变化、但全是仪表盘"同样是噪声）。
     *
     * 注意它**不影响投递**：`self` 仍要进 `runtimeDiff`（模型必须看到最新数）——
     * 两个消费者口径不同，别合成一个开关。
     */
    changelog?: false;
}

/**
 * 任务头字段的投递划分（逐键必填：清单在 shared/task-head.ts 的 TASK_HEAD_FIELDS）。
 *
 * 判据（##426）：**只有「任务存续期内不变 + 值得缓存」的才进 system**。
 * 任务头大部分字段是**编辑就变**（title / state / updated / change_type / module / priority / persona）——
 * 放 runtime 更合适：
 *   ⚠️ **但别再用“会砸前缀缓存”当理由**（2026-10-31 更正）。那是 ##426 时期（还没有段首冻结）
 *   的事实：现在 system 一旦发出就是**段首快照**，名单里的单元后来变了**不会**重写 system，
 *   而是以 `system:` 增量的形式补在 `role:user` 上（`step-delta.ts`）。
 *   真实的代价只有两笔，都很小：① 首轮 / 压缩重建那一次，system 字节更大（按全价）；
 *   ② 这些值每轮都变 → 进 system 也只能靠补丁传达，不如一开始就归 runtime（字段少、语义清）。
 */
const TASK_HEAD_DELIVERY: Record<TaskHeadField, { system: boolean; reason: string }> = {
    title: { system: false, reason: "任务标题：改一次任务就变（每次都得补一条 system 增量）→ runtime" },
    state: {
        system: false,
        reason: "任务状态：每轮都可能变（pending→in_progress→done），每变都得补增量 → runtime",
    },
    parent: { system: true, reason: "父任务 URI：只在 move 时变（任务存续期内基本不变）→ system" },
    created: { system: true, reason: "创建时间：整个存续期不变 → system（可缓存）" },
    updated: {
        system: false,
        reason: "最后编辑时间：任何一次编辑都刷新（与 state 同频）→ runtime",
    },
    change_type: { system: false, reason: "变更性质：编辑任务时会变 → runtime" },
    module: { system: false, reason: "模块：编辑任务时会变 → runtime" },
    priority: { system: false, reason: "优先级：调整时会变 → runtime" },
    persona: { system: false, reason: "绑定的人物：绑定时变（空 = 跟随缺省）→ runtime" },
};

/** 任务头字段的投递理由（页面「划分规则」表用；逐键必填） */
const TASK_HEAD_REASONS: Record<TaskHeadField, string> = Object.fromEntries(
    TASK_HEAD_FIELDS.map((f) => [f.key, TASK_HEAD_DELIVERY[f.key].reason]),
) as Record<TaskHeadField, string>;

/**
 * 候选投递单元 = 顶层字段 + 少数需要单独拆开的子字段。
 *
 * 为什么顶层之外还要拆：`task` 下面 `uri/dir/created/parent` 在任务存续期内不变，
 * 而 `state/updated/title/body` 每改一次任务就变 —— 按第一层粗暴划分会把这两类塞进同一份，
 * 规则表的意义正在这里（##426）。
 */
export const PLACE_CANDIDATES: PlaceCandidate[] = [
    { path: "diy", system: true, reason: "进程身份（CLI / 数据根）：整个会话不变" },
    { path: "project", system: true, reason: "项目路径：只在切项目时变" },
    // ##426：**默认最小 system 名单** —— 只有「绝对有信心不变」的才留 system，其余一律回 runtime。
    // 用户口径（2026-10-25）：「理论上除了绝对有信心的一些字段外，默认把所有变量都放到 run，
    // 只有觉得统计上需要放到 sys 的才回放到 sys」。
    //
    // ⚠️ **理由已更新（2026-10-31）**：原文写的是「system 每轮全量重建，名单含易变字段就砸前缀
    // 缓存」—— 那是 ##426 时期的事实。现在 system 是**段首快照**（压缩才重建，见
    // `shared/context/segment-snapshot.ts`）：名单里的单元后来变了**不会**重写 system，
    // 只会在 `role:user` 里补一条 `system:` 增量。
    // 所以把易变项留在 system 不会“每轮砸缓存”；真正的代价只有首轮 / 压缩重建那一次多一些字节。
    // 默认仍取最小名单：段首越短，重建（收费那一次）越便宜，也不至于让易变值占着本该属于
    // 稳定项的 help 描述空间。**别再拿“会砸缓存”当让用户改配置的理由**。
    {
        path: "cwd",
        system: false,
        reason: "工作目录整段含 note/isFallback/isTaskDir/isAppDir —— 目录判定会变（变了需补增量）；体量小，放 runtime 更干净",
    },
    { path: "chain", system: true, reason: "AGENTS.md 链：只在目录/文件改动时变" },
    // 任务头（frontmatter）字段（##322：**读侧显式给头**，确认任务/取父级不必去 cat 文件）。
    // 它们就是文件头的同一份（不是副本），随文件走。**只有存续期不变的才进 system**（见 TASK_HEAD_DELIVERY）。
    // **名单不在此手抄**：path 从 TASK_HEAD_FIELDS 派生（##322 review R3），reason 必须逐键齐全
    // （Record<TaskHeadField,string> ⇒ 新增头字段漏写理由直接编译失败，这就是要的效果）。
    ...TASK_HEAD_FIELDS.map((f) => ({
        path: `task.${f.key}`,
        system: TASK_HEAD_DELIVERY[f.key].system,
        reason: TASK_HEAD_REASONS[f.key],
    })),
    { path: "task.uri", system: true, reason: "任务 URI：不变" },
    { path: "task.dir", system: true, reason: "任务目录：不变" },
    // ── 模版节（identity / rules / guard，值是模版渲染结果；见 prompt-registry 的 DELIVERED_SECTIONS）──
    // 为什么必须有：它们此前**完全不在投递里**（名单没有 = 两个容器都不投）—— 真发于是丢掉
    // 人物行为指令、行为规范与保命契约（209 review P0-1 实测：persona/身份/<rules>/<guard> 全 false）。
    // 为什么不列 persona：身份节（identity.md）里已经有「人物是「X」」+ 行为指令，
    // 再列 persona 会把同一段指令投两遍（浪费前缀缓存、也让人分不清哪份为准）。
    { path: "identity", system: true, reason: "身份：人物名 + 行为指令（模版节渲染结果）；任务存续期内不变 → 可缓存" },
    { path: "rules", system: true, reason: "行为规范：静态文本，只在改模版时变" },
    { path: "guard", system: true, reason: "保命契约：静态文本，丢了模型可能换写法杀宿主进程" },
    // 「我自己的东西在哪、怎么找」：稳定信息 → 默认进 system。
    // 用户 2026-10-15：上下文树主要是**给模型定位信息**用的 —— 关键位置（我这个任务真发的请求
    // 落到哪个文件、怎么找）给不出来，模型就无法自查"我上一步到底发出去了什么"。
    // 值只有 `file`（纯数据）；路径规则/定位命令在 `.describe()` → 信封的 `help.reqlog`。
    {
        path: "reqlog",
        system: false,
        reason: "真发请求的流量日志在哪：**文件名按天变**（跨天得补一条增量）；且只是定位信息、本就不常查 → runtime",
    },
    { path: "task.body", system: false, reason: "任务正文：每次编辑正文就变 → 放 runtime，不污染 system 缓存" },
    { path: "skills", system: false, reason: "技能清单：安装/升级技能就变" },
    // 房间上下文（##377 第 26 刀）：**两个原子单元，别合成一个** —— runtime 增量按 place 逐条比
    // （`projection.ts` 的 renderedHash），合起来则"成员改个名"会把整段 recent 重发一遍。
    { path: "room.members", system: false, reason: "房间成员：低频（改成员才变）" },
    { path: "room.recent", system: false, reason: "房间近期发言：高频（有人说话就变）" },
    // 事实库投影（##404 待办 4）：**runtime 而不是 system** —— 它是"任务当前的真身"，
    // 每轮都变（agent 自己在本轮里就可能 submit 一批）—— 段首冻结后它不会重写 system，
    // 但每变一次都得补一条 system 增量，不如直接归 runtime（增量本来就走这条路）。
    // 与 `task.body` 同一道理：内容随工作推进而变，但变化**稀疏**（不是每轮都有新事实），
    // 故单列一个原子单元比并进 body 更好 —— body 是 prose、facts 是结构化键值，
    // 混在一起既不能按 claim diff，也没法在页面上分开看。
    { path: "facts", system: false, reason: "事实库投影：随 submit 变（稀疏）；结构化，与 body 的散文分开" },
    // 知识库索引（##404 待办 1）：AGENTS.md 链里「按需才查」的条目迁进库后，agent 靠它知道
    // **库里有什么**。为什么与 facts 同样进 runtime：索引里的 `claims` 计数**随 submit 变**
    // （新增一条事实 → 那个主题的条数就变），归 runtime 才能按单元补增量。
    // 为什么单列而不并进 facts：二者字节量与变化频率差一个量级（索引 ~1.5 KB 随主题数，
    // 投影 4 KB 随条目数），合并后"改一个主题名"会把 4 KB 投影整段重发。
    { path: "kb", system: false, reason: "知识库索引：随库主题/条数变（低频）；与 facts 投影分开计价" },
    // 仓库文档索引（##5 第 11 轮 B）：`docs/` 不在 AGENTS.md 链上，不列出来 agent 就不知道
    // 有哪些设计稿。与 kb 同样进 runtime：**文档增删 / 改标题就变**（变了要补增量）。
    // 为什么单列而不并进 kb：真源不同（文件树 vs 事实库），变更频率也不同（kb 随 submit 变、
    // docs 随 git 提交变）。合并后"submit 一条事实"会把整段文档索引重发。
    { path: "docs", system: false, reason: "仓库文档索引：随文档增删/改标题变（低频）；真源是文件树" },
    // 自量（##404 / ##9 提案）：窗口占用 / 上一步消耗 / 本轮累计。
    // 为什么必须进 runtime：这三个数**每步都变**（窗口随本步 token、`turn.cost` 随累计），
    // 进 system 就是每步把前缀缓存打碎（实测 cacheRead 占 92~99%，一改输入成本×几十）。
    // 为什么单列而不并进别的单元：它的变化频率是**最高档**（每步一次），与其他单元混在一起
    // 会让“别的字段改一下”也把这份高频段重发一遍。
    {
        path: "self",
        system: false,
        changelog: false,
        reason: "自量（窗口占用/上一步消耗/本轮累计）：每步都变 → 必须 runtime，且不进变更历史（见 changelog 字段）",
    },
];

/** 默认 system 名单（真发与预览共用；用户可在页面上改，改动只影响该页面预览） */
export function defaultSystemPlaces(): ContextPath[] {
    return PLACE_CANDIDATES.filter((c) => c.system).map((c) => c.path);
}

/** 一份容器的投递内容（信封里的一段） */
export interface DeliveryPart {
    places: ContextPath[];
    text: string;
    bytes: number;
    /**
     * path → 该 path 在 `text` 里的行号区间（1 基闭区间）。
     * 与 text 出自同一次渲染（`renderPathsTraced`），故高亮/滚动一定指得准。
     */
    lines: Record<ContextPath, { from: number; to: number }>;
}

/**
 * 一轮请求的投递（真发用它发；预览用它显示；快照把它记下来给 diff 用）。
 *
 * 文本形态 = **信封**（见 envelope.ts）：`system.text` = `help:` + `system:` + `runtime:` 三段的
 * 一份 YAML（**两条树全量**，##442 用户 2026-10-27「dsh 方式 B」）。`runtime.text` 仍单独给一份
 * （`runtime:` 一段），只为 diff / 测试 / 旧调用点；**真发不再把它插进 user 消息**。
 * 轮中途/跨轮的变化由 `controlDeltaDelivery` 按"变化的原子单元"现造。
 */
export interface Delivery {
    tree: ContextTreeState;
    /** system 容器全文（信封：`help:` + `system:` + `runtime:`）→ 放 `streamText` 的 system 参数 */
    system: DeliveryPart;
    /** system 的**纯数据**部分（只有变量树、不带 help 段）—— golden 比对与调试用 */
    systemData: DeliveryPart;
    /** runtime 容器全文（信封：`runtime:` 一段）—— 已并入 `system.text`；本字段留给 diff / 测试 */
    runtime: DeliveryPart;
    /** path → 子树值 hash（前 12 位）：步间比较"哪些变量变了" */
    valueHashes: Record<ContextPath, string>;
    wireVersion: string;
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

/** 把 globals 灌成一棵 Context Tree（每个顶层字段一条事实） */
export function treeOfGlobals(globals: Record<string, unknown>): ContextTreeState {
    void emptyCursor;
    let tree = createTree();
    const facts: ContextFact[] = Object.entries(globals).map(([k, v]) => ({
        type: "patch" as const,
        path: k,
        op: "set" as const,
        value: v,
    }));
    tree = applyFacts(tree, facts).state;
    return tree;
}

/** 值树里每个节点一条 hash（含中间容器；父的 hash 就是它整棵子树的 hash） */
function valueHashesOf(state: ContextTreeState): Record<ContextPath, string> {
    const out: Record<ContextPath, string> = {};
    const walk = (node: unknown, base: string): void => {
        if (base) out[base] = hashValue(node).slice(0, 12);
        if (isPlainObject(node)) {
            for (const [k, v] of Object.entries(node)) walk(v, base ? `${base}.${k}` : k);
        } else if (Array.isArray(node)) {
            node.forEach((v, i) => walk(v, base ? `${base}.${i}` : String(i)));
        }
    };
    walk(state.values, "");
    return out;
}

/** 候选兼容性：与已选 system 名单不得互为祖先/后代（places 的硬规则） */
function candidatesCompatible(p: ContextPath, systemPlaces: readonly ContextPath[]): boolean {
    for (const s of systemPlaces) {
        if (s === p) continue;
        if (s.startsWith(`${p}.`) || p.startsWith(`${s}.`)) return false;
    }
    return true;
}

/**
 * 一份 system 名单对应的**有效投递单元**（不含 `inTree` 过滤）：候选 ∪ 名单，再去掉与名单
 * 互为祖先后代的候选（`places` 的硬规则）。
 *
 * 为什么提出来：`buildDelivery` 与**历史归因**（`unitsFromSystemPlaces`）必须用同一份名单 ——
 * 各算一份必然漂移。反例（review RV-14）：只遍历 `PLACE_CANDIDATES` 时，手填的候选外单元被整个丢掉
 * （它的变化报成"无原因"）；名单里是**祖先级**单元（如手填 `task`）时，还会把被挤掉的候选
 * 当成幽灵单元造出来（`task.body` → 谎报 `task.body(runtime)`，实际该轮是 `task(system)`）。
 */
export function unitPathsOf(systemPlaces: readonly ContextPath[]): ContextPath[] {
    return [...new Set([...PLACE_CANDIDATES.map((c) => c.path), ...systemPlaces])].filter((p) =>
        candidatesCompatible(p, systemPlaces),
    );
}

/**
 * 构造一轮投递（**真发与预览的唯一入口**）。
 * systemPlaces 缺省用推荐名单；名单里不存在于值树的 path 自动忽略（不报错：
 * 名单是用户偏好，跨任务复用时会有些 path 没有）。
 */
export function buildDelivery(
    globals: Record<string, unknown>,
    systemPlaces: readonly ContextPath[] = defaultSystemPlaces(),
): Delivery {
    // places 取「候选里存在的」+ system 名单（后者可能含候选外的手填 path）
    //
    // 判据是**整条 path 真的存在**，不是只看顶层键（##377 第 26 刀）：
    // `room.recent` 在"没人说话"时整个单元缺席 —— 只看顶层 `room` 会把它留成 place，
    // 于是它有个"空"的 renderedHash ⇒ 每步 diff 都报 `set room.recent: ''`，
    // 把"上下文"变成噪声（还会砸前缀缓存）。同一形状的坑对任何可选子单元都成立。
    const inTree = (p: ContextPath): boolean => {
        let cur: unknown = globals;
        for (const seg of p.split(".")) {
            if (cur === null || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) return false;
            cur = (cur as Record<string, unknown>)[seg];
        }
        return true;
    };
    const places = unitPathsOf(systemPlaces).filter(inTree).sort();

    let tree = treeOfGlobals(globals);
    tree = setPlaces(tree, places);
    for (const p of places) tree = setPlacement(tree, p, systemPlaces.includes(p) ? "system" : "runtime");

    const sysPlaces = tree.places.filter((p) => tree.placement[p] === "system").sort();
    const runPlaces = tree.places.filter((p) => (tree.placement[p] ?? "runtime") === "runtime").sort();
    // help 里的 runtime 描述取**候选全集**而不是 runPlaces（本轮真出现的那些）——
    // 否则可选单元的出现/消失会改 system 文本，把前缀缓存扭一次（见 `buildHelpDoc` 注释）。
    const helpRunPlaces = unitPathsOf(systemPlaces)
        .filter((p) => !sysPlaces.includes(p))
        .sort();
    // system 信封：`help:`（**唯一的结构说明源**，由 zod 递归派生）+ `system:`（变量树）。
    // 一次产出同时给出文本与行号映射（emitValue 边写边记）—— 高亮/滚动才不会指错行；
    // 行号键剥掉 `system.` 前缀，与变量树 path 口径一致。
    const sys = systemEnvelope(tree, sysPlaces, runPlaces, helpRunPlaces);
    const run = runtimeEnvelope(tree, runPlaces);

    const part = (p: ContextPath[], t: { text: string; lines: DeliveryPart["lines"] }): DeliveryPart => ({
        places: p,
        text: t.text,
        bytes: byteLen(t.text),
        lines: t.lines,
    });
    return {
        tree,
        system: part(sysPlaces, sys),
        systemData: part(sysPlaces, { text: systemDataText(tree, sysPlaces), lines: {} }),
        runtime: part(runPlaces, run),
        valueHashes: valueHashesOf(tree),
        wireVersion: WIRE_VERSION,
    };
}

/**
 * 轮中途那一步的 `runtimeDiff:` 信封（**只列变化的原子单元** → 变更后的当前值）。
 *
 * 为什么是「变更后的当前值」而不是 before/after 摘要：这一步的作用是**纠正模型手里的数据**
 * ——它要的是新值；旧值它本来就在上下文里（该轮首步的全量 runtime）。给截断的 before/after
 * 只会让它继续按旧值干活（那正是「几小时的会话建立在错误数据上」这个 bug 的形态）。
 *
 * 无变化的单元 → 空 places → 空串（调用方跳过注入，不砸前缀缓存）。
 */
export function runtimeDiffDelivery(tree: ContextTreeState, paths: readonly ContextPath[]): DeliveryPart {
    const sorted = [...paths].sort();
    const r = runtimeDiffEnvelope(tree, sorted);
    return { places: sorted, text: r.text, bytes: byteLen(r.text), lines: r.lines };
}

/**
 * **控制变量增量**：只列变化的原子单元（system / runtime 分开），值 = 变更后的新值。
 * 单元整体消失 ⇒ 该 path 落 `null`（见 `envelope.subsetOfDelta`）。
 *
 * 两段都空 → 空串（调用方据此**不注入**，不砸前缀缓存）。
 */
export function controlDeltaDelivery(
    tree: ContextTreeState,
    systemPaths: readonly ContextPath[],
    runtimePaths: readonly ContextPath[],
): DeliveryPart {
    const r = controlDeltaEnvelope(tree, systemPaths, runtimePaths);
    return {
        places: [...systemPaths, ...runtimePaths].sort(),
        text: r.text,
        bytes: byteLen(r.text),
        lines: r.lines,
    };
}

/**
 * 该 path 在这种划分下是否归 **runtime**。
 * 判据与 `buildDelivery` 同一套（不在 places 里的按 runtime 算）—— 分叉出一份"runtime 判据"
 * 必然与真发漂移（哪里是 system 才是真源）。
 */
export function isRuntimePlace(tree: ContextTreeState, path: ContextPath): boolean {
    return !tree.places.includes(path) || (tree.placement[path] ?? "runtime") === "runtime";
}

/** 调试用：确认投递与 project() 口径一致 */
export const deliveryProjection = (s: ContextTreeState) => projectTree(s, emptyCursor()).projection;
