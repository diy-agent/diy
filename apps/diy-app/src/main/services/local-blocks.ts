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

import type { Triage } from "../../shared/error-triage";
import { cutMarker } from "@diy-agent/context/format/cut-marker";

export type JSONVal = string | number | boolean | null | JSONVal[] | { [k: string]: JSONVal };

export type BlockKind = "turn" | "step" | "text" | "think" | "tool" | "plan" | "error";

/**
 * 轮次**结束原因**（判别联合）—— 遵 `rule.discriminated-union`：判别键 `type` 与公共字段同级，
 * 每个分支**私有**的数据一律进 `data`。落 `turn` 块的 `endReason` 字段（整体 patch）。
 *
 * 为什么必须有它（##288）：原先轮次"结束"的唯一信号是 `closeTurn` **无条件**发的 `stop` ——
 * 「模型自然说完」/「打满步数被掐」/「用户中断」/「流断裂」在 UI 上是同一个形状，
 * 用户看日志时无从判断"到底是谁结束的、为什么"。
 * 值域照 dsh 的 `TurnEndReasonMap`，砍掉 diy 没有对照组的 `blocked` / `forked`。
 */
export type TurnEndReason =
    | { type: "completed"; data: {} } // 模型自然说完（末步无待续工具）
    | { type: "max-steps"; data: { steps: number; limit: number } } // 打满 maxSteps，模型仍在请求工具
    // `layer`：这个上限**是哪一层定的**（##429 拍板：日志必须能回答「为什么这次是 2000」）。
    // 可选 —— 老日志没有它，读侧不得因缺键报错。取值见 `shared/output-budget.ts::OutputBudgetLayer`。
    | { type: "max-tokens"; data: { maxOutputTokens: number; layer?: string } } // 撞输出上限被截断
    // source：`"user"` = 用户主动停止（`cancel()` 显式带上）· `"detached"` = 流意外中断/没跑完的兜底
    //（##305 起消费端断开**不再**产生它）· 旧日志里的 `"abort"` = 来源不明的中断。文案映射唯一源见 shared/turn-end
    | { type: "aborted"; data: { source: string } }
    // `code` / `triage` = **根因 + 性质**（##393 用户口径：不再分类「有限额/中断」这类同级词，
    // 直接放根因，但要说清「是我方 bug / 已识别外部 / 未识别外部」）。判据唯一出口 =
    // `shared/error-triage.ts::endReasonOf`，文案唯一源 = `shared/turn-end.ts`。
    | { type: "error"; data: { source: string; message: string; code?: string | null; triage?: Triage } } // llm / stream / budget / drive-turn
    // 崩溃/被杀后冷读补 closer（进程已死，不可能是正常收尾）。两条正交标注并存：
    // - `code` / `triage`：##393 的三档性质归类（活进程也会写）
    // - `why` / `evidence`：##416 冷读时按现场证据给出的**可命名原因**（`app-exit:<kind>` / `crash:minidump`），
    //   语义由 `shared/interrupted-cause.ts::codeOfInterruptedWhy` 派生；**可选**，老记录没有 ⇒ unknown 兜底，不许猜。
    | { type: "interrupted"; data: { code?: string | null; triage?: Triage; why?: string; evidence?: string } };

export type Op =
    | { op: "start"; id: string; kind: BlockKind; parent?: string | null; meta?: Record<string, JSONVal> }
    | { op: "delta"; id: string; fields: Record<string, JSONVal> }
    | { op: "patch"; id: string; fields: Record<string, JSONVal> }
    | { op: "stop"; id: string };

/** 运行时块：kind 声明字段的扁平容器 + 结构位 */
/**
 * Text 字段**硬顶**（##93 D）：一个块的内容超过 `head + tail` 时，store 只留头尾，
 * 中间换成一行显式标注 + 计数（`block.__cap[字段] = { total, omitted }`）。
 *
 * 为什么要有：##266 那轮会话单个 `text` 块 328 万字符 —— 它一个人就顶掉了整个渲染进程的内存预算，
 * 而界面**同时**只看得到其中几十行。窗口化（##93 A）只解决 CPU，内存得靠这里。
 *
 * 为什么默认关：`main` 侧的 store 是**投递真源**（`blocksToMessages` / `projectAll` 要靠全文
 * 重建 messages），裁了就是丢上下文。只有渲染端那份**纯显示**的 fold 可以裁。
 */
export interface TextCap {
    /** 头部保留字符数 */
    head: number;
    /** 尾部保留字符数 */
    tail: number;
}

/** 被裁字段的计数（挂在 block 的 `__cap` 上，随 attrs 一起下发到 UI） */
export interface TextCapInfo {
    /** 该字段完整字符数（含被省略部分） */
    total: number;
    /** 被省略的字符数 */
    omitted: number;
}

/** 渲染端硬顶（UI 只用它显示；全文按需另取，见 ##93 D 的 range 读） */
export const RENDER_TEXT_CAP: TextCap = { head: 64 * 1024, tail: 64 * 1024 };

/**
 * 读一个 Text 字段的**显示值**。被硬顶裁过时拼 `head + 标记 + tail`（每次读重拼 128 KB，瞬时垃圾），
 * 未裁时就是字段原值。
 *
 * 为什么不把拼好的串存进块里：那样 store 里会同时留着 head/tail 与显示串两份（实测 456 KB/块），
 * 而判据是「常驻 < 200 KB」。惰性拼装把常驻压到 head+tail 一份。
 */
export function displayText(b: Block | undefined, path = "content"): string {
    if (!b) return "";
    const raw = (b.__raw as Record<string, { head: string; tail: string }> | undefined)?.[path];
    if (!raw)
        return typeof (b as Record<string, unknown>)[path] === "string"
            ? ((b as Record<string, unknown>)[path] as string)
            : "";
    const cap = (b.__cap as Record<string, TextCapInfo> | undefined)?.[path];
    return raw.head + (cap ? capMark(cap.omitted, cap.total) : "") + raw.tail;
}

/**
 * 把字符串**压平成独立副本**（切断 V8 SlicedString 对父串的引用）。
 *
 * 为什么必须：`slice(k)` 返回的是 SlicedString，它引用**整条父串** —— 对 3.28 M 的串取尾巴，
 * 等于把整条串继续钉在堆上（实测硬顶后仍有 202 KB/块，压平后 ~130 KB/块）。
 * 只在 head/tail 两段上做（各 ≤ 64 KB），每次 delta 两次 64 KB 拷贝 ≈ 0.04 ms，与每帧预算相比可忽略。
 */
