// src/shared/context/history-index.ts
// 🎯 「压缩历史索引」的**格式说明**（变量树的一个节点）—— 纯函数，禁止 import node:*
//
// ── 为什么要单独一个节点（用户 2026-10-06）──
// 「索引注记的格式说明（字段表 + 回取法）应该从 zod 简化产出，作为一个变量树节点进 system。
//   我们的变量树就应该可扩展，不要啥都拼非结构化文本进提示词。」
//
// 分工定死：
//   · **稳定**（本文件）→ system 变量树节点：字段含义 + 回取命令。只在 schema 升级时变，
//     进 system 不砸前缀缓存（不变的前缀仍是前缀）。
//   · **易变**（每次压缩都可能不同）→ 留在 messages 里那条注记的数据。
//
// ── 为什么字段表从 zod 派生 ──
// 手写字段表 = 第二真源：改了 schema 忘改文案，说明就开始撒谎，而且没人测得出来。

import { fieldDocs } from "../schema-doc";
import { BudgetNoteSchema } from "./budget-note";

/** 字段说明的一条 */
export interface FieldDocEntry {
    name: string;
    desc: string;
    required: boolean;
}

/** 索引说明节点（变量树里的 `historyIndex`）——**纯数据** */
export interface HistoryIndexValue {
    about: string;
    source: string;
    retrieve: { byLine: string; byTurn: string };
    note: FieldDocEntry[];
}

/**
 * 构造节点值。说明的是**预算注记**（`BudgetNoteSchema`，见 budget-note.ts）——
 * 当前唯一由 UI/自动流程产生的注记形态。
 *
 * @param relPath 全量日志的相对路径（相对 `$DIY_HOME`）—— 直接写进回取命令，模型可照抄执行。
 */
export function historyIndexValue(relPath: string): HistoryIndexValue {
    return {
        about: "会话历史被按字节预算压缩时，messages 里会出现一条 history 注记 —— 这是它的格式说明与原文回取法",
        source: `${relPath}（每 1 行 = 1 条消息；**行号即消息序号**）`,
        retrieve: {
            byLine: `bash: sed -n 'A,Bp' "$DIY_HOME/${relPath}"   # A/B 取注记里 kept 缺的行号`,
            byTurn: `bash: grep -n '"turn":"T"' "$DIY_HOME/${relPath}"   # 按轮 id 定位`,
        },
        note: fieldDocs(BudgetNoteSchema),
    };
}
