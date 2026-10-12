/**
 * 轮次折叠 / 展开级别的**语义**（纯函数，可单测）——组件只负责画。
 *
 * 为什么单独一层：折叠态"显示什么、按什么序、展开到第几层"是语义而不是样式，
 * 错一次就是"用户发言被拽到助理回复下面"（2026-10-04 现象：顺序不对）。
 * 语义放这里用测试钉住，LocalChatPage 只消费结果。
 *
 * 一个轮次在界面上分三段，判据各自成函数：
 *   ① 轮首用户发言 `leadUsers` —— 渲染在轮次头**之前**（IM 顺序：用户先说、对方再接）
 *   ② 中间内容 `foldedItems`（1-2 级）/ `contentItems`（3 级起）
 *   ③ 活动块 `liveTailOf` + 插入位置 `liveSlotIndex` —— 只有直播轮次有（**就地**画在中间区里）
 */

import type { BlockNode, TurnEndReason } from "../../main/services/local-blocks";

/** 用户发言块（插话与轮次开场那次发言同形，只差 attrs.steer） */
export function isUserText(n: BlockNode): boolean {
    return n.tag === "text" && n.attrs.role === "user";
}

/** 过程块：think / tool（分段、实时区都只认这两种） */
export function isProc(n: BlockNode): boolean {
    return n.tag === "think" || n.tag === "tool";
}

/**
 * 文档序拉平：叶子块（step 是纯容器，DFS 顺序 = 时间顺序）。
 * 渲染只按此序 + 折叠策略决定可见性，**绝不按 kind 重排**（时序是协议的基本承诺）。
 * 兼底：任何带 children 的容器都向下递归，否则一旦数据里出现嵌套容器
 * （如旧日志中的嵌套 turn），整段子树会直接不渲染。
 */
export function leavesOf(turn: BlockNode): BlockNode[] {
    const out: BlockNode[] = [];
    const walk = (n: BlockNode) => {
        for (const c of n.children) {
            if (c.tag === "step" || c.children.length > 0) walk(c);
            else out.push(c);
        }
    };
    walk(turn);
    return out;
}

/**
 * **结论**：文档序**最后一个叶子**恰好是助理正文时才成立，否则 null。
 *
 * 为什么不是"最后一条正文"（2026-10-11 用户报的 bug）：一轮可能是
 * `正文(过程) → 工具(跑着被人中断)`，正文**不是**结论 —— 旧判据取"最后一条正文"，
 * 于是 1-2 级折叠起来看到的是那句过程话，**像结论一样**；3 级才对上它真正的位置。
 * 判据改成"它必须是这一轮的最后一个叶子"：模型说完就停 ⇒ 正文在末尾 ⇒ 是结论；
 * 末叶子是工具/思考/错误 ⇒ 这一轮**没有结论**（`sceneTailOf` 接手给我"现场"）。
 */
export function conclusionOf(turn: BlockNode): BlockNode | null {
    // 用户块（含轮中插话）不算"助理说过的话"：末尾压着一条插话时，结论仍是那句正文
    const ls = leavesOf(turn).filter((n) => !isUserText(n));
    const last = ls[ls.length - 1];
    return last && last.tag === "text" ? last : null;
}

/**
 * 轮首的**用户发言**（文档序开头连续的用户 text）—— IM 顺序下它们排在轮次头之前。
 *
 * 为什么单独拆出来（2026-10-11 现象"助理发言排在了用户前面"）：
 *   轮次头 = 助理的身份行（🤖 人物 · 模型 · 统计）。它渲染在轮首时，视觉上就是
 *   "助理先开口，用户后说话" —— 与 IM 里"用户先说、对方再接"的直觉相反。
 *   判据：用户发言在前导段里 ⇒ 渲染序为 [用户气泡] → [轮次头] → [内容]。
 *
 * 只取**开头连续**的用户块：轮次中间的插话（steer）必须留在原地（文档序即时间序），
 * 提前等于又一次重排（2026-10-04 那个坑）。
 */
export function leadUsers(turn: BlockNode): BlockNode[] {
    const out: BlockNode[] = [];
    for (const n of leavesOf(turn)) {
        if (!isUserText(n)) break;
        out.push(n);
    }
    return out;
}