// ⚠️ 不能用 `Buffer`：本模块 main 与 **renderer** 共用（浏览器没有 Buffer —— 曾经在这里抛
// `ReferenceError: Buffer is not defined`，整条 op 被跳过、大块内容凭空消失）。
// TextEncoder / TextDecoder 两边都有；往返会把 lone surrogate 变成 U+FFFD（与 Buffer 行为一致），
// 所以切点仍必须先避开代理对（见下面的 sliceNoSplitOff）。
const FLATTEN_ENC = new TextEncoder();
const FLATTEN_DEC = new TextDecoder();
const flatten = (v: string): string => (v.length < 256 ? v : FLATTEN_DEC.decode(FLATTEN_ENC.encode(v)));

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * 取头 n 个 code unit，**不在代理对中间切**（切了就会得到 lone surrogate —— 再经 `Buffer` 的
 * UTF-8 往返变成 `U+FFFD`，不可逆地损坏文本：`"🎉".repeat(100).slice(0,7)` 就是现场）。
 */
function headSlice(v: string, n: number): string {
    if (v.length <= n) return v;
    const cut = isHighSurrogate(v.charCodeAt(n - 1)) && isLowSurrogate(v.charCodeAt(n)) ? n - 1 : n;
    return v.slice(0, cut);
}

/** 取尾 n 个 code unit，同样避开代理对（起点落在低代理上就前移一位，宁可少一个字符）。 */
function tailSlice(v: string, n: number): string {
    if (v.length <= n) return v;
    let start = v.length - n;
    if (isHighSurrogate(v.charCodeAt(start - 1)) && isLowSurrogate(v.charCodeAt(start))) start += 1;
    return v.slice(start);
}

/**
 * 裁剪标记（##425）：`view` 档 —— 原文完整（盘上有），只是**这个视图**留了头尾两段。
 * 中间嵌在内容里、经 markdown 渲染 ⇒ `fence: true`，否则 `<cut …/>` 会被当成 HTML 吞掉。
 * `resume` 指向 UI 的「载入全文」出口（见 `CapNotice`）。
 */
