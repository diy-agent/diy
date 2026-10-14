// tests/core/local-agent-history-window.test.ts
// 🎯 大会话分页的**窗口与游标**（任务 ##293）。
//
// 契约（渲染端只回传游标、不解释字节，故这里只验行为）：
//   ① 窗口 ops 是「全量轮次序列的一段**连续后缀/前段**」，段边界在轮 start 上；
//   ② 带游标重取 = 同一段（起点不变），文件只变长 ⇒ 只是这一段变长（增量刷新的前提）；
//   ③ 上滚取更早一段：从**最老段起点**往前，拼起来与全量**无缺口、无重复**；
//   ④ 游标失效（清空 / 覆盖写 / 起点不再是轮首）一律退**全量**，绝不给出错位的窗口。
// 另外钉住 `history()`（全量、CLI 契约）与窗口互不影响：缓存按 (task, 起点) 分键。
// 纯文件读写 + 纯函数，无 Electron / 无网络。
import { describe, it, expect, beforeAll } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import { decodeCursor, encodeCursor, isTurnStartAt } from "../../src/main/services/local-ops-seek";
import type { Op } from "../../src/main/services/local-blocks";

/** 一轮的行（text 内容逐 token 落盘 → 折叠后一条 patch）：与真实形态一致 */
function turnLines(i: number, filler = 40): string[] {
    const id = `t${String(i).padStart(4, "0")}`;
    const chunk = "字".repeat(filler);
    return [
        JSON.stringify({ op: "start", id, kind: "turn", meta: { model: "0@test/m" } }),
        JSON.stringify({ op: "start", id: `${id}_u`, kind: "text", parent: id, meta: { role: "user" } }),
        JSON.stringify({ op: "delta", id: `${id}_u`, fields: { content: `问${i}` } }),
        JSON.stringify({ op: "stop", id: `${id}_u` }),
        JSON.stringify({ op: "start", id: `${id}_s1`, kind: "step", parent: id }),
        JSON.stringify({ op: "start", id: `${id}_a1`, kind: "text", parent: `${id}_s1`, meta: { role: "assistant" } }),
        JSON.stringify({ op: "delta", id: `${id}_a1`, fields: { content: chunk } }),
        JSON.stringify({ op: "stop", id: `${id}_a1` }),
        JSON.stringify({ op: "stop", id: `${id}_s1` }),
        JSON.stringify({ op: "stop", id }),
    ];
}

const turnIdsOf = (ops: Op[]): string[] =>
    ops.filter((o) => o.op === "start" && o.kind === "turn").map((o) => (o as { id: string }).id);

let manager: LocalAgentManager;
let project = "";
let seq = 0;

beforeAll(() => {
    manager = new LocalAgentManager();
    project = createProject(path.join(diyHome(), "hist-window-work"));
});

/** 新建一个会话（turns 轮），返回 uri 与 ops 文件路径 */
function newSession(turns: number, filler = 40): { uri: string; fp: string } {
    const uri = createTask({ title: `窗口 ${seq++}`, project });
    const fp = opsFile(uri);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, Array.from({ length: turns }, (_, k) => turnLines(k + 1, filler).join("\n")).join("\n") + "\n");
    return { uri, fp };
}

/** 一轮多少字节（用来把预算折算成轮数，避免把测试绑死在实现细节上） */
const turnBytes = (filler = 40): number => turnLines(1, filler).join("\n").length + 1;

