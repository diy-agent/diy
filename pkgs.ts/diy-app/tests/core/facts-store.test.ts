// tests/core/facts-store.test.ts — 事实库 RPC 侧适配（##404）
//
// 压的是 RPC 边界上才有的三种失败：定位真源（cwd 不是仓库）、载荷形状、readonly→DTO。
// 判据本身在 @diy/facts 已各自单测，这里**不重复验判据**，只验"接线没接歪"。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        expect(() => store.status({ dir: "/definitely/not/here" })).toThrow(/不存在|repo-missing/);
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
        // 真源是 **claim map**（350d2e33）：key = `subject#aspect`，`id` 降级为值里的可选字段。
        // 这条断言原本压"id 在 value 之前"，是列表形式年代的 —— 形状改了、断言没跟，红灯
        // 亮了很久没人管（`./sha.sh check` 不含单测）。现在压真正的契约：key 在最前。
        expect(text).toContain("dev.test#entry:");
        expect(text.indexOf("dev.test#entry")).toBeLessThan(text.indexOf("value: ./sha.sh test-unit"));
        // id 仍是**审计锚点**（不可派生），只是不再当结构键 —— 它必须还在值里
        expect(text).toContain("id: test.entry");
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

// ── 任务级库（--in task:<uri>）──────────────────────────────────────────────
//
// 与仓库库的差别只有两条：词表继承、首次写入即诞生。这里压这两条 + 定位判据。
// 为什么不测"当前任务"缺省：**没有这个缺省**（同时干两个任务时无从判断，见 resolveFactsTarget 头注）。
describe("--in task:<uri>（任务级库）", () => {
    let home = "";
    let taskDir = "";
    const prevHome = process.env["DIY_HOME"];

    beforeEach(() => {
        home = mkdtempSync(path.join(os.tmpdir(), "facts-home-"));
        process.env["DIY_HOME"] = home;
        taskDir = path.join(home, "projects/4/tasks/404");
        mkdirSync(taskDir, { recursive: true });
    });
    afterEach(() => {
        if (prevHome === undefined) delete process.env["DIY_HOME"];
        else process.env["DIY_HOME"] = prevHome;
        rmSync(home, { recursive: true, force: true });
    });

    const oneFact = {
        id: "edge.claim-target",
        subject: "dev.test",
        aspect: "bail",
        value: "跑到第一个失败为止",
        review: "accepted",
        lifecycle: "active",
        evidence: { source: "user", at: "K.ts:1", verifiedAt: "2026-10-21" },
    };

    it("解析到 <DIY_HOME>/<uri>/knowledge，词表回落仓库、允许首次建库", () => {
        const t = store.resolveFactsTarget({ in: "task:projects/4/tasks/404" });
        expect(t.dir).toBe(path.join(taskDir, "knowledge"));
        expect(t.allowMissing).toBe(true);
        expect(t.subjectsFallback).toBe(path.join(kb, "subjects.yaml"));
    });

    it("缺省 / project 指向仓库库（任务库不抢缺省）", () => {
        for (const spec of [undefined, "project"]) {
            const t = store.resolveFactsTarget(spec === undefined ? {} : { in: spec });
            expect(t.dir).toBe(kb);
            expect(t.allowMissing).toBe(false);
        }
    });

    it("global 指向**设备级库** <DIY_HOME>/knowledge，不是仓库库", () => {
        // 原先 global 与 project 都落到仓库库 —— 那让"设备级事实"无处可去（##5 需求 3 的实质）。
        const t = store.resolveFactsTarget({ in: "global" });
        expect(t.dir).toBe(path.join(home, "knowledge"));
        expect(t.allowMissing).toBe(true);
        // 词表仍继承仓库（同一套 subject 命名），证据按 ~ 解析
        expect(t.subjectsFallback).toBe(path.join(kb, "subjects.yaml"));
        // 证据解析根 = **真家目录**（不是 dirname(DIY_HOME)：lab 的 DIY_HOME 在 build/ 下）
        expect(t.root).toBe(os.homedir());
    });

    it("首次 submit 建库：目录不存在也能写，且继承的 subject 通得过 G3", () => {
        const r = store.submitPayload({ facts: [oneFact], subjects: [] }, { in: "task:projects/4/tasks/404" });
        expect(r.problems.filter((p) => p.level === "error")).toEqual([]);
        expect(r.report.added).toEqual(["edge.claim-target"]);
        // 真落盘在任务目录，仓库真源不受影响
        const written = readFileSync(path.join(taskDir, "knowledge/facts/dev.yaml"), "utf8");
        expect(written).toContain("edge.claim-target");
        expect(store.status().facts).toBe(2);
    });

    it("继承的词表不会被复制进本地（否则第一次写入就把继承退化成快照）", () => {
        // ① 只用继承来的 subject、不新增 → 本地根本不建 subjects.yaml
        store.submitPayload({ facts: [oneFact], subjects: [] }, { in: "task:projects/4/tasks/404" });
        expect(existsSync(path.join(taskDir, "knowledge/subjects.yaml"))).toBe(false);
        expect(store.status({ in: "task:projects/4/tasks/404" }).problems.filter((p) => p.level === "warning")).toEqual([]);

        // ② 新增一个本地 subject → 写回的文件只含这一个，不含继承来的 app.port / dev.test
        store.submitPayload(
            { facts: [], subjects: [{ key: "task.local", description: "本任务独有的对象" }] },
            { in: "task:projects/4/tasks/404" },
        );
        // 只看 `subjects:` 之后：文件头注本身就举例提到了 app.port
        const body = readFileSync(path.join(taskDir, "knowledge/subjects.yaml"), "utf8").split("subjects:")[1] ?? "";
        expect(body).toContain("task.local");
        expect(body).not.toContain("app.port");
        expect(body).not.toContain("dev.test");
    });

    it("本地 subjects.yaml 优先于仓库词表（局部扩词不污染仓库）", () => {
        const local = path.join(taskDir, "knowledge");
        mkdirSync(local, { recursive: true });
        writeFileSync(path.join(local, "subjects.yaml"), "subjects:\n  dev.test:\n    description: 任务局部描述\n");
        const t = store.resolveFactsTarget({ in: "task:projects/4/tasks/404" });
        expect(t.subjectsFallback).toBe(path.join(kb, "subjects.yaml"));
        const r = store.submitPayload({ facts: [oneFact], subjects: [] }, { in: "task:projects/4/tasks/404" });
        expect(r.problems.filter((p) => p.level === "error")).toEqual([]);
    });

    it("uri 形状不对 / 任务目录不存在 → 带码报错，不静默落到别处", () => {
        expect(() => store.resolveFactsTarget({ in: "task:404" })).toThrow(/bad-in|task:<taskUri>/);
        expect(() => store.resolveFactsTarget({ in: "task:projects/4/tasks/999" })).toThrow(/task-missing|不存在/);
        expect(() => store.resolveFactsTarget({ in: "whatever" })).toThrow(/bad-in|task:<taskUri>/);
    });

    it("status --in 尚未建库 → 报缺失（不当空库），讯息指向 submit", () => {
        expect(() => store.status({ in: "task:projects/4/tasks/404" })).toThrow(/还没建.*submit/);
    });
});

