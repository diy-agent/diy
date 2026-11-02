// dev-page.ts — 主进程侧的页面插件：把「树列表 / 启停 / 构建 / 打开」全做成方法，
// renderer 只负责画 DOM 与调 `page:invoke`（@diy-agent/workbench 的通道）。
//
// 为什么全在主进程：spawn / kill / 读注册表 / osascript 都是宿主能力；renderer 在 sandbox 里
// 拿不到 Node，也不该拿。

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureIdentity } from "@diy-agent/remote/node";
import type { PageContribution } from "@diy-agent/workbench";
import { DevRunner, cdpUrl, devLogDir, focusPid, memoryOf, openPath } from "./actions.js";
import { buildSnapshot, displayPath, matchRecord, readRecords, registryDir } from "./instances.js";
import { DEV_METHODS, isBuildCommand, isOpenMode, type DevSnapshot } from "./shared.js";
import { resolveTargets, type ResolvedTarget } from "./targets.js";

const here = dirname(fileURLToPath(import.meta.url)); // build/<variant>/main

/** 仓库根：从产物目录往上找「有 pkgs.ts 和 apps 的那一层」（worktree / 主仓都能命中） */
export function findRepoRoot(start: string = here): string {
    let dir = resolve(start);
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, "pkgs.ts")) && existsSync(join(dir, "apps"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(start);
}

function targetById(id: unknown): ResolvedTarget | null {
    if (typeof id !== "string") return null;
    return resolveTargets(findRepoRoot()).list.find((target) => target.id === id) ?? null;
}

/** 数据根 → instance-id（首次调用会把它落盘，和实例自己启动时做的是同一件事）；缓存避免每秒读盘 */
const nodeIds = new Map<string, string>();
export function nodeIdOf(home: string, app: string): string {
    const cached = nodeIds.get(home);
    if (cached !== undefined) return cached;
    try {
        const { identity } = ensureIdentity(home, { appName: app });
        nodeIds.set(home, identity.id);
        return identity.id;
    } catch {
        return "diy-unknown";
    }
}

const runner = new DevRunner(findRepoRoot(), devLogDir());

export function snapshot(): DevSnapshot {
    const targets = resolveTargets(findRepoRoot());
    return buildSnapshot(targets.list, {
        repoRoot: targets.repoRoot,
        records: readRecords(registryDir()),
        starting: runner.starting(),
        nodeIdOf,
        memOf: memoryOf,
        registry: registryDir(),
    });
}

export function startTarget(id: unknown): { ok: boolean; pid: number | null; logFile: string; reason: string } {
    const target = targetById(id);
    if (target === null) return { ok: false, pid: null, logFile: "", reason: `没有这个目标：${String(id)}` };
    const started = runner.start(target);
    return {
        ok: started.pid !== null,
        pid: started.pid,
        logFile: started.logFile,
        reason: started.pid === null ? "spawn 没有拿到 pid" : `已启动（pid ${started.pid}）`,
    };
}

export async function stopTarget(id: unknown): Promise<{ ok: boolean; killed: number[]; forced: boolean; reason: string }> {
    const target = targetById(id);
    if (target === null) return { ok: false, killed: [], forced: false, reason: `没有这个目标：${String(id)}` };
    const record = matchRecord(target, readRecords(registryDir()));
    if (record === null && !runner.starting().has(target.id)) {
        return { ok: false, killed: [], forced: false, reason: "该目标没有在运行" };
    }
    const result = await runner.stop(target, record);
    return {
        ok: true,
        killed: result.killed,
        forced: result.forced,
        reason: `已发 SIGTERM：${result.killed.join(", ") || "（无）"}${result.forced ? "；未退出，已 SIGKILL" : ""}`,
    };
}

export function focusTarget(id: unknown): { ok: boolean; reason: string } {
    const target = targetById(id);
    if (target === null) return { ok: false, reason: `没有这个目标：${String(id)}` };
    const record = matchRecord(target, readRecords(registryDir()));
    if (record === null) return { ok: false, reason: "该目标没有在运行" };
    return focusPid(record.pid);
}

export function openTargetPath(args: unknown): { ok: boolean; reason: string } {
    const input = (args ?? {}) as { id?: unknown; which?: unknown; mode?: unknown };
    const target = targetById(input.id);
    if (target === null) return { ok: false, reason: `没有这个目标：${String(input.id)}` };
    if (!isOpenMode(input.mode)) return { ok: false, reason: `不支持打开方式：${String(input.mode)}` };
    const which = input.which === "home" ? target.homePath : target.cwd;
    return openPath(which, input.mode);
}

export function runBuild(args: unknown): ReturnType<DevRunner["run"]> {
    const input = (args ?? {}) as { id?: unknown; command?: unknown };
    const target = targetById(input.id);
    if (target === null) throw new Error(`没有这个目标：${String(input.id)}`);
    if (!isBuildCommand(input.command)) throw new Error(`不允许的命令：${String(input.command)}`);
    return runner.run(target, input.command);
}

export function revealCdp(args: unknown): { ok: boolean; reason: string } {
    const input = (args ?? {}) as { id?: unknown };
    const target = targetById(input.id);
    if (target === null) return { ok: false, reason: `没有这个目标：${String(input.id)}` };
    const record = matchRecord(target, readRecords(registryDir()));
    const url = cdpUrl(record?.port ?? null);
    if (url === null) return { ok: false, reason: "该实例没有可用的调试端口（未就绪 / 未注册）" };
    return openPath(url, "finder");
}

/** 主进程页面插件（workbench 的 `pages` 形状） */
export const page: PageContribution = {
    id: "dev",
    title: "dev 启动器",
    icon: "⚙",
    methods: {
        [DEV_METHODS.snapshot]: () => snapshot(),
        [DEV_METHODS.start]: (args) => startTarget((args as { id?: unknown } | undefined)?.id),
        [DEV_METHODS.stop]: (args) => stopTarget((args as { id?: unknown } | undefined)?.id),
        [DEV_METHODS.focus]: (args) => focusTarget((args as { id?: unknown } | undefined)?.id),
        [DEV_METHODS.open]: (args) => openTargetPath(args),
        [DEV_METHODS.run]: (args) => runBuild(args),
        [DEV_METHODS.session]: () => runner.sessionSnapshot(),
        [DEV_METHODS.clearSession]: () => {
            runner.clearSession();
            return { ok: true, reason: "日志已清空" };
        },
        [DEV_METHODS.revealCdp]: (args) => revealCdp(args),
    },
};

export default page;

// 供单测用的旁路导出（不参与页面装配）
export { displayPath };
