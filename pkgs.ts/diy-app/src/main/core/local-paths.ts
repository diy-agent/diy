// src/main/core/local-paths.ts
// 🎯 会话落盘路径的**唯一出口**（key 算法只此一份）。
//
// 为什么单独一个模块：`prompt-registry` 的通道也要知道 llm 日志的相对路径 ——
// 索引注记的「回取命令」要写进 system 节点（当前真源是 `local-agent` 的 history 段，
// 由本模块的 `llmLogRelPath` 产出）。`local-agent` 已经 import 了 `prompt-registry`
// 的 assembleGlobals，反向 import 会成环；key 算法又不能复制第二份
// （两处算法漂移 = 模型按注释取不到原文，比不给索引更坏）。
//
// ── 落位（##379）：按项目路径分层，一个会话一个目录 ──
//   `$DIY_HOME/local/projects/4/tasks/266-07a945e1d52d/ops.jsonl | llm.jsonl | …`
//   · 目录名 = `keyOf(uri)`（**唯一性算法原样**，只是从文件名升成目录名）；
//   · 父路径 = uri 的路径部分；文件名 = `<kind>.jsonl`（不再带 key 前缀）。
//   旧落位（平铺 `local/<key>.<kind>.jsonl`）**不强制迁移**：读侧双认、写侧粘旧
//   （见 `resolveSessionFile` 的三条裁决）。存量文件由 `agent local migrate-layout` 搬迁。
//
// 约定：本模块只做主进程路径计算与目录创建，不含任何会话逻辑。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
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
 *
 * ##379 起它是**目录名**（不再是文件名前缀）；算法一字未动（硬约束）。
 */
export function keyOf(taskUri: string): string {
    const readable = taskUri.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const sum = createHash("sha256").update(taskUri).digest("hex").slice(0, 12);
    return `${readable}-${sum}`;
}

/**
 * 会话 id（zen/go 会话亲和头 + 注册表条目 id）。
 * 从 keyOf 派生：**id 算法只有这一份** —— local-agent 的亲和头、注册表条目、
 * 流量观测（traffic 的 `x-opencode-session`）三处必须同源，两处漂移 = 串会话。
 */
export function sessionIdOf(taskUri: string): string {
    return `local-${keyOf(taskUri)}`;
}