// ── 目录级摘要 / 全文检索（##5 报送的需求 1、2）─────────────────
//
// 这两条命令存在的唯一理由是**链上正文要能删**：删了之后 agent 得先"扫一眼有哪些条目"
// （brief）或"按听到的词定位"（find），否则 `get` 要求精确 claim 就成了死门槛。
// 所以压的是"能不能替我决定下一步查哪条"，不是"格式对不对"。
describe("brief", () => {
    it("列全部 aspect，按 aspect 排序，变体数如实计数", () => {
        const r = store.brief("app.port", { dir: kb }).subjects[0]!;
        expect(r.subject).toBe("app.port");
        expect(r.desc).toBe("端口");
        // beforeEach 的 app.port 只有 default 一个 aspect、两条变体（production / dev+test）
        expect(r.entries.map((e) => e.aspect)).toEqual(["default"]);
        expect(r.claims).toBe(1);
        expect(r.facts).toBe(2);
        // `variants > 1` 是"该问一句当前环境"的信号（与投递投影 cell.variants 同义）
        expect(r.entries[0]!.variants).toBe(2);
        // 代表值取**最通用**的一条：`env: [development, test]`（管两个环境）比
        // `env: production`（管一个）更像通例 → "0"。这条断言同时锁住"不随文件行序抖"。
        expect(r.entries[0]!.preview).toBe("0");
    });

    it("subject 不存在 ⇒ 不报错，给相近主题（只说「没有」等于让人重敲一次）", () => {
        const r = store.brief("app.po", { dir: kb }).subjects[0]!;
        expect(r.entries).toEqual([]);
        expect(r.notes.join(" ")).toContain("相近");
        expect(r.notes.join(" ")).toContain("app.port");
    });

    it("preview 是线索不是结论：超长截断带 …，且比完整值短", () => {
        const long = "甲".repeat(200);
        write("facts/long.yaml", `domain: long\nfacts:\n  - id: long.thing\n    subject: dev.test\n    aspect: big\n    value: '${long}'\n    review: accepted\n    lifecycle: active\n    evidence: { source: code, at: K.ts:1 }\n`);
        const r = store.brief("dev.test", { dir: kb, maxChars: 20 }).subjects[0]!;
        const big = r.entries.find((e) => e.aspect === "big")!;
        expect(big.preview.length).toBeLessThanOrEqual(21);
        expect(big.preview.endsWith("…")).toBe(true);
    });
});