/**
 * 1-2 级的内容区（结论 + 用户发言 + error）—— **严格文档序，不重排**。
 *
 * 历史教训（2026-10-04）：上一版是「全部用户发言 → 实时行 → 最后一条正文」三段拼接。
 * 而插话块在文档序上位于轮次**中间**（用户在第 38 步与第 39 步之间发的），
 * 折叠后它被拽到轮首 → 与它后面那条助理回复的相对顺序颠倒，看着像"助理先说、用户后说"。
 * 现在只做"藏中间过程"，不做"搬位置"：
 *   · 用户发言 —— 恒显（"我说过啥"的脉络本体；插话必须就地）；
 *     **但轮首那批由调用方先行渲染**（见 leadUsers），否则会与轮次头顺序打架
 *     —— 组件渲染时须把它们从本列表里剔掉，不剔就是同一句画两遍
 *   · error 块 —— 恒显（一轮报错后折叠起来与成功轮次长得一模一样 = 信息丢失）
 *   · 最后一条助理正文（结论）—— **恒显**：1 级压成 N 行摘要、2 级给全文。
 *   · 其余（更早的正文、全部过程）一律收起，3 级才见（见 contentItems）
 */
export function foldedItems(turn: BlockNode): BlockNode[] {
    const last = conclusionOf(turn);
    const out: BlockNode[] = [];
    for (const n of leavesOf(turn)) {
        if (isUserText(n) || n.tag === "error" || n === last) out.push(n);
    }
    return out;
}

// ─── 3 级起的中间区：正文逐条 + 连续过程折成一行 ──────────────

/** 3 级起「中间区」的一项（文档序） */
export type ContentItem =
    | { kind: "user"; key: string; node: BlockNode }
    | { kind: "error"; key: string; node: BlockNode }
    | { kind: "text"; key: string; node: BlockNode }
    | { kind: "proc"; key: string; parts: BlockNode[] };

/**
 * 3 级起的中间区（**严格文档序，不重排**）。
 *
 * 用户 2026-10-11 第四次口径（推翻上一版的"紧凑行"）：
 *   ① **助理正文一律各自成项、全文显示**（"3 级不折叠 text"）—— 上一版把"过程 +
 *      收束它的那条正文"压成一行，收起时显示的是**正文首行**、展开后那条正文却排在
 *      工具**后面**，与文档序（思考 → 正文）眼见的顺序相反（用户实测："思考->文本，
 *      但折叠时显示的是文本，展开文本却跑到后面"）。
 *   ② **连续的思考/工具折成一行 bar**：bar 左侧写这一段**第一个**过程的内容、
 *      右侧是思考数 / 工具数（`💭 n · ⚙ n`）；点它展开成逐条单行（= 第 4 级那一行）。
 *
 * 为什么这样切就绕开了顺序问题：正文与过程**各按文档序先后成项，没有任何"合并"**
 * —— 合并在哪，顺序就在哪出问题（上一版的教训）。bar 只含过程，它落在哪一行
 * 就是那些过程在时间线上的位置。
 *
 * 单独成项、不进 bar 的三种：
 *   · 用户发言（含插话）—— 脉络本体，且必须就地（提前 = 又一次重排）
 *   · error 块 —— 收进 bar 就看不见了（一轮报错后与成功轮次长得一样 = 信息丢失）
 *   · 助理正文（含结论）—— 这一轮"说了什么"的正文，全文可见，不压不并
 *
 * 轮首用户发言由调用方先画（见 leadUsers），此处排除，避免同一句画两遍。
 * `skip` 给调用方剔除**活动块那一个节点** —— 它要带定高展开体单独画，留在文档序里就是
 * 同一块画两遍（2026-10-04 review P1-1）。位置由 `liveSlotIndex` 补回（插回文档序原位）。
 */
export function contentItems(turn: BlockNode, skip?: (n: BlockNode) => boolean): ContentItem[] {
    const lead = new Set(leadUsers(turn));
    const out: ContentItem[] = [];
    let parts: BlockNode[] = []; // 连续的过程叶子（think/tool/plan…），文档序
    const flush = () => {
        // 空段不出：`skip` 剔掉实时区那一个节点后，一段可能整个空了
        if (parts.length) out.push({ kind: "proc", key: parts[0]!.id, parts });
        parts = [];
    };
    for (const n of leavesOf(turn)) {
        if (lead.has(n) || skip?.(n)) continue;
        if (isUserText(n)) {
            flush();
            out.push({ kind: "user", key: n.id, node: n });
        } else if (n.tag === "error") {
            flush();
            out.push({ kind: "error", key: n.id, node: n });
        } else if (n.tag === "text") {
            flush();
            out.push({ kind: "text", key: n.id, node: n });
        } else {
            // 过程块攒着 —— 连续的过程在界面上就是一行的 bar（见上）
            parts.push(n);
        }
    }
    flush();
    return out;
}

