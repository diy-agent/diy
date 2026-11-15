// tools/clip.ts —— 单条工具输出的**投递层**截断。
//
// 规则照老方案（@diy-agent/tools/shell/cap-output + @diy-agent/compaction 的 clipToolResult）：
//   · **不在 execute 里裁**：execute 的返回值是原文，UI / 日志 / 审计都看全量；
//     只裁"发给模型的那一份"（这里挂在 transcript 入账处）。
//   · 头 N 行 + 尾 M 行 + 中间 marker，单行超长再截，最后按字符预算兜底。
//   · 未超限时逐字符不变（不做任何归一，避免无意义的缓存失效）。
//
// 老库还把原文落盘并在 marker 里给 resume 路径；diy2 暂不落盘 —— marker 提示模型
// 用 read 的 offset 或缩小命令输出重取。

import type { ModelMessage } from 'ai';

export interface ClipPolicy {
    /** 单条输出上限（字符）；未超就原样返回 */
    maxChars: number;
    /** 保留的头部行数 */
    headLines: number;
    /** 保留的尾部行数 */
    tailLines: number;
    /** 单行超过多少字符就截断（JSON / 压缩产物这类"一行一条"） */
    maxLineChars: number;
}

export const DEFAULT_CLIP: ClipPolicy = {
    maxChars: 12_000,
    headLines: 80,
    tailLines: 20,
    maxLineChars: 500,
};

const HINT = '需要更多内容请用 read 的 offset 分段读，或用 head/tail 缩小命令输出。';

/** 截断一条工具输出（只用于喂模型的那份） */
export function clipToolOutput(text: string, policy: ClipPolicy = DEFAULT_CLIP): string {
    if (text.length <= policy.maxChars) return text;

    const rawLines = text.split('\n');
    const lines = rawLines.map((line) =>
        line.length > policy.maxLineChars ? `${line.slice(0, policy.maxLineChars)}…（本行已截断）` : line,
    );

    const head = lines.slice(0, policy.headLines);
    const tail = lines.slice(Math.max(head.length, lines.length - policy.tailLines));
    const dropped = Math.max(0, lines.length - head.length - tail.length);
    const marker = `…（中间省略 ${dropped} 行；原文共 ${rawLines.length} 行 / ${text.length} 字符，完整内容没有进入上下文。${HINT}）…`;

    let body = [...head, marker, ...tail].join('\n');
    if (body.length > policy.maxChars) {
        // 行数已收敛但字符仍超（超长行 / 中文密集）：按字符头尾再收一次
        const headChars = Math.floor(policy.maxChars * 0.7);
        const tailChars = Math.floor(policy.maxChars * 0.2);
        body = `${body.slice(0, headChars)}\n…（已按字符截断）…\n${body.slice(-tailChars)}`;
    }
    return body;
}

/**
 * 只裁"喂给模型"的 tool 消息。
 *
 * 挂在 transcript 入账处（agent 的 onStepTranscript）而不是 execute：
 * UI 的 `tool-result` 事件仍然拿到完整输出，只有下一轮拼进 prompt 的那份是裁剪过的。
 */
export function clipModelMessage(message: ModelMessage, policy: ClipPolicy = DEFAULT_CLIP): ModelMessage {
    if (message.role !== 'tool') return message;
    return {
        ...message,
        content: message.content.map((part) => {
            if (part.type !== 'tool-result') return part;
            const output = part.output as { type?: string; value?: unknown };
            if (typeof output?.value === 'string') {
                const clipped = clipToolOutput(output.value, policy);
                return clipped === output.value ? part : { ...part, output: { ...output, value: clipped } };
            }
            if (output?.value !== undefined) {
                const text = JSON.stringify(output.value) ?? '';
                if (text.length <= policy.maxChars) return part;
                return { ...part, output: { type: 'text', value: clipToolOutput(text, policy) } };
            }
            return part;
        }),
    } as ModelMessage;
}
