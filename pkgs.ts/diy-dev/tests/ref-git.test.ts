/**
 * ref-git.test.ts — git 子进程封装单测（clone / checkout / pull）
 *
 * 用测试内自建本地 git 仓库构造 src（含默认分支、tag v1.0.0、分支 develop），
 * 全部离线，不触网。cloneMirror 直接收 url 参数（不经 parseRepoUrl），可喂本地路径。
 * 193 起 clone/update 走流式执行（exec.runStreaming），测试需 await。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cloneMirror, updateMirror, requireGit } from "../src/ref/git";
import { ProgressRenderer, getDefaultRenderer, setDefaultRendererForTest } from "../src/ref/render";

let root: string;
let src: string;

/** 跑 git 命令并断言成功 */
function g(args: string[], cwd?: string): string {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    return (r.stdout ?? "").trim();
}

/** 构造 src 仓库：master 分支一个提交 + tag v1.0.0 + 分支 develop 一个提交 */
function buildSrcRepo(): void {
    g(["init", "-b", "master", src]);
    g(["config", "user.email", "t@t"], src);
    g(["config", "user.name", "t"], src);
    writeFileSync(join(src, "a.txt"), "1", "utf-8");
    g(["add", "."], src);
    g(["commit", "-m", "c1"], src);
    g(["tag", "v1.0.0"], src);
    g(["checkout", "-b", "develop"], src);
    writeFileSync(join(src, "a.txt"), "2", "utf-8");
    g(["add", "."], src);
    g(["commit", "-m", "c2"], src);
    g(["checkout", "master"], src);
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "refgit-"));
    src = join(root, "src");
    requireGit();
    buildSrcRepo();
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("cloneMirror", () => {
    it("无版本 → clone 默认分支 HEAD（master）", async () => {
        const dir = join(root, "main");
        await cloneMirror({ dir, url: src, version: null });
        expect(existsSync(`${dir}/.git`)).toBe(true);
        expect(g(["symbolic-ref", "--short", "HEAD"], dir)).toBe("master");
        expect(existsSync(join(dir, "a.txt"))).toBe(true);
    });

    it("tag 版本 → detached at tag", async () => {
        const dir = join(root, "v1.0.0");
        await cloneMirror({ dir, url: src, version: "v1.0.0" });
        const head = g(["rev-parse", "HEAD"], dir);
        const tag = g(["rev-parse", "v1.0.0"], src);
        expect(head).toBe(tag);
        // detached：无当前分支
        const { status } = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
            cwd: dir,
            encoding: "utf-8",
        });
        expect(status).not.toBe(0);
    });

    it("分支版本 → 检出为本地 tracking 分支", async () => {
        const dir = join(root, "develop");
        await cloneMirror({ dir, url: src, version: "develop" });
        expect(g(["symbolic-ref", "--short", "HEAD"], dir)).toBe("develop");
        // develop 上 a.txt 应为 "2"（develop 的提交内容）
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("2");
    });

    it("目录已含 git 仓库 → 跳过（幂等）", async () => {
        const dir = join(root, "main");
        await cloneMirror({ dir, url: src, version: null });
        // 第二次调用不应重建（保持原 HEAD）
        const headBefore = g(["rev-parse", "HEAD"], dir);
        await cloneMirror({ dir, url: src, version: null });
        expect(g(["rev-parse", "HEAD"], dir)).toBe(headBefore);
    });
});

describe("updateMirror", () => {
    it("分支 → pull 返回 updated:true（无远端变化也是成功）", async () => {
        const dir = join(root, "main");
        await cloneMirror({ dir, url: src, version: null });
        const out = await updateMirror(dir, false);
        expect(out.updated).toBe(true);
    });

    it("tag → 跳过返回 updated:false + note", async () => {
        const dir = join(root, "tag");
        await cloneMirror({ dir, url: src, version: "v1.0.0" });
        const out = await updateMirror(dir, true);
        expect(out.updated).toBe(false);
        expect(out.note).toContain("tag");
    });

    it("分支 pull 拉到 src 的新提交", async () => {
        const dir = join(root, "main");
        await cloneMirror({ dir, url: src, version: null });
        // src 新增一个提交
        writeFileSync(join(src, "b.txt"), "new", "utf-8");
        g(["add", "."], src);
        g(["commit", "-m", "c3"], src);
        const before = g(["rev-parse", "HEAD"], dir);
        await updateMirror(dir, false);
        const after = g(["rev-parse", "HEAD"], dir);
        expect(after).not.toBe(before);
        expect(existsSync(join(dir, "b.txt"))).toBe(true);
    });
});

describe("短命令输出通道（review §二#5 探针）", () => {
    it("run() 回显走 getDefaultRenderer().info()（F4 统一通道），且可复位", () => {
        const writes: string[] = [];
        const fake = new ProgressRenderer(
            { write: (s: string) => void writes.push(s) },
            { isTTY: false },
        );
        setDefaultRendererForTest(fake);
        try {
            requireGit(); // git --version：本套测试前提（beforeEach 也调它）
            const out = writes.join("");
            expect(out).toContain("$ git --version"); // 回显进了注入的 renderer
            expect(out).toContain("git version"); // stdout 原样透传
        } finally {
            setDefaultRendererForTest(null); // 复位单例，别污染后续用例
        }
        expect(getDefaultRenderer()).not.toBe(fake); // null 后重建为进程级单例
    });
});

describe("非 semver tag 与 SHA 消歧", () => {
    /** detached 断言：无当前分支 */
    function expectDetached(dir: string): void {
        const { status } = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
            cwd: dir,
            encoding: "utf-8",
        });
        expect(status).not.toBe(0);
    }

    it("非 semver tag（nightly）→ 按本地 refs 消歧 detached", async () => {
        g(["tag", "nightly"], src);
        const dir = join(root, "nightly");
        await cloneMirror({ dir, url: src, version: "nightly" });
        expectDetached(dir);
        expect(g(["rev-parse", "HEAD"], dir)).toBe(g(["rev-parse", "nightly"], src));
    });

    it("SHA → detached 检出", async () => {
        const sha = g(["rev-parse", "HEAD"], src);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        const dir = join(root, "sha");
        await cloneMirror({ dir, url: src, version: sha });
        expectDetached(dir);
        expect(g(["rev-parse", "HEAD"], dir)).toBe(sha);
    });

    it("detached HEAD 的 updateMirror(isTag=false) → 安全网跳过不 pull", async () => {
        const dir = join(root, "tag");
        await cloneMirror({ dir, url: src, version: "v1.0.0" });
        const out = await updateMirror(dir, false); // 初判漏网（如 nightly）时靠 detached 兜底
        expect(out.updated).toBe(false);
        expect(out.note).toContain("detached");
    });
});
