// src/shared/context/budget-note.ts
// 🎯 预算压缩的**历史索引注记**（用户 2026-10-07 目标式压缩）—— 纯函数，禁止 import node:*
//
// ── 与旧 `dropped.ts` 的区别（为什么另立一份）──
// 旧注记挂在「轮边界 + 内容轴」上：逐段列 `range/turns/tools/why`（O(被丢段)）。
// 新注记挂在「字节预算」上：只列**保留区间**（O(保留段)）—— 默认预算 3KB 时保留极少，
// 故这份注记天然比旧的小一个量级。
//
// ── 为什么只标保留位置、不逐 gap 标注（用户 2026-10-07）──
// 保留区间之间的**空隙即 gap**，行号跳号本身就说清了「这里被省了」。模型不必靠逐段标注，
// 看 `kept: [[5,8],[120,135]]` 就知道 9~119 被省。
//
// ── 形态（##310 六轮拍板后）──
// `history:` 段 = **纯数据**（file / absPath / budgetBytes / keptBytes / countBytes / mustBytes / kept）。
// ⚠️ `countBytes` / `mustBytes` 是**拆账**不是修饰：托底级不占预算 ⇒ 只报 budget+kept
// 会让人读成「超了 58%」（本任务 ##5 实账 20480 vs 32298，代码一直是对的、说法是错的）。
// 解释（这是什么、怎么回取原文、字段含义）**一律在信封的 `help.history`**
// （由 `HistoryNoteSchema` 递归派生）—— 值节点里禁出现 `about`/`legend`/`retrieve`
// 一类解释性字段：一条信息只在一处，且那一处由代码（zod）派生、不会腐坏。
//
// 载体就是 YAML 文本（同 system / runtime 变量树同一机制）：用户 2026-10-07
// 「我们就是把格式化 yaml 作为文本内容塞到消息 content 里」。

import { z } from "zod";
import { toYaml } from "./render";

/**
 * 压缩历史注记（`history:` 段）的**契约**。
 *
 * `file` 的 desc 就是"怎么回取原文"的规则说明 —— 它落在 `help.history.file`，
 * 模型照着做即可；这里不再另存一份命令（那正是 `retrieve:` 那类解释字段被删掉的原因）。
 */
export const HistoryNoteSchema = z
    .object({
        file: z
            .string()
            .describe(
                "全量消息日志（相对 `$DIY_HOME`）。**每 1 行 = 1 条消息，行号即序号**；" +
                    "取被省区间 `sed -n 'A,Bp' \"$DIY_HOME/<file>\"`，按轮定位 `grep -n '\"turn\":\"T\"' …`",
            ),
        absPath: z.string().describe("同一份日志的绝对路径（bash 直接可用，省掉拼接）"),
        budgetBytes: z
            .number()
            .describe(
                "**只约束「按预算挑」的那部分（count 级）**；托底级（最近 N 步）走 `mustBytes`、**不占它**" +
                    " ⇒ `keptBytes > budgetBytes` 是正常的，不是溢出",
            ),
        keptBytes: z.number().describe("实际保留字节总数 = `countBytes + mustBytes`"),
        countBytes: z.number().describe("预算内那部分的实付字节（自身 ≤ `budgetBytes`）"),
        mustBytes: z.number().describe("托底级（最近 N 步，`clip: full`）实付字节，**不占预算**"),
        kept: z
            .array(z.tuple([z.number(), z.number()]))
            .describe("保留的行号区间 [from, to]（含两端，1-based）；**区间之间的空隙即被省略的部分**"),
    })
    .describe("会话历史被按字节预算压缩时的**保留位置索引**（顶层 `history:` 键，**不进** user.message）");

export type HistoryNote = z.infer<typeof HistoryNoteSchema>;

export interface HistoryNoteCtx {
    /** 全文日志的相对路径（相对 $DIY_HOME） */
    file: string;
    /** 绝对路径（bash 直接可用） */
    absPath: string;
}

/** 把注记渲染成信封里的一个**顶层键片段**（`history:` 一段；字段说明在 `help.history`） */
export function renderBudgetNote(note: Omit<HistoryNote, "file" | "absPath">, ctx: HistoryNoteCtx): string {
    return toYaml({ history: { file: ctx.file, absPath: ctx.absPath, ...note } });
}