/**
 * 直播轮次的**活动块** = 文档序**最后一个非用户叶子**（think / tool / **text** / error …）；
 * 刚发出去、模型连第一个事件都还没产出 → null，那段时间交给"等待响应"的 loading。
 *
 * 判据沿革（两次都栽在"只认过程"上）：
 *   · 旧版只认 think/tool 且"后面有正文就让位"（规则③）—— 正文一开始流框就消失、
 *     同一块内容换容器，双重跳变（用户 2026-10-11 实测："遇到一个 text 消息时，
 *     动态输出的文本框会消失…视觉跳动"）。R17 删了规则③，但**仍只认过程**
 *     ⇒ 正文在框**下面**长；正文流完再遇到工具，活动块换成新工具（在正文**之后**）
 *     ⇒ 那段正文"消失、跳到框上面去"（用户 2026-10-11 第二条反馈）。
 *   · 现在（用户定稿）：动态框是**中间载体**，装**所有正在收取中的数据**（text/tool/think）
 *     —— 正文也在框里；它定稿后按级别**弹射到上方完成区**，框接着装下一条。
 *   于是"框下 → 框上"这条错位路径根本不存在：任何时刻框里都是"最新那条"。
 *
 * 位置由 `liveSlotIndex` 补回文档序原位（`contentItems` 已把它 skip 掉）。
 *
 * `stopped` 两态由渲染侧判定：未定稿 = 在跑（体里实时刷）；已定稿但还没被下一步替换掉
 * = **冻结**（标题栏转 `⋯ 等待下一步…`，内容留在框里）。用户口径："step 完成后不要立即消失 …
 * 直到下一步开始接收时替换掉当前最后一条，避免长时间空白期"。
 */
export function liveTailOf(turn: BlockNode, isLive: boolean): BlockNode | null {
    if (!isLive) return null;
    const ls = leavesOf(turn).filter((n) => !isUserText(n));
    return ls[ls.length - 1] ?? null;
}

/**
 * 轮次**异常结束**时"最后那个叶子"就是**现场**（1 级也要看得见的 item）。
 *
 * 用户 2026-10-11 口径：「我起码知道是模型说我正常结束了，还是模型说我有长度/金额限制
 * 所以要结束了，还有就是压根没收到 llm 的结束，只是不知道为啥结束了 —— 保留现场的理由很充分」。
 *
 * 判据：
 *   · 结束原因属**异常类**（`aborted` / `interrupted` / `error` / `max-steps`；`completed` 与
 *     `max-tokens` 不算 —— 后者仍以正文收尾，`notice` 已说清）；
 *   · 且**末叶子不是助理正文**（是正文时那本就是结论，`conclusionOf` 已经把它当结论显示，
 *     再出一份现场就是同一句画两遍）。
 * 旧日志没有 `endReason`（`turn.attrs.interrupted` 兜底）。
 */
export function sceneTailOf(turn: BlockNode): BlockNode | null {
    const t = endReasonOf(turn);
    const abnormal = t
        ? t.type === "aborted" || t.type === "interrupted" || t.type === "error" || t.type === "max-steps"
        : Boolean(turn.attrs.interrupted);
    if (!abnormal) return null;
    const ls = leavesOf(turn).filter((n) => !isUserText(n));
    const last = ls[ls.length - 1];
    if (!last || last.tag === "text") return null;
    return last;
}

/** 现场/活动框的构成：末叶子是 error 时，错误当**红条压在框顶**、主体取它前面那一个非 error 叶子 */
export interface TailScene {
    /** 主体（当时正在跑的东西）；可能为 null（错误之前没有内容） */
    body: BlockNode | null;
    /** 错误条（末叶子是 error 块时） */
    error: BlockNode | null;
}

