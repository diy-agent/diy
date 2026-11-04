// cap-output.ts — 单条工具输出的**投递层截断**（##127 / ##419）
//
// 从 apps/diy-app/src/main/services/tool-output.ts 抽出的纯逻辑部分：预算常量、策略、
// 截断 + marker 生成、原文落盘的**契约**。落盘位置由调用方注入 —— 因为「原文写哪」
// 是宿主的目录约定（diy-app 用 `<会话目录>/toolout/`，别的宿主可能用内存或别处）。
//
// ⚠️ 为什么落点必须是 `toModelOutput`（工具结果 → 模型消息的钩子），不是 `execute`：
//   · `execute` 的返回值 = 落进 ops 的**原文**（UI / 日志 / 压缩都从它取）。在 execute 里裁 =
//     原文当场丢（用户也看不到全量），且与 UI 显示不一致；
//   · `toModelOutput` 只改写**发给模型的那一份**，在投递时现算 —— marker 与落盘都在这里，
//     ops 原文永不动（##343 的硬边界）。
//
// ⚠️ 三条路径同一条预算（不再有「报错被裁、成功裸奔」的不对称）：
//   bash 成功 / bash 报错 / read 的行窗口，共用同一对常量。
//   旧行为是报错裁 6000、成功裸 return，唯一兜底是 execFile 的 maxBuffer 静默截断
//   （ENOBUFS，模型与用户都拿不到信号）—— 风险正好反了：真正撑爆上下文的是成功的大输出。

import { clipToolResult, type ToolResultPolicy } from "@diy-agent/compaction/compaction";

/** 单条工具输出的预算（**与 read 的行窗口同一对常量**：三路径一个策略） */
export const TOOL_OUTPUT_MAX_LINES = 2000;
export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;

/** 头尾保留行数（##127「头尾各半」；触发阈值 = head + tail = 单条预算的行数） */
export const TOOL_OUTPUT_HEAD_LINES = TOOL_OUTPUT_MAX_LINES / 2;
export const TOOL_OUTPUT_TAIL_LINES = TOOL_OUTPUT_MAX_LINES / 2;

/**
 * 工具输出层的裁剪策略（唯一真源）。与**历史投递层**同用 `clipToolResult` ⇒ marker 同构，
 * 只有参数不同（这里是「一条输出」的预算，那里是用户拧的 `toolResult.render`）。
 */
export const TOOL_OUTPUT_POLICY: ToolResultPolicy = {
    render: "headtail",
    renderData: {
        head: TOOL_OUTPUT_HEAD_LINES,
        tail: TOOL_OUTPUT_TAIL_LINES,
        maxLineChars: 2000,
        maxKeepBytes: TOOL_OUTPUT_MAX_BYTES,
    },
};

export interface CappedToolOutput {
    /** 发给模型的文本（未超限时与原文**逐字符相同**） */
    text: string;
    /** 是否发生了截断（只有截断才落盘，避免给每条小输出写文件） */
    clipped: boolean;
    /** 原文落盘位置（调用方给的字符串，通常是绝对路径；未截断 = 无） */
    origPath?: string;
}

export interface CapToolOutputOptions {
    /** 策略（缺省 TOOL_OUTPUT_POLICY）；历史投递 / 测试可传自己的 */
    policy?: ToolResultPolicy;
    /**
     * 落盘原文，返回它所在位置（写进 marker 的 `resume`，模型可 `read` 回取）。
     *
     * **由宿主注入**：目录约定是 app 的事（diy-app 用 `<会话目录>/toolout/`；Web 宿主
     * 可能落到别的根；测试里甚至可以只返回一个假路径）。抛错 = 落盘失败 ⇒ 退化成
     * 不带 `resume` 的 marker（**不假装成功**：模型至少知道「被截了、且这次取不回」）。
     */
    writeOriginal?: (content: string) => string;
}

/**
 * 单条工具输出 → **发给模型的那一份**（##127）。
 *
 * 超限（> 2000 行 / > 50KB / 有超长行）时：头尾保留 + marker；原文落盘（位置进 marker 的
 * `resume`）。落盘失败不假装成功：退化成不带 `resume` 的 marker。
 */
export function capToolOutput(text: string, options: CapToolOutputOptions = {}): CappedToolOutput {
    const policy = options.policy ?? TOOL_OUTPUT_POLICY;
    const probe = clipToolResult(text, policy);
    if (!probe.clipped) return { text, clipped: false };

    if (options.writeOriginal === undefined) {
        // 没给落盘能力：只裁，不给 resume（与「落盘失败」同一档语义）
        return { text: probe.text, clipped: true };
    }

    let origPath: string | undefined;
    try {
        origPath = options.writeOriginal(text);
    } catch {
        origPath = undefined;
    }
    if (origPath === undefined) return { text: probe.text, clipped: true };

    const withResume = clipToolResult(text, policy, { origPath });
    return { text: withResume.text, clipped: true, origPath };
}
