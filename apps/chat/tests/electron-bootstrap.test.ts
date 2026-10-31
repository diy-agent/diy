import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../bin/diy-chat.mjs";
import {
    DEFAULT_MIRRORS,
    chooseMirror,
    electronStoreDir,
    ensureElectronBinary,
    formatProgress,
    locateElectronBinary,
    mirrorUrl,
    platformExe,
    probeMirrors,
} from "../bin/electron-bootstrap.mjs";

const makeDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** 假 electronDir：只要 package.json（真实现读 version / checksums / extract-zip 都在这一步之后） */
function fakeElectronDir(version = "43.8.6"): string {
    const dir = makeDir("electron-pkg-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "electron", version }), "utf8");
    return dir;
}

/** 已就绪的 store（version 文件 + 可执行文件占位） */
function readyStore(version: string, platform = process.platform, arch = process.arch): string {
    const dir = electronStoreDir({ version, platform, arch });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "version"), String(version).replace(/^v/, ""), "utf8");
    const exe = join(dir, platformExe(platform));
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "", "utf8");
    return dir;
}

/** 可控的假 fetch：按 URL 决定延迟 / 失败；记录调用顺序与并发度 */
function fakeFetch(plan: Record<string, { ms?: number; status?: number; error?: string }> = {}) {
    const calls: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const impl = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const matched = Object.entries(plan).find(([needle]) => needle !== "default" && url.includes(needle))?.[1];
        const rule = matched ?? plan["default"] ?? { ms: 5 };
        try {
            if (rule.ms) await new Promise((r) => setTimeout(r, rule.ms));
            if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
            const status = rule.status ?? 200;
            return {
                ok: status >= 200 && status < 300,
                status,
                headers: new Headers(rule.error ? {} : { "content-length": "123456789" }),
                body: null,
            } as unknown as Response;
        } finally {
            inFlight -= 1;
        }
    }) as unknown as typeof fetch;
    return { impl, calls, peak: () => peak };
}

const zip = "electron-v43.8.6-darwin-x64.zip";

afterEach(() => {
    delete process.env["DIY_ELECTRON_STORE"];
    delete process.env["ELECTRON_MIRROR"];
    delete process.env["DIY_ELECTRON_MIRROR"];
    delete process.env["DIY_ELECTRON_ZIP"];
});

describe("probeMirrors（并发探测）", () => {
    it("三个源同时起跑：总耗时 ≈ 最慢的那个，不是三者之和", async () => {
        const fake = fakeFetch({ "npmmirror.com": { ms: 120 }, "cdn.npmmirror.com": { ms: 150 }, github: { ms: 200 } });
        const started = Date.now();
        const results = await probeMirrors({ mirrors: DEFAULT_MIRRORS, version: "43.8.6", zip, fetchImpl: fake.impl });
        const elapsed = Date.now() - started;
        expect(results).toHaveLength(3);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(fake.peak()).toBe(3); // 三个同时在飞
        expect(elapsed).toBeLessThan(120 + 150 + 200); // 串行会 ≥ 470ms
        expect(elapsed).toBeGreaterThanOrEqual(190);
    });

    it("每个源都有独立结果：成功的带毫秒，不通的带原因", async () => {
        const fake = fakeFetch({ github: { status: 502 } });
        const results = await probeMirrors({ mirrors: DEFAULT_MIRRORS, version: "43.8.6", zip, fetchImpl: fake.impl });
        const byId = Object.fromEntries(results.map((r) => [r.id, r]));
        expect(byId["npmmirror"]?.ok).toBe(true);
        expect(byId["npmmirror"]?.ms).toBeGreaterThanOrEqual(0);
        expect(byId["github"]?.ok).toBe(false);
        expect(byId["github"]?.error).toBe("HTTP 502");
        // 结果顺序 = 候选顺序（日志逐行输出靠它）
        expect(results.map((r) => r.id)).toEqual(DEFAULT_MIRRORS.map((m) => m.id));
    });

    it("单源超时按 AbortSignal.timeout 记成「超时」，不拖累别的源", async () => {
        const slow = (async (_input: string | URL, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                    reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })),
                );
            })) as unknown as typeof fetch;
        const results = await probeMirrors({
            mirrors: [{ id: "dead", label: "dead", kind: "github" }],
            version: "43.8.6",
            zip,
            timeoutMs: 30,
            fetchImpl: slow,
        });
        expect(results[0]?.ok).toBe(false);
        expect(results[0]?.error).toBe("超时");
    });
});

