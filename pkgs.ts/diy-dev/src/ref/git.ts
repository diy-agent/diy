// src/ref/git.ts — git 子进程封装（clone / checkout / pull）
//
// 外部命令防御：requireGit() 在调用前检查 git 存在，缺失给安装提示而非裸报错。
// 镜像目录作为「只读源码快照」，完整 clone 后显式检出目标 ref，避免浅历史不可达。
//
// 日志策略（193 重写）：
//   - 长命令（clone / fetch / pull）走 exec.runStreaming + ProgressRenderer 实时渲染
//     （TTY 原地重绘、非 TTY 里程碑行、静默心跳提示），替代旧 spawnSync「跑完才 dump」黑屏；
//   - 短命令（--version / checkout / symbolic-ref）走 runBuffered 缓冲执行；
//   - 超时分级（190 第四节）：ls-remote 15s、单 ref fetch 60s；clone / pull 不设硬超时
//     （5caf645 加过 clone 180s 被 8b2ae9e 故意删除——会误杀大仓库），卡住由 Ctrl+C 中断；
//   - 统一注入 GIT_TERMINAL_PROMPT=0（见 exec.ts）。
//
// clone 后 ref 检出策略：
//   - 无版本 / main → 保持默认分支 HEAD（track origin/默认分支，后续可 pull）
//   - SHA / tag（含非 semver 如 nightly，以本地 refs/tags/ 消歧）→ detached 检出，后续不 pull
//   - 显式分支名（develop/feat.x 等，斜杠分支整体作 ref 名）→ checkout -B <v> origin/<v>（本地 track，后续可 pull）
//   - /tree/<分支>/<子目录> 天然歧义（分支 feat/foo 根 vs 分支 feat 下 foo 目录），一律按 ref 名整体解释，
//     失败时提示改用 @<分支> 精确形式

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { runBuffered, runStreaming, type ExecResult } from "../git/exec";
import { getDefaultRenderer, type ProgressRenderer } from "./render";
import { isPinnedVersion, isShaVersion } from "./store";

export interface GitRunResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

