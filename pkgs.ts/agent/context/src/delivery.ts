// src/shared/context/delivery.ts
// 🎯 一轮请求的**投递内容**（真发与预览的唯一构造入口，纯函数）。
//
// 为什么必须同源：预览的全部价值就是"看到的就是会发出去的"。真发（local-agent 的 runTurn）
// 与预览（ctxlab 页）都调本文件 —— 同一份 globals、同一套渲染，于是两边逐字节相同；
// 任何"预览另算一份"的写法都会让两边慢慢漂移。
//
// 一封信封（##520：system / runtime 两容器已删）：
//   `system.text` = `help:`（结构说明）+ `vars:`（变量树**全量**），放 streamText 的 system 参数；
//   之后任何变化都只追加一条 user 增量（`controlDeltaDelivery`），不重写已发出的 system。
//   system 是**段首快照**（压缩才重建），前缀缓存命中靠它。

import { project as projectTree } from "./projection.js";
import { applyFacts, createTree, setPlaces } from "./reducer.js";
import { controlDeltaEnvelope, dataText, varsEnvelope } from "./envelope.js";
import type { SchemaDoc } from "./schema/schema-doc.js";
import { hashValue } from "./hash.js";
import { WIRE_VERSION } from "./wire.js";
import { isPlainObject } from "./tree.js";
import type { ContextFact, ContextPath, ContextTreeState } from "./types.js";
import { TASK_HEAD_FIELDS } from "./schema/task-head.js";
import { emptyCursor } from "./projection.js";

/**
 * 候选投递单元（原子单元；两两不重叠）。
 *
 * 为什么还要拆子字段：`task` 下面 `uri/dir/created/parent` 在任务存续期内不变，
 * 而 `state/updated/title/body` 每改一次任务就变 —— 按第一层粗暴划分会让「改正文」把
 * 整段任务头重发一遍。单元决定**增量与变更历史的粒度**（##426 / ##520）。
 */
export interface PlaceCandidate {
    path: ContextPath;
    /** 为什么单列（人话；页面「结构树」与排查时用） */
    reason: string;
    /**
     * 是否进**变更历史**（`changelog` / 上下文树的"变化步骤"）。缺省 `true`。
     *
     * 为什么允许为 `false`：变更历史回答的是「**上下文为什么变了**」，它的读者是"要判断
     * 有没有东西该重看"的人和 agent。而 `self` 是**仪表盘**（花了多少钱 / 窗口多满），
     * 每步必变 —— 让它进变更历史，等于每一步都落一条 `changed`，真实变化被淹掉
     * （##5 早报过"变化步骤一堆空的"，反过来"每步都有变化、但全是仪表盘"同样是噪声）。
     *
     * 注意它**不影响投递**：`self` 仍要进增量（模型必须看到最新数）——
     * 两个消费者口径不同，别合成一个开关。
     */
    changelog?: false;
}

/** 任务头字段的投递理由（页面「结构树」表用；逐键必填） */
const TASK_HEAD_REASONS: Record<string, string> = Object.fromEntries(
    TASK_HEAD_FIELDS.map((f) => [f.key, `任务头 ${f.key}：编辑任务时可能变 → 单列一个原子单元`]),
);

