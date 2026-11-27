// tools/delivery.ts —— 投递层的**唯一接线点**：给 ToolSet 里每一个工具挂上同一个 `toModelOutput`。
//
// 为什么要有这个文件（2026-11-27 的根因）：
//   `toModelOutput` 的注释一直写着「投递层是唯一每条工具结果进模型前的钩子」，但实际只传给了
//   bash —— read / run_code / job / unit_* 全都没走这一层，各自另立一套预算（read 100KB、
//   run_code 返回值 32KB、job tail 16KB）。真出现大输出时，要么当场顶爆这一轮请求（没接投递层
//   的工具），要么被裁两遍（自己裁一次、投递层再裁一次）。
//
// 现在只有一条规矩：**装配完 ToolSet 后统一遍历注入**，不再逐个工厂传参 —— 工厂漏传一个
//   （历史上就是漏了三个）不会有人发现，遍历注入则「新加工具自动继承」。
//
// 两条不能踩的边界：
//   1. **已有 `toModelOutput` 的工具（bash）不被顶掉** —— 先跑它，再裁它给出的文本。
//   2. **带非文本内容的工具（view_image 的图片）不许变成 JSON** —— 图片一旦变成字符串，
//      模型就再也看不见它了。所以这里按「文本 / 内容块」分流：只裁文本，媒体块原样过。

import type { ToolSet } from 'ai';

/** 投递层截断器（`createToolOutputCapper` 的产物；只改「发给模型的那一份」） */
export type DeliveryCap = (text: string, toolCallId: string) => string | Promise<string>;

/** 一次工具结果的形状（AI SDK 只给这么多，别指望拿到 execute 的原始对象以外的东西） */
interface ToolResultLike {
    readonly toolCallId: string;
    readonly input: unknown;
    readonly output: unknown;
}

/** 进模型的那一份：纯文本，或「内容块数组」（文本 + 媒体混排） */
type ModelOut = { readonly type: 'text'; readonly value: string } | { readonly type: 'content'; readonly value: readonly unknown[] };

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function isTextOut(v: unknown): v is { type: 'text'; value: string } {
    return isRecord(v) && v['type'] === 'text' && typeof v['value'] === 'string';
}

function isContentOut(v: unknown): v is { type: 'content'; value: readonly unknown[] } {
    return isRecord(v) && v['type'] === 'content' && Array.isArray(v['value']);
}

/** 内容块里的文本块（`{type:'text', text}` —— 注意字段叫 `text`，不是 `value`） */
function isTextPart(v: unknown): v is { type: 'text'; text: string } {
    return isRecord(v) && v['type'] === 'text' && typeof v['text'] === 'string';
}

/**
 * 工具结果 → 进模型的那一份（未裁剪前的形状）。
 *
 * 三条分支各有理由：
 *   · 字符串（read / write / edit / bash 的 execute 返回值）⇒ 原样，逐字符不动；
 *   · `{type:'text'|'content'}`（bash 自己的 toModelOutput / view_image 的图片）⇒ 原样；
 *   · 结构化对象（run_code / job / unit_* / ask / journal）⇒ JSON，且用 `indent 2`：
 *     紧凑 JSON 是**一整行**，会被投递层的「单行 2000 字符」上限切掉中段 ——
 *     而那正是 `file-read.ts` 头注里警告过的「一行就是一条记录」。
 */
export function renderToolOutput(output: unknown): ModelOut {
    if (typeof output === 'string') return { type: 'text', value: output };
    if (isTextOut(output) || isContentOut(output)) return output;
    const json = JSON.stringify(output, null, 2);
    // undefined / 函数这类序列化不出来的东西：退回 String，至少别让工具结果变空
    return { type: 'text', value: json === undefined ? String(output) : json };
}

/**
 * 只裁**文本**：内容块里的媒体（图片字节）原样过。
 *
 * 一个工具里有多个文本块时，每个块单独落盘（`<toolCallId>.txt` / `<toolCallId>-t1.txt`），
 * 不互相覆盖 —— 否则 marker 里的 `resume` 会指向别人。
 */
async function capModelOut(out: ModelOut, cap: DeliveryCap, toolCallId: string): Promise<ModelOut> {
    if (out.type === 'text') return { type: 'text', value: await cap(out.value, toolCallId) };

    const parts: unknown[] = [];
    let index = 0;
    for (const part of out.value) {
        if (!isTextPart(part)) {
            parts.push(part); // 媒体块：不裁、不落盘、不转字符串
            continue;
        }
        // 第一个文本块用原样的 toolCallId（marker 里的常年形态），后面的加 `-t<n>` 分开落盘
        const id = index === 0 ? toolCallId : `${toolCallId}-t${String(index)}`;
        index += 1;
        parts.push({ ...part, text: await cap(part.text, id) });
    }
    return { type: 'content', value: parts };
}

/**
 * 给**每一个**工具挂上同一个投递层截断器。
 *
 * 代价：每轮多两次 `split('\n')` + 字节计数（ToolSet 本来就是每轮重建的，见 room.ts `toolsFor`）。
 * 收获：没有「哪个工具忘了接」这一档故障了 —— 新加工具自动继承。
 */
export function capEveryTool(tools: ToolSet, cap: DeliveryCap): ToolSet {
    const out: ToolSet = {};
    for (const [name, def] of Object.entries(tools)) {
        const own = (def as { toModelOutput?: (opts: ToolResultLike) => unknown }).toModelOutput;
        out[name] = {
            ...def,
            toModelOutput: async (opts: ToolResultLike): Promise<ModelOut> => {
                const raw = own === undefined ? opts.output : await own(opts);
                return capModelOut(renderToolOutput(raw), cap, opts.toolCallId);
            },
        } as ToolSet[string];
    }
    return out;
}