describe("brief 多主题 / 预算（##5 需求 3）", () => {
    it("逗号分隔多主题 ⇒ 一次调用返回各主题，形状恒为数组", () => {
        const r = store.brief("app.port,dev.test", { dir: kb });
        expect(r.subjects.map((x) => x.subject)).toEqual(["app.port", "dev.test"]);
        expect(r.budget).toBeUndefined();
    });

    it("单主题也是 1 元素数组（形状不随入参变，消费方不必写两套分支）", () => {
        const r = store.brief("app.port", { dir: kb });
        expect(r.subjects).toHaveLength(1);
    });

    it("--budget 超了按比例缩每条 preview，回执给 used", () => {
        const long = "乙".repeat(300);
        write("facts/long.yaml", `domain: long\nfacts:\n  - id: long.thing\n    subject: dev.test\n    aspect: big\n    value: '${long}'\n    review: accepted\n    lifecycle: active\n    evidence: { source: code, at: K.ts:1 }\n`);
        const wide = store.brief("dev.test", { dir: kb, maxChars: 80, budget: 60 });
        expect(wide.budget!.limit).toBe(60);
        expect(wide.budget!.used).toBeLessThanOrEqual(60);
        const item = wide.subjects[0]!;
        expect(item.entries.find((e) => e.aspect === "big")!.preview.length).toBeLessThanOrEqual(60);
    });
});

describe("find", () => {
    it("人话也能查：subject 的 description 进检索面（agent 听到的是「端口」，不是 app.port）", () => {
        const r = store.find("端口", { dir: kb });
        expect(r.total).toBeGreaterThan(0);
        expect(r.hits[0]!.hitIn).toContain("subject");
    });

    it("命中内容排在命中键名之前（查到的是一件真事，不是凑巧同名的键）", () => {
        // "app" 既在 claim 里也在 id 里；"18888" 只在 value 里 → 后者必须排前面
        const r = store.find("app,18888", { dir: kb });
        expect(r.total).toBe(1);
        expect(r.hits[0]!.hitIn).toContain("value");
        const byClaim = store.find("app.port", { dir: kb });
        expect(byClaim.hits[0]!.hitIn).not.toContain("value");
    });

    it("多关键词 = 与（每个都得命中某处），不是或", () => {
        const both = store.find("app.port,18888", { dir: kb });
        expect(both.total).toBeGreaterThan(0);
        const none = store.find("app.port,绝不可能出现的词", { dir: kb });
        expect(none.total).toBe(0);
        expect(none.notes.join(" ")).toContain("没有命中");
    });

    it("limit 截断但 total 仍报全量（两者不等 = 被截了）", () => {
        const all = store.find("app.port", { dir: kb, limit: 100 });
        const cut = store.find("app.port", { dir: kb, limit: 1 });
        expect(cut.hits.length).toBe(1);
        expect(cut.total).toBe(all.total);
        expect(cut.notes.join(" ")).toContain("共");
    });
});