/** 会话子文件种类（**唯一清单**：双认 / 迁移 / clear 都按它走，别在各处再列一遍） */
export const SESSION_KINDS = ["ops", "llm", "usage", "steps", "compact", "changelog", "raw"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * uri → 目录段（`projects/4/tasks/379` → 同名三段）。
 * 过滤空段与 `.`/`..`：路径段只用来分层展示，**唯一性仍由 keyOf 保证**，
 * 所以即使某天 uri 形状变了（多一段、含奇怪字符），也不会逃出 `local/` 或撞名。
 */
function uriSegments(taskUri: string): string[] {
    return taskUri.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..");
}

/** 新落位（##379）：`local/<uri 路径…>/<keyOf(uri)>/` */
export function sessionDir(taskUri: string): string {
    return path.join(localDir(), ...uriSegments(taskUri), keyOf(taskUri));
}

/** 新落位下的文件绝对路径（**不判存在**；写侧目标） */
export function sessionFile(taskUri: string, kind: SessionKind): string {
    return path.join(sessionDir(taskUri), `${kind}.jsonl`);
}

/** 旧平铺落位（##379 之前；存量兼容用，见 `resolveSessionFile` 的「粘旧」裁决） */
export function legacySessionFile(taskUri: string, kind: SessionKind): string {
    return path.join(localDir(), `${keyOf(taskUri)}.${kind}.jsonl`);
}

/**
 * 相对 `$DIY_HOME` 的新落位路径（`local/<uri 路径…>/<key>/<kind>.jsonl`）。
 *
 * 与 `llmLogRelPath` 的区别：这个**不带「粘旧」裁决**，只描述新落位 —— 给两处用：
 * ① 意图测试要往**另一个进程的 home**（真 Electron 实例的 DIY_HOME）预置落盘状态，
 *    而 `sessionFile()` 只认本进程的 `diyHome()`（测试进程与实例是**两个** home）；
 * ② 迁移/审查要人读的相对路径。
 */
export function sessionFileRel(taskUri: string, kind: SessionKind): string {
    return path.relative(diyHome(), sessionFile(taskUri, kind)).split(path.sep).join("/");
}

/**
 * 会话文件解析 —— **读侧双认 + 写侧粘旧，同一裁决**（##379）：
 *   1. 新路径存在 → 新（迁移断点两侧并存时也取新：新是完整副本）；
 *   2. 旧平铺存在 → 旧（存量会话继续追加，历史不被劈成两半）；
 *   3. 都不在 → 新（新会话按新落位创建）。
 * ⚠️ 三条缺一不可：只有「新优先」会让存量会话的下一次 append 写到新文件、
 * 读侧从此只看得见新文件 = **历史静默腰斩**。
 */
export function resolveSessionFile(taskUri: string, kind: SessionKind): string {
    const next = sessionFile(taskUri, kind);
    if (existsSync(next)) return next;
    const legacy = legacySessionFile(taskUri, kind);
    if (existsSync(legacy)) return legacy;
    return next;
}

/**
 * 写侧入口：解析 + **确保父目录**。
 * ⚠️ 纯读且**高频**的场景（任务列表逐条 stat）不要用这个 —— 会撒一地空目录，用 `resolveSessionFile`。
 */
export function sessionFileForWrite(taskUri: string, kind: SessionKind): string {
    const file = resolveSessionFile(taskUri, kind);
    mkdirSync(path.dirname(file), { recursive: true });
    return file;
}

/**
 * 该会话在**新老两个落位**下的全部文件（迁移用）。
 */
export function sessionFileCandidates(taskUri: string): { file: string; legacy: boolean }[] {
    const seen = new Map<string, boolean>();
    for (const kind of SESSION_KINDS) {
        const next = sessionFile(taskUri, kind);
        const old = legacySessionFile(taskUri, kind);
        if (!seen.has(next)) seen.set(next, false);
        if (!seen.has(old)) seen.set(old, true);
    }
    return [...seen].map(([file, legacy]) => ({ file, legacy }));
}

/**
 * 「清空对话」要删的会话文件（**两个落位都删**）。
 * 必须两份都删：只删 `resolve` 命中的那一份，另一份会被读侧兜底重新认领 = 清空静默失效。
 * ⚠️ `changelog` **不在清单里**（它是跨会话审计时间线，见 local-agent clear 的注记）。
 */
export const CLEARED_SESSION_KINDS = ["ops", "llm", "raw", "steps", "usage", "compact"] as const;

export function sessionFilesToClear(taskUri: string): string[] {
    const out: string[] = [];
    for (const kind of CLEARED_SESSION_KINDS) {
        out.push(sessionFile(taskUri, kind), legacySessionFile(taskUri, kind));
    }
    return out;
}

/**
 * 会话 Op 流文件路径（**带建父目录**：调用点大多既读又写，写侧少一次 mkdir 就少一处 ENOENT）。
 * 导出供测试构造「历史对话已存在」的落盘状态：测试与产品共用同一路径实现
 * （key = 可读前缀 + uri 哈希），不复制 key 算法到测试里。
 */
export function opsFile(taskUri: string): string {
    return sessionFileForWrite(taskUri, "ops");
}

/** 全量消息日志（append-only；每行 1 条消息，行号即消息序号 —— 压缩注记的行号口径） */
export function llmFile(taskUri: string): string {
    return sessionFileForWrite(taskUri, "llm");
}

/** 会话日志的相对路径（相对 `$DIY_HOME`）——写进投递文本给模型/人照此回取 */
export function llmLogRelPath(taskUri: string): string {
    return path.relative(diyHome(), llmFile(taskUri)).split(path.sep).join("/");
}

/**
 * 该任务**是否对话过**（##355「干净任务」的判据）。
 *
 * 判据 = Op 日志存在且**非空**：`ops.jsonl` 是 append-only 的会话史书，只在真发起过轮次时
 * 才有内容；而 `agent.local.clear` 会**物理删掉**它（见 local-agent 的 clear 文件清单）⇒
 * 「存在且非空」与「对话过且没被清空」是同一件事。
 *
 * 为什么不做成读文件数行：本判据只服务列表展示（每任务一次 stat），要的是零成本的粗判；
 * 真实行数走 `agent.local.opsWatermark`（那里才需要精确水位）。
 * ⚠️ 不要拿「注册表里有没有该任务的条目」当本判据：**打开会话页**就会建条目（ops 订阅者
 * 变化 → noteActivity），"打开过"不等于"说过话"。
 */
export function hasConversation(taskUri: string): boolean {
    try {
        // 纯读：**不建目录**（列表页逐条调，建目录就是撒垃圾）
        return statSync(resolveSessionFile(taskUri, "ops")).size > 0;
    } catch {
        return false; // 不存在（没对话过）—— 与"读不到"同价：无证据即无对话
    }
}
