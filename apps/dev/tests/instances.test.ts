import { describe, expect, it } from "vitest";
import {
    buildSnapshot,
    displayPath,
    matchRecord,
    parseRecord,
    sameApp,
    samePath,
    withPort,
    type InstanceRecordLite,
} from "../instances.js";
import type { AppSpec, WorktreeInfo } from "../shared.js";

const record = (patch: Partial<InstanceRecordLite> = {}): InstanceRecordLite => ({
    pid: 1234,
    app: "diy-chat",
    launch: "lab",
    worktree: "/repo",
    port: null,
    diyHome: "/repo/build/lab/home",
    variant: "lab",
    env: "development",
    argv: ["/electron", "build/lab/main/index.mjs"],
    cwd: "/repo/apps/chat",
    startedAt: "2026-11-02T10:00:00.000+0800",
    updatedAt: "2026-11-02T10:00:01.000+0800",
    parents: [],
    ...patch,
});

const chatApp = (dir = "/repo/apps/chat"): AppSpec => ({
    name: "chat",
    title: "diy 聊天",
    dir,
    launches: [
        {
            id: "lab",
            title: "开发（lab）",
            command: "./sha.sh lab",
            entries: [{ kind: "app", title: "Electron 窗口" }],
        },
    ],
});

const webApp = (): AppSpec => ({
    name: "web",
    title: "diy web",
    dir: "/repo/apps/web",
    launches: [
        {
            id: "web-8123",
            command: "./sha.sh lab",
            env: { PORT: "8123" },
            entries: [{ kind: "web", title: "浏览器", url: "http://localhost:8123" }],
        },
    ],
});

describe("parseRecord（宽松）", () => {
    it("缺字段给缺省值；坏 pid 整条作废", () => {
        expect(parseRecord({})).toBeNull();
        const parsed = parseRecord({ pid: 7, app: null, launch: null, worktree: null, port: "x" });
        expect(parsed?.pid).toBe(7);
        expect(parsed?.app).toBeNull();
        expect(parsed?.launch).toBeNull();
        expect(parsed?.worktree).toBeNull();
        expect(parsed?.port).toBeNull();
    });

    it("老记录（没有 launch / worktree）不报错", () => {
        const parsed = parseRecord({ pid: 7, app: "chat", diyHome: "/h", variant: "lab" });
        expect(parsed?.launch).toBeNull();
        expect(parsed?.worktree).toBeNull();
    });
});

describe("匹配键 (worktree, app, launch)", () => {
    it("app 允许 chat / diy-chat 两种历史口径", () => {
        expect(sameApp("chat", "chat")).toBe(true);
        expect(sameApp("diy-chat", "chat")).toBe(true);
        expect(sameApp("diy-chat", "minimal")).toBe(false);
        expect(sameApp(null, "chat")).toBe(false);
    });

    it("worktree 路径相等（写法不同也算同一个）", () => {
        expect(samePath("/repo", "/repo")).toBe(true);
        expect(samePath("/repo/", "/repo")).toBe(true);
        expect(samePath("/wt/t502", "/repo")).toBe(false);
        expect(samePath(null, "/repo")).toBe(false);
    });

    it("三元组全中才算同一个 launch", () => {
        const ref = { worktree: "/repo", app: "chat", launch: "lab" };
        expect(matchRecord(record(), ref)).toBe(true);
        expect(matchRecord(record({ app: "chat" }), ref)).toBe(true);
        expect(matchRecord(record({ launch: null }), ref)).toBe(false);
        expect(matchRecord(record({ app: "diy-minimal" }), ref)).toBe(false);
        expect(matchRecord(record({ worktree: "/repo/" }), ref)).toBe(true);
        expect(matchRecord(record({ worktree: "/wt/other" }), ref)).toBe(false);
    });
});

