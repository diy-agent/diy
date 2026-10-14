// tests/core/traffic-log.test.ts
// 流量日志落盘：按天切文件、追加并回读位置、版本兼容口径、失效提示。
import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { appendRecord, readRecord, queryRecords, dayFile, absOf, LOG_DIR_REL, LOG_FORMAT, TrafficLogError } from "../../src/main/core/traffic-log";

describe("traffic-log", () => {
    it("按天切文件名（本地日期）", () => {
        expect(dayFile(new Date(2026, 9, 13))).toBe("2026-10-13.jsonl");
    });

    it("追加 → 位置可回读（同一行）", () => {
        const loc = appendRecord({ url: "https://a.example/x", status: 200 });
        expect(loc.file.startsWith(LOG_DIR_REL + "/")).toBe(true);
        const back = readRecord(loc) as Record<string, unknown>;
        expect(back.url).toBe("https://a.example/x");
        expect(back._fmt).toBe(LOG_FORMAT);
    });

    it("大版本不兼容 → 抛 TrafficLogError（跳过，不迁移）", () => {
        // 手写一行格式大版本为 9 的记录，读它应当被拒
        const rel = `${LOG_DIR_REL}/1998-01-01.jsonl`;
        const abs = absOf(rel);
        appendFileSync(abs, JSON.stringify({ _fmt: "9.0", url: "x" }) + "\n");
        expect(() => readRecord({ file: rel, offset: 0, len: 999 })).toThrow(TrafficLogError);
    });

    it("小版本差异仍可读（只忽略未知字段）", () => {
        const rel = `${LOG_DIR_REL}/1998-01-02.jsonl`;
        const abs = absOf(rel);
        const line = JSON.stringify({ _fmt: "1.7", url: "y", futureField: 1 }) + "\n";
        appendFileSync(abs, line);
        const back = readRecord({ file: rel, offset: 0, len: Buffer.byteLength(line) }) as Record<string, unknown>;
        expect(back.url).toBe("y");
    });

    it("文件不存在 → 人话提示", () => {
        expect(() => readRecord({ file: `${LOG_DIR_REL}/1997-01-01.jsonl`, offset: 0, len: 1 })).toThrow(/不存在/);
    });

    it("位置带回行号与绝对路径（1 起算）", () => {
        const loc = appendRecord({ url: "https://a.example/l", status: 200 });
        expect(loc.line).toBeGreaterThan(0);
        expect(loc.abs.endsWith(loc.file)).toBe(true);
        const back = readRecord(loc) as Record<string, unknown>;
        expect(back.url).toBe("https://a.example/l");
    });

    it("按日期查（当天）→ 命中且新的在前，附 log 位置", () => {
        appendRecord({ url: "https://a.example/1", status: 200, ts: 1000 });
        appendRecord({ url: "https://a.example/2", status: 500, ts: 2000 });
        const r = queryRecords({ date: dayFile().replace(".jsonl", "") });
        expect(r.records.length).toBeGreaterThanOrEqual(2);
        // 新的在前
        expect(Number(r.records[0]!.ts)).toBeGreaterThanOrEqual(Number(r.records[1]!.ts));
        expect(r.records[0]!.log.abs).toBeTruthy();
        expect(r.records[0]!.log.line).toBeGreaterThan(0);
    });

    it("全文检索匹配正文（不区分大小写）", () => {
        appendRecord({ url: "https://a.example/s", status: 200, resBody: { head: "Hello TRACE-XYZ", tail: "" } });
        const hit = queryRecords({ date: "all", text: "trace-xyz" });
        expect(hit.records.some((x) => (x.url as string) === "https://a.example/s")).toBe(true);
        const miss = queryRecords({ date: "all", text: "不存在的关键词zzz" });
        expect(miss.records.some((x) => (x.url as string) === "https://a.example/s")).toBe(false);
    });

    it("状态过滤：err = 无状态（网络错）", () => {
        appendRecord({ url: "https://a.example/err", status: null, err: "ECONNRESET" });
        const r = queryRecords({ date: "all", status: "err" });
        expect(r.records.some((x) => (x.url as string) === "https://a.example/err")).toBe(true);
    });

    it("limit 截断时 truncated=true", () => {
        const r = queryRecords({ date: "all", limit: 1 });
        expect(r.records.length).toBeLessThanOrEqual(1);
        if (r.hits > 1) expect(r.truncated).toBe(true);
    });
});
