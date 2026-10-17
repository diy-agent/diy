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
// 结束原因 → 人话 / 图标 的**唯一文案源**（main 与 renderer 共用，##308）：这里只做
// 「块树 → endReason/notice」的取数，措辞一律不在此处另写一份（否则又分叉）。
import { endMarkOf, turnEndText, type EndMark } from "../../shared/turn-end";
export { endMarkOf, type EndMark };


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
    // 说明句本身（含 aborted 按 source 的分句）在 shared/turn-end —— main 的中止 error 块同源同句。
    return turnEndText(r, notice);
}

/**
 * **机器回执轮**：`enqueueWhileRunning` 为"这条消息已排队"的回执落的**顶层 turn 块**（##306）。
 *
 * 它长着 turn 的形状，内容却只是一条提示条（`meta.source === "queue"`，id 形如 `qt-steer/N`）：
 * 不是人发起的一轮，也不会产出任何助理内容。判据与渲染那张提示条**同一处**
 * （`LocalChatPage` 的 error 块分支读的就是 `attrs.source === "queue"`）—— 两处必须同源。
 *
 * ⚠️ 它**只能**靠这个标记认出来。曾经没有任何地方认得它，于是它被当成"正常一轮"参与
 * 「最后一轮是谁」的判定（见 `liveTurnOf`）—— 用户 2026-10-17 实测：正在跑的轮次被
 * 打上「⚠ 本轮未完成（流中断/崩溃恢复）」的假警报（回执轮排在它后面、且**已 stop**，
 * 于是"最后一轮"= 回执轮、`liveTurnId` 判 null ⇒ 真正在跑的那轮不再算"直播中"）。
 */
export function isReceiptTurn(n: BlockNode): boolean {
    return n.tag === "turn" && attrStr(n.attrs.source) === "queue";
}

/**
 * **直播中的那一轮** = 最后一个未收尾的**真实**轮次（机器回执轮不算数）。
 *
 * 判据要两道，缺一不可：
 *   ① 必须是**最后一个** turn（直播轮只会是队尾那个）；
 *   ② 它自己**没收 stop** —— 外部（CLI / 另一窗口）刚起一轮、而我们还没收到它的 ops 时，
 *      队尾是早已收尾的历史轮，拿它顶替会把一段正常历史渲染成"进行中"（2026-10-11 实测）。
 *   ⚠️ 回执轮必须**先剔除**：它排在直播轮之后且立刻 stop（见 `isReceiptTurn`），
 *      留着它 ① 会把直播轮顶掉（假警报"本轮未完成"）、② 会拿到一个 null。
 *
 * `live`（main 真值：该任务此刻是否有轮次在跑）由调用方传入 —— 本层不读 store（同 `isInterruptedToolBlock`）。
 */
