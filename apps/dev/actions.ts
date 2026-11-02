// actions.ts — 启停 / 唤出 / 打开 / 跑命令的真正执行层。
//
// 三条边界：
//   · **启动不聚焦**：子进程带 `DIY_NO_FOCUS=1`（外壳据此 showInactive），并且独立进程组
//     （`detached`）—— 关闭时整组 SIGTERM，不留 vite / tsx 孤儿。
//   · **只认白名单命令**：构建组固定为 build/check/test/sync/build-pkgs/clean，拒绝任意命令。
//   · **输出进内存 + 文件**：UI 只读尾部；完事后日志还在 `<数据根>/log/dev/` 里可查。

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandSession, LaunchSpec } from "./shared.js";
import type { InstanceRecordLite } from "./instances.js";

/** 跑命令时可继承、但**会误导子进程**的变量：全部剔除（数据根 / 变体 / launch 由这一层决定） */
const STRIPPED_ENV = ["DIY_HOME", "DIY_ENV", "DIY_VARIANT", "DIY_LAUNCH", "DIY_CLI"] as const;

/** 子进程环境：剔除继承的数据根类变量，再叠这条 launch 的（`DIY_INSTANCE_REGISTRY` 保留 = 测试隔离） */
export function launchEnv(launch: LaunchSpec, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    for (const key of STRIPPED_ENV) delete env[key];
    env["DIY_ENV"] = "development";
    env["DIY_NO_FOCUS"] = "1";
    // 注册表靠它把运行时对回 app.yaml 的那一条（匹配键之一）
    env["DIY_LAUNCH"] = launch.id;
    return { ...env, ...launch.env };
}

