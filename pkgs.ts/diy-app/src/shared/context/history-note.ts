// src/shared/context/history-note.ts
// 🎯 压缩后的**历史索引注记**（##432 刀 2：一条上限 + 一次事件）—— 纯函数，禁止 import node:*
//
// ── 为什么只剩这几个字段 ──
// 旧注记是「预算 / 保留字节 / 两个预算桶 / 保留区间」—— 那是 `must` + `budgetBytes` 那套
// 多级挑拣的记账。新算法只有「一条上限 + 一块丢弃区间」，所以注记也只说三件事：
//   丢了 N 条 · 切点在哪（`<file>:<行>`，要原文按它去取）· 上限是多少（判断"还会不会再压"）。
//
// ── 形态（##310 六轮拍板 + ##421）──
// `history:` 段 = **纯数据**；位置 = 自占一条 user 消息、**放在历史第一条之前**（一眼能看出压缩了），
// 且**只在真丢了消息时出现**。解释（怎么回取原文、字段含义）一律在信封的 `help.history`
// （由下面的 zod 递归派生）—— 值节点里禁出现解释性字段。

import { z } from "zod";
import { toYaml } from "./render";

/**
 * 压缩历史注记（`history:` 段）的**契约**（##432 刀 2 的新形状）。
 *
 * `file` 的 desc 就是"怎么回取原文"的规则说明 —— 它落在 `help.history.file`，模型照着做即可；
 * 这里不再另存命令（那正是 `retrieve:` 那类解释字段被删掉的原因）。
 */
export const HistoryNoteSchema = z
    .object({
        file: z
            .string()
            .describe(
                "全量消息日志（相对 `$DIY_HOME`）。**每 1 行 = 1 条消息，行号即序号**；" +
                    "取被丢区间 `sed -n 'A,Bp' \"$DIY_HOME/<file>\"`，按轮定位 `grep -n '\"turn\":\"T\"' …`",
            ),
        absPath: z.string().describe("同一份日志的绝对路径（bash 直接可用，省掉拼接）"),
        limitTokens: z
            .number()
            .describe("单条上限（token，字符数 / 4 粗估）：从最后一步往前累加，装得下就装，装不下就停"),
        dropped: z.number().describe("这次丢掉的消息条数（不含保头；保头 = 前 600 token，永远保留）"),
        cut: z
            .object({
                line: z.number().describe("切点行号（1-based，与 `file` 的行号一一对应）：**这一行及之后是原文**"),
                turn: z.string().nullable().describe("切点所在那轮的 id（按轮定位用）；null = 不在任何轮里"),
            })
            .describe("切点：它之前（除保头外）的内容被丢弃"),
        kept: z
            .array(z.tuple([z.number(), z.number()]))
            .describe("保留下来的消息行号区间 [from, to]（含两端）；**区间之间的空隙 = 被丢弃的部分**"),
    })
    .describe(
        "会话历史被压缩后**保留位置索引**：自占一条 user 消息（`history:` 顶层键），放在**历史第一条之前**、" +
            "system 之后；**没丢掉任何消息时这条消息根本不出现**。取原文看 `file` / `absPath` / `cut`",
    );

export type HistoryNote = z.infer<typeof HistoryNoteSchema>;

export interface HistoryNoteCtx {
    /** 全文日志的相对路径（相对 $DIY_HOME） */
    file: string;
    /** 绝对路径（bash 直接可用） */
    absPath: string;
}

/** 把注记渲染成一段 `history:` YAML（自占一条消息的内容；字段说明在 `help.history`） */
export function renderHistoryNote(note: Omit<HistoryNote, "file" | "absPath">, ctx: HistoryNoteCtx): string {
    return toYaml({ history: { file: ctx.file, absPath: ctx.absPath, ...note } });
}