export function composeTail(turn: BlockNode, tail: BlockNode | null): TailScene | null {
    if (!tail) return null;
    if (tail.tag !== "error") return { body: tail, error: null };
    const ls = leavesOf(turn).filter((n) => !isUserText(n));
    const i = ls.findIndex((n) => n.id === tail.id);
    const prev = i > 0 ? ls[i - 1]! : null;
    return { body: prev && prev.tag !== "error" ? prev : null, error: tail };
}

/** 结束原因（读该轮事实；脏值当没有） */
export function endReasonOf(turn: BlockNode): TurnEndReason | null {
    const r = turn.attrs.endReason as TurnEndReason | undefined;
    if (!r || typeof r !== "object") return null;
    return typeof (r as { type?: unknown }).type === "string" ? r : null;
}

/**
 * 轮次末尾的**结束状态说明**（所有级别恒显 —— 它属于"1 级不变量"）。
 *
 * 为什么要有：用户 2026-10-11 —— "我不知道到底是真的模型说结束了，还是有 bug 漏消息了"。
 * `endReason`（##288 拍板①）是判据；这里只把它翻成人话。
 * `notice` 仍是更细的那句（含限制值），有它优先。
 */
export function turnEndNote(turn: BlockNode): string | null {
    const notice = typeof turn.attrs.notice === "string" && turn.attrs.notice ? turn.attrs.notice : null;
    const r = endReasonOf(turn);
    if (!r) return turn.attrs.interrupted ? "本轮未完成（流中断/崩溃恢复）" : notice;
    switch (r.type) {
        case "completed":
            return notice;
        case "max-steps":
            return notice ?? `达到步数上限 ${r.data.limit}，本轮被强制收尾（模型仍在请求工具）`;
        case "max-tokens":
            return notice ?? "输出达到上限被截断";
        case "aborted":
            return r.data.source === "detached" ? "本轮被中断（消费端断开，未跑完）" : "本轮被中断（未跑完）";
        case "error":
            return notice; // 细节由 error 块 / 现场说，同一句不写两遍
        case "interrupted":
            return "本轮未完成（流中断/崩溃恢复）";
    }
}

/**
 * 轮尾**状态行**的状态图标（末行恒显 —— 它是"这轮到底怎么结束的"的唯一常显位）。
 *
 * 用户 2026-10-11 口径："我起码知道是模型说我正常结束了，还是模型说有长度/金额限制所以要结束了，
 * 还是压根没收到 llm 结束"。`endReason`（##288 拍板）是判据，这里只把它翻成一个字形 + 一句 tip。
 * **字形承载状态、文字只进 tooltip**（用户 2026-10-12：状态行上不写"正常结束"这类字）。
 *
 * tone 三档给样式用（不是给判据用）：`ok` 绿 · `cut` 黄（被限制/被中断，非报错）· `err` 红 ·
 * `live` 灰（进行中）。无 `endReason` 的旧日志 → 不给图标（`icon: ""`，不编状态）。
 */
export interface EndMark {
    icon: string;
    tip: string;
    tone: "live" | "ok" | "cut" | "err" | "none";
}

export function endMarkOf(end: TurnEndReason | null, live: boolean): EndMark {
    if (live) return { icon: "◌", tip: "本轮进行中", tone: "live" };
    if (!end) return { icon: "", tip: "", tone: "none" };
    switch (end.type) {
        case "completed":
            return { icon: "✓", tip: "正常结束（completed）", tone: "ok" };
        case "max-steps":
            return { icon: "⛔", tip: `步数上限收尾（上限 ${end.data.limit}）`, tone: "cut" };
        case "max-tokens":
            return { icon: "⛔", tip: "输出长度上限", tone: "cut" };
        case "aborted":
            return {
                icon: "⛔",
                tip: end.data.source === "detached" ? "被中断（消费端断开，未跑完）" : "被中断（未跑完）",
                tone: "cut",
            };
        case "interrupted":
            return { icon: "⛔", tip: "未完成（流中断/崩溃恢复）", tone: "cut" };
        case "error":
            return { icon: "✗", tip: "错误终止", tone: "err" };
    }
}

/**
 * 活动块**该插在中间区的第几项之前**（`contentItems` 已把它 skip 掉，位置得补回来）。
 *
 * 为什么必须补：活动块是"最后一个过程叶子"，但它后面**可能还有东西** —— 最常见的就是
 * 收尾那条正文（think → tool → 正文 是标准时序）。挂在列表末尾就会排到那条正文**后面**，
 * 与文档序相反（顺序一错用户一眼看得出来，2026-10-04 那个坑）。
 * 判据 = 文档序位置：数一数前面有几项，其**首个叶子**排在活动块之前。
 * 取不到（节点已被移除）→ 排在末尾，宁可偏后也不要抛错。
 */