describe("chooseMirror（选最快的；用户指定优先）", () => {
    const results = [
        { id: "a", label: "a", url: "ua", ok: true, ms: 300 },
        { id: "b", label: "b", url: "ub", ok: true, ms: 40 },
        { id: "c", label: "c", url: "uc", ok: false, ms: 10, error: "超时" },
    ];

    it("没指定镜像 ⇒ 选响应最快的可用源", () => {
        const { chosen, reason } = chooseMirror(results, null);
        expect(chosen?.id).toBe("b");
        expect(reason).toContain("b");
    });

    it("ELECTRON_MIRROR 已设且可用 ⇒ 按用户优先（哪怕不是最快）", () => {
        const withUser = [...results, { id: "user", label: "你指定的", url: "uu", ok: true, ms: 290 }];
        expect(chooseMirror(withUser, { id: "user", label: "你指定的", kind: "mirror" }).chosen?.id).toBe("user");
    });

    it("用户指定的不通 ⇒ 回落到最快，并说明原因", () => {
        const withUser = [...results, { id: "user", label: "你指定的", url: "uu", ok: false, ms: 3000, error: "超时" }];
        const { chosen, reason } = chooseMirror(withUser, { id: "user", label: "你指定的", kind: "mirror" });
        expect(chosen?.id).toBe("b");
        expect(reason).toContain("回落");
    });

    it("全都不通 ⇒ chosen = null", () => {
        expect(chooseMirror(results.filter((r) => !r.ok), null).chosen).toBeNull();
    });
});

describe("formatProgress", () => {
    it("有总长时给百分比 / 速度 / ETA", () => {
        const line = formatProgress({ done: 28 * 1024 * 1024, total: 100 * 1024 * 1024, elapsedMs: 2000 });
        expect(line).toContain("28%");
        expect(line).toContain("MB/s");
        expect(line).toContain("ETA");
        expect(line).toMatch(/\[=+> *\]/);
    });

    it("没有总长（镜像不给 content-length）只说已下多少 MB，不编百分比", () => {
        const line = formatProgress({ done: 8 * 1024 * 1024, total: 0, elapsedMs: 1000 });
        expect(line).toContain("8MB");
        expect(line).not.toContain("%");
    });
});

describe("ensureElectronBinary", () => {
    it("store 里已就绪 ⇒ 只打印检查 + 命中，不探测不下载（零网络）", async () => {
        const version = "43.8.6";
        process.env["DIY_ELECTRON_STORE"] = makeDir("store-");
        const dir = readyStore(version);
        const logs: string[] = [];
        let fetched = 0;
        const fetchImpl = (async () => {
            fetched += 1;
            throw new Error("不该联网");
        }) as unknown as typeof fetch;

        const r = await ensureElectronBinary({ version, electronDir: fakeElectronDir(version), log: (m) => logs.push(m), fetchImpl });
        expect(r.source).toBe("store");
        expect(r.dir).toBe(dir);
        expect(fetched).toBe(0);
        expect(logs[0]).toContain("检查 Electron 二进制");
        expect(logs.some((l) => l.includes("已就绪"))).toBe(true);
    });

    it("需要下载时按「检查 → 探测 → 使用」顺序输出，且每个镜像各一行", async () => {
        const version = "43.8.6";
        process.env["DIY_ELECTRON_STORE"] = makeDir("store-");
        const logs: string[] = [];
        const fake = fakeFetch({ "npmmirror.com": { ms: 30 }, "cdn.npmmirror.com": { ms: 80 }, github: { ms: 260 } });

        // 走到下载阶段就认输（真下载 120MB 不在单测里做）；这里只验前面的阶段输出
        await expect(
            ensureElectronBinary({ version, electronDir: fakeElectronDir(version), log: (m) => logs.push(m), fetchImpl: fake.impl }),
        ).rejects.toThrow();

        expect(logs[0]).toContain("检查 Electron 二进制");
        expect(logs.some((l) => l.includes("未找到"))).toBe(true);
        expect(logs.some((l) => l.includes("探测镜像（并发"))).toBe(true);
        const resultLines = logs.filter((l) => /^\s+[✓✗] (npmmirror|npmmirror-cdn|github|你指定的)/.test(l));
        expect(resultLines).toHaveLength(3);
        expect(resultLines.join("\n")).toContain("✓ npmmirror");
        expect(logs.some((l) => /→ 使用 npmmirror：.*（\d+ms）/.test(l))).toBe(true);
        expect(logs.some((l) => l.includes("下载 electron-v43.8.6"))).toBe(true);
    });

    it("全部镜像不通 ⇒ 报错里列出每个源 + 两条手动命令", async () => {
        const version = "43.8.6";
        process.env["DIY_ELECTRON_STORE"] = makeDir("store-");
        const fake = fakeFetch({ default: { status: 503 } });
        const err = (await ensureElectronBinary({
            version,
            electronDir: fakeElectronDir(version),
            fetchImpl: fake.impl,
        }).catch((e: unknown) => e as Error)) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain("所有 Electron 镜像都不可用");
        for (const mirror of DEFAULT_MIRRORS) expect(err.message).toContain(mirror.id);
        expect(err.message).toContain("DIY_ELECTRON_ZIP=");
        expect(err.message).toContain("ELECTRON_MIRROR=");
    });

    it("ELECTRON_MIRROR 已设 ⇒ 也探测并报告实测耗时", async () => {
        const version = "43.8.6";
        process.env["DIY_ELECTRON_STORE"] = makeDir("store-");
        process.env["ELECTRON_MIRROR"] = "https://mirror.corp/electron/";
        const logs: string[] = [];
        const fake = fakeFetch({ "mirror.corp": { ms: 12 }, "npmmirror.com": { ms: 40 } });
        await expect(
            ensureElectronBinary({ version, electronDir: fakeElectronDir(version), log: (m) => logs.push(m), fetchImpl: fake.impl }),
        ).rejects.toThrow();
        expect(logs.some((l) => /✓ 你指定的\s+\d+ms/.test(l))).toBe(true);
        expect(logs.some((l) => /按你指定的 ELECTRON_MIRROR（实测 \d+ms）/.test(l))).toBe(true);
        expect(fake.calls.some((u) => u.includes("mirror.corp"))).toBe(true);
        expect(fake.calls.some((u) => u.includes("github"))).toBe(true); // 用户源之外也探测
    });
});