export function liveTurnOf(nodes: BlockNode[]): BlockNode | null {
    const turns = nodes.filter((n) => n.tag === "turn" && !isReceiptTurn(n));
    const last = turns[turns.length - 1];
    return last && !last.stopped ? last : null;
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
    // 判据必须与标题同一套：先去掉前导/尾随空行再数行。
    // 反例（review ##253 RV-2）：content = "\n只有一行" —— 原始串含 "\n" 被判可展开，
    // 而标题 `firstLine` 跳过空行后就是"只有一行"，点开看到的和标题一模一样（"像坏了"）。
    const t = c.trim();
    return t.includes("\n") || t.length > THINK_LINE_MAX;
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
    /** 助理正文（过程里说的那些话）—— **结论不在此列**：它属结尾槽，见 `tailOf` */
    | { kind: "text"; key: string; node: BlockNode }
    /** 连续过程折成一行 bar（切法见 contentItems） */
    | { kind: "proc"; key: string; parts: BlockNode[] };

/**
 * **结尾槽**：这一轮的**落点** —— 自暴露、恒显、与状态行同级，**不受历史折叠影响**
 * （用户 2026-10-12 R22 口径：对话 = 执行过程历史 + 执行过程 + 结尾 + 状态；v3 之错 =
 * 把错误"转移"进结尾可展开框，没留在现场）。
 *
 * 四形态，判据自上而下（先到先得）：
 *   · `live`       执行过程 —— 正在跑的那一轮（**半结尾**）：本轮一有动态内容就出现，
 *                  正常结束就把结尾推出去、自己消失；终止性错误**就地转红**留在这里，不搬家。
 *   · `scene`      现场 —— 异常结束（`error` / `max-steps` / `aborted` / `interrupted`）
 *                  且末件不是正文：停在那一刻的东西（见 `sceneTailOf` / `composeTail`）。
 *   · `conclusion` 结论 —— 末件恰是助理正文（见 `conclusionOf`）。
 *   · `endleaf`    结束点 —— 正常结束（completed / max-tokens）但末件不是正文（通常是工具）：
 *                  **保持工具形态** + 「本轮结束点」tag，不复用结论样式（用户 2026-10-12 R25 拍板）。
 * 都不是 → null（异常结束而末件是正文 = 结论已覆盖，不另开现场）。
 *
 * `ceilToLastLeaf` 之外的另一条硬约束：`endleaf` 的末件**不能是 error 块** —— 那是现场该管的事。
 */
export type TailKind = "conclusion" | "endleaf" | "scene" | "live";
export interface TurnTail {
    kind: TailKind;
    node: BlockNode;
}

export function tailOf(turn: BlockNode, live: BlockNode | null): TurnTail | null {
    if (live) return { kind: "live", node: live };
    const scene = sceneTailOf(turn);
    if (scene) return { kind: "scene", node: scene };
    const conc = conclusionOf(turn);
    if (conc) return { kind: "conclusion", node: conc };
    const t = endReasonOf(turn);
    const abnormal = t
        ? t.type === "error" || t.type === "max-steps" || t.type === "aborted" || t.type === "interrupted"
        : Boolean(turn.attrs.interrupted);
    if (abnormal) return null; // 异常结束但末件是正文：结论已覆盖，不再出结束点
    const ls = leavesOf(turn).filter((n) => !isUserText(n));
    const last = ls[ls.length - 1];
    if (!last || last.tag === "error") return null;
    return { kind: "endleaf", node: last };
}

/**
 * `endleaf`（结束点）那句 tag 的 tooltip —— **必须跟着 `endReason` 走**。
 *
 * 为什么单独成一个纯函数：`EndLeafBox` 原来把它写死成「正常结束，但模型未给文字结论」，
 * 而 `tailOf` 在没有 `endReason` 的**旧日志**上同样会给 `endleaf`（判据只看"末件不是正文、
 * 又没异常"）⇒ 同一件事，状态行说"不知道"（`endMarkOf` 对无 endReason 刻意不给图标），
 * 尾槽却断言"正常结束"（review ##253 RV-3）。旧日志里"末件是工具"完全可能是崩溃/中断留下的，
 * 不能替它编一个结束原因。搁在纯函数里才能被单测钉住（组件文案测不到）。
 *
 * **不说"末件是工具"**（review ##253 小项4）：`endleaf` 的末件不一定落在工具上 ——
 * `max-tokens` 撞在长思考里时末件就是思考（甚至 plan）。而且**那一件东西就画在 tip 旁边**
 * （`EndLeafBox` 的 `ProcBody`），tooltip 再断言一次它是什么，只会在猜错时撒谎。
 */
export function endLeafTip(turn: BlockNode): string {
    // **notice 优先**（三个分支统一）：它是 main 写下的更细的那句，有就压过一切模板文案
    // （review ##253 小项4：原来只有 `completed` 分支读它，`max-tokens` 分支把它丢了）。
    const notice = typeof turn.attrs.notice === "string" && turn.attrs.notice ? turn.attrs.notice : null;
    const r = endReasonOf(turn);
    // **无 endReason 的旧日志也要先问 notice**（review3 RV-7）：`notice` 早在 `endReason` 之前一个月
    // 就有了（maxSteps/maxTokens 的收尾文案）⇒ 那一批"上限收尾"轮**带 notice、无 endReason**，
    // 原来 `!r` 抢在前面 ⇒ 状态行说"达到上限"、其上的 tooltip 却说"结束原因未知"（同一件事两套说法）。
    // 与 `turnEndNote` **同源同分支**（`interrupted ? … : notice`），只是最后兜底多一句解释。
    if (!r) return turnEndNote(turn) ?? "结束原因未知（本版之前的记录没有 endReason）";
    if (notice) return notice;
    switch (r.type) {
        case "completed":
            return "正常结束，但模型未给文字结论";
        case "max-tokens":
            return "输出达到上限被截断";
        default:
            // tailOf 只在这一步之外（非异常）才会给 endleaf；真走到这儿就照实说
            return turnEndNote(turn) ?? "本轮结束点";
    }
}

/**
 * 一轮的**过程历史行**（"级别同构"的唯一切口）—— 纯函数，可单测。
 *
 * 只产历史（用户发言 / error / 助理正文 / 过程 bar），**不含结尾槽**：
 * 结论 / 结束点 / 现场 / 执行过程由 `tailOf` 单独给，渲染在历史容器**之外**（自暴露、恒显）。
 * 历史**开不开**由调用方按 `historyOpenOf` 决定（不展开时整段不渲染），故本函数与级别无关 ——
 * 级别只影响两处：结尾槽结论是否压摘要（`planOfLevel.conclusionClamped`）、
 * 过程 bar 是否铺开（`midExpanded`）。
 *
 * `live` = 本轮的活动块节点（非直播轮 / 还没出内容 → null）：只用来把"结尾槽那一个叶子"
 * 从历史里剔掉（**四种结尾形态一视同仁** —— 结论也是结尾，也不该在历史里再出现一遍）。
 * 轮首那批用户发言由调用方先画（见 leadUsers），此处排除。
 */
export function turnRows(turn: BlockNode, live: BlockNode | null): TurnRow[] {
    const tail = tailOf(turn, live)?.node ?? null;
    const owned = new Set<string>(tail ? [tail.id] : []);
    // **现场的主体也要排进 owned**：末叶子是 error 时尾槽画的是「红条 + 它前面那个叶子」，
    // 那个 body 不排掉就会在过程历史里再画一遍（同一块上下各一份，默认 3 级下不用点就能看见）。
    // 这条 R20 修过、R21「级别同构」重构把 owned 收成 `{tail.id}` 时又丢了（review ##253 RV-1）。
    // 排除判据只此一处 —— 组件里不许再补 skip 集合（级别同构的口径）。
    const sceneBody = composeTail(turn, tail)?.body;
    if (sceneBody) owned.add(sceneBody.id);
    const rows: TurnRow[] = [];
    for (const it of contentItems(turn, (n) => owned.has(n.id))) {
        if (it.kind === "proc") rows.push({ kind: "proc", key: it.key, parts: it.parts });
        else rows.push({ kind: it.kind, key: it.key, node: it.node });
    }
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
 * 单轮不做循环 —— 点轮次头就是"把我这条展开 / 收拢"两态（见 `historyOpenOf`）。
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
 * **过程历史这一轮开不开**（三态，缺一不可）。
 *
 * 用户 2026-10-12 R22 口径：**级别只改"历史展开多少"，历史开不开归人物栏那枚 chevron** ——
 *   · `true`  —— 用户收拢了这一轮 ⇒ 恒闭；
 *   · `false` —— 用户展开了这一轮 ⇒ 恒开（**1 级下点人物栏也能直接开历史**，不必先切到 3 级）；
 *   · `undefined` —— 没动过：默认跟全局（3 级起开，1-2 级闭）。
 * 缺了 `undefined` 这档，全局按成 1（整体全缩）时每轮都会"因为'展开'而又开回来"，等于按钮失灵。
 */
export function historyOpenOf(mark: boolean | undefined, global: TurnLevel): boolean {
    if (mark === true) return false;
    if (mark === false) return true;
    return global >= TURN_LEVEL_MAX - 1;
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

/** 每一级"看得见什么"（组件据此渲染，判断只此一处）—— **只管两处**：结论摘要、过程 bar 铺开 */
export interface LevelPlan {
    /** 结尾槽的结论**压成 N 行摘要** —— 1 级压、2 级起全文 */
    conclusionClamped: boolean;
    /** 过程 bar 铺开成逐条 —— 4 级（用户单点某一行也能只展开它自己） */
    midExpanded: boolean;
    /** 历史**缺省**开 —— 3 级起（`historyOpenOf` 的 `undefined` 档；同一判据，这里冗余一份给读者） */
    historyOpen: boolean;
}

export function planOfLevel(level: TurnLevel): LevelPlan {
    return {
        conclusionClamped: level <= TURN_LEVEL_MIN,
        midExpanded: level >= TURN_LEVEL_MAX,
        historyOpen: historyOpenOf(undefined, level),
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
    // **前导空行不算额度**：Markdown 里首个块之前的空行没有语义（渲染时本来就被吃掉），
    // 却会占满摘要的全部行数 —— `clampLines("\n\n正文", 2)` 会把两行额度全用在空行上，
    // 摘要里一个字都看不见（review ##253 RV-2 的同一类"判据两处口径"）。
    let start = 0;
    while (start < lines.length && lines[start]!.trim() === "") start++;
    const kept = lines.slice(start);
    if (kept.length <= n) return { text: kept.join("\n"), omitted: 0 };
    return { text: kept.slice(0, n).join("\n"), omitted: kept.length - n };
}

// ─── 过程行的**状态**（图标 / 默认开合）──────────────────────
//
// 判据**只在这里**：组件 `statusMark` / `procOpen` 只把结果画成字形与 class。
//
// 为什么必须抽出来（##329 review1 R1）：`status==="error"` → ✗、失败块恒展开，
// 是**用户唯一能看出"这一步失败了"的地方**；判据若留在组件私有函数里，单测够不着 ⇒
// 有人改 status 语义时测试全绿、界面照旧 —— 那正是 ##329 的原始形态（数据对了、界面没变）。
//
// ⚠️ 判据要的是 main 真值 `live`（含别人发起的轮次），**作为参数传进来**，不在本层读 store：
//    本地 running 只代表"我这轮在等自己的流"，拿它当整体运行态会把 CLI 正在跑的一轮
//    判成"中断的历史"（任务 194 现象一）；反过来把"未收 stop"当直播中，真崩溃的历史就不再可见。

const attrStr = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** tool 块是否**失败**（`status==="error"`，##329 起由 main 侧抛错路径保证）
 *  —— 判据唯一出处：状态灯 ✗ / 恒展开 / 过程 bar 的 ✗ 三处共用 */
export function isFailedTool(n: BlockNode): boolean {
    return n.tag === "tool" && attrStr(n.attrs.status) === "error";
}

/**
 * 中断的 tool 块：
 *   ① 显式终态 status=interrupted（main 已收敛并写进 ops）→ 直接读，不靠推断
 *   ② 兼容旧会话：未收 stop 且该任务**此刻确实没有轮次在跑**（历史日志里还没收敛）
 */
export function isInterruptedToolBlock(n: BlockNode, live: boolean): boolean {
    if (n.tag !== "tool") return false;
    const s = attrStr(n.attrs.status);
    if (s === "interrupted") return true;
    if (n.stopped) return false;
    if (s === "done" || s === "error") return false;
    return !live;
}

/** 状态灯的样式档（组件映到 class；**判据不认 class**） */
export type ProcTone = "error" | "ok" | "warn" | "wait" | "muted" | "none";

/** 过程行行首那枚状态灯 */
export interface ProcStatus {
    /** 字形；`""` = 这一行不画状态灯（用户发言） */
    icon: string;
    tone: ProcTone;
    /** 在跑（闪动） */
    pulse?: boolean;
    tip?: string;
}

/**
 * 行首状态灯 = 💭 / ⚙ 类字形的**状态位**（● 在跑 / ✓ 完成 / ✗ 失败 / ⊘ 中断）。
 * 少了它，一行 `思考` 与一行 `Bash · 命令` 在长列表里只能靠读文字分辨（2026-10-11 用户口径）。
 */
export function procStatusOf(n: BlockNode, live: boolean): ProcStatus {
    if (n.tag === "error") return { icon: "❌", tone: "error" };
    if (n.tag === "text") {
        if (isUserText(n)) return { icon: "", tone: "none" };
        return n.stopped ? { icon: "✍", tone: "muted" } : { icon: "●", tone: "wait", pulse: true };
    }
    if (n.tag === "think") {
        return n.stopped ? { icon: "💭", tone: "none" } : { icon: "●", tone: "wait", pulse: true };
    }
    if (attrStr(n.attrs.status) === "done") return { icon: "✓", tone: "ok" };
    if (isFailedTool(n)) return { icon: "✗", tone: "error" };
    // 中断遗留（无 stop、无结果）：不能跟"正在执行"共用同一个点，否则用户看不出历史断在哪
    if (isInterruptedToolBlock(n, live)) {
        return {
            icon: "⊘",
            tone: "warn",
            tip: "上一轮中断，没有结果（此行已被收敛为终态，正文与发往模型的同源）",
        };
    }
    if (!n.stopped) return { icon: "●", tone: "wait", pulse: true };
    return { icon: "○", tone: "muted" };
}

/**
 * 过程行**默认开不开**（2026-10-04 重写）：**pin 是用户的显式覆盖，默认值只给这几档**。
 *
 * 正文与过程分两套默认：
 *   · 正文：pin → L2/L3 默认展开、L1 折成一行（**直播中同样折叠** —— L1 的语义就是
 *     "只看最后一行"，收起态仍显示正在写的那一行 + 光标，进度照样可见）；
 *   · 过程：error 块 / **失败的工具行** / 中断遗留 tool 恒开（看"断在哪"）→ pin → 一律默认收起
 *     （原 L4「全开」档已取消 —— 档位不再负责"帮用户全开"）。
 */
export function procOpenOf(n: BlockNode, pin: Record<string, boolean>, live: boolean): boolean {
    if (n.tag === "error") return true;
    if (isFailedTool(n)) return true;
    if (isInterruptedToolBlock(n, live)) return true;
    if (n.id in pin) return pin[n.id]!;
    return false;
}
