// dev-page.ts — 主进程侧的页面插件：静态发现 + 运行时对账 + 启停 / 打开 / 跑命令。
//
// 分工（##502 第二轮）：
//   · 静态清单：`discovery.ts`（git worktree list × apps/*/app.yaml）—— 不读注册表
//   · 动态状态：`instances.ts`（注册表按 `(worktree, app, launch)` 对上）
//   · 动作：`actions.ts`（spawn / kill / 打开 / 白名单命令）
//
// renderer 只负责画 DOM 与调 `page:invoke`；spawn / kill / 读注册表都是宿主能力。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRootOf, type PageContribution } from "@diy-agent/workbench";
import { DevRunner, cdpUrl, devLogDir, focusPid, memoryOf, openPath } from "./actions.js";
import { discoverAppsIn, listWorktrees } from "./discovery.js";
import { buildSnapshot, launchKey, matchRecord, readRecords, registryDir } from "./instances.js";
import {
    DEV_METHODS,
    isBuildCommand,
    isOpenMode,
    type AppSpec,
    type DevSnapshot,
    type LaunchRef,
} from "./shared.js";

const runner = new DevRunner(devLogDir());

/** 仓库根：从产物目录往上找到带 `.git` 的那一层（worktree / 主仓都能命中） */
export const REPO_ROOT = repoRootOf();

/** 静态发现的结果（每次 snapshot 都重扫：新加 app.yaml / 新开 worktree 立刻出现） */
interface Discovery {
    readonly worktrees: ReturnType<typeof listWorktrees>;
    readonly appsByWorktree: Map<string, readonly AppSpec[]>;
    readonly problems: readonly string[];
}

function discover(): Discovery {
    const worktrees = listWorktrees(REPO_ROOT);
    const appsByWorktree = new Map<string, readonly AppSpec[]>();
    const problems: string[] = [];
    for (const worktree of worktrees) {
        const found = discoverAppsIn(worktree.path);
        appsByWorktree.set(worktree.path, found.apps);
        problems.push(...found.problems);
    }
    return { worktrees, appsByWorktree, problems };
}

function builtOf(worktree: string): boolean {
    return existsSync(join(worktree, "build"));
}

export function snapshot(): DevSnapshot {
    const found = discover();
    return buildSnapshot(found.worktrees, {
        repoRoot: REPO_ROOT,
        worktrees: found.worktrees,
        appsOf: (worktree) => found.appsByWorktree.get(worktree) ?? [],
        records: readRecords(registryDir()),
        starting: runner.starting(),
        problems: found.problems,
        builtOf,
        memOf: memoryOf,
        registry: registryDir(),
    });
}

/** 解析 `(worktree, app, launch)` 三元组，拿到静态声明（找不到 = 参数不对） */
function resolveLaunch(ref: LaunchRef): { app: AppSpec; launch: AppSpec["launches"][number] } | null {
    const found = discoverAppsIn(ref.worktree).apps.find((app) => app.name === ref.app);
    if (found === undefined) return null;
    const launch = found.launches.find((item) => item.id === ref.launch);
    if (launch === undefined) return null;
    return { app: found, launch };
}

function recordOf(ref: LaunchRef) {
    return readRecords(registryDir()).find((rec) => matchRecord(rec, ref)) ?? null;
}

export function startLaunch(ref: LaunchRef): { ok: boolean; pid: number | null; logFile: string; reason: string } {
    const resolved = resolveLaunch(ref);
    if (resolved === null) return { ok: false, pid: null, logFile: "", reason: `没有这个 launch：${ref.app}.${ref.launch}` };
    const started = runner.start({
        key: launchKey(ref.worktree, ref.app, ref.launch),
        appDir: resolved.app.dir,
        launch: resolved.launch,
    });
    return {
        ok: started.pid !== null,
        pid: started.pid,
        logFile: started.logFile,
        reason: started.pid === null ? "spawn 没有拿到 pid" : `已启动（pid ${started.pid}）`,
    };
}

