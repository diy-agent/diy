// tests/services/local-ops-seek.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 大会话 seek 起点（任务 ##293）：按字节预算向上取最近轮首
//
// 钉住三条保证（与实现头注一一对应）：
//   ① 返回偏移恒在**行首**（字节偏移；UTF-8 多字节内容不按字符数算）；
//   ② 返回 `0` 或 `size - offset >= budgetBytes`（`0` = 全量，永远合法）；
//   ③ 窗口内每轮完整（除末轮外每个 turn 的 start 都有 stop）。
// 另加「与朴素全量实现逐一对拍」—— 语义的唯一权威是那句定义，不是本实现的回溯技巧。
//
// 纯文件读写，无 Electron / 无网络。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seekWindowStart, SEEK_CHUNK_BYTES } from "../../src/main/services/local-ops-seek";
import type { Op } from "../../src/main/services/local-blocks";

let dir: string;
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "diy-seek-"));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const tmpFile = (): string => join(dir, `s${seq++}.ops.jsonl`);

function writeOps(fp: string, ops: Op[]): void {
    writeFileSync(fp, ops.map((o) => `${JSON.stringify(o)}\n`).join(""), "utf-8");
}

/** 一轮：turn start + 一个 text 块（内容重复 `pad` 次 `unit`）+ 收尾 */
function turnOps(id: string, pad = 0, unit = "x"): Op[] {
    const sid = `${id}-b1`;
    return [
        { op: "start", id, kind: "turn", meta: { model: "m" } },
        { op: "start", id: sid, kind: "text", parent: id },
        { op: "patch", id: sid, fields: { content: unit.repeat(pad) } },
        { op: "stop", id: sid },
        { op: "stop", id },
    ];
}

/** 参照实现（朴素全量扫描）：同一句定义的另一份写法，用来对拍 */
function naiveSeek(buf: Buffer, budgetBytes: number): number {
    const size = buf.length;
    const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : 0;
    const target = size - budget;
    if (target <= 0) return 0;
    let best = 0;
    let start = 0;
    for (let i = 0; i <= size; i++) {
        if (i < size && buf[i] !== 0x0a) continue;
        const raw = buf.subarray(start, i).toString("utf-8").trim();
        if (raw) {
            try {
                const o = JSON.parse(raw) as { op?: unknown; kind?: unknown };
                if (o.op === "start" && o.kind === "turn" && start <= target) best = start;
            } catch {
                /* 半行/坏行：跳过 */
            }
        }
        start = i + 1;
    }
    return best;
}

/** 断言三条保证（对任意返回值都必须成立） */
function checkInvariants(fp: string, budget: number, off: number): void {
    const buf = readFileSync(fp);
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeLessThan(buf.length);
    if (off === 0) return; // 全量：语义上永远合法（① 行首 / ② 无需 ≥ budget）
    // ① 行首
    expect(buf[off - 1]).toBe(0x0a);
    // ② 窗口 ≥ 预算
    expect(buf.length - off).toBeGreaterThanOrEqual(budget);
    // 该行确为轮 start 行
    const nl = buf.indexOf(0x0a, off);
    const op = JSON.parse(buf.subarray(off, nl < 0 ? buf.length : nl).toString("utf-8")) as {
        op?: unknown;
        kind?: unknown;
    };
    expect(op.op).toBe("start");
    expect(op.kind).toBe("turn");
}

describe("seekWindowStart — 基本语义", () => {
    it("文件不存在 → 0（无日志即全量，不炸）", () => {
        expect(seekWindowStart(join(dir, "nope.ops.jsonl"), 1024)).toBe(0);
    });

    it("空文件 → 0", () => {
        const fp = tmpFile();
        writeOps(fp, []);
        expect(seekWindowStart(fp, 1024)).toBe(0);
    });

    it("预算 ≥ 文件大小 → 0（没有任何可省的）", () => {
        const fp = tmpFile();
        const ops = [...turnOps("t1", 50), ...turnOps("t2", 50)];
        writeOps(fp, ops);
        const size = readFileSync(fp).length;
        expect(seekWindowStart(fp, size + 1)).toBe(0);
        expect(seekWindowStart(fp, size)).toBe(0); // 恰好相等：target = 0
    });

    it("预算无效（0 / NaN / 负）→ 退化成「只取最后一个轮首」", () => {
        const fp = tmpFile();
        writeOps(fp, [...turnOps("t1", 50), ...turnOps("t2", 50)]);
        const buf = readFileSync(fp);
        const last = buf.lastIndexOf(Buffer.from('{"op":"start","id":"t2"', "utf-8"));
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const off = seekWindowStart(fp, bad);
            // ±Infinity：+∞ ⇒ 预算 ≥ 全文件 ⇒ 0；其余 ⇒ 末轮轮首
            if (bad === Number.POSITIVE_INFINITY) expect(off).toBe(0);
            else expect(off).toBe(last);
        }
    });

    it("尾部半行（正在流式写）不干扰：仍取到完整轮首", () => {
        const fp = tmpFile();
        writeOps(fp, [...turnOps("t1", 50), ...turnOps("t2", 50)]);
        appendFileSync(fp, '{"op":"delta","id":"t2-b1","fields":{"content":"半行还', "utf-8");
        const buf = readFileSync(fp);
        const off = seekWindowStart(fp, 40);
        expect(off).toBe(naiveSeek(buf, 40));
        checkInvariants(fp, 40, off);
    });
});

