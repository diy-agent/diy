// src/shared/context/history-index.ts
// 🎯 「压缩历史索引」的**格式说明**（变量树的一个节点）—— 纯函数，禁止 import node:*
//
// ── 为什么要单独一个节点（用户 2026-10-06）──
// 「索引注记的格式说明（字段表 + 回取法）应该从 zod 简化产出，作为一个变量树节点进 system。
//   我们的变量树就应该可扩展，不要啥都拼非结构化文本进提示词。」
//
// 于是分工定死：
//   · **稳定**（本文件）→ system 变量树节点：字段含义 + 回取命令。只在 schema 升级时变，
//     进 system 不砸前缀缓存（不变的前缀仍是前缀）。
//   · **易变**（每轮/每次压缩都可能不同）→ 留在 messages 里那条 user 注记的数据。
//   同一条信息不许两处都有 —— 那正是"到处都是解释性注释"的来源。
//
// ── 为什么字段表从 zod 派生 ──
// 手写字段表 = 第二真源：改了 schema 忘改文案，说明就开始撒谎，而且没人测得出来。
// 这里直接把 `DroppedNoteSchema` / `DroppedSegmentSchema` 的 `.describe()` 抽出来。

import { fieldDocs } from "../schema-doc";
import { DroppedNoteSchema, DroppedSegmentSchema } from "./dropped";

/** 字段说明的一条（与 schema-doc 的 FieldDoc 同形；这里显式声明以便进 zod 契约） */
export interface FieldDocEntry {
    name: string;
    desc: string;
    required: boolean;
}

/** 索引说明节点（变量树里的 `historyIndex`）——**纯数据**，渲染交给既有的 YAML 产出器 */
export interface HistoryIndexValue {
    about: string;
    source: string;
    retrieve: { byLine: string; byTurn: string };
    note: FieldDocEntry[];
    segment: FieldDocEntry[];
    noteLocation: string;
}

/**
 * 构造节点值。
 *
 * @param relPath 全量日志的相对路径（相对 `$DIY_HOME`）—— 直接写进回取命令，模型可照抄执行；
 *                刻意**不带绝对路径**：树里已有 `diy.home`，写两遍只会让 system 更长。
 */
export function historyIndexValue(relPath: string): HistoryIndexValue {
    return {
        about: "会话历史被压缩时，messages 里会出现一条 dropped 注记 —— 这是它的格式说明与原文回取法",
        source: `${relPath}（每 1 行 = 1 条消息；**行号即消息序号**）`,
        retrieve: {
            byLine: `bash: sed -n 'A,Bp' "$DIY_HOME/${relPath}"   # A/B 取注记里的 range`,
            byTurn: `bash: grep -n '"turn":"T"' "$DIY_HOME/${relPath}"   # T 取注记里的 turns`,
        },
        noteLocation: "注记是 messages 里的**一条 user 消息**（就在被省位置之后），内容形如 dropped: { total, segments }",
        note: fieldDocs(DroppedNoteSchema),
        segment: fieldDocs(DroppedSegmentSchema),
    };
}
