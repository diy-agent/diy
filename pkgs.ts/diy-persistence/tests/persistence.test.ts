// tests/persistence.test.ts
// @diy/persistence 的基本契约：键算法稳定、路径分层、appender 给出的锚点可被 checkOpsRef 认回、
// 压缩边界 append/read 往返。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
    checkOpsRef,
    createOpsAppender,
    keyOf,
    readBoundary,
    readOps,
    readTurnRecords,
    sessionFile,
    sessionIdOf,
    appendCompactionEntry,
    appendTurnRecord,
} from "../src/index";

const home = mkdtempSync(join(tmpdir(), "diy-persistence-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const uri = "projects/1/tasks/1";

describe("键与路径", () => {
    it("keyOf 稳定且带可读前缀；sessionIdOf 从它派生", () => {
        expect(keyOf(uri)).toBe(keyOf(uri));
        expect(keyOf(uri)).toMatch(/^projects_1_tasks_1-[0-9a-f]{12}$/);
        expect(sessionIdOf(uri)).toBe(`local-${keyOf(uri)}`);
        expect(keyOf("a/b")).not.toBe(keyOf("a:b")); // 防碰撞（历史坑）
    });

    it("路径落在 <home>/local/<uri 路径…>/<key>/<kind>.jsonl", () => {
        expect(sessionFile(home, uri, "turns")).toBe(join(home, "local", "projects", "1", "tasks", "1", keyOf(uri), "turns.jsonl"));
    });
});

describe("ops 写入器 + turns", () => {
    it("append 返回的锚点能被 checkOpsRef 认回；turns 记录落盘后可读", () => {
        const appender = createOpsAppender(home, uri);
        const ref = appender.append({ op: "start", id: "t1", kind: "turn" });
        expect(ref).toEqual({ offset: 0, len: expect.any(Number), seq: 1 });
        expect(appender.lastRef()).toEqual(ref);
        expect(checkOpsRef(home, uri, ref!)).toEqual({ ok: true });
        expect(readOps(home, uri)).toEqual([{ op: "start", id: "t1", kind: "turn" }]);

        appendTurnRecord(home, uri, {
            turnId: "t1",
            at: new Date().toISOString(),
            state: "ok",
            user: "问",
            texts: [{ seq: 2, text: "答" }],
            refFirstOp: ref!,
        });
        const [rec] = readTurnRecords(home, uri);
        expect(rec!.turnId).toBe("t1");
        expect(rec!.ref.ops).toEqual(ref);
        // 锚点对不上（行号/页内偏移变了）⇒ seq 悬空
        expect(checkOpsRef(home, uri, { ...ref!, seq: 9 })).toEqual({ ok: false, reason: "seq" });
    });

    it("压缩边界：append 后可读到**最后一条**（append-only ⇒ 后者覆盖前者）", () => {
        appendCompactionEntry(home, uri, {
            at: new Date().toISOString(),
            limitTokens: 1000,
            dropped: 3,
            headLine: 2,
            cut: { llmLine: 6, turnId: "t1" },
        });
        const b = readBoundary(home, uri);
        expect(b?.limitTokens).toBe(1000);
        expect(b?.cut.llmLine).toBe(6);
        expect(b?.headLine).toBe(2);
        // 落盘形状：一行一条 JSON（v2 + kind）
        const line = readFileSync(sessionFile(home, uri, "turns"), "utf-8").trim().split("\n").at(-1)!;
        const row = JSON.parse(line) as { v: number; kind: string };
        expect(row).toMatchObject({ v: 2, kind: "compaction" });
    });
});