export function liveSlotIndex(turn: BlockNode, items: readonly { key: string }[], node: BlockNode): number {
    const order = new Map<string, number>();
    leavesOf(turn).forEach((n, i) => order.set(n.id, i));
    const at = order.get(node.id) ?? Number.POSITIVE_INFINITY;
    let i = 0;
    while (i < items.length && (order.get(items[i]!.key) ?? Number.POSITIVE_INFINITY) < at) i++;
    return i;
}

/**
 * 这一行**点开会不会多出东西** —— 决定行首给「展开箭头」还是「末级点」。
 *
 * 用户 2026-10-11 口径：思考行收起时先给**首行**预览（与工具行的 `tool · 命令首行` 对称），
 * 点开才看全文；若思考**只有一行**，展开体与那行标题是同一句 —— 那就不该有展开能力
 * （点开毫无变化，像坏了）。行首**不能空着**：左列箭头是层级刻度，缺一格整行文字会左移、与上下行错位，
 * 故给一个极轻的点（`IconDot`，不是箭头 —— 箭头承诺「里面还有东西」）。
 *
 * 工具行**恒可展开**：它有 result（或命令被裁）要看 —— 展开永远比标题多东西。
 * 阈值与标题的首行截断一致（`LocalChatPage.firstLine` 切到 90 字）：被裁的单行思考也必须能点开看全。
 */
const THINK_LINE_MAX = 90;

export function expandableOf(n: BlockNode): boolean {
    if (n.tag !== "think") return true;
    const c = typeof n.attrs.content === "string" ? n.attrs.content : "";
    return c.includes("\n") || c.trim().length > THINK_LINE_MAX;
}

// ─── 一轮的行（级别同构的唯一切口） ──────────────────────

/**
 * 一轮正文区的**一行**。级别只决定"**已完成的**行显示多少"，尾行（活动块 / 错误现场）
 * **任何级别都在**、形状一致 —— 这就是"级别同构"。
 *
 * 为什么统一成一个行类型（用户 2026-10-11 口径：「级别显示应该是同构的，尽量不要特殊处理，
 * 如果有特殊情况…有可能是我们把层次或位置搞错了…尽量同构代码也简单」）：
 *   旧版按级别分了两条渲染路径（1-2 级 fallback / 3-4 级中间区），于是每加一条规格
 *   （活动块、现场、结论、错误…）都得在两处各写一遍，还各自漏过东西（现场只在一处出、
 *   活动块只在一处画）—— 特例不是需求带来的，是"两套结构"带来的。
 *   现在：**一条行序列**，`turnRows` 一处产出，`<For>` 一处渲染，级别只影响序列内容。
 *
 * `key` 是行的稳定标识（`<For>` 按引用 diff 的依据，见组件 reuseRows）：
 *   · 尾行**只带 id**（节点每帧换引用 —— 带节点就是每帧重建 DOM = 点击全丢）
 *   · 其余行带节点；节点在块树里未变则同引用（`toTree` 缓存），故可据以复用
 */
export type TurnRow =
    | { kind: "user"; key: string; node: BlockNode }
    | { kind: "error"; key: string; node: BlockNode }
    /** 助理正文；`clamp` = 压成 N 行摘要（1 级的结论那一行） */
    | { kind: "text"; key: string; node: BlockNode; clamp: boolean }
    /** 连续过程折成一行 bar（3 级起；切法见 contentItems） */
    | { kind: "proc"; key: string; parts: BlockNode[] }
    /** 尾行：直播**活动块**（live）或异常结束的**现场** —— 任何级别都在，节点按 id 现取 */
    | { kind: "tail"; key: string };

/**
 * 尾行的节点：直播中 = 活动块（`live`，见 liveTailOf）；否则 = 异常结束的现场（`sceneTailOf`）。
 * 判据只此一处 —— 组件与 `turnRows` 都从这里取，免得两处各判一次而分叉。
 */
export function tailNodeOf(turn: BlockNode, live: BlockNode | null): BlockNode | null {
    return live ?? sceneTailOf(turn);
}

