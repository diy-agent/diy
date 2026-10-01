/**
 * ref-store.test.ts — store 数据层单测（URL 解析 / spec 拆解 / diy.yaml / lock）
 *
 * 纯逻辑 + tmpdir 文件操作，不触网、不调 git。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    parseRepoUrl,
    parseSpec,
    isTagVersion,
    isPinnedVersion,
    normalizeVersion,
    mirrorRelDir,
    stripVersion,
    addSource,
    removeSource,
    listSpecs,
    loadRefLock,
    saveRefLock,
} from "../src/ref/store";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "refstore-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("parseRepoUrl", () => {
    it("解析 https URL", () => {
        expect(parseRepoUrl("https://github.com/org/repo")).toEqual({
            host: "github.com",
            owner: "org",
            repo: "repo",
        });
    });

    it("剥离 .git 与尾部斜杠", () => {
        expect(parseRepoUrl("https://github.com/org/repo.git/")).toEqual({
            host: "github.com",
            owner: "org",
            repo: "repo",
        });
    });

    it("解析 git@ ssh 形式", () => {
        expect(parseRepoUrl("git@github.com:org/repo.git")?.host).toBe("github.com");
        expect(parseRepoUrl("git@github.com:org/repo.git")?.owner).toBe("org");
    });

    it("无法解析时返回 null", () => {
        expect(parseRepoUrl("not a url")).toBeNull();
    });
});

describe("parseSpec / 版本判定", () => {
    it("剥离 @ 版本", () => {
        const p = parseSpec("https://github.com/org/repo@v1.0.0");
        expect(p.url).toBe("https://github.com/org/repo");
        expect(p.version).toBe("v1.0.0");
        expect(p.key).toBe("github.com/org/repo");
    });

    it("无版本 → version null", () => {
        expect(parseSpec("https://github.com/org/repo").version).toBeNull();
    });

    it("isTagVersion: v前缀/纯数字为 tag，分支名不是", () => {
        expect(isTagVersion("v1.0.0")).toBe(true);
        expect(isTagVersion("4.9.8")).toBe(true);
        expect(isTagVersion("main")).toBe(false);
        expect(isTagVersion("develop")).toBe(false);
        expect(isTagVersion("diy-v0.1.8")).toBe(false);
    });

    it("normalizeVersion 兜底 main", () => {
        expect(normalizeVersion(null)).toBe("main");
        expect(normalizeVersion("  ")).toBe("main");
        expect(normalizeVersion("develop")).toBe("develop");
    });

    it("mirrorRelDir 相对 home 路径", () => {
        const { info } = parseSpec("https://github.com/org/repo");
        expect(mirrorRelDir(info, "main")).toBe("ref/github.com/org/repo/main");
    });
});

describe("diy.yaml source 读写", () => {
    it("add 保留原始 URL 串", () => {
        const spec = addSource(dir, "https://github.com/org/repo");
        expect(spec).toBe("https://github.com/org/repo");
        expect(listSpecs(dir)).toEqual(["https://github.com/org/repo"]);
    });

    it("同 host/owner/repo 替换（含版本变化）", () => {
        addSource(dir, "https://github.com/org/repo");
        const spec = addSource(dir, "https://github.com/org/repo@v2.0.0");
        expect(spec).toBe("https://github.com/org/repo@v2.0.0");
        expect(listSpecs(dir)).toEqual(["https://github.com/org/repo@v2.0.0"]);
    });

    it("不同 owner/repo 并存", () => {
        addSource(dir, "https://github.com/a/x");
        addSource(dir, "https://github.com/b/y");
        expect(listSpecs(dir)).toHaveLength(2);
    });

    it("remove 按 owner/repo 匹配并保留原始串", () => {
        addSource(dir, "https://github.com/org/repo@v1.0.0");
        const removed = removeSource(dir, "org/repo");
        expect(removed).toBe("https://github.com/org/repo@v1.0.0");
        expect(listSpecs(dir)).toEqual([]);
        expect(removeSource(dir, "org/repo")).toBeNull();
    });

    it("remove 未匹配返回 null 且不改文件", () => {
        addSource(dir, "https://github.com/a/x");
        expect(removeSource(dir, "zzz")).toBeNull();
        const raw = readFileSync(join(dir, "diy.yaml"), "utf-8");
        expect(raw).toContain("https://github.com/a/x");
    });

    it("remove 在无 diy.yaml 目录 → null 且不创建文件（190 核对表 #10）", () => {
        expect(existsSync(join(dir, "diy.yaml"))).toBe(false);
        expect(removeSource(dir, "org/repo")).toBeNull();
        // 不允许先建空文件再报「未找到」
        expect(existsSync(join(dir, "diy.yaml"))).toBe(false);
    });
});

describe("ref.lock.yaml 往返", () => {
    it("save 后 load 结构一致", () => {
        const now = new Date().toISOString();
        saveRefLock(dir, {
            version: 1,
            generated: now,
            source: {
                "github.com/org/repo": {
                    key: "github.com/org/repo",
                    url: "https://github.com/org/repo",
                    version: null,
                    dir: "ref/github.com/org/repo/main",
                    lastSync: now,
                },
            },
        });
        const lock = loadRefLock(dir)!;
        expect(lock.generated).toBe(now);
        expect(lock.source["github.com/org/repo"]!.dir).toBe("ref/github.com/org/repo/main");
    });

    it("无 lock 文件返回 null", () => {
        expect(loadRefLock(dir)).toBeNull();
    });

    it("损坏 YAML 返回 null 不抛", () => {
        const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(join(dir, ".diy"), { recursive: true });
        writeFileSync(join(dir, ".diy", "ref.lock.yaml"), "::: 坏 yaml\n- x", "utf-8");
        expect(loadRefLock(dir)).toBeNull();
    });
});

describe("parseSpec / 浏览器地址形式", () => {
    it("/tree/ tag：后段即版本", () => {
        const p = parseSpec("https://github.com/nodeca/babelfish/tree/2.0.0");
        expect(p.url).toBe("https://github.com/nodeca/babelfish");
        expect(p.version).toBe("2.0.0");
        expect(p.key).toBe("github.com/nodeca/babelfish");
    });

    it("/tree/ 分支", () => {
        expect(parseSpec("https://github.com/org/repo/tree/main").version).toBe("main");
    });

    it("/tree/ 斜杠分支保持完整", () => {
        expect(parseSpec("https://github.com/org/repo/tree/feature/foo").version).toBe(
            "feature/foo",
        );
    });

    it("/tree/ 尾部斜杠与 fragment 剥离", () => {
        expect(parseSpec("https://github.com/org/repo/tree/main/").version).toBe("main");
        expect(parseSpec("https://github.com/org/repo/tree/main#readme").version).toBe("main");
        expect(parseSpec("https://github.com/org/repo/tree/v1.0.0?plain=1").version).toBe("v1.0.0");
    });

    it("/releases/tag/ 按 tag", () => {
        const p = parseSpec("https://github.com/org/repo/releases/tag/v1.2.3");
        expect(p.url).toBe("https://github.com/org/repo");
        expect(p.version).toBe("v1.2.3");
    });

    it("/commit/ 按 SHA", () => {
        const sha = "a".repeat(40);
        const p = parseSpec(`https://github.com/org/repo/commit/${sha}`);
        expect(p.url).toBe("https://github.com/org/repo");
        expect(p.version).toBe(sha);
    });

    it("裸 SSH 无版本可解析（@ 归属前缀不误切）", () => {
        const p = parseSpec("git@github.com:org/repo.git");
        expect(p.url).toBe("git@github.com:org/repo.git");
        expect(p.version).toBeNull();
    });

    it("SSH + @tag", () => {
        const p = parseSpec("git@github.com:org/repo@v1.0.0");
        expect(p.version).toBe("v1.0.0");
    });

    it("/blob/ 文件页明确拒绝", () => {
        expect(() => parseSpec("https://github.com/org/repo/blob/main/a.ts")).toThrow(/blob/);
    });

    it("/pull/ 功能页明确拒绝", () => {
        expect(() => parseSpec("https://github.com/org/repo/pull/1")).toThrow(/pull/);
    });

    it("stripVersion 处理 /tree/ 形式", () => {
        expect(stripVersion("https://github.com/org/repo/tree/2.0.0")).toBe(
            "https://github.com/org/repo",
        );
    });

    it("add 同仓库 @ 与 /tree/ 形式互替（同 key）", () => {
        addSource(dir, "https://github.com/org/repo@v2.0.0");
        addSource(dir, "https://github.com/org/repo/tree/v2.0.0");
        expect(listSpecs(dir)).toEqual(["https://github.com/org/repo/tree/v2.0.0"]);
    });

    it("remove 按 owner/repo 匹配 /tree/ 注册项", () => {
        addSource(dir, "https://github.com/org/repo/tree/2.0.0");
        expect(removeSource(dir, "org/repo")).toBe("https://github.com/org/repo/tree/2.0.0");
    });
});

describe("isPinnedVersion", () => {
    it("tag 与 SHA 不可变，分支可变", () => {
        expect(isPinnedVersion("v1.0.0")).toBe(true);
        expect(isPinnedVersion("2.0.0")).toBe(true);
        expect(isPinnedVersion("a".repeat(40))).toBe(true);
        expect(isPinnedVersion("main")).toBe(false);
        expect(isPinnedVersion("nightly")).toBe(false); // 非 semver tag 靠 clone 后消歧
    });
});
