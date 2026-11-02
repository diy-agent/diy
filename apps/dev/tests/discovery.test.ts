import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAppsIn, parseAppYaml, parseWorktrees } from "../discovery.js";

const dirs: string[] = [];
function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "dev-disc-"));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const YAML = `
name: chat
title: diy 聊天
launches:
  - id: lab
    title: 开发（lab）
    command: ./sha.sh lab
    entries:
      - kind: app
        title: Electron 窗口
`;

describe("parseAppYaml", () => {
    it("解析出 name / title / launches / entries", () => {
        const app = parseAppYaml(YAML, { dir: "/repo/apps/chat", dirName: "chat", file: "/repo/apps/chat/app.yaml" });
        expect(app.name).toBe("chat");
        expect(app.title).toBe("diy 聊天");
        expect(app.dir).toBe("/repo/apps/chat");
        expect(app.launches).toHaveLength(1);
        expect(app.launches[0]).toMatchObject({ id: "lab", command: "./sha.sh lab" });
        expect(app.launches[0]?.entries[0]).toEqual({ kind: "app", title: "Electron 窗口" });
    });

    it("name / title 缺省取目录名", () => {
        const app = parseAppYaml("launches:\n  - id: a\n    command: x\n    entries:\n      - kind: app\n", {
            dir: "/r/apps/foo",
            dirName: "foo",
            file: "f",
        });
        expect(app.name).toBe("foo");
        expect(app.title).toBe("foo");
    });

    it("env / web entry 的 url 保留", () => {
        const app = parseAppYaml(
            "name: web\nlaunches:\n  - id: web-8123\n    command: ./sha.sh lab\n    env:\n      PORT: 8123\n    entries:\n      - kind: web\n        url: http://localhost:8123\n",
            { dir: "/r/apps/web", dirName: "web", file: "f" },
        );
        expect(app.launches[0]?.env).toEqual({ PORT: "8123" });
        expect(app.launches[0]?.entries[0]).toEqual({ kind: "web", url: "http://localhost:8123" });
    });

    it("坏输入逐个报错（缺 command / 重复 id / web 缺 url / kind 非法）", () => {
        const bad = (text: string): string => {
            try {
                parseAppYaml(text, { dir: "/r", dirName: "r", file: "f" });
                return "";
            } catch (error) {
                return (error as Error).message;
            }
        };
        expect(bad("launches: []")).toMatch(/launches/);
        expect(bad("launches:\n  - id: a\n")).toMatch(/缺 command/);
        expect(
            bad("launches:\n  - id: a\n    command: x\n    entries:\n      - kind: app\n  - id: a\n    command: y\n    entries:\n      - kind: app\n"),
        ).toMatch(/重复/);
        expect(bad("launches:\n  - id: a\n    command: x\n    entries:\n      - kind: web\n")).toMatch(/缺 url/);
        expect(bad("launches:\n  - id: a\n    command: x\n    entries:\n      - kind: nope\n")).toMatch(/kind/);
    });
});

describe("parseWorktrees", () => {
    it("解析主仓 + 额外 worktree，忽略 bare", () => {
        const out = [
            "worktree /repo",
            "HEAD abc",
            "branch refs/heads/main",
            "",
            "worktree /wt/t502",
            "HEAD def",
            "branch refs/heads/t502-dev-app",
            "",
            "worktree /bare",
            "bare",
            "",
        ].join("\n");
        expect(parseWorktrees(out)).toEqual([
            { path: "/repo", branch: "main" },
            { path: "/wt/t502", branch: "t502-dev-app" },
        ]);
    });
});

describe("discoverAppsIn", () => {
    it("只认 apps/*/app.yaml；坏文件记 problem 不影响其它 app", () => {
        const root = scratch();
        mkdirSync(join(root, "apps/good"), { recursive: true });
        mkdirSync(join(root, "apps/bad"), { recursive: true });
        mkdirSync(join(root, "apps/no-yaml"), { recursive: true });
        writeFileSync(join(root, "apps/good/app.yaml"), "name: good\nlaunches:\n  - id: lab\n    command: ./sha.sh lab\n    entries:\n      - kind: app\n");
        writeFileSync(join(root, "apps/bad/app.yaml"), "launches: oops\n");
        const found = discoverAppsIn(root);
        expect(found.apps.map((app) => app.name)).toEqual(["good"]);
        expect(found.problems).toHaveLength(1);
        expect(found.problems[0]).toMatch(/bad\/app\.yaml/);
    });
});