describe("seekWindowStart — 三条保证", () => {
    it("① 偏移恒在行首（UTF-8 多字节按字节算，不按字符数）", () => {
        const fp = tmpFile();
        // 每轮内容全是 3 字节汉字：字符数 ≠ 字节数，行首判定必须按字节
        const ops = [1, 2, 3, 4, 5].flatMap((i) => turnOps(`t${i}`, 60, "汉字甲"));
        writeOps(fp, ops);
        const buf = readFileSync(fp);
        const size = buf.length;
        for (const budget of [1, 500, 2_000, 5_000, size - 1]) {
            const off = seekWindowStart(fp, budget);
            checkInvariants(fp, budget, off);
            expect(off).toBe(naiveSeek(buf, budget));
            if (off > 0) {
                // 行首处必是 `{"op":"start"...`（不能是半个汉字/半行）
                expect(buf.subarray(off, off + 10).toString("utf-8")).toBe('{"op":"sta');
            }
        }
    });

    it("② 窗口 ≥ 预算：预算落在轮内时**向上**取该轮轮首（故窗口可超额）", () => {
        const fp = tmpFile();
        writeOps(fp, [...turnOps("t1", 300), ...turnOps("t2", 50_000), ...turnOps("t3", 900)]);
        const buf = readFileSync(fp);
        const budget = 500; // target 落在 t3 内（t3 段 ~1000B）
        const off = seekWindowStart(fp, budget);
        const t3 = buf.lastIndexOf(Buffer.from('{"op":"start","id":"t3"', "utf-8"));
        expect(off).toBe(t3);
        expect(buf.length - off).toBeGreaterThan(budget); // 超额（多出 t3 在本预算内的部分）
        checkInvariants(fp, budget, off);
    });

    it("③ 窗口内每轮完整：除末轮外每个 turn 的 start 都有 stop", () => {
        const fp = tmpFile();
        writeOps(
            fp,
            [1, 2, 3, 4, 5, 6].flatMap((i) => turnOps(`t${i}`, 400)),
        );
        const budget = 2_000;
        const off = seekWindowStart(fp, budget);
        const win = readFileSync(fp).subarray(off).toString("utf-8").trimEnd().split("\n");
        const starts = new Set<string>();
        const stops = new Set<string>();
        for (const line of win) {
            const o = JSON.parse(line) as { op: string; id: string; kind?: string };
            if (o.op === "start" && o.kind === "turn") starts.add(o.id);
            if (o.op === "stop") stops.add(o.id);
        }
        const ids = [...starts];
        expect(ids.length).toBeGreaterThan(1); // 至少两轮，否则"除末轮外"没东西可查
        for (const id of ids.slice(0, -1)) expect(stops.has(id), `${id} 缺 stop`).toBe(true);
    });
});