/**
 * 一轮的正文行（**级别同构的唯一切口**）—— 纯函数，可单测。
 *
 * 级别只改"已完成的"部分：
 *   1-2 级 —— 用户发言（**轮首那批由调用方先画**，见 leadUsers）+ error + **结论**（1 级压 N 行 / 2 级全文）
 *   3-4 级 —— 用户发言 + error + **助理正文逐条**（全文）+ 连续过程折成一行 bar
 * 尾行（活动块 / 现场）**与上面这些无关**：它表示"正在发生 / 断在哪"，任何级别都出，
 * 且位置由**文档序**决定（`liveSlotIndex`）—— 插回它该在的那一行之前，不重排。
 *
 * `live` = 本轮的活动块节点（非直播轮 / 还没出内容 → null）。节点只在函数内用来定位与排除
 * （它必须**只画一次**），行里**只存 id**。
 */
export function turnRows(turn: BlockNode, level: TurnLevel, live: BlockNode | null): TurnRow[] {
    const plan = planOfLevel(level);
    const tail = tailNodeOf(turn, live);
    const lead = new Set(leadUsers(turn));
    /** 尾行的节点不再进文档序行（同一块画两遍就是重复 —— review P1-1） */
    const owned = new Set<string>(tail ? [tail.id] : []);
    const rows: TurnRow[] = [];
    if (plan.mid) {
        for (const it of contentItems(turn, (n) => owned.has(n.id))) {
            if (it.kind === "proc") rows.push({ kind: "proc", key: it.key, parts: it.parts });
            else if (it.kind === "text") rows.push({ kind: "text", key: it.key, node: it.node, clamp: false });
            else rows.push({ kind: it.kind, key: it.key, node: it.node });
        }
    } else {
        for (const n of foldedItems(turn)) {
            // 轮首那批用户发言由调用方先画（IM 顺序，见 leadUsers）—— 这里再画一遍就是同一句两遍
            if (lead.has(n) || owned.has(n.id)) continue;
            if (isUserText(n)) rows.push({ kind: "user", key: n.id, node: n });
            else if (n.tag === "error") rows.push({ kind: "error", key: n.id, node: n });
            else rows.push({ kind: "text", key: n.id, node: n, clamp: plan.conclusionClamped });
        }
    }
    if (tail) rows.splice(liveSlotIndex(turn, rows, tail), 0, { kind: "tail", key: tail.id });
    return rows;
}

// ─── 展开级别 ────────────────────────────────────────

/**
 * 轮次展开级别（像 JSON 树那样一层比一层细）。
 *
 * 2026-10-11 用户口径（第四次修正）：
 *   1 摘要结论 —— 轮次头 + 末条助理正文，**压成 N 行摘要**（底部渐隐 + "还有 N 行"提示行）
 *   2 完整结论 —— 轮次头 + 末条正文**全文**（其余仍不显示）
 *   3 全部正文 —— + 中间区：**助理正文逐条全文**，连续的过程折成一行 bar（见 contentItems）
 *   4 逐条过程 —— 过程 bar 铺开成"每事件一行"（正文同 3 级）
 *
 * **级别循环只归顶部那一个按钮**（`cycleTurnLevel`，对所有轮次一起换层）；
 * 单轮不做循环 —— 点轮次头就是"把我这条展开 / 收拢"两态（见 `levelOfTurn`）。
 * 4 级那个"铺开"也能被用户**单点某一行**单独触发（组件的 pin），不必先整体换层：
 * 展开这一行的结果与 4 级那一行长得一样（用户 2026-10-11 口径："展开就还是第 4 层"）。
 *
 * **活动块（直播中那条）不受级别限制**：1 级看不清中间区，但它仍以**定高活动框**出现 ——
 * 只剩一行状态的话首行很快定住、看不出还在跑（用户 2026-10-11 口径）。
 *
 * **第 5 层 = 单条工具/思考的正文（内容），不在级别里**（`TURN_DETAIL_LAYER`）：
 * 一轮几十个事件、每个几百行，整体展开就"一屏放不下两轮"。那份内容只由用户
 * **点开某一行**自己决定（组件的 pin），级别按钮碰不到它。
 */
export type TurnLevel = 1 | 2 | 3 | 4;

