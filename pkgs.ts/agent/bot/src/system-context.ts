// system-context.ts — bot 的**简化版**系统上下文组装器（##516）
//
// 为什么不复用 diy-app 的那套：真正的组装器在 `apps/diy-app/src/main/services/`
// （prompt-registry 的 AGENTS.md 链 + facts-context 的投影），依赖 Electron / 任务 /
// 房间 / 模版引擎 —— bot 用不了，也不该被拖进去。`@diy-agent/context` 只是**信封格式**
// （渲染 / 解析 prompt 里的上下文块），同样不是组装器。
//
// 这里只做一件事，只读：AGENTS.md 链 —— `$DIY_HOME/AGENTS.md` → `$HOME` 逐层 → 工作目录逐层（外 → 内）。
// （原先还有「② facts 摘要」：随 2026-11-19 yaml 事实库退役一起删了 —— 它读 `knowledge/facts/`，
//   那个目录早已不存在，恒返回空串。知识库索引现在由 `@diy-agent/entity-runtime` 的 kbProvider 投。）
//
// 三条硬约束（##516 body）：
//   · 只在**新建会话**时调用一次（`chat.ts` 里与 instructions 同一时机）—— 每轮重写会打碎前缀缓存
//   · 有长度上限（缺省 8 KB），超了按优先级截断并**标注**
//   · 组装失败**不抛**（降级为缺席）—— 上下文构造失败 = 人发不出消息

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** 系统上下文的缺省字节上限（UTF-8）—— 与 diy-app 的 system 预算同量级 */
export const SYSTEM_CONTEXT_MAX_BYTES = 8192;

/** AGENTS.md 链上的一层（外层在前） */
export interface AgentsFileRef {
    /** 文件绝对路径 */
    readonly path: string;
    /** 生效目录（文件所在目录） */
    readonly scope: string;
    readonly content: string;
}

export interface SystemContextOptions {
    /** 数据根（`$DIY_HOME`）：它的 `AGENTS.md` 是应用级规范 */
    readonly home: string;
    /** 工作目录（bot 的 workspace）；缺省 = `$DIY_HOME` */
    readonly cwd?: string;
    /** 字节上限；缺省 {@link SYSTEM_CONTEXT_MAX_BYTES} */
    readonly maxBytes?: number;
}

export interface SystemContextResult {
    /** 直接塞进 system 的正文（空串 = 什么都没读到） */
    readonly text: string;
    /** 正文的 UTF-8 字节数 */
    readonly bytes: number;
    /** 链上实际读到的文件（外层在前） */
    readonly chain: readonly AgentsFileRef[];
    /** 被预算截掉的部分（人可读；空数组 = 没截） */
    readonly omitted: readonly string[];
}

const EMPTY: SystemContextResult = { text: '', bytes: 0, chain: [], omitted: [] };

/**
 * AGENTS.md 链：从工作目录逐层向上到 `$HOME`，外层在前；再加 `$DIY_HOME/AGENTS.md`。
 *
 * 与 diy-app（`prompt-registry.ts` 的 `chainOf`）同口径的三条：
 *   · 上界 = `$HOME`（不进 `/`、不进 `/Users`）：`~/AGENTS.md`、`~/git/AGENTS.md` 是全局规则
 *   · 工作目录不在 `$HOME` 内时只取该目录自身一层（别把「进程恰好启动在哪」当成规范）
 *   · 应用级 `$DIY_HOME/AGENTS.md` 恒在链首（去重）
 *
 * 与 diy-app 的差异：不排除任务正文（bot 没有任务概念）。
 */
export function agentsChainOf(options: { home: string; cwd?: string }): AgentsFileRef[] {
    const start = resolve(options.cwd ?? options.home);
    const userHome = homedir();
    const underHome = start === userHome || start.startsWith(userHome + sep);
    const stop = underHome ? userHome : start;

    const seen = new Set<string>();
    const files: string[] = [];
    for (let dir = start; ; dir = dirname(dir)) {
        const file = join(dir, 'AGENTS.md');
        if (!seen.has(file) && existsSync(file)) {
            seen.add(file);
            files.push(file);
        }
        if (dir === stop || dir === dirname(dir)) break;
    }
    files.reverse(); // 外层在前
    const appLevel = join(options.home, 'AGENTS.md');
    if (!seen.has(appLevel) && existsSync(appLevel)) files.unshift(appLevel);

    const out: AgentsFileRef[] = [];
    for (const file of files) {
        const content = readText(file);
        if (content !== '') out.push({ path: file, scope: dirname(file), content });
    }
    return out;
}

function readText(file: string): string {
    try {
        return readFileSync(file, 'utf-8').trim();
    } catch {
        return '';
    }
}

/**
 * 组装系统上下文（**永不抛**）。
 *
 * 顺序即优先级：AGENTS.md 链外层 → 内层。
 * 超预算时从**尾部**砍（内层规则 > 外层），并在末尾标注砍掉了什么 ——
 * 静默截断等于让人以为「规则只有这些」。
 */
export function buildSystemContext(options: SystemContextOptions): SystemContextResult {
    try {
        const budget = options.maxBytes ?? SYSTEM_CONTEXT_MAX_BYTES;
        const chain = agentsChainOf(options);

        const parts: Array<{ label: string; text: string }> = chain.map((file) => ({
            label: file.path,
            text: `<!-- AGENTS.md: ${file.path}（作用域 ${file.scope}） -->\n${file.content}`,
        }));

        const kept: string[] = [];
        const omitted: string[] = [];
        let used = 0;
        for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i]!;
            const cost = Buffer.byteLength(part.text, 'utf-8') + 2; // +2 = 段间空行
            if (used + cost <= budget) {
                kept.push(part.text);
                used += cost;
                continue;
            }
            // 装不下就从这里开始整段放弃：靠后的段优先级更低，
            // 「跳过大的、塞进后面小的」会打乱优先级顺序（外层规则 > 内层）。
            omitted.push(...parts.slice(i).map((rest) => rest.label));
            break;
        }
        if (omitted.length > 0) {
            // 截断必须**可见**：静默截断会让人以为「规则只有这些」
            kept.push(
                `<!-- 系统上下文超过上限 ${String(budget)} 字节：已省略 ${String(omitted.length)} 段（${omitted.join('、')}） -->`,
            );
        }
        const text = kept.join('\n\n');
        return { text, bytes: Buffer.byteLength(text, 'utf-8'), chain, omitted };
    } catch {
        // 组装失败 = 降级为缺席：上下文构造失败不该让人发不出消息
        return EMPTY;
    }
}