/** 把带 \r 刷屏的 git 输出整理成多行可读文本（错误消息用）。 */
function readable(s: string): string {
    return s
        .split(/[\r\n]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .join("\n");
}

/** 短命令：回显 + 缓冲执行，结束后把命令回显 + 输出甩到 stderr。timeoutMs 可选（如 ls-remote 15s）。 */
function run(args: string[], cwd?: string, timeoutMs?: number): GitRunResult {
    process.stderr.write(`$ git ${args.join(" ")}${cwd ? `  # ${cwd}` : ""}\n`);
    const r = runBuffered(args, { cwd, timeoutMs });
    const out = r.stdout.trim();
    const err = r.stderr.trim();
    // 成功也放出来：用户要看到 git 是否进行中，而不只是失败时
    if (out) process.stderr.write(`${out}\n`);
    if (err) process.stderr.write(`${err}\n`);
    if (r.error) process.stderr.write(`${r.error}\n`);
    return { ok: r.ok, stdout: out, stderr: err, timedOut: r.timedOut };
}

/**
 * 流式跑长命令：命令回显 + stderr 进度实时进 renderer（无 renderer 用进程级默认），
 * 结束后吐残留缓冲。stdout（如 pull 合并摘要）结束时补一行。
 */
async function runStream(
    args: string[],
    opts: { cwd?: string; timeoutMs?: number; prog?: ProgressRenderer },
): Promise<ExecResult> {
    const prog = opts.prog ?? getDefaultRenderer();
    prog.info(`$ git ${args.join(" ")}${opts.cwd ? `  # ${opts.cwd}` : ""}`);
    const res = await runStreaming(args, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        onData: (chunk) => prog.feed(chunk),
        onIdle: (silentMs) => prog.waiting(silentMs),
    });
    prog.drain();
    const out = res.stdout.trim();
    if (out) prog.info(out);
    return res;
}

/** 检查 git 命令可用；缺失 throw 带安装提示的错误。 */
export function requireGit(): void {
    if (!run(["--version"]).ok) {
        throw new Error("缺少外部命令: git\n  安装 git 后重试：brew install git");
    }
}

/**
 * 校验 URL 是可达的 git 仓库（git ls-remote --heads）。
 * 仅供 add 阶段预检；15s 硬超时（190 核对表 #1）；不可达即 throw。
 */
export function verifyRemoteUrl(url: string): void {
    const res = run(["ls-remote", "--heads", "--", url], undefined, 15_000);
    if (!res.ok) {
        const why = res.timedOut
            ? "git ls-remote 超时（15s），网络过慢或不可达"
            : res.stderr || res.stdout || "git ls-remote 请求失败";
        throw new Error(`URL 无法访问或不是 git 仓库: ${url}\n  ${why}`);
    }
}

/** 本地是否存在该 tag（clone 拉全量 tags；loose ref 与 packed-refs 都查，纯 fs 不调 git 无噪音）。 */
function hasLocalTag(dir: string, tag: string): boolean {
    if (tag.includes("..")) return false; // 路径穿越守卫：走 fetch 路径安全失败
    if (existsSync(`${dir}/.git/refs/tags/${tag}`)) return true;
    try {
        const packed = readFileSync(`${dir}/.git/packed-refs`, "utf-8");
        return packed.split("\n").some((l) => l.endsWith(` refs/tags/${tag}`));
    } catch {
        return false;
    }
}

export interface MirrorOpts {
    /** 镜像目标目录（绝对路径） */
    dir: string;
    /** 仓库 URL（https / git@ssh 均可） */
    url: string;
    /**
     * 目标 ref：@ 后段 / /tree/ 后段 / releases / commit 统归一处。null/空 → 保持默认分支 HEAD；
     * SHA / tag → detached 检出；其余看作分支名检出。
     */
    version: string | null;
    /** 进度渲染器；缺省用进程级默认（stderr） */
    prog?: ProgressRenderer;
}

/**
 * clone 到 dir 并按 version 检出 ref。
 * 目录已含 git 仓库则跳过（交由 updateMirror 增量处理）。
 * clone 不设硬超时（190 第四节），进度实时渲染 + 心跳提示。
 */
export async function cloneMirror(opts: MirrorOpts): Promise<void> {
    const url = opts.url.trim();
    if (url.length === 0) throw new Error("git URL 为空");
    if (existsSync(`${opts.dir}/.git`)) return;

    mkdirSync(dirname(opts.dir), { recursive: true });
    const prog = opts.prog ?? getDefaultRenderer();

    const cl = await runStream(["clone", "--progress", "--", url, opts.dir], { prog });
    if (!cl.ok) {
        try {
            rmSync(opts.dir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
        const why = readable(cl.stderr) || readable(cl.stdout) || "git clone 失败";
        throw new Error(`clone 失败: ${why}`);
    }

    const v = (opts.version ?? "").trim();
    if (v.length === 0 || v === "main") return; // 保持默认分支（track，可 pull）

    // ref 消歧：clone 已拉全量 tags+heads。顺序：SHA → tag（含非 semver，以本地 refs 为准）→ 分支。
    if (isShaVersion(v)) {
        // commit：full clone 已含对象，直接 detached 检出
        const co = run(["-C", opts.dir, "checkout", v]);
        if (!co.ok) throw new Error(`checkout '${v}' 失败（仓库无该 commit）: ${co.stderr || ""}`);
        return;
    }
    if (isPinnedVersion(v) || hasLocalTag(opts.dir, v)) {
        // tag：本地已有直接 detached；缺失再 fetch 单 tag（兜底，如 tag 在 clone 后新建）。
        // 兜底 fetch 属短网络命令：给 60s 硬超时（超时分级，clone 才是不设超时的那个）
        if (!hasLocalTag(opts.dir, v)) {
            const f = await runStream(["-C", opts.dir, "fetch", "--progress", "origin", "tag", v], {
                prog,
                timeoutMs: 60_000,
            });
            if (!f.ok) {
                throw new Error(
                    f.timedOut
                        ? `拉取 tag '${v}' 失败（fetch 超时 60s）`
                        : `拉取 tag '${v}' 失败，请确认仓库存在该 tag`,
                );
            }
        }
        const co = run(["-C", opts.dir, "checkout", v]);
        if (!co.ok) throw new Error(`checkout '${v}' 失败: ${co.stderr || ""}`);
        return;
    }
    // 分支：fetch 并建本地 tracking 分支（origin/v 已在 clone 时拉取全部 heads）
    const originRef = `origin/${v}`;
    if (!existsSync(`${opts.dir}/.git/refs/remotes/${originRef}`)) {
        const f = await runStream(["-C", opts.dir, "fetch", "--progress", "origin", v], {
            prog,
            timeoutMs: 60_000,
        });
        if (!f.ok) {
            throw new Error(
                (f.timedOut
                    ? `拉取分支 '${v}' 失败（fetch 超时 60s）`
                    : `拉取分支 '${v}' 失败，请确认仓库存在该分支`) +
                    `（若从 /tree/ 复制且地址含子目录如 …/tree/<分支>/<子目录>，请改用 @<分支> 精确形式）`,
            );
        }
    }
    const co = run(["-C", opts.dir, "checkout", "-B", v, originRef]);
    if (!co.ok) throw new Error(`checkout '${v}' 失败: ${co.stderr || ""}`);
}

export interface UpdateOutcome {
    /** true=已执行 pull/更新；false=tag 固定未动 */
    updated: boolean;
    note?: string;
}

/**
 * 更新已有镜像，对齐增量策略：
 *   - tag / SHA（不可变）→ 不 pull
 *   - 分支 / 无版本（track 默认分支）→ git pull --ff-only 快进到远端最新
 * 安全网：detached HEAD（SHA / 非 semver tag 检出，正则初判漏网时）一律不 pull。
 * 跳过原因经 note 返回，由调用方（impl）渲染条目行——本函数不再直写 stderr。
 */
export async function updateMirror(
    dir: string,
    isTag: boolean,
    prog?: ProgressRenderer,
): Promise<UpdateOutcome> {
    if (isTag) return { updated: false, note: "tag 固定，跳过 pull" };
    if (!run(["-C", dir, "symbolic-ref", "-q", "HEAD"]).ok) {
        return { updated: false, note: "detached HEAD，跳过 pull" };
    }
    const res = await runStream(["-C", dir, "pull", "--progress", "--ff-only", "origin"], {
        prog,
    });
    if (!res.ok) {
        const why = readable(res.stderr) || readable(res.stdout) || "git pull 失败";
        throw new Error(`git pull 失败（${dir}）: ${why}`);
    }
    return { updated: true };
}
