import { describe, expect, it } from "vitest";
import {
    buildSnapshot,
    displayPath,
    inferApp,
    instanceUri,
    matchRecord,
    parseRecord,
    type InstanceRecordLite,
} from "../instances.js";
import { resolveTargets } from "../targets.js";

const record = (patch: Partial<InstanceRecordLite> = {}): InstanceRecordLite => ({
    pid: 1234,
    app: "diy-chat",
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

describe("parseRecord", () => {
    it("宽松读取：缺字段给缺省值，坏 pid 整条作废", () => {
        expect(parseRecord({})).toBeNull();
        const parsed = parseRecord({ pid: 7, app: null, port: "x" });
        expect(parsed?.pid).toBe(7);
        expect(parsed?.app).toBeNull();
        expect(parsed?.port).toBeNull();
        expect(parsed?.argv).toEqual([]);
    });

    it("老记录（app 为 null）不报错", () => {
        const parsed = parseRecord({ pid: 7, app: null, diyHome: "/h", variant: "lab" });
        expect(parsed?.app).toBeNull();
        expect(parsed?.variant).toBe("lab");
    });
});

describe("inferApp", () => {
    it("从 argv / cwd 认出 app 短名", () => {
        expect(inferApp(record({ app: null, cwd: "/w/pkgs.ts/diy-app" }))).toBe("diy-app");
        expect(inferApp(record({ app: null }))).toBe("diy-chat");
        expect(inferApp(record({ app: null, cwd: "/nowhere", argv: ["x"] }))).toBeNull();
    });
});

describe("matchRecord", () => {
    const targets = resolveTargets("/repo").list;
    const chat = targets.find((t) => t.id === "chat-lab")!;
    const web8123 = targets.find((t) => t.id === "web-8123")!;
    const web8124 = targets.find((t) => t.id === "web-8124")!;

    it("按 app + 变体匹配", () => {
        expect(matchRecord(chat, [record()])?.pid).toBe(1234);
        expect(matchRecord(chat, [record({ app: "diy-app" })])).toBeNull();
        expect(matchRecord(chat, [record({ variant: "prod" })])).toBeNull();
    });

    it("web 两个入口按端口区分", () => {
        const rec = record({ app: "diy-web", port: 8123, cwd: "/repo/apps/web" });
        expect(matchRecord(web8123, [rec])).not.toBeNull();
        expect(matchRecord(web8124, [rec])).toBeNull();
    });

    it("老记录（app=null）靠 argv 兜底", () => {
        expect(matchRecord(chat, [record({ app: null })])).not.toBeNull();
    });
});

describe("displayPath / instanceUri", () => {
    it("仓库内显示相对路径，家目录缩 ~", () => {
        expect(displayPath("/repo/build/lab/home", "/repo")).toBe("build/lab/home");
        expect(displayPath("/Users/ccc/.diy", "/repo")).toMatch(/^~\/\.diy$/);
    });

    it("实例 URI 格式 diy://<nodeId>/<app>.<variant>", () => {
        expect(instanceUri("diy-9c5cdc25", "diy-app", "lab")).toBe("diy://diy-9c5cdc25/diy-app.lab");
    });
});

describe("buildSnapshot", () => {
    const targets = resolveTargets("/repo").list;
    const inputs = {
        repoRoot: "/repo",
        records: [record({ pid: 4321, app: "diy-chat", startedAt: "2026-11-02T10:00:00.000+0800" })],
        starting: new Set<string>(["diy-app-lab"]),
        nodeIdOf: () => "diy-9c5cdc25",
        memOf: () => 256 * 1024 * 1024,
        now: Date.parse("2026-11-02T10:10:00.000+0800"),
        registry: "/home/u/.diy-instances",
    };

    it("运行中的带 runtime，启动中的标 starting", () => {
        const snapshot = buildSnapshot(targets, inputs);
        const chat = snapshot.entries.find((entry) => entry.id === "chat-lab")!;
        expect(chat.running).toBe(true);
        expect(chat.runtime?.pid).toBe(4321);
        expect(chat.runtime?.uptimeMs).toBe(10 * 60 * 1000);
        expect(chat.runtime?.memBytes).toBe(256 * 1024 * 1024);
        expect(chat.uri).toBe("diy://diy-9c5cdc25/diy-chat.lab");

        const app = snapshot.entries.find((entry) => entry.id === "diy-app-lab")!;
        expect(app.running).toBe(false);
        expect(app.starting).toBe(true);
        expect(snapshot.runningCount).toBe(1);
    });

    it("未运行时 runtime 为 null（不编造 PID）", () => {
        const snapshot = buildSnapshot(targets, { ...inputs, records: [] });
        expect(snapshot.entries.every((entry) => entry.runtime === null)).toBe(true);
        expect(snapshot.runningCount).toBe(0);
    });
});