export const PLACE_CANDIDATES: PlaceCandidate[] = [
    { path: "diy", reason: "进程身份（CLI / 数据根）：整个会话不变" },
    { path: "project", reason: "项目路径：只在切项目时变" },
    { path: "cwd", reason: "工作目录整段含 note/isFallback/isTaskDir/isAppDir —— 目录判定会变；体量小" },
    { path: "chain", reason: "AGENTS.md 链：只在目录/文件改动时变" },
    // 任务头（frontmatter）字段（##322：**读侧显式给头**，确认任务/取父级不必去 cat 文件）。
    // 它们就是文件头的同一份（不是副本），随文件走；**逐键一个单元**（改正文不该重发整头）。
    // **名单不在此手抄**：path 从 TASK_HEAD_FIELDS 派生（##322 review R3），reason 必须逐键齐全
    // （Record<TaskHeadField,string> ⇒ 新增头字段漏写理由直接编译失败，这就是要的效果）。
    ...TASK_HEAD_FIELDS.map((f) => ({
        path: `task.${f.key}`,
        reason: TASK_HEAD_REASONS[f.key]!,
    })),
    { path: "task.uri", reason: "任务 URI：不变" },
    { path: "task.dir", reason: "任务目录：不变" },
    // ── 模版节（identity / rules / guard，值是模版渲染结果；见 prompt-registry 的 DELIVERED_SECTIONS）──
    // 为什么必须有：它们此前**完全不在投递里**（名单没有 = 不投）—— 真发于是丢掉
    // 人物行为指令、行为规范与保命契约（209 review P0-1 实测：persona/身份/<rules>/<guard> 全 false）。
    // 为什么不列 persona：身份节（identity.md）里已经有「人物是「X」」+ 行为指令，
    // 再列 persona 会把同一段指令投两遍（浪费前缀缓存、也让人分不清哪份为准）。
    { path: "identity", reason: "身份：人物名 + 行为指令（模版节渲染结果）；任务存续期内不变" },
    { path: "rules", reason: "行为规范：静态文本，只在改模版时变" },
    { path: "guard", reason: "保命契约：静态文本，丢了模型可能换写法杀宿主进程" },
    // 「我自己的东西在哪、怎么找」：关键位置（我这个任务真发的请求落到哪个文件、怎么找）
    // 给不出来，模型就无法自查"我上一步到底发出去了什么"。
    // 值只有 `file`（纯数据）；路径规则/定位命令在 `.describe()` → 信封的 `help.reqlog`。
    { path: "reqlog", reason: "真发请求的流量日志在哪：文件名按天变；只是定位信息、本就不常查" },
    { path: "task.body", reason: "任务正文：每次编辑正文就变；散文，与结构化单元分开" },
    { path: "skills", reason: "技能清单：安装/升级技能就变" },
    // 房间上下文（##377 第 26 刀）：**两个原子单元，别合成一个** —— 增量按 place 逐条比
    // （`projection.ts` 的 renderedHash），合起来则"成员改个名"会把整段 recent 重发一遍。
    { path: "room.members", reason: "房间成员：低频（改成员才变）" },
    { path: "room.recent", reason: "房间近期发言：高频（有人说话就变）" },
    // 事实库投影（##404 待办 4）：它是"任务当前的真身"，随 submit 变（稀疏）；
    // 与 `task.body` 分开：body 是 prose、facts 是结构化键值，混在一起既不能按 claim diff，
    // 也没法在页面上分开看。
    { path: "facts", reason: "事实库投影：随 submit 变（稀疏）；结构化，与 body 的散文分开" },
    // 知识库索引（##404 待办 1）：agent 靠它知道**库里有什么**。
    // 为什么单列而不并进 facts：二者字节量与变化频率差一个量级，合并后"改一个主题名"会把
    // 4 KB 投影整段重发。
    { path: "kb", reason: "知识库索引：随库主题/条数变（低频）；与 facts 投影分开计价" },
    // 仓库文档索引（##5 第 11 轮 B）：`docs/` 不在 AGENTS.md 链上，不列出来 agent 就不知道
    // 有哪些设计稿。与 kb 同样：真源不同（文件树 vs 事实库），变更频率也不同。
    { path: "docs", reason: "仓库文档索引：随文档增删/改标题变（低频）；真源是文件树" },
    // 自量（##404 / ##9 提案）：窗口占用 / 上一步消耗 / 本轮累计。
    // 为什么单列：它的变化频率是**最高档**（每步一次），与其他单元混在一起会让"别的字段改一下"
    // 也把这份高频段重发一遍；且不进变更历史（见 changelog 字段）。
    {
        path: "self",
        changelog: false,
        reason: "自量（窗口占用/上一步消耗/本轮累计）：每步都变，且不进变更历史（见 changelog 字段）",
    },
];

/** 全部候选单元（**常量名单**；help 的结构说明与增量口径都按它） */
export function unitPaths(): ContextPath[] {
    return PLACE_CANDIDATES.map((c) => c.path);
}