export const TURN_LEVEL_MIN = 1;
export const TURN_LEVEL_MAX = 4;

/** 第 5 层：单条工具/思考的**内容**。刻意不在级别循环里（太庞大），只由用户点那行自己开 */
export const TURN_DETAIL_LAYER = 5;

/** 默认级别：3（全部正文）—— 打开会话就能读到正文、也看得见过程轮廓 */
export const DEFAULT_TURN_LEVEL: TurnLevel = 3;

export function isTurnLevel(v: unknown): v is TurnLevel {
    return v === 1 || v === 2 || v === 3 || v === 4;
}

/** 循环：1→2→3→4→1（**只给顶部全局按钮用**） */
export function cycleTurnLevel(level: TurnLevel): TurnLevel {
    return (level >= TURN_LEVEL_MAX ? TURN_LEVEL_MIN : level + 1) as TurnLevel;
}

/**
 * 单轮的级别：**只有两态**（收拢 = 1，展开 = 跟全局）。
 *
 * 用户 2026-10-11 口径：级别循环只归顶部那个按钮，**单条信息不做循环** ——
 * 点轮次头就是"把我这条展开 / 收拢"。
 *
 * `mark` 是三态，缺一不可：
 *   · `true`  —— 用户收拢了这一轮（恒 1）
 *   · `false` —— 用户展开了这一轮（跟全局；全局为 1 时给到 2 —— 那一级本来就什么都没展开，
 *     点了必须看得见变化，否则点一下毫无反应，像坏了）
 *   · `undefined` —— 没动过：**完全跟全局**。缺了它，全局按成 1（整体全收缩）时
 *     每一轮都会"因为'展开'而后退到 2"，等于按钮失灵。
 */
export function levelOfTurn(mark: boolean | undefined, global: TurnLevel): TurnLevel {
    if (mark === true) return TURN_LEVEL_MIN;
    if (mark === false) return global > TURN_LEVEL_MIN ? global : 2;
    return global;
}

/** 级别名（给 aria / tip 用；界面上不写死文案，改级别只改这里） */
export function turnLevelLabel(level: TurnLevel): string {
    if (level === 1) return "摘要结论";
    if (level === 2) return "完整结论";
    if (level === 3) return "全部正文";
    return "逐条过程";
}

/** 顶部**全局**按钮的说明（它才负责换层） */
export function turnLevelTip(level: TurnLevel): string {
    return `所有轮次展开级别 ${level}/${TURN_LEVEL_MAX}（${turnLevelLabel(level)}）· 点击整体换一层（第 ${TURN_DETAIL_LAYER} 层「单条工具/思考的内容」点那一行自己开，不在循环里）`;
}

/** 轮次头（单轮收拢 / 展开）的说明 —— 单条不换层，别让 tip 也写成"下一级" */
export function turnFoldTip(open: boolean): string {
    return open ? "点击收拢这一轮（只留结论摘要）" : "点击展开这一轮（按顶部那个级别显示）";
}

/** 每一级"看得见什么"（组件据此渲染，判断只此一处） */
export interface LevelPlan {
    /** 结论（末条助理正文）**压成 N 行摘要** —— 1 级压、2 级起全文 */
    conclusionClamped: boolean;
    /** 中间区可见（正文逐条 + 过程 bar）—— 3 级起 */
    mid: boolean;
    /** 过程 bar 铺开成逐条 —— 4 级（用户单点某一行也能只展开它自己） */
    midExpanded: boolean;
}

export function planOfLevel(level: TurnLevel): LevelPlan {
    return {
        conclusionClamped: level <= TURN_LEVEL_MIN,
        mid: level >= 3,
        midExpanded: level >= 4,
    };
}

/**
 * 按可视行数截断正文（**1 级「摘要结论」**的摘要态；Markdown 不解析时也走这里）。
 *
 * 只截**行**不截字符：正文里代码块/列表被字符数切开比少几行更难看懂。
 * 返回 omitted（被藏起来的行数）而不是布尔 —— 界面要说出"还有几行"，
 * 光一个 `…` 信息量太低（2026-10-11 用户反馈：看不出被裁过）。
 */
export function clampLines(text: string, n: number): { text: string; omitted: number } {
    const lines = text.split("\n");
    if (lines.length <= n) return { text, omitted: 0 };
    return { text: lines.slice(0, n).join("\n"), omitted: lines.length - n };
}