describe("seekWindowStart — 识别与回溯", () => {
    it("非轮 start 行（text/step 的 start）不被误当轮首", () => {
        const fp = tmpFile();
        // 一轮内容里带一条 kind:"text" 的 start 行 —— 字面模式像，语义不是
        const ops: Op[] = [
            ...turnOps("t1", 20),
            { op: "start", id: "t1-x", kind: "text", parent: "t1" },
            { op: "stop", id: "t1-x" },
            ...turnOps("t2", 20),
        ];
        writeOps(fp, ops);
        const buf = readFileSync(fp);
        const budget = 20; // target 落在伪造的 text start 行之后
        const off = seekWindowStart(fp, budget);
        expect(off).toBe(naiveSeek(buf, budget));
        const nl = buf.indexOf(0x0a, off);
        expect(buf.subarray(off, nl).toString("utf-8")).toContain('"kind":"turn"');
    });

    it("坏行（半截 JSON）不参与候选：跳过继续往前找", () => {
        const fp = tmpFile();
        const good = turnOps("t1", 100);
        writeFileSync(
            fp,
            `${JSON.stringify(good[0])}\n{"op":"start","id":"t2","kind":TRUNC\n`,
            "utf-8",
        );
        const buf = readFileSync(fp);
        const off = seekWindowStart(fp, 10);
        expect(off).toBe(0); // 唯一真轮首在文件头 → 全量
        expect(naiveSeek(buf, 10)).toBe(0);
    });

    it("单轮自身超预算：仍返回该轮轮首（窗口 > 预算，不落空）", () => {
        const fp = tmpFile();
        writeOps(fp, [...turnOps("t1", 20), ...turnOps("t2", 400_000)]);
        const buf = readFileSync(fp);
        const budget = 1_000; // 末轮 400KB ≫ 预算
        const off = seekWindowStart(fp, budget);
        expect(off).toBe(naiveSeek(buf, budget));
        expect(off).toBe(buf.lastIndexOf(Buffer.from('{"op":"start","id":"t2"', "utf-8")));
        expect(off).toBeGreaterThan(0); // 不是全量
        checkInvariants(fp, budget, off);
    });

    it("跨块回溯：末轮 > 2×块大小，起点在更早的块里也能取到", () => {
        const fp = tmpFile();
        const big = SEEK_CHUNK_BYTES * 2 + 1_000; // 单轮 ~512KB
        writeOps(fp, [...turnOps("t1", 100), ...turnOps("t2", big)]);
        const buf = readFileSync(fp);
        expect(buf.length).toBeGreaterThan(SEEK_CHUNK_BYTES * 2);
        const budget = 1_000; // target 距 t2 轮首 ~512KB ⇒ 必须跨至少两块回溯
        const off = seekWindowStart(fp, budget);
        expect(off).toBe(naiveSeek(buf, budget));
        expect(off).toBe(buf.lastIndexOf(Buffer.from('{"op":"start","id":"t2"', "utf-8")));
        checkInvariants(fp, budget, off);
    });

    it("轮首恰在 target 之后 / 之前：floor 语义与朴素实现一致", () => {
        const fp = tmpFile();
        writeOps(
            fp,
            [1, 2, 3].flatMap((i) => turnOps(`t${i}`, 1_000)),
        );
        const buf = readFileSync(fp);
        const t2 = buf.lastIndexOf(Buffer.from('{"op":"start","id":"t2"', "utf-8"));
        const t3 = buf.lastIndexOf(Buffer.from('{"op":"start","id":"t3"', "utf-8"));
        // target 恰为 t3 轮首 ⇒ 取 t3（≤ 成立）
        expect(seekWindowStart(fp, buf.length - t3)).toBe(t3);
        // 再要 1 字节预算：target 落到 t3 轮首**之前** ⇒ 只能退到 t2（窗口随之超额）
        expect(seekWindowStart(fp, buf.length - t3 + 1)).toBe(t2);
    });

    it("随机对拍：不同规模/预算下与朴素实现逐一致，且三条保证成立", () => {
        const fp = tmpFile();
        const rand = (n: number): number => Math.floor(Math.random() * n);
        const ops: Op[] = [];
        let bytes = 0;
        for (let i = 0; i < 30; i++) {
            // 轮大小跨越三个量级（含个别巨轮），制造各种 target 落点
            const unit = i % 3 === 0 ? "汉字甲" : "x";
            const pad = i % 7 === 0 ? rand(300_000) : rand(3_000);
            const t = turnOps(`r${i}`, pad, unit);
            ops.push(...t);
        }
        writeOps(fp, ops);
        bytes = readFileSync(fp).length;
        for (let k = 0; k < 24; k++) {
            const budget = rand(bytes) + 1;
            const off = seekWindowStart(fp, budget);
            expect(off, `budget=${budget}`).toBe(naiveSeek(readFileSync(fp), budget));
            checkInvariants(fp, budget, off);
        }
        expect(bytes).toBeGreaterThan(1_000); // 对拍样本别是退化的
    });
});