/** 一份投递内容（信封里的一段） */
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
 * 文本形态 = **信封**（见 envelope.ts）：`text` = `help:` + `vars:` 的一份 YAML
 * （**变量树全量**）。轮中途/跨轮的变化由 `controlDeltaDelivery` 按"变化的原子单元"现造。
 */
export interface Delivery {
    tree: ContextTreeState;
    /** 信封全文（`help:` + `vars:`）→ 放 `streamText` 的 system 参数 */
    text: DeliveryPart;
    /** 变量树的**纯数据**部分（只有变量树、不带 help 段）—— golden 比对与调试用 */
    data: DeliveryPart;
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

/**
 * 构造一轮投递（**真发与预览的唯一入口**）。
 *
 * 单元 = 候选里**整条 path 真的存在**的那些（##377 第 26 刀）：`room.recent` 在"没人说话"时
 * 整个单元缺席 —— 只看顶层 `room` 会把它留成 place，于是它有个"空"的 renderedHash
 * ⇒ 每步 diff 都报 `set room.recent: ''`，把"上下文"变成噪声（还会砸前缀缓存）。
 * 同一形状的坑对任何可选子单元都成立。
 */
export function buildDelivery(
    globals: Record<string, unknown>,
    /** 各 provider 的结构说明（`helpsOf(providers)`）；缺省 = 从 zod 派生 */
    helps?: Record<string, SchemaDoc>,
): Delivery {
    const inTree = (p: ContextPath): boolean => {
        let cur: unknown = globals;
        for (const seg of p.split(".")) {
            if (cur === null || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) return false;
            cur = (cur as Record<string, unknown>)[seg];
        }
        return true;
    };
    const places = unitPaths().filter(inTree).sort();

    let tree = treeOfGlobals(globals);
    tree = setPlaces(tree, places);

    // 信封：`help:`（**唯一的结构说明源**，由 zod 递归派生）+ `vars:`（变量树）。
    // 一次产出同时给出文本与行号映射（emitValue 边写边记）—— 高亮/滚动才不会指错行；
    // 行号键剥掉 `vars.` 前缀，与变量树 path 口径一致。
    // help 的描述取**候选全集**而不是本轮真出现的那些 —— 否则可选单元的出现/消失会改文本，
    // 把前缀缓存扭一次（见 `buildHelpDoc` 注释）。
    const env = varsEnvelope(tree, places, unitPaths(), helps);

    const part = (p: ContextPath[], t: { text: string; lines: DeliveryPart["lines"] }): DeliveryPart => ({
        places: p,
        text: t.text,
        bytes: byteLen(t.text),
        lines: t.lines,
    });
    return {
        tree,
        text: part(places, env),
        data: part(places, { text: dataText(tree, places), lines: {} }),
        valueHashes: valueHashesOf(tree),
        wireVersion: WIRE_VERSION,
    };
}

/**
 * **变量增量**：只列变化的原子单元，值 = 变更后的新值。
 * 单元整体消失 ⇒ 该 path 落 `null`（见 `envelope.subsetOfDelta`）。
 *
 * 为什么是「变更后的当前值」而不是 before/after 摘要：这一步的作用是**纠正模型手里的数据**
 * ——它要的是新值；旧值它本来就在上下文里（该轮首步的全量）。给截断的 before/after
 * 只会让它继续按旧值干活（那正是「几小时的会话建立在错误数据上」这个 bug 的形态）。
 *
 * 无变化的单元 → 空 places → 空串（调用方跳过注入，不砸前缀缓存）。
 */
export function controlDeltaDelivery(tree: ContextTreeState, paths: readonly ContextPath[]): DeliveryPart {
    const sorted = [...paths].sort();
    const r = controlDeltaEnvelope(tree, sorted);
    return { places: sorted, text: r.text, bytes: byteLen(r.text), lines: r.lines };
}

/** 调试用：确认投递与 project() 口径一致 */
export const deliveryProjection = (s: ContextTreeState) => projectTree(s, emptyCursor()).projection;