const capMark = (omitted: number, total: number): string =>
    `\n\n${cutMarker({
        by: "renderer-text-cap",
        scope: "view",
        why: "render",
        unit: "chars",
        total,
        kept: Math.max(0, total - omitted),
        resume: "ui:载入全文",
        fence: true,
    })}\n\n`;

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
    turn: {
        usage: "Flag",
        status: "Flag",
        notice: "Flag",
        reasoningEffort: "Flag",
        durationMs: "Flag",
        endReason: "Flag",
        // degraded（##424）：该轮是**降级重建**出来的（`turns.jsonl` 折成只读文本），不是 ops 原文。
        // `{ refDangling: boolean, state: "ok"|"interrupted"|"error", at: ISO }` ——
        // `refDangling` 时 UI 行内写「原始记录已清理」（锚点指向的 ops 已经不在了）。
        // 正常路径永不出现这个字段（turns 只在降级时被消费）。
        degraded: "Flag",
    },
    step: { model: "Flag", usage: "Flag", status: "Flag" },
    // steer / steerId：用户"插嘴"写进对话流的标记（模式 next-step|next-turn，缺省 = 本轮开场的那次发言）
    // 与队列项 id（steer/N，回查用）。走 start 的 meta 落位（见 local-agent 的 steerBlockOps），
    // 声明在这里是给"它们是 text 块的合法字段"一个正式出处 —— 否则将来谁拿 patch 写它们会得到 issue。
    text: {
        role: "Flag",
        content: "Text",
        steer: "Flag",
        steerId: "Flag",
        // author：发言者署名（##166 §40 A）—— 代发 / 多 agent 同席时 UI 据此区分发言者；
        // 省略 = 本任务本人（沿用"我说过啥"的右侧气泡）。落位见 local-agent 的两处 user 块。
        author: "Flag",
        // room：房间来源（##377 第 23 刀）—— `{ roomId, sayId }`，只有 room 投递带。
        // 与 author 分工：author = 谁说的，room = 从哪来的。省略 = 不是投递来的
        // （任务页本人发言 / 老数据）⇒ 气泡逐字不变。Δt 不适用 ⇒ Flag（整对象写一次）。
        room: "Flag",
        // speaker：发言者（##422）—— `{ id, name? }`，省略 = 未知/单人（任务页本人发言 / 老数据）。
        // 与 `author` 分工：author 给 **UI**（气泡左右 / 署名，值 = 成员 id），speaker 给 **模型**
        // （投影成历史 user 消息的 `from:` 段，带显示名）。两个字段同时落、同一写入点，
        // 但**读侧各自独立**：删掉任一个只会让那一侧退回老行为，不会把另一侧弄错。
        speaker: "Flag",
        // 结构化机器事件（job 结束等）：投影时走 notify（##442 2026-10-27）。JSON 对象整写。
        notify: "Flag",
    },
    // ms：这块**自己花掉的时间**（##399 活动框右侧角标）—— think = 从 reasoning-start 到
    // reasoning-end（模型生成这段思考的时长），tool = 从 tool-call 到 tool-result（真执行时长，
    // **不含**吐参数那段）。旧日志没有它 ⇒ 消费端必须按"没有就不显示"处理。
    think: { content: "Text", ms: "Flag" },
    tool: {
        tool: "Flag",
        title: "Flag",
        status: "Flag",
        input: "Text",
        args: "Flag",
        output: "Text",
        /** 执行耗时（tool-call → tool-result，ms）；与 think.ms 同一口径 */
        ms: "Flag",
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
export const INTERRUPTED_TOOL_NOTICE = "[此调用已中断（上一轮未跑完），没有结果；这是已结束的历史记录，不要重试]";

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
 * 只收敛**本轮**遗留的 tool 块（`parent` 以 turnId 开头即属本轮）—— 与 interruptedToolPatches
 * 同一套终态（status=interrupted + 契约文案 + stop），区别只在**范围**。
 *
 * 为什么需要「本轮」这个范围（##375）：用户在轮次中途点停止（`cancel()`）会掐断 LLM 流，
 * SDK 再也发不出这条工具调用的 tool-result / tool-error ⇒ 块永远停在 `status:"running"`、
 * 也收不到 stop（UI 上就是一行「停不掉的工具」）。此时**轮次正在收尾**，等不到下一轮开场的
 * 残留收敛（那是给崩溃/杀进程兜底的，迟到 = 用户当场看见假"在跑"）。
 *
 * 与 interruptedToolPatches 的取舍：那个挑全库、给加载/开轮用（冷读兜底）；本函数挑本轮、
 * 给轮次收口用（热路径）。两者都幂等：已终态 / 已 stop 的块不再返回。
 */
export function interruptedToolPatchesOfTurn(store: BlockStore, turnId: string): Op[] {
    const out: Op[] = [];
    for (const b of store.blocks.values()) {
        if (b.kind !== "tool") continue;
        if (!String(b.parent ?? "").startsWith(turnId)) continue; // 只碰本轮（tool 的 parent = 本轮的 step）
        const status = String(b.status ?? "");
        if (status === INTERRUPTED_STATUS || status === "done" || status === "error") continue;
        if (b.stopped) continue;
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
 *   · 本函数管**结构闭合**：所有还没 stop 的块（turn / step / text / think / tool …），
 *     外加**轮级结束原因**（`turn.endReason = interrupted`，见下）。
 * 会话加载时调用（幂等）：崩溃现场若停在半轮，不补 stop 就会让 UI 永远显示"本轮未完成"，
 * 且 append-only 的 llm 全量日志也没法给这一轮定稿（定稿判据 = turn 已 stop）。
 *
 * 顺序：倒序遍历（父块总先于子块创建）→ 子先父后，与 closeTurn 的收尾顺序一致。
 *
 * ⚠️ 只补**结构闭合**（stop）与**结束原因**（interrupted），**不补 `durationMs`** —— 正常收尾的耗时
 * 由 closeTurn 写（`durationMs = Date.now() - turnId 内嵌开始毫秒`），而崩溃/被杀那一刻进程已死，
 * "这一轮跑到哪结束"无从得知，编一个数就是假事实。故这类轮次的头部**永远没有耗时位**，
 * 只显示按 `endReason` 派生的「本轮未完成」。这是有意为之，不是漏填。
 *
 * 为什么 endReason 也在这里补（##288 拍板②）：`interrupted` 是**冷读合成**的 closer ——
 * 进程已死，真相只有一个"没跑完"，与 dsh 在同一位置（turn-end 的 interrupted）取同名。
 * 幂等：已有 `endReason`（正常收尾落过 / 之前已补过）不覆盖。
 *
 * `opts.interruptedData`（##416）：调用方按**时间窗口**查现场（`log/app-exit.jsonl` / minidump）
 * 拿到的可命名原因；本函数保持纯函数（不读盘），查不到就写空 data ⇒ 三档仍归 unknown。
 */
/** 冷读补 `interrupted` 时可选的「现场勘验」回调（##416）—— 纯函数不读盘，IO 留给调用方 */
export interface InterruptedDataResolver {
    /** 返回 null = 窗口内没有可命名证据 ⇒ 保持 `data:{}`（三档仍是 unknown，不猜） */
    (turn: Block): { why: string; evidence?: string } | null;
}

export function danglingStopPatches(store: BlockStore, opts: { interruptedData?: InterruptedDataResolver } = {}): Op[] {
    const out: Op[] = [];
    const ids = [...store.blocks.values()].filter((b) => !b.stopped).map((b) => b.id);
    for (const id of ids.reverse()) {
        const b = store.blocks.get(id)!;
        if (b.kind === "turn" && b.endReason === undefined) {
            // 能命名才命名（##416）：`why` 由调用方按 `log/app-exit.jsonl` / minidump 的**时间窗口**判定，
            // 查不到就退回空 data —— 与改动前逐字一致，SIGKILL / 断电说不出就是不许猜。
            const named = opts.interruptedData?.(b) ?? null;
            const data: { why?: string; evidence?: string } = {};
            if (named) {
                data.why = named.why;
                if (named.evidence) data.evidence = named.evidence;
            }
            out.push({ op: "patch", id, fields: { endReason: { type: "interrupted", data } } });
        }
        out.push({ op: "stop", id });
    }
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
    /** Text 硬顶（缺省 = 不裁；只有渲染端那份纯显示的 fold 传） */
    private readonly textCap?: TextCap;

    constructor(opts: { textCap?: TextCap } = {}) {
        this.textCap = opts.textCap;
    }

    /**
     * Text 字段落值（delta 追加 / patch 覆盖共用出口）—— 超硬顶时只留头尾。
     *
     * **头尾各自增量维护**（`__raw[path] = { head, tail }`），不在大字符串上 `slice`：
     * V8 的 `slice` 返回 **SlicedString**，它**引用整条父串** —— `big.slice(0, 64K)` 看上去只留
     * 6.4 万字符，实际把 3.28 M 的父串一起钉在堆上（实测 257 KB/块 vs 128 KB/块的目标）。
     * 所以：头部「攒够就停」（只 append 不切），尾部「滚动窗口」（切的对象永远 ≤ tail + 一次 delta，
     * 有界）。导出的显示串 = head + 标记 + tail 由 `buildNode` 拼（保 identity 缓存，不每帧拼）。
     *
     * delta 与 patch 的差别只在 `total` 怎么来：delta 是「之前的累计 + 新片段」（裁掉的中段已不在
     * 内存里，长度只能靠计数），patch 是整体覆盖，`total` = 新值长度。
     */
    private setText(b: Block, path: string, val: string, mode: "delta" | "patch"): void {
        const cap = this.textCap;
        const caps = (b.__cap ??= {}) as Record<string, TextCapInfo>;
        const raws = (b.__raw ??= {}) as Record<string, { head: string; tail: string }>;
        const r0 = raws[path];
        const prev = caps[path];
        // 已裁过就直接读真身（**不要**读 `b[path]`：那是惰性拼装串，读一次就是一次 128 KB 重建）
        const curStr = r0
            ? ""
            : typeof (b as Record<string, unknown>)[path] === "string"
              ? ((b as Record<string, unknown>)[path] as string)
              : "";
        const total = mode === "delta" ? (prev?.total ?? curStr.length) + val.length : val.length;
        if (!cap || total <= cap.head + cap.tail) {
            // 不超顶：仍是 cons string（`cur += val` 摊销 O(1)），并清掉旧的裁剪计数
            delete caps[path];
            delete raws[path];
            const base = r0 ? r0.head + r0.tail : curStr;
            (b as Record<string, unknown>)[path] = mode === "delta" ? base + val : val;
            return;
        }
        let head: string;
        let tail: string;
        if (mode === "patch") {
            head = flatten(headSlice(val, cap.head));
            tail = flatten(tailSlice(val, cap.tail));
        } else if (r0) {
            // 头「攒够就停」，尾「滚动窗口」——切的对象恒 ≤ 64 KB + 一次 delta（有界），
            // 且切片立刻压平（否则 SlicedString 把父串一起钉住，等于没裁）
            head = r0.head.length >= cap.head ? r0.head : flatten(headSlice(r0.head + val, cap.head));
            tail = flatten(tailSlice(r0.tail + val, cap.tail));
        } else {
            const full = curStr + val; // 首次超顶：这一刻才付一次全文代价（此后再不切大串）
            head = flatten(headSlice(full, cap.head));
            tail = flatten(tailSlice(full, cap.tail));
        }
        // 计数按**实际留下的长度**算（代理对齐可能少 1 个 code unit，不能让标记的数字对不上）
        const omitted = Math.max(0, total - head.length - tail.length);
        caps[path] = { total, omitted };
        raws[path] = { head, tail };
        // 显示串**不落库**：`b[path]` 是个惰性 getter（见 `blockGet`），按需拼 head + 标记 + tail
        delete (b as Record<string, unknown>)[path];
    }

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
                // parent 三种形态（见 Op 类型）：
                //   · turn / 显式 null → 一律无父（root）。null 是「显式无父」这个语义的唯一表达：
                //     undefined 在 JSON 里整字段消失，重放时只能退回栈顶（隐式），
                //     于是折叠流（compactOps）里一个"本就该是根的块"会被挂到前一棵未闭合子树上。
                //   · 显式 id → 用它（折叠流全部走这条）
                //   · 省略   → 栈顶（隐式，实时流/老日志的形态）
                const parent =
                    op.kind === "turn" || op.parent === null
                        ? undefined
                        : (op.parent ?? this.openStack[this.openStack.length - 1]);
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
                // 只有"未定稿 → 定稿"这一次才算触碰：重复 stop（同一份折叠流再喂一遍）必须无副作用，
                // 否则 touched 一变，toForest 的身份缓存整片失效（渲染端 reload 时全量重建）。
                if (!b.stopped) {
                    b.stopped = true;
                    this.touch(op.id);
                }
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
                let changed = false;
                for (const [path, val] of Object.entries(op.fields ?? {})) {
                    const decl = path === "children" ? undefined : SCHEMA[b.kind]?.[path];
                    if (op.op === "patch") {
                        // 值没变就既不写也不计数：这让「对同一份折叠流重复 apply」成为**无副作用**操作
                        // （见下方 touch 的注释 —— 它是渲染端不重建整棵树的前提）。
                        const cur = path.includes(".") ? getPath(b, path) : (b as Record<string, unknown>)[path];
                        if (jsonEqual(cur, val)) continue;
                        if (path.includes(".")) setPath(b, path, val);
                        else if (this.textCap && decl === "Text" && typeof val === "string" && !jsonEqual(cur, val)) {
                            // patch 是整体覆盖 ⇒ 硬顶按「新值的完整长度」重算（不是叠在旧的累计上）
                            this.setText(b, path, val, "patch");
                        } else (b as Record<string, unknown>)[path] = val;
                        changed = true;
                        continue;
                    }
                    // delta：必须有类型声明，未知字段降级为 patch（前向兼容，记 issue）
                    if (decl === undefined) {
                        this.issues.push({
                            op,
                            reason: `未知字段 ${b.kind}.${path}，delta 降级为 patch`,
                        });
                        setPath(b, path, val);
                        changed = true;
                        continue;
                    }
                    if (decl === "Flag") {
                        this.issues.push({
                            op,
                            reason: `Flag 字段 ${b.kind}.${path} 不接受 delta，忽略`,
                        });
                        continue;
                    }
                    const cur = path.includes(".") ? getPath(b, path) : (b as Record<string, unknown>)[path];
                    if (decl === "Text") {
                        const next = `${typeof cur === "string" ? cur : ""}${typeof val === "string" ? val : JSON.stringify(val)}`;
                        // 点分路径不参与硬顶（Text 字段都是顶层；带点的走 setPath 保持原语义）
                        if (path.includes(".")) setPath(b, path, next);
                        else if (this.textCap)
                            this.setText(b, path, typeof val === "string" ? val : JSON.stringify(val), "delta");
                        else (b as Record<string, unknown>)[path] = next;
                    } else {
                        // List：值本身是数组则逐元素追加，否则作为单元素 push。
                        // ⚠ **就地 push，不 `[...cur]`**（##93 E）：List 字段只会被**追加**
                        // （SCHEMA 里仅 `plan.items` 是 List），每次追加都复制整组 = O(n²)；
                        // 一条 1.16 M op 的真实会话里 List delta 为 0，但形状上一旦有就是平方。
                        // 值语义为什么不破：追加只增不改已有元素，且每次 apply 都 `touch()` ⇒
                        // `toForest` 会重建该节点；已导出的旧节点与 store 共享数组，看到的是
                        // **更新的同一条数据**（跨进程到 renderer 时是 structured clone，天然快照）。
                        const arr = Array.isArray(cur) ? cur : [];
                        if (Array.isArray(val)) arr.push(...(val as JSONVal[]));
                        else arr.push(val);
                        (b as Record<string, unknown>)[path] = arr;
                    }
                    changed = true;
                }
                // 只有真的改了才触碰：`touched` 是 toForest 身份缓存的判据，重复 apply 同一份
                // 终值若也 bump 它，所有轮次都会被当成"变过"而全量重建（渲染端 reload 的 GC 风暴）。
                if (changed) this.touch(op.id);
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

// ─── 折叠：块树 → 等价的紧凑 Op 流 ─────────────────────
//
// 为什么需要（用户 2026-10-12 大会话假死）：Op 日志是**逐 token** 落盘的（一个 text-delta
// 一条 op），于是一次 74MB 的会话有 877,050 条 op —— 其中 98% 只是"同一个块又追加了几个字符"。
// 全量读 → 全量下发 → 渲染端全量 fold，CPU 与内存都被这层纯属结构开销的碎片吃掉。
//
// 折叠把"每块开始的样子 + 结束的样子"直接写出来，中间的碎片不再是一条条 op：
//   start(每块一次) + patch(该块字段终值) + stop(已闭合的块一次)。
// 同一棵块树，块数不变、内容一字不差，op 数降到千分之几。
//
// 等价性（= 可以安全替换，判据见 tests/core/local-blocks 的往返测试）：
//   · parent 全部显式写出（无父写 null）→ 不依赖 start 顺序（openStack），
//     于是「交叉闭合 / 孤儿块 / 未 stop 的残留」都不会被重放出不同的父子关系；
//   · 字段值取**fold 后的终值**：delta 累加(Text/List)、patch 覆盖、点分路径…… 折叠后
//     一律由一条 patch 覆盖同一路径写回 —— 终值相同即等价，与它当初怎么变过来的无关；
//   · children 顺序 = 按块的 children 数组递归输出（与 start 插入序一致）；
//   · stopped 由 stop op 表达；touched 是 fold 期间的时序号（重放会重编），结构位不进 patch。
// 有意丢弃的只有「怎么变成这样的」——即流式中间态与 fold issues（诊断信息，见 compact ops
// 的调用侧：issues 在折叠前统计并出声）。
export function compactOps(store: BlockStore): Op[] {
    const out: Op[] = [];
    const emit = (id: string): void => {
        const b = store.blocks.get(id);
        if (!b) return; // 悬挂引用（史书里理论上不该有）：跳过而非崩，与 toTree 的兜底同策
        out.push({ op: "start", id: b.id, kind: b.kind, parent: b.parent ?? null });
        const fields: Record<string, JSONVal> = {};
        for (const [k, v] of Object.entries(b)) {
            if (k === "id" || k === "kind" || k === "parent" || k === "children" || k === "stopped" || k === "touched")
                continue;
            // `__` 前缀 = fold 侧的本地记账（如 `__cap` 的裁剪计数，##93 D）：不是块数据，不进折叠流
            if (k.startsWith("__")) continue;
            if (v === undefined) continue;
            fields[k] = v as JSONVal;
        }
        // 被硬顶裁过的 Text 字段不在 `b` 上（只在 `__raw` 里），折叠时按**显示值**写出：
        // 折叠流是「终值即等价」的，裁过的 store 本来就只剩头尾（渲染端才裁，而它不做折叠）。
        for (const p of Object.keys((b.__raw as Record<string, unknown> | undefined) ?? {})) {
            fields[p] = displayText(b, p);
        }
        if (Object.keys(fields).length > 0) out.push({ op: "patch", id: b.id, fields });
        for (const c of b.children) emit(c);
        if (b.stopped) out.push({ op: "stop", id: b.id });
    };
    for (const r of store.roots()) emit(r.id);
    return out;
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

/** JSON 语义深比较（patch 幂等判据：值没变就别碰块 —— 见 apply 的 patch 分支）。 */
function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
        return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
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
    // `__raw` 是硬顶的内部记账（头/尾两段的真身），不进 attrs；`__cap` 的计数要进（UI 用）
    delete (attrs as Record<string, unknown>).__raw;
    // 被硬顶裁过的字段：attrs 上挂**惰性 getter**（每次读拼一次，不常驻第二份 128 KB 串）
    for (const p of Object.keys((b.__raw as Record<string, unknown> | undefined) ?? {})) {
        delete (attrs as Record<string, unknown>)[p];
        Object.defineProperty(attrs, p, {
            enumerable: true,
            configurable: true,
            get: () => displayText(b, p),
        });
    }
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
 * **逐条容错地**把一批 op 应用到 store 上；返回失败条数（0 = 全成功）。
 *
 * 为什么需要它（##377 第 15 刀）：`BlockStore.apply` 对**结构损坏**的 op 会抛
 * （未知块 / 坏模式走 `issues` 不抛，但 `op` 本身是 null、`fields` 不是对象这类会抛）。
 * 调用方（渲染端的 `applyInto`）原来直接 `for (op of ops) store.apply(op)` ——
 * **一条抛错就中断整批，且没有任何日志**：尾部那批 op 全不落地，
 * 症状是"最新的几轮整段消失"，而界面上与"模型还没回"完全同形。
 *
 * 取舍：坏记录**不该吃掉它后面**的所有记录 ⇒ 出声、跳过、继续。
 * 这不是"吞错"—— 坏 op 原样打出来（前 3 条）+ 总数汇总，排查时看得见。
 */
export function applyOpsSafely(store: BlockStore, ops: readonly Op[]): number {
    // 重复 apply 会给"重复 start"记 issue；渲染端不消费 issues，但别让它无界堆积
    if (store.issues.length > 0) store.issues.length = 0;
    let failed = 0;
    for (const op of ops) {
        try {
            store.apply(op);
        } catch (e) {
            failed++;
            if (failed <= 3) console.warn("[local-blocks] op 应用失败（跳过，继续后续）:", op, e);
        }
    }
    if (failed > 0) console.warn(`[local-blocks] 本批 op 有 ${failed}/${ops.length} 条应用失败（已跳过）`);
    return failed;
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
//  - think 块投影成**本 step 第一条 assistant 消息的 reasoning part**（挂 content 最前）；
//    思考模式下上游要求把 `reasoning_content` 回传，缺则整轮 400（##371：luminal 端点必现，
//    orcarouter / deepinfra 端点不校验 —— 所以是一半概率中招，不是偶发抖动）
//  - tool 块 id = toolCallId；args=定稿入参对象，output=结果文本，status ∈ running|done|error
//  - 每个 turn 的 step 子节点按序产出 assistant 消息（text+tool-call）与 tool 结果消息

// 与 @ai-sdk 的 ModelMessage 结构对齐的最小类型（避免本模块依赖 ai 包）
export interface LocalTextPart {
    type: "text";
    text: string;
}
/** 推理内容（think 块的投影形态）—— ai-sdk `ModelMessage` 的 reasoning part */
export interface LocalReasoningPart {
    type: "reasoning";
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

/**
 * 工具结果的**输出形状**（判别联合，对齐 `@ai-sdk` 的 `ToolResultOutput`）：
 *   "text"       —— 成功结果（含"（空结果）"占位、中断契约文案）
 *   "error-text" —— **失败结果**（execute 抛错 → SDK 的 tool-error → 块 status="error"）
 *
 * 为什么失败必须换个判别键、而不是也写 "text"（##329 的 b）：
 *   块上的 `status` 是**我们自己的**属性，模型看不见；发给模型的只有 `output`。
 *   若失败也写 "text"，协议层这条 tool-result 与成功结果**形状完全相同** ——
 *   成败只剩 `[读取失败] ` 这个文案前缀可辨，等于把机器判据押在用户可见文案上
 *   （body 否掉的 c 方案就是同一个错）。`error-text` 让"这条是失败"落在**结构位**上。
 *   注：当前 openai-compatible / openai 两个 provider 把 text 与 error-text **拍平进同一分支**
 *   （`case "text": case "error-text": contentValue = output.value`），wire 上逐字节相同 ——
 *   所以这不是"让模型多知道什么"，而是**形状不再撒谎 + 判据回到状态**；
 *   换 Anthropic 这类把 error-text 映射成 `is_error: true` 的 provider 时才有实感。
 */
export type ToolResultOutput = { type: "text"; value: string } | { type: "error-text"; value: string };

export interface LocalToolResultPart {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: ToolResultOutput;
    /** 自证位（仅 withOrigin 时写；投递默认不带 —— 见 ToolResultOrigin） */
    origin?: ToolResultOrigin;
}
export interface LocalModelMessage {
    role: "user" | "assistant" | "tool";
    content: string | Array<LocalTextPart | LocalReasoningPart | LocalToolCallPart | LocalToolResultPart>;
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
     * 【##432 刀 2】**已落盘的压缩边界**（store 下标）：`[0, headEnd)` 保头 + `[cut, n)` 保留。
     * 有它就**只按边界切**（每步不重算）—— 这是「压缩是一次事件」在投递侧的落点。
     */
    historyCut?: { cut: number; headEnd: number };
    /**
     * 【##406 刀 2】**装配后硬上限**（字节）：装完量`keptBytes`，超了就把 `must` 级从
     * 超了就**按 step 从前往后整组收窄**（见 `selectHistoryByCut` 的 `cap` 分支）。
     * 缺省（不传）= 不设上限，老调用点行为逐字不变。
     */
    hardCapBytes?: number;
    /** 只投递从这个 turn 起的块（压缩边界）；null = 一个都不投（全部清零）；缺省 = 全投 */
    sinceTurnId?: string | null;
    /**
     * **全局回落 clip**（= 策略 `toolResult.render` 的降级，##343 M1）：某条消息**没被任何级声明
     * clip** 时用它。有它才谈得上「保底级 `full`、其余照旧裁」。
     */
    defaultClip?: ClipSpec;
    /**
     * **推理的全局回落裁法**（##374 T2）：某条 assistant 消息**没被任何级声明 `reasoningClip`** 时用它。
     * 与 `defaultClip` 对称（工具侧不声明就回落全局策略）—— 否则同一份 plan 里两个轴的行为反着来。
     * 缺省（不传）= 不裁（老调用点的行为逐字不变；真发/预览由 main 注入 `DEFAULT_REASONING_CLIP`）。
     */
    defaultReasoningClip?: ReasoningClipSpec;
    /**
     * 工具结果渲染（由 main 注入：同一份纯函数既算预览也算真发，见 shared/context/compaction）。
     * **不带 title**：渲染只需要「谁的输出、输出是什么」，title 是 UI 的东西（曾经传了但没人用，
     * 留着等于撒谎说渲染依赖它）。
     * 入参带 `clip`（**这条消息**的裁法，由选择阶段带出；缺省/null = 回落 `defaultClip`）——
     * 「谁被裁 / 谁全量」是**按消息**的，渲染器必须能看见它，否则保底级声明 `full` 也白搭。
     */
    transformToolResult?: (b: { id: string; tool: string; output: string; clip?: ClipSpec | null }) => string;
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

import { clipReasoningText, utf8Bytes, type ClipSpec, type ReasoningClipSpec } from "@diy-agent/compaction/compaction";
import {
    chatEnvelope,
    hasTopLevelKey,
    isEnvelopeText,
    stripRuntimeSections,
    userEnvelope,
    type NotifyItem,
    type Speaker,
} from "@diy-agent/context/envelope";
import { HUMAN_MEMBER_ID } from "../../shared/room";
/**
 * **选择结果**（投递侧唯一形状）：保留了哪些下标 / 丢了哪些 / 连续区间 / 渲染后字节。
 *
 * ##432 清理（用户 2026-10-25 拍板）：旧的 `countBytes` / `mustBytes` 两桶随级列表一起删 ——
 * 「must 级不占预算」这个病根就是它们带来的；现在只有**一个数**（`keptBytes`）。
 */
export interface BudgetSelection {
    kept: number[];
    dropped: number[];
    /** 保留的连续区间（1-based 行号），给注记「kept: [[1,1],[80,80]]」与账本用 */
    keptRuns: [number, number][];
    /** 实际占用字节（渲染后口径，工具结果已按策略裁剪） */
    keptBytes: number;
    /** 每条被选中消息的裁法（选择阶段带出；缺省 = 回落 `defaultClip`） */
    clips?: (ClipSpec | null)[];
    /** 每条被选中消息的推理裁法（缺省 = 回落 `defaultReasoningClip`） */
    reasoningClips?: (ReasoningClipSpec | null)[];
    /** 装配后硬上限的降级留痕（真降了才有 —— 调用点据此出声） */
    hardCap?: {
        capBytes: number;
        withinCap: boolean;
        degradations: { kind: string; detail: string }[];
    };
}

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
    /**
     * 当前 step 积攒的 think 块（推理内容）——**不单独产出消息**，而是挂到本 step 第一条
     * assistant 消息的 content **最前面**（顺序：reasoning part 在 tool-call / text 之前）。
     *
     * 为什么必须回传（##371）：思考模式下上游要求把 `reasoning_content` 带回
     * （`The reasoning_content in the thinking mode must be passed back to the API`），
     * 少了就**整轮 400**。实测同一请求体在不同上游端点上结果不同：
     * luminal-dsv4.1flash 必 400，orcarouter / deepinfra 不校验 —— 这就是「只有时中招」的真相。
     *
     * 为什么是「挂上去」而不是「新增一条消息」：`projectAll` 的**下标 = llm.jsonl 行号**，
     * 压缩注记 / 预览 / 记账全按它对齐；消息条数一变，这些的语义全错位。
     */
    let pendingThink: LocalReasoningPart[] = [];
    const takePending = (): LocalReasoningPart[] => {
        const p = pendingThink;
        pendingThink = [];
        return p;
    };
    const walk = (id: string, turnId?: string, stepId?: string) => {
        const b = store.blocks.get(id)!;
        // turn 只认 turn 块自己；step 只认 step 块自己 —— 之后的叶块一路继承下来
        // （开场 user 的 parent 是 turn、assistant/tool 的 parent 是 step，继承即如实反映）
        const turn = b.kind === "turn" ? b.id : turnId;
        const step = b.kind === "step" ? b.id : stepId;
        if (b.kind === "think") {
            // 推理内容**不回退**成消息：本 step 没产出任何 assistant 消息时（只思考没输出）
            // 它随换步被丢弃 —— 那样才不改变消息条数与下标语义。
            const text = (b.content as string) ?? "";
            if (text) pendingThink.push({ type: "reasoning", text });
            return;
        }
        // 换轮 / 换步：上一步没挂上的思考没有归属了，丢弃（挂到下一步的 assistant 消息上
        // 就是伪造「下一步的推理」）
        if (b.kind === "turn" || b.kind === "step") pendingThink = [];
        if (b.kind === "text") {
            const role = (b.role as string) ?? "user";
            const text = (b.content as string) ?? "";
            if (!text) return;
            if (role === "user") {
                // 新形态（##442 用户 2026-10-27）：**所有** user 消息的 content 都是
                // `chat: [{from, text}]`；`from` = 块上的 speaker / author，缺省 = 本机用户。
                //
                // 重放前先剥**控制段**（`system` / `runtime` / legacy `runtimeDiff`）：
                // 历史块里若存着一份完整信封，那些值是"当时"的，重放会把它伪装成现状；
                // `notify` / `chat` / `summary` 是线索，一段不动（见 `stripRuntimeSections`）。
                // 已是 chat 信封（回放旧块 / 同一份块被投影两次）⇒ 原样，不再嵌套。
                // 结构化机器事件：整条走 notify（内容 = meta.notify，不用正文；正文仍留给 UI 列表）
                const notify = b.notify as NotifyItem | undefined;
                if (notify && typeof notify.kind === "string") {
                    out.push({ role: "user", content: userEnvelope({ notify: [notify] }), turn, ...(step ? { step } : {}) });
                    return;
                }
                const body = stripRuntimeSections(text);
                if (!body.trim()) return; // 纯控制增量块（历史里不该有；有也跳过，别造空发言）
                const speaker = b.speaker as Speaker | undefined;
                const author = typeof b.author === "string" && b.author ? b.author : undefined;
                // 机器来源先用合法身份兜住：job / system 的**结构化事件**（notify.kind=job-done/compact）
                // 下一步再接；现在至少别在 chat 里冒出 `from: job`（不在 human/agent 词表里）。
                const from =
                    speaker && typeof speaker.id === "string" && speaker.id
                        ? speaker.id
                        : author === "job" || author === "system"
                          ? "agent:system"
                          : (author ?? HUMAN_MEMBER_ID);
                const content =
                    isEnvelopeText(body) && hasTopLevelKey(body, "chat") ? body : chatEnvelope([{ from, text: body }]);
                out.push({ role: "user", content, turn, ...(step ? { step } : {}) });
            } else {
                const lead = takePending(); // 本 step 攒下的推理，随第一条 assistant 消息落地
                // assistant 文本并入最近的 assistant 消息（若上一条正是纯文本 assistant 则拼接）
                const last = out[out.length - 1];
                if (
                    last?.role === "assistant" &&
                    typeof last.content !== "string" &&
                    !last.content.some((p) => p.type === "tool-call")
                ) {
                    const parts = last.content as Array<LocalTextPart | LocalReasoningPart>;
                    // 推理必须排在文本**之前**：think 块落到文本块后面时（罕见）插到最前
                    parts.unshift(...lead);
                    parts.push({ type: "text", text });
                } else {
                    out.push({
                        role: "assistant",
                        content: [...lead, { type: "text", text }],
                        turn,
                        ...(step ? { step } : {}),
                    });
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
            const lead = takePending(); // 同上：推理挂到这条 tool-call 的 assistant 消息上
            out.push({
                role: "assistant",
                content: [
                    ...lead,
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
            //    当成工具真实输出送去裁剪：callpath 模式把它换成一条 `<cut by="tool-result-callpath" …/>`，
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
            // 失败结果换判别键（##329 的 b）：**只有** status==="error" 才是 tool-error 的产物。
            // `interrupted` 走 status="interrupted"，是本地补的契约终态（不是工具抛错）→ 保持 "text"，
            // 别让模型把「被中断」读成「这条命令失败了」（语义不同，成本是模型据此换路子重试）。
            const output: ToolResultOutput =
                status === "error" ? { type: "error-text", value: raw } : { type: "text", value: raw };
            out.push({
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: b.id,
                        toolName: String(b.tool ?? "bash"),
                        output,
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
/** **轮边界选择**（旧机制：`selectForDelivery` 在没有落盘边界时用它；压缩主路径走 `historyCut`） */
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

// ─── 历史选择（##432 刀 2）────────────────────────────────────────
//
// **只有一种选择方式**：压缩事件算好并落盘的边界（`historyCut`），投递侧照切。
// 用户 2026-10-25 拍板：`ladder / role / recent / steps` + `must` + `budgetBytes` 那套
// 「元件库 + 装配器」整体删掉 —— 让人（和 agent）去编排装配计划的面一个不留。
// 没有边界时退回**轮边界**口径（`sinceTurnId`），那是与压缩无关的老语义。

/**
 * 选择阶段的**成本口径**：投递口径（渲染后字节；工具结果按传进来的 clip 裁剪）。
 * 与最终渲染走同一个 `renderMessage` ⇒ 「算边界的字节」就是「发出去的那条消息字节」。
 * 为什么抽成一个函数：量边界的路径（硬上限收窄 / 预览）与真发必须**同一份**口径 ——
 * 各写一份就会出现「量出来能装下、发出去超了」（##406 的病因）。
 */
export function costOfWith(opts: Pick<DeliveryOpts, "transformToolResult" | "defaultClip" | "defaultReasoningClip">) {
    return (m: LocalModelMessage, clip: ClipSpec | null, reasoningClip: ReasoningClipSpec | null = null): number =>
        utf8Bytes(JSON.stringify(renderMessage(m, opts, clip, reasoningClip)));
}

/**
 * **渲染**：保留下来的消息 → 可发/可落盘的形状。
 * 三件事：① 工具结果裁剪（只作用于**真实输出**，见 origin）；② assistant 的**推理文本**裁剪
 * （##374 T2；只裁短、绝不裁空 —— 见 clipReasoningText）；③ 按 opts 决定写不写
 * `turn`/`step`/`origin` 自证位（真发不带，落盘带）。
 *
 * ⚠️ 为什么推理走这里而不是投影期（`projectAll`）：裁剪只落**投递层** —— ops / 块树 / UI 永远是原文，
 * 预算口径（`costOfWith`）与真发（`blocksToMessages`）都必须过这一个函数，才谈得上「按 A 算预算、发出去是 B」不存在。
 */
function renderMessage(
    m: LocalModelMessage,
    opts: DeliveryOpts,
    clip: ClipSpec | null = null,
    reasoningClip: ReasoningClipSpec | null = null,
): LocalModelMessage {
    const out: LocalModelMessage = { role: m.role, content: m.content };
    if (opts.withIndex) {
        if (m.turn !== undefined) out.turn = m.turn;
        if (m.step !== undefined) out.step = m.step;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
        // 这一条消息的推理裁法：级声明优先，缺省回落全局缺省（`null`/undefined = 都不裁）
        const eff = reasoningClip ?? opts.defaultReasoningClip ?? null;
        if (eff) {
            let changed = false;
            const parts = m.content.map((p) => {
                if (p.type !== "reasoning") return p;
                const r = clipReasoningText(p.text, eff);
                if (!r.clipped) return p;
                changed = true;
                return { type: "reasoning" as const, text: r.text }; // 只改文本；part **绝不删除/清空**（裁空 = 上游 400）
            });
            if (changed) out.content = parts; // 没裁动 ⇒ 引用原样（老断言的引用相等仍成立）
        }
        return out;
    }
    if (m.role !== "tool") return out;
    const transform = opts.transformToolResult;
    const parts = (m.content as LocalToolResultPart[]).map((p) => {
        const part: LocalToolResultPart = {
            type: "tool-result",
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            output: {
                // 判别键**原样透传**（勿写成固定 "text"）：`error-text` 是「这条工具失败了」的
                // 结构位判据，压回 text 就等于把 ##329 的 b 在最后一步又丢掉。
                type: p.output.type,
                // 裁剪只作用于**工具真实输出**（origin="tool"）—— 中断契约文本与占位文案动了
                // 就误导模型（用户 2026-10-06：本地补的错误信息不许当历史投递）
                value:
                    transform && p.origin === "tool"
                        ? transform({
                              id: p.toolCallId,
                              tool: p.toolName,
                              output: p.output.value,
                              // 这条消息的裁法（选择阶段带出）；没声明 ⇒ 回落 defaultClip
                              clip: clip ?? opts.defaultClip ?? null,
                          })
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
): { kept: number[]; dropped: number[]; clips?: (ClipSpec | null)[]; reasoningClips?: (ReasoningClipSpec | null)[] } {
    // 有落盘边界 ⇒ 照切（唯一主路径）；没有 ⇒ 轮边界口径（与压缩无关的老语义）
    return opts.historyCut ? selectHistoryByCut(all, opts.historyCut, opts) : selectHistory(all, opts);
}

/**
 * **按已落盘的边界选择**（##432 刀 2）：`[0, headEnd)` 保头 + `[cut, n)` 从切点往后的原文。
 *
 * 这里**没有任何策略** —— 边界是压缩事件算好落盘的，
 * 每步只按它切（因此同一步里多次投递得到**逐字相同**的 messages）。
 */
export function selectHistoryByCut(
    all: readonly LocalModelMessage[],
    range: { cut: number; headEnd: number },
    opts: Pick<DeliveryOpts, "transformToolResult" | "defaultClip" | "defaultReasoningClip"> & {
        hardCapBytes?: number;
    } = {},
): BudgetSelection {
    const n = all.length;
    const cut = Math.max(0, Math.min(range.cut, n));
    const headEnd = Math.max(0, Math.min(range.headEnd, cut));
    const costOf = costOfWith(opts);
    const cost = (i: number): number => costOf(all[i]!, null, null);

    /**
     * 从 `cut` 往后按**步边界**收窄（##432 review B：`##406` 的装配后硬上限必须在这条新路径上仍然生效）。
     * 收窄只能「整组丢」（不许切开 tool 配对）；最后一组永远保留（否则一条不剩 = 清零）。
     */
    const advance = (from: number): number => {
        // 下一个 step 边界（无 step 的消息并入前一组 ⇒ 这里只看 step 变化处）
        for (let i = from + 1; i < n; i++) {
            const prevStep = all[i - 1]!.step;
            const step = all[i]!.step;
            if (step !== undefined && step !== prevStep) return i;
        }
        return n;
    };

    const build = (cutAt: number): BudgetSelection => {
        const kept: number[] = [];
        const dropped: number[] = [];
        for (let i = 0; i < n; i++) (i < headEnd || i >= cutAt ? kept : dropped).push(i);
        const keptRuns: [number, number][] = [];
        let prev = -2;
        let keptBytes = 0;
        for (const i of kept) {
            keptBytes += cost(i);
            if (i === prev + 1) keptRuns[keptRuns.length - 1]![1] = i + 1;
            else keptRuns.push([i + 1, i + 1]);
            prev = i;
        }
        return { kept, dropped, keptRuns, keptBytes };
    };

    let out = build(cut);
    const cap = opts.hardCapBytes && opts.hardCapBytes > 0 ? opts.hardCapBytes : 0;
    if (cap > 0) {
        let cur = cut;
        let narrowed = 0;
        while (out.keptBytes > cap) {
            const next = advance(cur);
            if (next >= n) break; // 只剩最后一组：它是最后可发的一块，再收就什么都没有了
            cur = next;
            narrowed += 1;
            out = build(cur);
            if (out.dropped.length === 0) break;
        }
        if (narrowed > 0) {
            out.hardCap = {
                capBytes: cap,
                withinCap: out.keptBytes <= cap,
                degradations: [{ kind: "history-cap", detail: `按 step 收窄 ${narrowed} 次` }],
            };
        }
    }
    return out;
}

/** 块树 → 可发/可落盘的消息（选择 + 渲染；跳过 turn/step 容器 —— think 已挂进 assistant 消息） */
export function blocksToMessages(store: BlockStore, opts?: DeliveryOpts): LocalModelMessage[] {
    const o = opts ?? {};
    const all = projectAll(store);
    const sel = selectForDelivery(all, o);
    // 选择 → 渲染：**把选择出的 clip 带过去**（两段分离不得破：选择只算下标与裁法，渲染才真裁）
    return sel.kept.map((i) => renderMessage(all[i]!, o, sel.clips?.[i] ?? null, sel.reasoningClips?.[i] ?? null));
}
