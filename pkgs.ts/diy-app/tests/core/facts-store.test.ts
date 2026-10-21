// tests/core/facts-store.test.ts — 事实库 RPC 侧适配（##404）
//
// 压的是 RPC 边界上才有的三种失败：定位真源（cwd 不是仓库）、载荷形状、readonly→DTO。
// 判据本身在 @diy/facts 已各自单测，这里**不重复验判据**，只验"接线没接歪"。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as store from "../../src/main/services/facts-store";

let root = "";
let kb = "";
const prevDir = process.env["DIY_FACTS_DIR"];

function write(rel: string, text: string): void {
    const abs = path.join(kb, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
}

beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "facts-rpc-"));
    kb = path.join(root, "knowledge");
    writeFileSync(path.join(root, "K.ts"), "1\n2\n3\n");
    write("subjects.yaml", "subjects:\n  app.port:\n    description: 端口\n  dev.test:\n    description: 测试\n");
    write(
        "facts/app.yaml",
        [
            "domain: app",
            "facts:",
            "  - id: port.production",
            "    subject: app.port",
            "    aspect: default",
            "    value: '18888'",
            "    scope: { env: production }",
            "    review: accepted",
            "    lifecycle: active",
            "    evidence: { source: code, at: K.ts:2, verifiedAt: '2026-10-21' }",
            "  - id: port.dev",
            "    subject: app.port",
            "    aspect: default",
            "    value: '0'",
            "    scope: { env: [development, test] }",
            "    review: accepted",
            "    lifecycle: active",
            "    evidence: { source: code, at: K.ts:2, verifiedAt: '2026-10-21' }",
            "",
        ].join("\n"),
    );
    process.env["DIY_FACTS_DIR"] = kb;
});
afterEach(() => {
    if (prevDir === undefined) delete process.env["DIY_FACTS_DIR"];
    else process.env["DIY_FACTS_DIR"] = prevDir;
    rmSync(root, { recursive: true, force: true });
});

describe("定位真源", () => {
    it("显式 --dir 优先，其次 DIY_FACTS_DIR", () => {
        expect(store.resolveFactsDir(kb)).toBe(kb);
        expect(store.resolveFactsDir()).toBe(kb);
    });

    it("显式目录原样返回（不预检），读取时才报不存在 —— 不静默当空库", () => {
        delete process.env["DIY_FACTS_DIR"];
        expect(store.resolveFactsDir("/definitely/not/here")).toBe("/definitely/not/here");
        expect(() => store.status("/definitely/not/here")).toThrow(/不存在|repo-missing/);
    });
});

describe("status / get", () => {
    it("status 计数与问题数与真源一致", () => {
        const r = store.status();
        expect(r.facts).toBe(2);
        expect(r.claims).toBe(1);
        expect(r.problems.filter((p) => p.level === "error")).toEqual([]);
    });

    it("按 env 取到对应变体（不是随便挑一条）", () => {
        const prod = store.get(["app.port#default"], { env: "production" });
        expect(prod.resolved[0]?.facts[0]?.value).toBe("18888");
        const dev = store.get(["app.port#default"], { env: "test" });
        expect(dev.resolved[0]?.facts[0]?.value).toBe("0");
    });

    it("悬空不是没找到：带码进 notes", () => {
        const r = store.get(["nope#x"]);
        expect(r.resolved).toEqual([]);
        expect(r.notes[0]).toContain("facts/claim-unknown");
    });
});

describe("submit", () => {
    it("载荷解析：裸数组与 {facts,subjects} 都收", () => {
        expect(store.parseSubmitPayload("[]").facts).toEqual([]);
        expect(store.parseSubmitPayload('{"facts":[{"id":"a"}],"subjects":[{"key":"s"}]}').subjects).toEqual([{ key: "s" }]);
        expect(() => store.parseSubmitPayload("{oops")).toThrow(/JSON/);
    });

    it("dry-run 回差异但不落盘", () => {
        const before = readFileSync(path.join(kb, "facts/app.yaml"), "utf8");
        const payload = store.parseSubmitPayload(
            JSON.stringify({
                facts: [
                    {
                        id: "port.production",
                        subject: "app.port",
                        aspect: "default",
                        value: "9999",
                        scope: { env: "production" },
                        review: "accepted",
                        lifecycle: "active",
                        evidence: { source: "code", at: "K.ts:2", verifiedAt: "2026-10-21" },
                    },
                ],
            }),
        );
        const r = store.submitPayload(payload, { dryRun: true });
        expect(r.report.updated.map((u) => u.id)).toEqual(["port.production"]);
        expect(readFileSync(path.join(kb, "facts/app.yaml"), "utf8")).toBe(before);
    });

    it("真写：字段顺序固化，条目按 claim 排序（diff 只落在改动那条）", () => {
        const payload = store.parseSubmitPayload(
            JSON.stringify({
                facts: [
                    {
                        id: "test.entry",
                        subject: "dev.test",
                        aspect: "entry",
                        value: "./sha.sh test-unit",
                        review: "accepted",
                        lifecycle: "active",
                        evidence: { source: "code", at: "K.ts:3", verifiedAt: "2026-10-21" },
                    },
                ],
            }),
        );
        const r = store.submitPayload(payload);
        expect(r.problems.filter((p) => p.level === "error")).toEqual([]);
        const text = readFileSync(path.join(kb, "facts/dev.yaml"), "utf8");
        expect(text).toContain("id: test.entry");
        expect(text.indexOf("id: test.entry")).toBeLessThan(text.indexOf("value: ./sha.sh test-unit"));
    });

    it("冲突整批拒：磁盘不动，问题带码回", () => {
        const payload = store.parseSubmitPayload(
            JSON.stringify([
                {
                    id: "port.dup",
                    subject: "app.port",
                    aspect: "default",
                    value: "4000",
                    scope: { env: "production" },
                    review: "accepted",
                    lifecycle: "active",
                    evidence: { source: "code", at: "K.ts:2", verifiedAt: "2026-10-21" },
                },
            ]),
        );
        const r = store.submitPayload(payload);
        expect(r.problems.map((p) => p.code)).toContain("facts/scope-conflict");
        expect(readFileSync(path.join(kb, "facts/app.yaml"), "utf8")).not.toContain("port.dup");
    });
});

describe("affected", () => {
    it("按 scope.paths 命中（改代码前的影响面）", () => {
        write(
            "facts/dev.yaml",
            [
                "domain: dev",
                "facts:",
                "  - id: test.bail",
                "    subject: dev.test",
                "    aspect: bail",
                "    value: 红灯即停",
                "    scope: { paths: [pkgs.ts/x] }",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: user, at: K.ts:3, verifiedAt: '2026-10-21' }",
                "",
            ].join("\n"),
        );
        const hit = store.affectedByFiles(["pkgs.ts/x/a.ts"]).ids;
        expect(hit).toContain("test.bail");
        expect(store.affectedByFiles(["other/b.ts"]).ids).not.toContain("test.bail");
    });
});
