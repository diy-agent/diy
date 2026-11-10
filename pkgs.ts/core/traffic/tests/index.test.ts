import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrafficStore, dayFileOf, type TrafficEntry } from "../src/index.js";

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traffic-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const http = (taskUri: string | null, extra: Record<string, unknown> = {}): TrafficEntry => ({
    kind: "http",
    at: 1_700_000_000_000,
    taskUri,
    ...extra,
});

describe("环形缓冲", () => {
    it("条数上限：超出就淘汰最旧的，dropped 累加", () => {
        const s = new TrafficStore({ bufferSize: 3 });
        for (let i = 0; i < 5; i += 1) s.push(http(`t${i}`));
        expect(s.recent().map((e) => e["taskUri"])).toEqual(["t2", "t3", "t4"]);
        expect(s.stats().dropped).toBe(2);
    });

    it("字节上限：单条超大不会被立刻淘汰（保证窗口至少留一条）", () => {
        const s = new TrafficStore({ bufferSize: 100, maxBytes: 100 });
        s.push(http("big", { reqBody: "x".repeat(5000) }));
        expect(s.recent()).toHaveLength(1);
    });

    it("字节上限：多条累计超了就淘汰旧的", () => {
        const s = new TrafficStore({ bufferSize: 100, maxBytes: 400 });
        for (let i = 0; i < 10; i += 1) s.push(http(`t${i}`, { reqBody: "x".repeat(100) }));
        const n = s.recent().length;
        expect(n).toBeLessThan(10);
        expect(s.stats().bytes).toBeLessThanOrEqual(400);
    });

    it("push 不传 at ⇒ 用注入的时钟补", () => {
        const s = new TrafficStore({ now: () => 12345 });
        s.push({ kind: "http" });
        expect(s.recent()[0]!.at).toBe(12345);
    });
});

describe("recent 筛选", () => {
    it("按 kind / taskUri / since / n 过滤", () => {
        const s = new TrafficStore();
        s.push({ kind: "http", at: 100, taskUri: "a" });
        s.push({ kind: "job", at: 200, taskUri: "a" });
        s.push({ kind: "http", at: 300, taskUri: "b" });

        expect(s.recent({ kind: "http" })).toHaveLength(2);
        expect(s.recent({ kind: ["http", "job"] })).toHaveLength(3);
        expect(s.recent({ taskUri: "a" })).toHaveLength(2);
        expect(s.recent({ since: 200 })).toHaveLength(2);
        expect(s.recent({ n: 1 })).toHaveLength(1);
        expect(s.recent({ n: 1 })[0]!.at).toBe(300);
    });

    it("返回副本 —— 改它不影响内部状态", () => {
        const s = new TrafficStore();
        s.push(http("a"));
        const got = s.recent();
        (got as TrafficEntry[]).length = 0;
        expect(s.recent()).toHaveLength(1);
    });
});

describe("订阅", () => {
    it("push 会同步推给订阅者；取消后不再推", () => {
        const s = new TrafficStore();
        const seen: TrafficEntry[] = [];
        const off = s.subscribe((e) => seen.push(e));
        s.push(http("a"));
        s.push(http("b"));
        off();
        s.push(http("c"));
        expect(seen.map((e) => e["taskUri"])).toEqual(["a", "b"]);
    });

    it("一个订阅者抛错不影响其他订阅者，也不影响 push", () => {
        const s = new TrafficStore();
        const seen: string[] = [];
        s.subscribe(() => {
            throw new Error("订阅者炸了");
        });
        s.subscribe((e) => seen.push(String(e["taskUri"])));
        expect(() => s.push(http("a"))).not.toThrow();
        expect(seen).toEqual(["a"]);
        expect(s.recent()).toHaveLength(1);
    });
});

describe("落盘与文件查询", () => {
    it("persist=true 写当天文件；query 能读回，且**新的在前**", () => {
        const s = new TrafficStore({ persist: true, dir, now: () => 1_700_000_000_000 });
        s.push(http("a", { at: 1_700_000_000_000 }));
        s.push(http("b", { at: 1_700_000_001_000 }));
        const file = join(dir, dayFileOf(1_700_000_000_000));
        expect(readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(2);
        // query 返回按时间正序（与 recent 同构），所以最后一条是 b
        expect(s.query().map((e) => e["taskUri"])).toEqual(["a", "b"]);
    });

    it("persist=false 时 query 返回空（没有文件可查）", () => {
        const s = new TrafficStore({ dir });
        s.push(http("a"));
        expect(s.query()).toEqual([]);
    });

    it("persist=true 但没给 dir ⇒ 构造就抛", () => {
        expect(() => new TrafficStore({ persist: true })).toThrow(/dir/);
    });

    it("query 能跨文件按 limit 截断（不加载全部分片）", () => {
        writeFileSync(join(dir, "2026-01-01.jsonl"), `${JSON.stringify(http("old"))}\n`, "utf-8");
        writeFileSync(join(dir, "2026-02-01.jsonl"), `${JSON.stringify(http("new"))}\n`, "utf-8");
        const s = new TrafficStore({ persist: true, dir });
        expect(s.query({ n: 1 }).map((e) => e["taskUri"])).toEqual(["new"]);
    });

    it("落盘失败 ⇒ 推一条 persist-error，但内存那条仍在，且不抛", () => {
        // 用一个"目录路径当文件"的手法制造写失败：dir 指向一个普通文件
        const bad = join(dir, "not-a-dir");
        writeFileSync(bad, "x", "utf-8");
        const s = new TrafficStore({ persist: true, dir: bad });
        const errors: TrafficEntry[] = [];
        s.subscribe((e) => {
            if (e.kind === "persist-error") errors.push(e);
        });
        expect(() => s.push(http("a"))).not.toThrow();
        expect(s.recent({ kind: "http" })).toHaveLength(1);
        expect(errors).toHaveLength(1);
        expect(s.stats().persistErrors).toBe(1);
    });
});

describe("dayFileOf", () => {
    it("本地时区的 YYYY-MM-DD.jsonl", () => {
        const at = new Date(2026, 10, 10, 15, 30).getTime(); // 本地 2026-11-10
        expect(dayFileOf(at)).toBe("2026-11-10.jsonl");
    });
});
