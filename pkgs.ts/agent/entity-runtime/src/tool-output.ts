// tool-output.ts —— 单条工具输出的**投递层截断**（diy2 宿主侧，##127 的同一条规矩）
//
// 预算与 marker 全部来自 `@diy-agent/tools` 的 `capToolOutput`（2000 行 / 50KB、头尾各半、
// marker 同构）—— 这里**只补「原文写哪」这个目录约定**：`<home>/toolout/<toolCallId>.txt`，
// 路径写进 marker 的 `resume`，模型不够自己 `read` 回取。
//
// 为什么必须挂在 `toModelOutput` 而不是 execute / 历史入账处（踩过的坑，2026-11-25）：
//   · execute 的返回值是原文（UI / ops / 审计都从它取），在那里裁 = 全量当场丢；
//   · 挂在**历史入账**（原来的 `tools/clip.ts`，`onStepTranscript`）只收拾"下一轮"——
//     同一次 generateText 里 SDK 自己攒的 messages 拿到的是**原文**，一步读完一个大文件
//     就能把这一轮直接顶爆（实测：`grep -rn` 撞上 4.5MB 的 sourcemap，请求当场
//     context_length_exceeded，压缩管不到轮内）。投递层是唯一"每条工具结果进模型前"的钩子。
//
// 落盘失败不假装成功：退化成不带 `resume` 的 marker（模型至少知道被裁了、这次取不回）。

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { capToolOutput, markBashTruncated } from '@diy-agent/tools';

/** 原文落盘目录（`<home>/toolout`）；home 未知时返回 undefined ⇒ 只裁、不给 resume */
export function toolOutDir(home: string | undefined): string | undefined {
    return home === undefined ? undefined : path.join(home, 'toolout');
}

/** 工具 id 里的非法文件名字符归一（`call_abc` / `t1759_s1_r1` 一般无需动） */
function safeName(id: string): string {
    return id.replace(/[^\w.-]+/g, '_');
}

/**
 * 造一个投递层截断器（`toModelOutput` 的实现）。
 *
 * 未超限 ⇒ 原样返回（逐字符不变，不砸缓存）；超限 ⇒ 头尾 + marker + 原文落盘。
 * bash 结果头里的 `truncated: false` 在真截断时改写成 true（`markBashTruncated`，
 * 别的工具的输出没有那个头，原样返回）。
 */
export function createToolOutputCapper(
    options: { readonly home?: string } = {},
): (text: string, toolCallId: string) => Promise<string> {
    const dir = toolOutDir(options.home);
    return async (text, toolCallId) => {
        // 先探一次（只在真要裁的时候才写盘，免得给每条小输出建文件）
        const probe = capToolOutput(text);
        if (!probe.clipped) return text;
        if (dir === undefined) return markBashTruncated(probe.text);

        const file = path.join(dir, `${safeName(toolCallId)}.txt`);
        try {
            await mkdir(dir, { recursive: true });
            await writeFile(file, text, 'utf8');
        } catch {
            return markBashTruncated(probe.text);
        }
        return markBashTruncated(capToolOutput(text, { writeOriginal: () => file }).text);
    };
}
