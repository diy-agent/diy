// src/main/core/flow-thread.ts — 打回**讨论线程**的读 / 写（##342）
//
// 需求（用户原话）：打回反复争论的消息载体要**可见、留痕** —— 于是打回意见正文有了自己的一等载体
// （`flow/threads.jsonl`，见 `flow-store.ts` 的 `FlowPost`），本文件是它的业务层：谁属于哪个线程、
// 线程怎么读、往线程里说话前要过哪道闸。
//
// ── 三种投影，同一份事件流（##166 §14 的定案）────────────────────────────────────
//   · 泳道视图（`FlowStage`）= 折线（领域态 `state.json` 的 `path`）；
//   · 消息视图 = 讨论流（`threads.jsonl` 的发言，按锚点归线程）；
//   · 「拉出来的聊天室」= 对**某个锚点**开过滤窗口 —— 一个节点都不多（不新建节点、不占位置）。
//   本文件保证的是**锚点把这两份对得上**：线程**从折线上的真打回边推出来**（不是从讨论流反推），
//   讨论流只是往那些锚点上挂发言。
//
// ── 两条立场 ────────────────────────────────────────────────────────────────
//   1. **锚点必须真**（body 硬约束「不造数据」）：`postThread` 写前校验「折线上确有这次 bounce 驻留」，
//      假锚点一律拒（并列出可用线程）。读侧对「讨论流里有、折线上查无」的旧发言**不丢**：
//      标 `real: false` 亮出来（那是被人手改坏的数据，藏起来才是二次撒谎）。
//   2. **旁注坏了不炸**（`rule.core-log`）：`listThreads` 把「读不出 / 有坏行」变成 `error` / `skipped`
//      字段，从不外抛 —— 与 `flow show` 的 `threadError` 同一立场（对照 ##337 review1 P2-B）。
//
// ── 三个出口（body 交付物 4；形状自定，定案见回报）──────────────────────────────
//   (a) **撤销打回** —— 走**现有合法边**，不进讨论流：dev 定义里 `implement --next--> review` 就是
//       「开发说服了评审，回评审」那条路（`diy flow advance <uri> --to review`）。**不改内核语义**；
//   (b) **线程 resolved** —— `postThread(..., type: "resolved")`：讨论流里的一条状态发言，位置不动；
//   (c) **升级人裁决** —— `postThread(..., type: "escalate")`（一条升级发言，`actor` 写清是谁升的）；
//       它的**领域侧落点**是走到 `actor: 'human'` 的节点（如 dev 定义的 `approve`），由人宣布。

import { flowFile, anchorKey, parseAnchorKey, readPosts, appendPost, requirePostText, type FlowAnchor, type FlowPost, type FlowPostType } from "./flow-store";
import { loadInstance } from "./flow";
import { randomUUID } from "node:crypto";
import type { FlowState, WorkflowDef } from "@diy-agent/flow";
import { localISOString } from "@diy-agent/time";

/** 线程状态（由发言推：最后一条「状态发言」说了算；没有状态发言 ⇒ `open`） */
export type FlowThreadStatus = "open" | "resolved" | "escalated";

/** 一条讨论线程（锚点 = 一次真打回边的穿越） */
export interface FlowThreadView {
    /** 文本 id：`from->to#seq`（与 `--thread` 参数、UI 的 `data-flow-thread` 同一个键） */
    readonly id: string;
    readonly anchor: FlowAnchor;
    readonly fromName: string;
    readonly toName: string;
    /** 打回源那次驻留的序号（从折线推；假锚点 ⇒ null） */
    readonly fromSeq: number | null;
    /** 折线上**确有**这条打回边（false = 讨论流里有、折线上查无 ⇒ 假数据，亮出来） */
    readonly real: boolean;
    /** 折线上的次序（第几次位置变更；假锚点 ⇒ -1） */
    readonly at: number;
    readonly status: FlowThreadStatus;
    /** 该线程的发言（append-only 的追加次序 = 时间序） */
    readonly posts: FlowPost[];
}

