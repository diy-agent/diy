// tests/core/traffic-log.test.ts
// 流量日志落盘：按天切文件、追加并回读位置、版本兼容口径、失效提示。
import { describe, it, expect } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
    appendRecord,
    readRecord,
    queryRecords,
    dayFile,
    absOf,
    listFileDetail,
    cleanLogs,
    LOG_DIR_REL,
    LOG_FORMAT,
    TrafficLogError,
} from "../../src/main/core/traffic-log";

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
        // 目录自己建：本用例不依赖「别的用例先跑过 appendRecord」——`--sequence.shuffle` 会打乱顺序
        mkdirSync(dirname(abs), { recursive: true });
        appendFileSync(abs, JSON.stringify({ _fmt: "9.0", url: "x" }) + "\n");
        expect(() => readRecord({ file: rel, offset: 0, len: 999 })).toThrow(TrafficLogError);
    });

    it("小版本差异仍可读（只忽略未知字段）", () => {
        const rel = `${LOG_DIR_REL}/1998-01-02.jsonl`;
        const abs = absOf(rel);
        mkdirSync(dirname(abs), { recursive: true });
        const line = JSON.stringify({ _fmt: "1.7", url: "y", futureField: 1 }) + "\n";
        appendFileSync(abs, line);
        const back = readRecord({ file: rel, offset: 0, len: Buffer.byteLength(line) }) as Record<string, unknown>;
        expect(back.url).toBe("y");
    });

    it("换数据根后写入器跟着换根（不留旧 fd）：两个根里各写一条，各自可回读", () => {
        // 回归（##402 实测）：`Writer` 是模块级单例、缓存的 fd 只按**天**换 ⇒ 前一个文件把
        // `DIY_HOME` 临时切走再切回时，这里仍写进旧根的文件 ⇒ 目标根没有那个文件，
        // 回读报「日志文件已不存在」。单测里切 `DIY_HOME` 是常规操作（room / seed 等），
        // 故按「天 + 数据根」双键换 fd。
        const a = mkdtempSync(join(tmpdir(), "traffic-log-rootA-"));
        const b = mkdtempSync(join(tmpdir(), "traffic-log-rootB-"));
        const prev = process.env["DIY_HOME"];
        try {
            process.env["DIY_HOME"] = a;
            const locA = appendRecord({ url: "https://a.example/rootA" });
            process.env["DIY_HOME"] = b;
            const locB = appendRecord({ url: "https://b.example/rootB" });
            // 回读各自那个根（位置里的 file 是相对路径，按当前 DIY_HOME 解析）
            expect((readRecord(locB) as { url?: string }).url).toBe("https://b.example/rootB");
            process.env["DIY_HOME"] = a;
            const locA2 = appendRecord({ url: "https://a.example/rootA2" });
            expect((readRecord(locA) as { url?: string }).url).toBe("https://a.example/rootA");
            expect((readRecord(locA2) as { url?: string }).url).toBe("https://a.example/rootA2");
            expect(existsSync(absOf(locA2.file))).toBe(true);
            // 旧根的那份没被"续写"进 a 根的同名文件（= 没有把两条记录叠在一起）
            expect((readRecord(locA) as { url?: string }).url).not.toBe("https://b.example/rootB");
        } finally {
            if (prev === undefined) delete process.env["DIY_HOME"];
            else process.env["DIY_HOME"] = prev;
            rmSync(a, { recursive: true, force: true });
            rmSync(b, { recursive: true, force: true });
        }
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

// ── 清理（##324 流量日志缓存清理界面）──────────────────────────────
// 口径（任务 ##324 body）：单位 = 整个按天文件；**今天正在写入的不可删**；删除不可恢复。

/** 本地日期偏移 n 天 → "YYYY-MM-DD" */
function dayShift(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return dayFile(d).replace(".jsonl", "");
}

/** 造一个某日期的日志文件（1 行），返回相对路径 */
function makeDay(n: number): string {
    appendRecord({ url: "https://seed.example/warmup", status: 200 }); // 确保目录存在
    const rel = `${LOG_DIR_REL}/${dayShift(n)}.jsonl`;
    appendFileSync(absOf(rel), JSON.stringify({ _fmt: LOG_FORMAT, url: `https://d${n}.example/x` }) + "\n");
    return rel;
}

describe("traffic-log 清理（##324）", () => {
    it("listFileDetail：日期 / 占用 / 今天标记（新的在前）", () => {
        const today = makeDay(0);
        const old = makeDay(-3);
        const detail = listFileDetail();
        const files = detail.map((d) => d.file);
        expect(files).toContain(today);
        expect(files).toContain(old);
        // 新的在前
        expect(files.indexOf(today)).toBeLessThan(files.indexOf(old));
        const t = detail.find((d) => d.file === today)!;
        expect(t.today).toBe(true);
        expect(t.date).toBe(dayShift(0));
        expect(t.bytes).toBeGreaterThan(0);
        expect(t.mtimeMs).toBeGreaterThan(0);
        expect(detail.find((d) => d.file === old)!.today).toBe(false);
    });

    it("cleanLogs(files)：真删旧文件、回报释放字节与剩余", () => {
        const old = makeDay(-4);
        const before = listFileDetail().find((d) => d.file === old)!.bytes;
        const r = cleanLogs({ files: [old] });
        expect(r.deleted).toEqual([old]);
        expect(r.freedBytes).toBe(before);
        expect(existsSync(absOf(old))).toBe(false);
        expect(r.remaining.files).toBe(listFileDetail().length);
    });

    it("今天（正在写入）的文件不可删 → skipped 带原因，文件还在", () => {
        const today = makeDay(0);
        const r = cleanLogs({ files: [today] });
        expect(r.deleted).toEqual([]);
        expect(r.skipped.some((s) => s.file === today && /今天/.test(s.reason))).toBe(true);
        expect(existsSync(absOf(today))).toBe(true);
    });

    it("越界 / 名字不合规一律拒（绝不删日志目录外的东西）", () => {
        const r = cleanLogs({ files: ["state.yaml", "log/network/../state.yaml", "log/network/notes.txt"] });
        expect(r.deleted).toEqual([]);
        expect(r.skipped.length).toBe(3);
        expect(r.skipped.every((s) => s.reason.includes("不是日志目录"))).toBe(true);
    });

    it("keepDays：只留最近 N 天（含今天），更早的删掉", () => {
        const keep1 = makeDay(-1);
        const keep2 = makeDay(-2);
        const gone1 = makeDay(-5);
        const gone2 = makeDay(-30);
        const r = cleanLogs({ keepDays: 3 }); // 保留今天 / -1 / -2
        expect(r.deleted).toContain(gone1);
        expect(r.deleted).toContain(gone2);
        expect(r.deleted).not.toContain(keep1);
        expect(r.deleted).not.toContain(keep2);
        expect(existsSync(absOf(gone1))).toBe(false);
        expect(existsSync(absOf(keep2))).toBe(true);
    });

    it("dryRun：只算不删", () => {
        const old = makeDay(-6);
        const before = listFileDetail().find((d) => d.file === old)!.bytes;
        const r = cleanLogs({ files: [old], dryRun: true });
        expect(r.deleted).toEqual([old]);
        expect(r.freedBytes).toBe(before);
        expect(existsSync(absOf(old))).toBe(true); // 磁盘没动
    });

    it("文件不存在 → skipped（不抛）", () => {
        const r = cleanLogs({ files: [`${LOG_DIR_REL}/1997-01-01.jsonl`] });
        expect(r.deleted).toEqual([]);
        expect(r.skipped[0]!.reason).toContain("不存在");
    });
});
