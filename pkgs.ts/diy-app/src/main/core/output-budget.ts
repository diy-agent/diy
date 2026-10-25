// src/main/core/output-budget.ts
// 🎯 输出预算的**文件层**（哪些配置能压低/抬高「单次吐多少」）。
//
// 判据全在 `shared/output-budget.ts`（纯函数、可单测）；本文件只做一件事：
// 把三处**用户可改**的来源读出来 —— 任务 frontmatter、人物、全局（limits.json / env）。
// 分开的理由：判据要能在 renderer / 单测里跑，文件读取只能在 main。
//
// 三处的写法（都只写自己那一层，缺省 = 不写键）：
//   · 任务：`AGENTS.md` frontmatter 的 `max_output_tokens: 8000`
//     （刻意不复用 `persona`/`priority` 那套具名 schema —— 它是**任务级微调**，
//       不是任务的身份字段，读侧宽松、写侧由用户手改即可，与 `tags` 这类非托管键同待遇）
//   · 人物：`personas.yaml` 该人物的 `maxOutputTokens`
//   · 全局：`limits.json` 的 `maxOutputTokens` / `DIY_LOCAL_MAX_OUTPUT_TOKENS`
//
// 约定：读侧一律**宽容**（读不懂 = 当没设，出声 warn），绝不因为一个坏数字让对话跑不起来。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { splitTaskFile } from "./state";
import { personaForTask } from "./persona";

/** 任务 frontmatter 里认的那个键名（写文档 / UI 提示都用它，别在别处再拼一遍） */
export const TASK_OUTPUT_KEY = "max_output_tokens";

/** 有限正数 → 整数；否则 null（读侧宽容：坏值当没设） */
function posInt(v: unknown, label: string): number | null {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
        if (v !== undefined && v !== null) console.warn(`[output-budget] ${label} 非法（${String(v)}），按未设置处理`);
        return null;
    }
    return Math.floor(n);
}

/** 任务级覆盖：`<home>/<taskUri>/AGENTS.md` 的 `max_output_tokens` */
export async function taskOutputOverride(home: string, taskUri: string): Promise<number | null> {
    const fp = path.join(home, taskUri, "AGENTS.md");
    let raw: string;
    try {
        raw = await readFile(fp, "utf-8");
    } catch {
        return null; // 任务文件不存在（首轮 / 已删）：没有覆盖
    }
    const split = splitTaskFile(raw);
    if (!split) return null;
    return posInt(split.front[TASK_OUTPUT_KEY], `任务 ${taskUri} 的 ${TASK_OUTPUT_KEY}`);
}

/** 人物级覆盖：任务生效人物的 `maxOutputTokens` */
export function personaOutputOverride(home: string, taskUri: string): number | null {
    const p = personaForTask(home, taskUri);
    return posInt(p.maxOutputTokens, `人物 ${p.id} 的 maxOutputTokens`);
}