describe("historyWindow：首载只折叠最近一段", () => {
    it("窗口是尾部连续的一段轮，起点是轮 start，且比全量小", () => {
        const { uri } = newSession(12);
        const whole = manager.history(uri);
        const budget = turnBytes() * 3; // 约 3 轮
        const w = manager.historyWindow(uri, { budgetBytes: budget });

        expect(turnIdsOf(w.ops).length).toBeGreaterThan(0);
        expect(turnIdsOf(w.ops).length).toBeLessThan(turnIdsOf(whole).length);
        // 首条就是轮 start（段边界落在轮首）
        expect(w.ops[0]).toMatchObject({ op: "start", kind: "turn" });
        // 后缀：窗口轮次 == 全量轮次的尾部
        const all = turnIdsOf(whole);
        expect(all.slice(all.length - turnIdsOf(w.ops).length)).toEqual(turnIdsOf(w.ops));
        expect(w.hasMore).toBe(true);
    });

    it("预算撑满整份 ⇒ 全量、hasMore=false", () => {
        const { uri } = newSession(4);
        const w = manager.historyWindow(uri, { budgetBytes: 10 * 1024 * 1024 });
        expect(turnIdsOf(w.ops)).toEqual(turnIdsOf(manager.history(uri)));
        expect(w.hasMore).toBe(false);
    });

    it("空会话：空 ops、hasMore=false、游标仍可用", () => {
        const uri = createTask({ title: `空 ${seq++}`, project });
        const w = manager.historyWindow(uri, { budgetBytes: 1024 });
        expect(w.ops).toEqual([]);
        expect(w.hasMore).toBe(false);
        expect(typeof w.cursor).toBe("string");
    });
});

describe("historyWindow + cursor：同段重取（轮末刷新的前提）", () => {
    it("追加新轮后带同一游标重取：含新轮、旧的轮一个不少、游标不变", () => {
        const { uri, fp } = newSession(10);
        const budget = turnBytes() * 2;
        const first = manager.historyWindow(uri, { budgetBytes: budget });
        const ids1 = turnIdsOf(first.ops);

        appendFileSync(fp, turnLines(9001).join("\n") + "\n");
        const again = manager.historyWindow(uri, { cursor: first.cursor });

        // 起点没变（token 文本可能变：里面绑着签发时的文件大小，但偏移是同一个）
        expect(decodeCursor(again.cursor, fp)).toBe(decodeCursor(first.cursor, fp));
        const ids2 = turnIdsOf(again.ops);
        expect(ids2.slice(0, ids1.length)).toEqual(ids1); // 老段是前缀（可增量并入）
        expect(ids2.at(-1)).toBe("t9001");
        expect(again.hasMore).toBe(first.hasMore);
        expect(first.stale).toBe(false);
        expect(again.stale).toBe(false); // 游标有效 ⇒ 不是退化全量
    });

    it("游标失效（覆盖写：前缀指纹变了）⇒ 退全量，而不是给错位的窗口", () => {
        const { uri, fp } = newSession(8);
        const w = manager.historyWindow(uri, { budgetBytes: turnBytes() * 2 });
        expect(turnIdsOf(w.ops).length).toBeLessThan(8);

        // 覆盖写：整份重写且内容不同（filler 变）⇒ 前 4KB 指纹变（同尺寸覆盖的唯一线索）
        writeFileSync(fp, Array.from({ length: 8 }, (_, k) => turnLines(k + 1, 400).join("\n")).join("\n") + "\n");
        const after = manager.historyWindow(uri, { cursor: w.cursor });
        expect(turnIdsOf(after.ops)).toEqual(turnIdsOf(manager.history(uri))); // 全量
        expect(after.hasMore).toBe(false);
        expect(after.stale).toBe(true); // **渲染端判据**：拿到 stale 就重置，不当前缀拼
    });

    it("游标失效（文件被清空）⇒ 空 ops", () => {
        const { uri, fp } = newSession(6);
        const w = manager.historyWindow(uri, { budgetBytes: turnBytes() * 2 });
        rmSync(fp, { force: true });
        const after = manager.historyWindow(uri, { cursor: w.cursor });
        expect(after.ops).toEqual([]);
        expect(after.stale).toBe(true);
    });
});

