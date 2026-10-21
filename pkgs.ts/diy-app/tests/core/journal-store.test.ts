// tests/core/journal-store.test.ts — 任务日志存储层（##404）
//
// 压的是 append-only 才有的三类失败：坏行必须容忍（一条坏行不许毁掉全部历史）、
// 批量导入必须整批拒（不许写一半）、find 的四维过滤（kind / since / until / grep）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as store from "../../src/main/services/journal-store";

const TASK = "projects/1/tasks/7";
let home = "";
const prevHome = process.env["DIY_HOME"];

beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "journal-"));
    process.env["DIY_HOME"] = home;
    const dir = path.join(home, TASK);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "AGENTS.md"), "---\nstate: pending\n---\n\n正文\n");
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env["DIY_HOME"];
    else process.env["DIY_HOME"] = prevHome;
});

const add = (o: Partial<store.JournalAddInput> = {}) => {
    return store.addEntries(TASK, [
        { kind: "progress", title: "落地一步", ...o }],
    );
};

describe("add / read", () => {
    it("seq 从 1 递增，且每行自带 task（自包含，不靠外部推断归属）", () => {
        add({ title: "第一条" });
        add({ title: "第二条" });
        const r = store.readJournal(TASK);
        expect(r.rows.map((x) => x.seq)).toEqual([1, 2]);
        expect(r.rows[1]?.title).toBe("第二条");
        expect(r.rows[1]?.task).toBe(TASK);
        expect(r.problems).toEqual([]);
    });

    it("空库 = 空读（不是报错）", () => {
        expect(store.readJournal(TASK).rows).toEqual([]);
    });

    it("任务不存在 → 立刻拒（不许在 ~/.diy 里造孤儿）", () => {
        expect(() => store.addEntries("projects/1/tasks/999", [{ kind: "learn", title: "x" }])).toThrow(/任务不存在/);
    });

    it("标题必须真是一行 / 非空", () => {
        expect(() => add({ title: "  " })).toThrow();
        expect(() => add({ title: "两\n行" })).toThrow();
    });

    it("kind 写错 → 拒（写错 kind 以后就查不到）", () => {
        expect(() => store.addEntries(TASK, [{ kind: "note" as never, title: "x" }])).toThrow();
    });
});

describe("正文三选一", () => {
    it("单给哪个用哪个", () => {
        expect(store.resolveBody("a", undefined, undefined)).toBe("a");
        expect(store.resolveBody(undefined, "b", undefined)).toBe("b");
        expect(store.resolveBody(undefined, undefined, "c")).toBe("c");
        expect(store.resolveBody(undefined, undefined, undefined)).toBeUndefined();
    });

    it("多给即错（静默取一个会让\"我明明写了两个\"变成悬案）", () => {
        expect(() => store.resolveBody("a", "b", undefined)).toThrow();
    });
});

describe("坏行容忍", () => {
    it("半截 JSON 只坏那一条，其余照读", () => {
        add({ title: "好的一条" });
        writeFileSync(store.journalFile(TASK), readFileSync(store.journalFile(TASK), "utf8") + '{"kind":"prog\n');
        add({ title: "后一条" });
        const r = store.readJournal(TASK);
        expect(r.rows.map((x) => x.title)).toEqual(["好的一条", "后一条"]);
        expect(r.problems).toHaveLength(1);
        expect(r.problems[0]?.seq).toBe(2);
    });
});

describe("find", () => {
    beforeEach(() => {
        store.addEntries(TASK, [
            { kind: "pitfall", title: "单引号包裹长文本", body: "js-yaml 会整段加引号", ts: "2026-10-20T01:00:00.000Z" },
            { kind: "decision", title: "日志走 append-only", body: "改日志没意义", ts: "2026-10-21T02:00:00.000Z", refs: ["b2f739da"] },
            { kind: "review", title: "验收：60 测试全绿", ts: "2026-10-21T03:00:00.000Z" },
        ]);
    });

    it("缺省最近优先", () => {
        expect(store.findJournal(TASK).rows.map((x) => x.seq)).toEqual([3, 2, 1]);
    });

    it("order=asc 回到时间序", () => {
        expect(store.findJournal(TASK, { order: "asc" }).rows.map((x) => x.seq)).toEqual([1, 2, 3]);
    });

    it("kind 过滤支持多值", () => {
        const r = store.findJournal(TASK, { kind: ["pitfall", "review"] });
        expect(r.rows.map((x) => x.kind)).toEqual(["review", "pitfall"]);
        expect(r.matched).toBe(2);
        expect(r.total).toBe(3);
    });

    it("since 按日粒度也生效（00:00 起）", () => {
        expect(store.findJournal(TASK, { since: "2026-10-21" }).rows).toHaveLength(2);
    });

    it("grep 搜 title / body / refs 三处", () => {
        expect(store.findJournal(TASK, { grep: "APPEND-ONLY" }).rows).toHaveLength(1);
        expect(store.findJournal(TASK, { grep: "整段" }).rows).toHaveLength(1);
        expect(store.findJournal(TASK, { grep: "b2f739da" }).rows).toHaveLength(1);
    });

    it("limit 截断但 matched 仍是全量（可提示还剩几条）", () => {
        const r = store.findJournal(TASK, { limit: 1 });
        expect(r.rows).toHaveLength(1);
        expect(r.matched).toBe(3);
    });

    it("非法时间当场报错，不静默返回空", () => {
        expect(() => store.findJournal(TASK, { since: "昨天" })).toThrow();
    });
});

describe("import", () => {
    it("一条坏 → 整批不写（半批历史比没有历史更糟）", () => {
        const r = store.importEntries(
            TASK,
            [
                { kind: "progress", title: "好的" },
                { kind: "learn", title: "" },
            ],
            false,
        );
        expect(r.accepted).toBe(0);
        expect(r.rejected).toBe(2);
        expect(store.readJournal(TASK).rows).toEqual([]);
    });

    it("dryRun 只算不写", () => {
        const r = store.importEntries(TASK, [{ kind: "progress", title: "x" }], true);
        expect(r.accepted).toBe(1);
        expect(store.readJournal(TASK).rows).toEqual([]);
    });

    it("载荷接受裸数组与 { entries }", () => {
        expect(store.parseImportPayload('[{"kind":"learn","title":"a"}]')).toHaveLength(1);
        expect(store.parseImportPayload('{"entries":[{"kind":"learn","title":"a"}]}')).toHaveLength(1);
        expect(() => store.parseImportPayload('{"x":1}')).toThrow();
    });
});

describe("render / stats", () => {
    it("渲染含 seq / 时间 / kind / 标题 / refs", () => {
        store.addEntries(TASK, [{ kind: "pitfall", title: "坑", refs: ["abc123"], ts: "2026-10-21T05:06:07.000Z" }]);
        const text = store.findJournal(TASK).text;
        expect(text).toContain("### #1 · 2026-10-21 05:06 · pitfall · 坑");
        expect(text).toContain("refs: `abc123`");
    });

    it("stats 按 kind 计数且五个 kind 恒在（没有的记 0）", () => {
        store.addEntries(TASK, [
            { kind: "pitfall", title: "a" },
            { kind: "pitfall", title: "b" },
        ]);
        const s = store.journalStats(TASK);
        expect(s.total).toBe(2);
        expect(s.byKind.pitfall).toBe(2);
        expect(s.byKind.decision).toBe(0);
        expect(s.bytes).toBeGreaterThan(0);
    });
});