/** `flow thread list` 的载荷 */
export interface FlowThreads {
    readonly uri: string;
    readonly threads: FlowThreadView[];
    /** 讨论流里跳过（读不出 / 形状不符）的行数 —— 旁注可坏，坏了只报数 */
    readonly skipped: number;
    /** 讨论流的错误位（`null` = 没出错）—— 与 `flow show` 的 `threadError` 同一立场 */
    readonly error: string | null;
    /** 讨论流文件（诊断 / 指路用；不存在也是正常态） */
    readonly file: string;
}

/** 折线里的一次真打回（锚点 + 它在折线上的下标 + 源驻留序号） */
interface RealBounce {
    readonly anchor: FlowAnchor;
    readonly fromSeq: number;
    readonly at: number;
}

/**
 * **从折线推出**真打回边（唯一来源 = 领域态，不读讨论流）。
 *
 * `kind === "bounce"` 的驻留 = 一次打回的落点；它的前一条就是打回源（首条不可能是 bounce ——
 * 进入入口恒为 `next`，见内核 container.ts）。
 */
function realBounces(state: FlowState<string>): RealBounce[] {
    const out: RealBounce[] = [];
    state.path.forEach((visit, i) => {
        if (visit.kind !== "bounce") return;
        const source = state.path[i - 1];
        if (!source) return;
        out.push({ anchor: { from: source.node, to: visit.node, seq: visit.seq }, fromSeq: source.seq, at: i });
    });
    return out;
}

function nodeNameOf(def: WorkflowDef<string>, id: string): string {
    return def.nodes.find((n) => n.id === id)?.name ?? id;
}

/** 线程状态：最后一条「状态发言」（`resolved` / `escalate`）说了算 */
function statusOf(posts: readonly FlowPost[]): FlowThreadStatus {
    for (let i = posts.length - 1; i >= 0; i -= 1) {
        const t = posts[i]!.type;
        if (t === "resolved") return "resolved";
        if (t === "escalate") return "escalated";
    }
    return "open";
}

/** 内部可变形状（构建期用；出口一律是不可变的 `FlowThreadView`） */
interface MutableThread {
    readonly anchor: FlowAnchor;
    readonly fromSeq: number | null;
    readonly real: boolean;
    readonly at: number;
    readonly posts: FlowPost[];
}

/**
 * 列讨论线程：**真打回边（折线）** ∪ **讨论流里出现过的锚点**。
 *
 * 前者是「一个节点都不多」的那份投影（打回了就有一个线程，哪怕还没人说话）；
 * 后者保证「讨论流里有的发言一条都不丢」
 * （只不过折线上查无此打回的发言被标 `real: false` —— 那是坏数据，亮出来而不是藏起来）。
 *
 * `thread` 给了就只看那一条；那条不存在 ⇒ **拒**（并列出可用线程：这是输入闸门，不静默给空）。
 */
export function listThreads(uri: string, thread?: string): FlowThreads {
    const { def, state } = loadInstance(uri);
    const only = thread === undefined || thread.trim() === "" ? null : anchorKey(parseAnchorKey(thread));
    const built = new Map<string, MutableThread>();
    const order: string[] = [];
    for (const b of realBounces(state)) {
        const key = anchorKey(b.anchor);
        built.set(key, { anchor: b.anchor, fromSeq: b.fromSeq, real: true, at: b.at, posts: [] });
        order.push(key);
    }
    let skipped = 0;
    let error: string | null = null;
    let posts: FlowPost[] = [];
    try {
        const read = readPosts(uri);
        posts = read.posts;
        skipped = read.skipped;
    } catch (e) {
        // 旁注读不出：不炸（位置 / 折线 / 线程结构照常），只把话写进 `error`
        error = `讨论流读不出：${(e as Error).message}（旁注坏了不影响推进 —— 删掉 ${flowFile(uri, "threads")} 即可）`;
    }
    for (const post of posts) {
        const key = anchorKey(post.anchor);
        let t = built.get(key);
        if (!t) {
            t = { anchor: post.anchor, fromSeq: null, real: false, at: -1, posts: [] };
            built.set(key, t);
            order.push(key);
        }
        t.posts.push(post);
    }
    const keys = only === null ? order : order.filter((k) => k === only);
    if (only !== null && keys.length === 0) {
        throw new Error(
            `没有这条打回线程 ${JSON.stringify(only)}：线程锚点必须指向**折线上真发生过的一次打回**` +
                `（不造数据）。现有：${order.join(" / ") || "（还没有打回）"}`,
        );
    }
    const threads: FlowThreadView[] = keys.map((key) => {
        const t = built.get(key)!;
        return {
            id: key,
            anchor: t.anchor,
            fromName: nodeNameOf(def, t.anchor.from),
            toName: nodeNameOf(def, t.anchor.to),
            fromSeq: t.fromSeq,
            real: t.real,
            at: t.at,
            status: statusOf(t.posts),
            posts: t.posts,
        };
    });
    return { uri, threads, skipped, error, file: flowFile(uri, "threads") };
}