describe("withPort（配置端口 vs 实际端口）", () => {
    it("一致时原样，不一致时换端口并标 mismatch", () => {
        expect(withPort("http://localhost:8123", 8123)).toEqual({ href: "http://localhost:8123", mismatch: false });
        const actual = withPort("http://localhost:8123", 8124);
        expect(actual.href).toBe("http://localhost:8124/");
        expect(actual.mismatch).toBe(true);
    });

    it("没有实际端口（未运行）= 用配置值、不标 mismatch", () => {
        expect(withPort("http://localhost:8123", null)).toEqual({ href: "http://localhost:8123", mismatch: false });
    });
});

describe("displayPath / buildSnapshot", () => {
    it("仓库内显示相对路径，家目录缩 ~", () => {
        expect(displayPath("/repo/build/lab/home", "/repo")).toBe("build/lab/home");
        expect(displayPath(`${process.env["HOME"]}/.diy`, "/repo")).toMatch(/^~\/\.diy$/);
    });

    it("静态清单不依赖注册表：空注册表也能列出全部 launch", () => {
        const worktrees: WorktreeInfo[] = [
            { path: "/repo", branch: "main" },
            { path: "/wt/t502", branch: "t502-dev-app" },
        ];
        const appsOf = (worktree: string): AppSpec[] =>
            worktree === "/repo" ? [chatApp(), webApp()] : [chatApp("/wt/t502/apps/chat")];
        const snapshot = buildSnapshot(worktrees, {
            repoRoot: "/repo",
            worktrees,
            appsOf,
            records: [],
            starting: new Set(),
            builtOf: () => true,
            registry: "/home/u/.diy-instances",
        });
        expect(snapshot.worktreeCount).toBe(2);
        expect(snapshot.appCount).toBe(3);
        expect(snapshot.launches.map((item) => `${item.worktree}|${item.app}|${item.launch}`)).toEqual([
            "/repo|chat|lab",
            "/repo|web|web-8123",
            "/wt/t502|chat|lab",
        ]);
        expect(snapshot.runningCount).toBe(0);
        expect(snapshot.launches[1]?.entries[0]?.href).toBe("http://localhost:8123");
    });

    it("注册表按三元组对上 ⇒ running，web entry 用实际端口并标配置值", () => {
        const worktrees: WorktreeInfo[] = [{ path: "/repo", branch: "main" }];
        const snapshot = buildSnapshot(worktrees, {
            repoRoot: "/repo",
            worktrees,
            appsOf: () => [webApp()],
            records: [
                record({ pid: 4321, app: "diy-web", launch: "web-8123", worktree: "/repo", port: 8124 }),
                record({ pid: 9999, app: "diy-chat", launch: "lab", worktree: "/repo" }),
            ],
            starting: new Set(),
            builtOf: () => true,
            memOf: () => 128 * 1024 * 1024,
            now: Date.parse("2026-11-02T10:10:00.000+0800"),
        });
        const web = snapshot.launches[0]!;
        expect(web.running).toBe(true);
        expect(web.runtime?.pid).toBe(4321);
        expect(web.runtime?.uptimeMs).toBe(10 * 60 * 1000);
        expect(web.runtime?.memBytes).toBe(128 * 1024 * 1024);
        expect(web.entries[0]?.href).toBe("http://localhost:8124/");
        expect(web.entries[0]?.configuredUrl).toBe("http://localhost:8123");
        expect(web.entries[0]?.portMismatch).toBe(true);
        // chat 的那条记录在静态清单里没有对应 launch ⇒ 不算 running（清单来自 app.yaml）
        expect(snapshot.runningCount).toBe(1);
    });

    it("started 但还没注册表 ⇒ starting；未构建 ⇒ built=false", () => {
        const worktrees: WorktreeInfo[] = [{ path: "/repo", branch: null }];
        const key = `/repo\u0000chat\u0000lab`;
        const snapshot = buildSnapshot(worktrees, {
            repoRoot: "/repo",
            worktrees,
            appsOf: () => [chatApp()],
            records: [],
            starting: new Set([key]),
            builtOf: () => false,
        });
        expect(snapshot.launches[0]?.starting).toBe(true);
        expect(snapshot.launches[0]?.running).toBe(false);
        expect(snapshot.launches[0]?.built).toBe(false);
    });
});
