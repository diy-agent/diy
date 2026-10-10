// src/main/core/local-paths.ts
// 🎯 会话落盘路径的**唯一出口**（key 算法只此一份）。
//
// 为什么单独一个模块：`prompt-registry`（装配 system 上下文）也要知道 llm 日志的相对路径
// —— 索引注记的「回取命令」要写进 system 节点。而 `local-agent` 已经 import 了
// `prompt-registry` 的 assembleGlobals，反向 import 会成环；key 算法又不能复制第二份
// （两处算法漂移 = 模型按注释取不到原文，比不给索引更坏）。
//
// 约定：本模块只做主进程路径计算与目录创建，不含任何会话逻辑。

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { diyHome } from "./state";

/** 会话数据根 `$DIY_HOME/local/`（不存在则创建） */
export function localDir(): string {
    const d = path.join(diyHome(), "local");
    mkdirSync(d, { recursive: true });
    return d;
}

/**
 * 会话文件/亲和头共用键。
 * ⚠️ 不能只做字符替换：`a/b` 与 `a:b` 会洗成同一个 `a_b`（碰撞=两任务互相串历史、
 * 共享 zen 会话亲和头）。可读前缀只为便于排查，唯一性由 sha256 前 12 位负责。
 */
export function keyOf(taskUri: string): string {
    const readable = taskUri.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const sum = createHash("sha256").update(taskUri).digest("hex").slice(0, 12);
    return `${readable}-${sum}`;
}

/**
 * 会话 Op 流文件路径。
 * 导出供测试构造「历史对话已存在」的落盘状态：测试与产品共用同一路径实现
 * （key = 可读前缀 + uri 哈希），不复制 key 算法到测试里。
 */
export function opsFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.ops.jsonl`);
}

/** 全量消息日志（append-only；每行 1 条消息，行号即消息序号 —— 压缩注记的行号口径） */
export function llmFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.llm.jsonl`);
}

/** 会话日志的相对路径（相对 `$DIY_HOME`）——写进投递文本给模型/人照此回取 */
export function llmLogRelPath(taskUri: string): string {
    return `local/${keyOf(taskUri)}.llm.jsonl`;
}