/**
 * 往线程里发一条言（##342 的写侧：`resolved` / `escalate` / 普通回应都走它）。
 *
 * 三道闸（都为了「不造数据」）：
 *   1. 锚点形状（`from->to#seq`）—— `parseAnchorKey`；
 *   2. **锚点在折线上确实是那条打回边** —— 这条闸的判据只有一处实现（`requireRealBounce`）；
 *   3. 正文非空（不写空发言）。
 * 全过了才 append；返回值是**重新读一遍**的线程表（UI 直接拿它刷新，不必再调一次 list）。
 */
export function postThread(uri: string, thread: string, text: string, type: FlowPostType, author: string): FlowThreads {
    const { state } = loadInstance(uri);
    const anchor = parseAnchorKey(thread);
    requireRealBounce(state, anchor);
    requirePostText(text); // 唯一真源在 flow-store（与 `appendBounceOpinion` 共用一道闸，见其头注）
    appendPost(uri, { id: randomUUID(), at: localISOString(), author, type, anchor, text });
    return listThreads(uri);
}

/**
 * 锚点闸门：折线上确有 `to#seq` 这次驻留、它是**打回**进来的、且源节点就是 `from`（缺一即拒）。
 *
 * **判据只有一处**（##342 review1 P3-1）：命中与否 = 「该锚点在 `realBounces(state)` 里」——
 * 与读侧 `listThreads` 同一份推导，不再各自 `state.path` 遍历一遍（改一处漏一处的风险）。
 * 下面那段重新翻折线的代码**只用于把拒绝原因说清**（是没这次驻留 / 是 `next` 进来的 / 是 `from` 不符），
 * **不是判据** —— 它给出的任何结论都不影响上面那句「在不在集合里」。
 */
function requireRealBounce(state: FlowState<string>, anchor: FlowAnchor): void {
    const bounces = realBounces(state);
    const key = anchorKey(anchor);
    const available = bounces.map((b) => anchorKey(b.anchor));
    if (available.includes(key)) return;
    // ── 以下只是**诊断**（把「为什么拒」说清），放行判据在上面的集合命中 ──
    const i = state.path.findIndex((v) => v.node === anchor.to && v.seq === anchor.seq);
    if (i < 0) {
        throw new Error(
            `折线上没有「${anchor.to}#${anchor.seq}」这次驻留：线程锚点必须指向一次**真打回**（不造数据）。` +
                `现有打回：${available.join(" / ") || "（还没有打回）"}`,
        );
    }
    const visit = state.path[i]!;
    const source = state.path[i - 1];
    if (visit.kind !== "bounce") {
        throw new Error(
            `「${anchor.to}#${anchor.seq}」是**推进**进来的（kind: 'next'），不是打回：线程只挂在打回上。` +
                `现有打回：${available.join(" / ") || "（还没有打回）"}`,
        );
    }
    if (!source || source.node !== anchor.from) {
        throw new Error(
            `「${anchor.to}#${anchor.seq}」是被「${source?.node ?? "?"}」打回的，不是「${anchor.from}」：` +
                `锚点的 from 必须与折线一致。现有打回：${available.join(" / ")}`,
        );
    }
}