/** 去掉 ANSI 转义（sha.sh 的彩色输出进 UI 会变成乱码方块） */
export function stripAnsi(text: string): string {
    // oxlint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** 日志目录：dev app 自己的数据根下 `log/dev/` */
export function devLogDir(env: NodeJS.ProcessEnv = process.env): string {
    const home = env["DIY_HOME"];
    return join(home !== undefined && home !== "" ? home : join(tmpdir(), "diy-dev"), "log", "dev");
}

/** pid 的内存占用（字节）；取不到 = null */
export function memoryOf(pid: number): number | null {
    try {
        const out = readFileSync(`/proc/${pid}/statm`, "utf-8");
        const pages = Number(out.split(" ")[1]);
        if (Number.isFinite(pages)) return pages * 4096;
    } catch {
        /* 非 Linux：退回 ps */
    }
    try {
        const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
            encoding: "utf-8",
            timeout: 1500,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const kb = Number(out);
        return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
    } catch {
        return null;
    }
}

/** 关闭时要发信号的那些 pid：记录里的进程 + 它的启动器父进程（vite / tsx / sha.sh） */
export function killPlan(record: InstanceRecordLite | null): number[] {
    if (record === null) return [];
    const out = new Set<number>([record.pid]);
    for (const parent of record.parents.slice(0, 3)) {
        if (/electron-dev|vite|tsx|sha\.sh|npm/.test(parent.command)) out.add(parent.pid);
    }
    return [...out];
}

const SESSION_LIMIT = 2000;

/** 每个 launch 一条日志文件；key 里的路径分隔符不能进文件名 */
export function logFileName(key: string): string {
    // oxlint-disable-next-line no-control-regex -- key 里的分隔符就是 NUL（见 instances.launchKey）
    return `${key.replace(/[\\/]+/g, "_").replace(/\u0000/g, "--")}.log`;
}

interface MutableSession {
    id: number;
    key: string;
    command: string;
    commandLine: string;
    running: boolean;
    startedAt: string;
    lines: string[];
    child: ChildProcess | null;
}

export interface StartInput {
    /** `(worktree, app, launch)` 的 key */
    readonly key: string;
    /** 命令在哪执行（app 目录） */
    readonly appDir: string;
    readonly launch: LaunchSpec;
}

export class DevRunner {
    private readonly children = new Map<string, ChildProcess>();
    private session: MutableSession | null = null;
    private seq = 0;

    constructor(
        private readonly logDir: string = devLogDir(),
        private readonly spawnFn: typeof spawn = spawn,
    ) {
        mkdirSync(this.logDir, { recursive: true });
    }

    /** 已经拉起、但还没出现在注册表里的 launch（构建 / 启动中） */
    starting(): Set<string> {
        const out = new Set<string>();
        for (const [key, child] of this.children) {
            if (child.exitCode === null && child.signalCode === null) out.add(key);
        }
        return out;
    }

    /** 启动：独立进程组 + 输出落文件；立即返回 pid（不等待构建完成） */
    start(input: StartInput): { pid: number | null; logFile: string } {
        const existing = this.children.get(input.key);
        if (existing && existing.exitCode === null && existing.signalCode === null) {
            return { pid: existing.pid ?? null, logFile: this.logFileFor(input.key) };
        }
        mkdirSync(this.logDir, { recursive: true });
        const logFile = this.logFileFor(input.key);
        const out = createWriteStream(logFile, { flags: "a" });
        out.write(
            `\n===== ${new Date().toISOString()} 启动 ${input.launch.command}（cwd=${input.appDir}）=====\n`,
        );
        // 一条启动命令 = 一段 shell（app.yaml 里写的就是人怎么手工跑它）
        const child = this.spawnFn(input.launch.command, {
            cwd: input.appDir,
            env: launchEnv(input.launch),
            shell: true,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.pipe(out);
        child.stderr?.pipe(out);
        child.on("exit", () => out.end());
        child.unref();
        this.children.set(input.key, child);
        return { pid: child.pid ?? null, logFile };
    }

    /** 停止：先整组 SIGTERM，2 秒后还活着就 SIGKILL；返回实际发过信号的 pid */
    async stop(key: string, record: InstanceRecordLite | null): Promise<{ killed: number[]; forced: boolean }> {
        const killed: number[] = [];
        const spawned = this.children.get(key);
        if (spawned !== undefined && spawned.pid !== undefined && spawned.exitCode === null) {
            try {
                process.kill(-spawned.pid, "SIGTERM");
                killed.push(spawned.pid);
            } catch {
                try {
                    spawned.kill("SIGTERM");
                    killed.push(spawned.pid);
                } catch {
                    /* 已经退了 */
                }
            }
        }
        for (const pid of killPlan(record)) {
            if (killed.includes(pid)) continue;
            try {
                process.kill(pid, "SIGTERM");
                killed.push(pid);
            } catch {
                /* 已经退了 */
            }
        }
        const watch = record?.pid ?? spawned?.pid;
        let forced = false;
        if (watch !== undefined) {
            for (let i = 0; i < 20; i++) {
                if (!(await alive(watch))) break;
                if (i === 19) {
                    try {
                        process.kill(watch, "SIGKILL");
                        forced = true;
                    } catch {
                        /* 刚好退了 */
                    }
                } else {
                    await sleep(100);
                }
            }
        }
        this.children.delete(key);
        return { killed, forced };
    }

    /** 跑构建 / 检查命令（白名单在调用方校验）；输出逐行进 session */
    run(key: string, appDir: string, command: string): CommandSession {
        if (this.session?.running) this.session.child?.kill("SIGTERM");
        const session: MutableSession = {
            id: ++this.seq,
            key,
            command,
            commandLine: `./sha.sh ${command}`,
            running: true,
            startedAt: new Date().toISOString(),
            lines: [],
            child: null,
        };
        this.session = session;
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const name of STRIPPED_ENV) delete env[name];
        const child = this.spawnFn("./sha.sh", [command], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
        session.child = child;
        const push = (chunk: Buffer): void => {
            for (const line of stripAnsi(chunk.toString()).split(/\r?\n/)) {
                if (line === "") continue;
                session.lines.push(line);
                if (session.lines.length > SESSION_LIMIT) session.lines.splice(0, session.lines.length - SESSION_LIMIT);
            }
        };
        child.stdout?.on("data", push);
        child.stderr?.on("data", push);
        child.on("exit", (code, signal) => {
            session.running = false;
            session.lines.push(`—— 结束（${signal === null ? `exit ${code ?? "?"}` : signal}）——`);
        });
        return sessionSnapshotOf(session);
    }

    sessionSnapshot(): CommandSession | null {
        return this.session === null ? null : sessionSnapshotOf(this.session);
    }

    clearSession(): void {
        this.session = null;
    }

    dispose(): void {
        for (const child of this.children.values()) {
            if (child.exitCode === null && child.pid !== undefined) {
                try {
                    process.kill(-child.pid, "SIGTERM");
                } catch {
                    /* 忽略 */
                }
            }
        }
        this.children.clear();
    }

    private logFileFor(key: string): string {
        return join(this.logDir, logFileName(key));
    }
}

function sessionSnapshotOf(session: MutableSession): CommandSession {
    return {
        id: session.id,
        key: session.key,
        command: session.command,
        commandLine: session.commandLine,
        running: session.running,
        startedAt: session.startedAt,
        lines: [...session.lines],
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function alive(pid: number): Promise<boolean> {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

// ── 打开路径 / 唤出窗口 ─────────────────────────────────────────

export interface OpenResult {
    readonly ok: boolean;
    readonly reason: string;
}

/** 用系统方式打开一个路径 / URL：Finder / VS Code / 终端 / 默认浏览器（macOS；其他平台给近似） */
export function openPath(pathOrUrl: string, mode: "finder" | "editor" | "terminal"): OpenResult {
    const mac = process.platform === "darwin";
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(pathOrUrl);
    let cmd: string;
    let args: string[];
    if (mode === "editor") {
        cmd = "code";
        args = [pathOrUrl];
    } else if (mode === "terminal") {
        if (mac) {
            cmd = "open";
            args = ["-a", "Terminal", pathOrUrl];
        } else {
            cmd = "x-terminal-emulator";
            args = [`--working-directory=${pathOrUrl}`];
        }
    } else if (mac) {
        // Finder 打开本地路径 / 默认浏览器打开 URL —— 都是 `open`
        cmd = "open";
        args = [pathOrUrl];
    } else {
        cmd = "xdg-open";
        args = [pathOrUrl];
    }
    try {
        const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
        child.on("error", () => undefined);
        child.unref();
        return { ok: true, reason: `${cmd} ${args.join(" ")}${isUrl ? "（默认浏览器）" : ""}` };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * 把目标窗口拉到前台：macOS 走 System Events（与 diy-app 的 `focusProcess` 同一手法）。
 * **同步取结果**：失败（没辅助功能权限 / 进程已走）要如实报给用户，不能先回 ok 再说。
 */
export function focusPid(pid: number): OpenResult {
    if (process.platform !== "darwin") {
        return { ok: false, reason: `本平台（${process.platform}）暂不支持按 pid 前置窗口` };
    }
    try {
        execFileSync(
            "osascript",
            ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`],
            { timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
        );
        return { ok: true, reason: `已把 pid ${pid} 拉到前台` };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const hint = message.includes("-1743")
            ? "（系统设置 → 隐私与安全性 → 自动化：允许 diy 控制 System Events）"
            : "";
        return { ok: false, reason: `${message}${hint}` };
    }
}

/** 打开 CDP 端点：Electron 的 /json 列表就是「所有可调试页面」 */
export function cdpUrl(port: number | null): string | null {
    if (port === null || port <= 0) return null;
    return `http://127.0.0.1:${port}/json`;
}