export async function stopLaunch(ref: LaunchRef): Promise<{ ok: boolean; killed: number[]; forced: boolean; reason: string }> {
    const resolved = resolveLaunch(ref);
    if (resolved === null) return { ok: false, killed: [], forced: false, reason: `没有这个 launch：${ref.app}.${ref.launch}` };
    const key = launchKey(ref.worktree, ref.app, ref.launch);
    const record = recordOf(ref);
    if (record === null && !runner.starting().has(key)) {
        return { ok: false, killed: [], forced: false, reason: "该 launch 没有在运行" };
    }
    const result = await runner.stop(key, record);
    return {
        ok: true,
        killed: result.killed,
        forced: result.forced,
        reason: `已发 SIGTERM：${result.killed.join(", ") || "（无）"}${result.forced ? "；未退出，已 SIGKILL" : ""}`,
    };
}

export function focusLaunch(ref: LaunchRef): { ok: boolean; reason: string } {
    if (resolveLaunch(ref) === null) return { ok: false, reason: `没有这个 launch：${ref.app}.${ref.launch}` };
    const record = recordOf(ref);
    if (record === null) return { ok: false, reason: "该 launch 没有在运行" };
    return focusPid(record.pid);
}

/** 打开：URL（浏览器）或某个路径（app 目录 / worktree 根） */
export function openTarget(args: unknown): { ok: boolean; reason: string } {
    const input = (args ?? {}) as { url?: unknown; which?: unknown; worktree?: unknown; app?: unknown; mode?: unknown };
    if (typeof input.url === "string" && input.url !== "") {
        return openPath(input.url, "finder");
    }
    if (typeof input.worktree !== "string" || typeof input.app !== "string") {
        return { ok: false, reason: "open 需要 url 或 (worktree, app, which)" };
    }
    if (!isOpenMode(input.mode)) return { ok: false, reason: `不支持打开方式：${String(input.mode)}` };
    const apps = discoverAppsIn(input.worktree).apps;
    const path = input.which === "worktree" ? input.worktree : apps.find((app) => app.name === input.app)?.dir;
    if (path === undefined) return { ok: false, reason: `找不到 app 目录：${input.app}` };
    return openPath(path, input.mode);
}

export function runBuild(args: unknown): ReturnType<DevRunner["run"]> {
    const input = (args ?? {}) as { worktree?: unknown; app?: unknown; launch?: unknown; command?: unknown };
    if (
        typeof input.worktree !== "string" ||
        typeof input.app !== "string" ||
        typeof input.launch !== "string" ||
        !isBuildCommand(input.command)
    ) {
        throw new Error(`run 参数不合法（要 launch 三元组 + 白名单命令）：${JSON.stringify(args)}`);
    }
    const ref: LaunchRef = { worktree: input.worktree, app: input.app, launch: input.launch };
    const resolved = resolveLaunch(ref);
    if (resolved === null) throw new Error(`没有这个 launch：${ref.app}.${ref.launch}`);
    return runner.run(launchKey(ref.worktree, ref.app, ref.launch), resolved.app.dir, input.command);
}

export function revealCdp(ref: LaunchRef): { ok: boolean; reason: string } {
    const record = recordOf(ref);
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
        [DEV_METHODS.start]: (args) => startLaunch(args as LaunchRef),
        [DEV_METHODS.stop]: (args) => stopLaunch(args as LaunchRef),
        [DEV_METHODS.focus]: (args) => focusLaunch(args as LaunchRef),
        [DEV_METHODS.open]: (args) => openTarget(args),
        [DEV_METHODS.run]: (args) => runBuild(args),
        [DEV_METHODS.session]: () => runner.sessionSnapshot(),
        [DEV_METHODS.clearSession]: () => {
            runner.clearSession();
            return { ok: true, reason: "日志已清空" };
        },
        [DEV_METHODS.revealCdp]: (args) => revealCdp(args as LaunchRef),
    },
};

export default page;