describe("mirrorUrl", () => {
    it("普通镜像走 <base>v<version>/<zip>，github 走 release 路径", () => {
        expect(mirrorUrl(DEFAULT_MIRRORS[0]!, { version: "43.8.6", zip })).toBe(
            "https://npmmirror.com/mirrors/electron/v43.8.6/electron-v43.8.6-darwin-x64.zip",
        );
        expect(mirrorUrl({ id: "g", label: "g", kind: "github" }, { version: "v43.8.6", zip })).toBe(
            "https://github.com/electron/electron/releases/download/v43.8.6/electron-v43.8.6-darwin-x64.zip",
        );
    });
});

describe("locateElectronBinary（--check 的判据：只查不下载）", () => {
    it("store 里有 ⇒ 直接返回可执行文件；没有 ⇒ null（不联网）", () => {
        const version = "43.8.6";
        process.env["DIY_ELECTRON_STORE"] = makeDir("store-");
        const electronDir = fakeElectronDir(version);
        expect(locateElectronBinary({ version, electronDir })).toBeNull();

        const dir = readyStore(version);
        const found = locateElectronBinary({ version, electronDir });
        expect(found?.dir).toBe(dir);
        expect(found?.source).toBe("store");
        expect(found?.exe).toBe(join(dir, platformExe()));
    });
});

describe("diy-chat 入口（单 bin + 子命令，##478 补充决策）", () => {
    it("无参数 = 启动应用；其余参数原样转给 electron", () => {
        expect(parseArgs([])).toEqual({ kind: "launch", check: false, passthrough: [] });
        expect(parseArgs(["--remote-debugging-port=9000"]).passthrough).toEqual(["--remote-debugging-port=9000"]);
    });

    it("electron 子命令 + --check", () => {
        expect(parseArgs(["electron"])).toMatchObject({ kind: "electron", check: false });
        expect(parseArgs(["electron", "--check"])).toMatchObject({ kind: "electron", check: true });
    });

    it("--mirror / --zip 走参数（等价于对应环境变量）", () => {
        const a = parseArgs(["electron", "--mirror=https://mirror.corp/electron/", "--zip=/tmp/e.zip"]);
        expect(a.mirror).toBe("https://mirror.corp/electron/");
        expect(a.zip).toBe("/tmp/e.zip");
    });

    it("--version / --help 不进入启动路径", () => {
        expect(parseArgs(["--version"]).kind).toBe("version");
        expect(parseArgs(["--help"]).kind).toBe("help");
        expect(parseArgs(["electron", "--help"]).kind).toBe("help");
    });

    it("通过软链执行（= npm 装出来的 <prefix>/bin/diy-chat）也能跑到 main", () => {
        // npm 的 bin 一律是软链；入口判据若直接比 pathToFileURL(argv[1]) 就会「运行什么都不发生」
        const link = join(makeDir("bin-link-"), "diy-chat");
        symlinkSync(join(import.meta.dirname, "..", "bin", "diy-chat.mjs"), link);
        const r = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("@diy-agent/app-chat");
    });

    it("包里只有一个 bin：diy-chat（多入口 bin 明确不做）", () => {
        const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
            bin: Record<string, string>;
        };
        expect(Object.keys(pkg.bin)).toEqual(["diy-chat"]);
    });
});
