// agents-chain —— 从工作目录逐层向上收集 AGENTS.md，外层在前、最深处在后。
//
// 从 `apps/diy-app/services/prompt-registry.ts` 的 `chainOf` 搬来（2026-11-05）。
// 搬的理由：这批判据**全是实测踩出来的**，而且和任务/上下文树都无关 —— 任何 diy agent
// 都需要同一套「规则链怎么找」，包括新写的 bot。留在 diy-app 里等于让 bot 抄一遍（必走样）。
//
// 参数化掉的两处 diy-app 专属：
//   · `skipFiles`  要排除的文件（diy-app 传任务本体：`tasks/<tid>/AGENTS.md` 是任务正文，
//                  不是规则）
//   · `appHome`    「应用级规范」从哪个数据根取（`$DIY_HOME/AGENTS.md`）；无应用级规范
//                  的宿主传一个不存在的路径即可（自然缺席）
//
// ── 设计判据（逐条都有实测来源，见下方注释）──
//   · 上界 = `stopAt`（缺省 homedir）：不进 `/`、不进 `/Users` —— 家里那几层
//     （`~/AGENTS.md`、`~/git/AGENTS.md` …）是用户指定的全局规则，就是要逐层生效
//   · 排除任务本体：`tasks/<tid>/AGENTS.md` 是**任务正文**，由任务节单独投递
//   · **cwd 不在 stopAt 内**时只取该目录自身一层（不向上爬到无关目录）
//   · 应用级 `$DIY_HOME/AGENTS.md` **unshift 到最前**（它是"应用自己的规范"，比项目层更外）
//   · 内容 `trim()` —— 这是**数据准备**（链内容是变量值，不是模版源）

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** 链上的一节（与 `@diy-agent/context` 的 `ChainItemSchema` 同形；本包不依赖它，避免反向耦合） */
export interface AgentsChainItem {
    /** AGENTS.md 的绝对路径 */
    readonly path: string;
    /** 生效目录（= 该文件的 dirname） */
    readonly scope: string;
    /** 正文（已 trim） */
    readonly content: string;
}

export interface AgentsChainOptions {
    /**
     * 应用级规范的位置：只取 `<appHome>/AGENTS.md`，并放在链的最前。
     *
     * 无应用级概念的宿主传任意不存在的路径即可 —— `existsSync` 失败就自然缺席，
     * 不需要"关掉它"的开关。
     */
    readonly appHome: string;
    /** 起点目录（通常是工具执行目录） */
    readonly cwd: string;
    /**
     * 向上收集的上界（含）。
     *
     * 缺省 `homedir()`：`~/AGENTS.md`、`~/git/AGENTS.md` 这类全局规则要生效到每个任务。
     * 传 `cwd` 自身 = 只取一层（不向上爬）。
     */
    readonly stopAt?: string;
    /**
     * 要**排除**的文件（绝对路径）。
     *
     * diy-app 用它排除任务本体：`tasks/<tid>/AGENTS.md` 是任务正文，由任务节单独投递，
     * 混进规则链等于把正文当规则注入。
     */
    readonly skipFiles?: readonly string[];
    /**
     * `true` = **只取应用级规范**，不爬 cwd 的链。
     *
     * diy-app 的用途：项目目录与任务目录都不存在时（`isAppDir`），cwd 是
     * `process.cwd()` —— 即「应用进程恰好被启动在哪个目录」。那既不是任务的项目、
     * 也不是应用自己的规范，注入它等于把"启动 shell 的偶然位置"当成任务规范；
     * 而且该目录若正好是个大仓库（`apps/diy-app/AGENTS.md` 70 KB），还会把 system 预算吃光
     * （连"保存一条模版覆盖"都会被体积校验拒绝）。
     */
    readonly appOnly?: boolean;
}

/** 收集一条 AGENTS.md 链。**纯 IO、无业务概念** —— 谁都能用。 */
export function agentsChain(opts: AgentsChainOptions): AgentsChainItem[] {
    const stopAt = opts.stopAt ?? homedir();
    const start = resolve(opts.cwd);
    const appLevel = join(opts.appHome, 'AGENTS.md');
    const read = (path: string): AgentsChainItem => ({
        path,
        scope: dirname(path),
        content: readFileSync(path, 'utf-8').trim(),
    });

    // 只取应用级（见 `appOnly` 的注释：cwd 不可信时不该爬）
    if (opts.appOnly === true) {
        return existsSync(appLevel) ? [read(appLevel)] : [];
    }

    const stop = resolve(stopAt);
    // cwd 在上界之内才向上爬；不在（比如工作目录在 /tmp）就只取它自己一层
    const upward = start === stop || start.startsWith(stop + sep);
    const skip = new Set((opts.skipFiles ?? []).map((p) => resolve(p)));

    const seen = new Set<string>();
    const files: string[] = [];
    for (let dir = start; ; dir = dirname(dir)) {
        const fp = join(dir, 'AGENTS.md');
        if (!skip.has(resolve(fp)) && !seen.has(fp) && existsSync(fp)) {
            seen.add(fp);
            files.push(fp);
        }
        if (!upward || dir === stop || dir === dirname(dir)) break;
    }
    // 收集顺序是「最深处 → 最外层」；反过来才是「外层在前」
    files.reverse();
    // 应用级规范排在最前（它是"应用自己的规则"，比项目层更外）
    if (!seen.has(appLevel) && existsSync(appLevel)) files.unshift(appLevel);

    return files.map(read);
}