describe("historyOlder：上滚取更早一段，拼起来无缺口", () => {
    it("一路往上取：段段相接，最后 hasMore=false 且覆盖全部轮", () => {
        const { uri } = newSession(20);
        const all = turnIdsOf(manager.history(uri));
        const budget = turnBytes() * 3;

        const tail = manager.historyWindow(uri, { budgetBytes: budget });
        let cursor = tail.cursor;
        let acc = turnIdsOf(tail.ops);
        let hasMore = tail.hasMore;
        // 最老段起点（首段的 cursor 就是上滚的入口）
        let guard = 0;
        // 不变量（每轮都验）：已知序列恒为**全量的后缀**，且每补一段就正好往前接一段
        // —— 这就是「无缺口、无重复」的准确表述（单看局部两段接不上不代表错，
        // 关键是它们在全量里相邻）。真正的拼接由渲染端做，这里只验 main 给的段对不对。
        while (hasMore && guard++ < 50) {
            expect(all.slice(all.length - acc.length)).toEqual(acc);
            const older = manager.historyOlder(uri, { cursor, budgetBytes: budget });
            const ids = turnIdsOf(older.ops);
            expect(ids.length).toBeGreaterThan(0);
            const idx = all.length - acc.length; // 这一段该落在 [idx - ids.length, idx)
            expect(all.slice(idx - ids.length, idx)).toEqual(ids);
            acc = ids.concat(acc);
            cursor = older.cursor;
            hasMore = older.hasMore;
        }
        expect(acc).toEqual(all);
        expect(guard).toBeLessThan(50); // 真的收敛（没有原地打转）
    });

    it("到文件头：空段 + hasMore=false（且不是 stale —— 它就是按游标算出来的）", () => {
        const { uri } = newSession(3);
        const whole = manager.historyWindow(uri, { budgetBytes: 10 * 1024 * 1024 }); // 全量
        const older = manager.historyOlder(uri, { cursor: whole.cursor, budgetBytes: 4096 });
        expect(older.ops).toEqual([]);
        expect(older.hasMore).toBe(false);
        expect(older.stale).toBe(false);
    });

    it("游标失效 ⇒ 退全量并标 stale（渲染端据此重置，否则会把全量当「更早一段」前插）", () => {
        const { uri, fp } = newSession(6);
        const tail = manager.historyWindow(uri, { budgetBytes: turnBytes() * 2 });
        writeFileSync(fp, Array.from({ length: 6 }, (_, k) => turnLines(k + 1, 400).join("\n")).join("\n") + "\n");
        const older = manager.historyOlder(uri, { cursor: tail.cursor, budgetBytes: 4096 });
        expect(older.stale).toBe(true);
        expect(turnIdsOf(older.ops)).toEqual(turnIdsOf(manager.history(uri))); // 退的是全量
        expect(older.hasMore).toBe(false);
    });
});

describe("history()（全量 / CLI 契约）与窗口互不影响", () => {
    it("先取窗口再取全量：全量仍是全部轮", () => {
        const { uri } = newSession(9);
        const w = manager.historyWindow(uri, { budgetBytes: turnBytes() * 2 });
        expect(turnIdsOf(w.ops).length).toBeLessThan(9);
        expect(turnIdsOf(manager.history(uri)).length).toBe(9);
    });
});

describe("游标编解码：绑定「同一份日志」而不是「这一刻的大小」", () => {
    it("append（只往尾部加）后仍有效；前缀变了则失效", () => {
        // filler 撑到 >4KB：前 4KB 才是「整文件覆盖写」的有效哨兵（小于 4KB 时它等于整份）
        const { fp } = newSession(2, 800);
        const at = encodeCursor(fp, 0);
        expect(decodeCursor(at, fp)).toBe(0);

        appendFileSync(fp, turnLines(7, 800).join("\n") + "\n"); // 日志长大是常态，不该让游标失效
        expect(decodeCursor(at, fp)).toBe(0);

        writeFileSync(fp, "overwritten\n"); // 前缀变了 ⇒ 不是同一份日志
        expect(decodeCursor(at, fp)).toBeNull();
    });

    it("形态不对 / 版本不对 / 文件不存在 ⇒ null", () => {
        const { fp } = newSession(1);
        expect(decodeCursor("not-a-token", fp)).toBeNull();
        expect(decodeCursor(Buffer.from(JSON.stringify({ v: 99, at: 0 }), "utf-8").toString("base64url"), fp)).toBeNull();
        expect(decodeCursor(encodeCursor(fp, 0), path.join(path.dirname(fp), "nope.jsonl"))).toBeNull();
    });

    it("isTurnStartAt：轮首 true、行中间 false", () => {
        const { fp } = newSession(3);
        const first = Buffer.from(turnLines(1).join("\n") + "\n", "utf-8");
        expect(isTurnStartAt(fp, 0)).toBe(true);
        expect(isTurnStartAt(fp, 5)).toBe(false); // 第一轮内部：行中间
        expect(isTurnStartAt(fp, first.length)).toBe(true); // 第二轮的行首
    });
});
