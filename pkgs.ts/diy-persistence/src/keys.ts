// src/keys.ts
// 🎯 会话键算法（**唯一真源**）：`@diy/persistence` 与 diy-app 的 local-paths 都从这里取。
//
// 为什么必须只有一份：`keyOf` 决定「哪些文件属于同一个会话」，`sessionIdOf` 决定上游的会话
// 亲和头 / 注册表条目 id。两处漂移 = 两个任务互相串历史 / 串上游会话，而症状与键算法毫无关系。

import { createHash } from "node:crypto";

/**
 * 会话文件/亲和头共用键。
 * ⚠️ 不能只做字符替换：`a/b` 与 `a:b` 会洗成同一个 `a_b`（碰撞=两任务互相串历史、
 * 共享 zen 会话亲和头）。可读前缀只为便于排查，唯一性由 sha256 前 12 位负责。
 *
 * ##379 起它是**目录名**（不再是文件名前缀）；算法一字未动（硬约束）。
 *
 * ⚠️ 空 uri 一律当场抛（##433）：`keyOf("")` 算出来的 `-e3b0c44298fc` 是**空串的 sha256 前 12 位** ——
 * 一个语法合法、读侧永远不会按它去找的**假会话目录**。静默拼出它 = 历史写进黑洞（写成功、读不回）。
 * 判据只有这一处：本模块是会话路径的**唯一出口**，`sessionDir` / `sessionFile` / `sessionIdOf` /
 * `sessionFileRel` / `legacySessionFile` 全部从它派生，故在这里拦一次就够，不要在各调用点各判一遍。
 */
export function keyOf(taskUri: string): string {
    if (typeof taskUri !== "string" || taskUri.trim().length === 0) {
        throw new Error(
            `agent/empty-task-uri: 会话路径需要非空 taskUri（收到 ${JSON.stringify(taskUri)}）；` +
                "空 uri 会拼出假目录 -<空串 sha256 前 12 位>",
        );
    }
    const readable = taskUri.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const sum = createHash("sha256").update(taskUri).digest("hex").slice(0, 12);
    return `${readable}-${sum}`;
}

/**
 * 会话 id（zen/go 会话亲和头 + 注册表条目 id）。
 * 从 keyOf 派生：**id 算法只有这一份** —— 亲和头、注册表条目、流量观测（`x-opencode-session`）
 * 三处必须同源。
 */
export function sessionIdOf(taskUri: string): string {
    return `local-${keyOf(taskUri)}`;
}
