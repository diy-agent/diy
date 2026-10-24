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

    // 2026-10-23（大王判决）：路径指错**不再是错误** —— 库没有就是空库，读就出空。
    // 顺带说明这里为什么不再"预检路径"：预检 + 读取两处判同一件事，就是"三处保护"的来源。
    it("显式目录原样返回，指到不存在的路径 ⇒ 空库（零计数，不抛）", () => {
        delete process.env["DIY_FACTS_DIR"];
        expect(store.resolveFactsDir("/definitely/not/here")).toBe("/definitely/not/here");
        const s = store.status({ dir: "/definitely/not/here" });
        expect(s.facts).toBe(0);
        expect(existsSync("/definitely/not/here")).toBe(false);
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

    it("subjects 元素字段写错 ⇒ **当场拒并给正确形状**（不再崩在 localeCompare）", () => {
        // 实测事故：`{"subjects":[{"subject":"x","description":"y"}]}` 一路穿到写盘阶段，
        // 抛 `TypeError: Cannot read properties of undefined (reading 'localeCompare')` ——
        // 报错看着像程序崩了，而不是"你载荷写错了"。
        expect(() => store.parseSubmitPayload('{"facts":[],"subjects":[{"subject":"x"}]}')).toThrow(/shape|key/);
        expect(() => store.parseSubmitPayload('{"facts":[],"subjects":[{"subject":"x"}]}')).toThrow(/形如 \{ key/);
        expect(() => store.parseSubmitPayload('{"facts":[],"subjects":["x"]}')).toThrow(/期望对象/);
        expect(() => store.parseSubmitPayload('{"facts":[],"subjects":[{"key":"  "}]}')).toThrow(/非空字符串/);
        expect(() => store.parseSubmitPayload('{"facts":[],"subjects":[{"key":"a","aliases":"b"}]}')).toThrow(/字符串数组/);
        // 合法：description / aliases 选填
        expect(store.parseSubmitPayload('{"facts":[],"subjects":[{"key":"a","description":"d","aliases":["b"]}]}').subjects).toEqual([
            { key: "a", description: "d", aliases: ["b"] },
        ]);
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
        // ⚠️ 别再压 `value: <一行>`：全库已改成块标量（`value: |` + 缩进正文），
        // 断言文本形状会被"纯格式重排"打红（`9b8bc91b` 之后这里就是这么断的）。
        // 压顺序即可：claim key 必须在值**之前**出现。
        expect(text.indexOf("dev.test#entry:")).toBeLessThan(text.indexOf("./sha.sh test-unit"));
        // id 仍是**审计锚点**（不可派生），只是不再当结构键 —— 它必须还在值里
        expect(text).toContain("id: test.entry");
    });

    it("payload 里事实本身不合 schema ⇒ 词表也一个字不写（事务边界）", () => {
        // 实测事故（##5）：这条返回 error「事实 0 条写入」，磁盘上 `subjects.yaml` 却已经多了
        // `zz.txcheck` —— 坏事实被过滤成空集后照样调了内核 `submit`，词表跟着落了盘，
        // 而 CLI 没有任何出口能撤（只能 `git checkout knowledge/subjects.yaml`）。
        const subjectsBefore = readFileSync(path.join(kb, "subjects.yaml"), "utf8");
        const payload = store.parseSubmitPayload(
            JSON.stringify({
                subjects: [{ key: "zz.txcheck", description: "自检" }],
                facts: [
                    {
                        id: "zz.txcheck.one",
                        subject: "zz.txcheck",
                        aspect: "a",
                        value: "x",
                        evidence: { source: "nonsense", at: "K.ts:1" },
                    },
                ],
            }),
        );
        const r = store.submitPayload(payload);
        expect(r.problems.map((p) => p.code)).toContain("facts/schema");
        expect(r.report.newSubjects).toEqual([]);
        expect(readFileSync(path.join(kb, "subjects.yaml"), "utf8")).toBe(subjectsBefore);
        expect(readFileSync(path.join(kb, "subjects.yaml"), "utf8")).not.toContain("zz.txcheck");
    });

    it("dropSubjects：删本地词表条目；删不掉的三条各自带码", () => {
        const del = store.submitPayload(store.parseSubmitPayload(JSON.stringify({ facts: [], subjects: [], dropSubjects: ["dev.test"] })));
        expect(del.problems.filter((p) => p.level === "error")).toEqual([]);
        expect(del.report.droppedSubjects).toEqual(["dev.test"]);
        expect(readFileSync(path.join(kb, "subjects.yaml"), "utf8")).not.toContain("dev.test");

        const inUse = store.submitPayload(store.parseSubmitPayload(JSON.stringify({ facts: [], subjects: [], dropSubjects: ["app.port"] })));
        expect(inUse.problems.map((p) => p.code)).toContain("facts/subject-drop-in-use");

        const both = store.submitPayload(
            store.parseSubmitPayload(JSON.stringify({ facts: [], subjects: [{ key: "x.y", description: "y" }], dropSubjects: ["x.y"] })),
        );
        expect(both.problems.map((p) => p.code)).toContain("facts/subject-drop-declared");
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

    it("解析到 <DIY_HOME>/<uri>/knowledge，词表回落仓库", () => {
        const t = store.resolveFactsTarget({ in: "task:projects/4/tasks/404" });
        expect(t.dir).toBe(path.join(taskDir, "knowledge"));
        expect(t.subjectsFallback).toBe(path.join(kb, "subjects.yaml"));
    });

    it("缺省 / project 指向仓库库（任务库不抢缺省）", () => {
        for (const spec of [undefined, "project"]) {
            const t = store.resolveFactsTarget(spec === undefined ? {} : { in: spec });
            expect(t.dir).toBe(kb);
        }
    });

    it("global 指向**设备级库** <DIY_HOME>/knowledge，不是仓库库", () => {
        // 原先 global 与 project 都落到仓库库 —— 那让"设备级事实"无处可去（##5 需求 3 的实质）。
        const t = store.resolveFactsTarget({ in: "global" });
        expect(t.dir).toBe(path.join(home, "knowledge"));
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

    // 2026-10-23 翻转：**尚未建库 = 空库**（零计数，不抛）。原先这里抛「库还没建…先跑 submit」，
    // 而 `submit --dry-run` 又会偷偷建库 —— 两边自相矛盾，且"没库"被当成了错误。
    it("status --in 尚未建库 → 零计数（空库），不抛", () => {
        const s = store.status({ in: "task:projects/4/tasks/404" });
        expect(s.facts).toBe(0);
        expect(s.subjects).toBe(0);
        expect(existsSync(path.join(taskDir, "knowledge"))).toBe(false);
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

describe("跨库读的三个口径缺口（##5 第 6 轮 A/B/C）", () => {
    let home = "";
    let devKb = "";
    const prevHome = process.env["DIY_HOME"];

    /** 设备级库（`<DIY_HOME>/knowledge`）：跨库用例都靠它 */
    const writeGlobal = (rel: string, text: string): void => {
        const abs = path.join(devKb, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, text);
    };
    const factLine = (id: string, value: string, lifecycle = "active"): string[] => [
        `  - id: ${id}`,
        "    subject: app.port",
        "    aspect: default",
        `    value: '${value}'`,
        "    review: accepted",
        `    lifecycle: ${lifecycle}`,
        "    evidence: { source: code, at: K.ts:1, verifiedAt: '2026-10-21' }",
    ];

    beforeEach(() => {
        home = mkdtempSync(path.join(os.tmpdir(), "facts-global-"));
        process.env["DIY_HOME"] = home;
        devKb = path.join(home, "knowledge");
        // 设备库独有的 subject（本根词表里没有）—— B 的口径靠它
        writeGlobal("subjects.yaml", "subjects:\n  dev.test:\n    description: 测试\n");
        process.env["DIY_FACTS_DIR"] = kb;
    });
    afterEach(() => {
        if (prevHome === undefined) delete process.env["DIY_HOME"];
        else process.env["DIY_HOME"] = prevHome;
        rmSync(home, { recursive: true, force: true });
    });

    it("A: 主库那条被 superseded 时，brief 的代表条目取额外库那条（不是挑中已失效的）", () => {
        // 主库 app.port#default 两条变体全标 superseded（= 让位给设备库）
        write(
            "facts/app.yaml",
            ["domain: app", "facts:", ...factLine("port.production", "18888", "superseded"), ...factLine("port.dev", "0", "superseded"), ""].join("\n"),
        );
        writeGlobal("facts/app.yaml", ["domain: app", "facts:", ...factLine("global.port", "3000"), ""].join("\n"));
        const b = store.brief("app.port");
        const entry = b.subjects[0]?.entries.find((e) => e.aspect === "default");
        // 缺省态不写：代表条目 active ⇒ 条目上不再带 lifecycle（异常态才是信号）
        expect(entry?.lifecycle).toBeUndefined();
        // 同主题全部同源 ⇒ file 提到主题级（不再每条重复绝对路径）
        expect(entry?.file).toBeUndefined();
        expect(b.subjects[0]?.file?.startsWith(home)).toBe(true);
        expect(entry?.variants).toBe(3);
    });

    it("B: status 计数分桶，且额外库独有的 subject 不再被判「未登记」", () => {
        // 设备库里有本根词表**没有**的 subject（真实情况：`skill` 只在设备库词表里）
        writeGlobal("subjects.yaml", "subjects:\n  skill:\n    description: 技能\n");
        writeGlobal(
            "facts/skill.yaml",
            [
                "domain: skill",
                "facts:",
                "  - id: global.skill.prefix",
                "    subject: skill",
                "    aspect: prefix",
                "    value: diy-*",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: user, verifiedAt: '2026-10-21' }",
                "",
            ].join("\n"),
        );
        const st = store.status();
        // 顶层 = 本根（2 条）；额外库单列 —— 混一桶会造出"我啥也没干库就暴涨"的假象
        expect(st.facts).toBe(2);
        expect(st.extra.facts).toBe(1);
        expect(st.extra.dirs).toEqual([devKb]);
        // 词表用「本根 ∪ 额外库」并集：只认本根的话 `skill` 会被判未登记（对自家库报错）
        expect(st.problems.filter((p) => p.code === "facts/subject-unregistered")).toEqual([]);
    });

    it("D: 同一 claim 两库都可用 ⇒ 报 facts/cross-lib-dup（两处维护 = 必然漂移）", () => {
        // 主库已有 app.port#default 两个 env 变体（active + accepted），设备库再写一份同 claim
        writeGlobal("facts/app.yaml", ["domain: app", "facts:", ...factLine("global.port", "3000"), ""].join("\n"));
        const dup = store.status().problems.filter((p) => p.code === "facts/cross-lib-dup");
        expect(dup).toHaveLength(1);
        expect(dup[0]?.level).toBe("warning");
        // 值不同 ⇒ 说清「低特定度那份被静默让位」，并两侧 id 都点出来
        expect(dup[0]?.detail).toContain("app.port#default");
        expect(dup[0]?.detail).toContain("不同");
        expect(dup[0]?.facts).toEqual(expect.arrayContaining(["global.port", "port.production"]));
    });

    it("D: 低层让位（superseded）不是双写 ⇒ 不报", () => {
        // 主库同 claim 全标 superseded（正确表达覆盖的方式：让位，投影只解析一次）
        write(
            "facts/app.yaml",
            ["domain: app", "facts:", ...factLine("port.production", "18888", "superseded"), ...factLine("port.dev", "0", "superseded"), ""].join("\n"),
        );
        writeGlobal("facts/app.yaml", ["domain: app", "facts:", ...factLine("global.port", "3000"), ""].join("\n"));
        expect(store.status().problems.filter((p) => p.code === "facts/cross-lib-dup")).toEqual([]);
    });

    it("C: submit 的 drop 与写入同批事务 —— 改名（删旧 + 写新）一次成型", () => {
        const payload = {
            drop: ["port.production"],
            facts: [
                {
                    id: "port.prod-renamed",
                    subject: "app.port",
                    aspect: "default",
                    value: "18888",
                    scope: { env: "production" },
                    review: "accepted",
                    lifecycle: "active",
                    evidence: { source: "code", at: "K.ts:2", verifiedAt: "2026-10-21" },
                },
            ],
            subjects: [],
        };
        const r = store.submitPayload(payload);
        expect(r.problems.filter((p) => p.level === "error")).toEqual([]);
        expect(r.report.dropped).toEqual(["port.production"]);
        const text = readFileSync(path.join(kb, "facts/app.yaml"), "utf8");
        expect(text).not.toContain("port.production");
        expect(text).toContain("port.prod-renamed");
    });

    it("C: drop 一个不存在的 id 不算成功（不静默吞）", () => {
        const r = store.submitPayload({ drop: ["no.such.fact"], facts: [], subjects: [] }, { dryRun: true });
        expect(r.report.dropped).toEqual([]);
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

    it("--budget 按**实际输出字节**计，超了先缩 preview", () => {
        const long = "乙".repeat(300);
        write("facts/long.yaml", `domain: long\nfacts:\n  - id: long.thing\n    subject: dev.test\n    aspect: big\n    value: '${long}'\n    review: accepted\n    lifecycle: active\n    evidence: { source: code, at: K.ts:1 }\n`);
        const wide = store.brief("dev.test", { dir: kb, maxChars: 80, budget: 600 });
        expect(wide.budget!.limit).toBe(600);
        expect(wide.budget!.used).toBeLessThanOrEqual(600);
        expect(wide.truncated).toBeUndefined();
        const item = wide.subjects[0]!;
        // `used` 的口径必须是「真正会发出去的那串字节」，不是字符估算
        expect(wide.budget!.used).toBe(Buffer.byteLength(JSON.stringify({ subjects: wide.subjects }), "utf8"));
        // 截断符 `…` 会多占 1 位（previewOf 输出 max+1），故上界是 maxChars+1
        expect(item.entries.find((e) => e.aspect === "big")!.preview.length).toBeLessThanOrEqual(81);
    });

    it("--budget 缩到下限仍装不下 ⇒ 裁条目并报 truncated（旧版这里只缩不裁，等于预算失效）", () => {
        // 20 字节连一条 `{aspect,gid,preview}` 的外壳都塞不下：只能裁到空（硬上限）
        const long = "乙".repeat(300);
        write("facts/long.yaml", `domain: long\nfacts:\n  - id: long.thing\n    subject: dev.test\n    aspect: big\n    value: '${long}'\n    review: accepted\n    lifecycle: active\n    evidence: { source: code, at: K.ts:1 }\n`);
        const wide = store.brief("dev.test", { dir: kb, maxChars: 80, budget: 20 });
        expect(wide.budget!.used).toBeLessThanOrEqual(20);
        expect(wide.truncated).toBeGreaterThan(0);
        // 裁空的主题整个去掉，不留 `entries: []` 的空壳（否则读的人以为「这主题没有条目」）
        expect(wide.subjects.every((s) => s.entries.length > 0 || s.notes.length > 0)).toBe(true);
    });

    it("--budget 够用 ⇒ 不缩不裁，truncated 缺席", () => {
        const r = store.brief("app.port", { dir: kb, budget: 100000 });
        expect(r.truncated).toBeUndefined();
        expect(r.budget!.used).toBeLessThanOrEqual(100000);
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

// ── 字节账与 expose 暴露档（##5 第 7 轮）────────────────────────────────────────
//
// 判据在 @diy/facts 的 checkExpose / weightsOf 已单测；这里只验**接线**：
//   ① status 给出按 subject 的字节账（预算是字节单位，claims 数看不出来）
//   ② submit 的 expose 载荷与事实**同一事务**（超预算 ⇒ 整批拒写，磁盘不动）
describe("字节账 / expose 档", () => {
    const fact = (id: string, subject: string, aspect: string, value: string) => ({
        id,
        subject,
        aspect,
        value,
        review: "accepted",
        lifecycle: "active",
        evidence: { source: "code", at: "K.ts:1" },
    });

    it("status.bySubject 按字节降序给权重，并带上该主题的 expose 档", () => {
        const st = store.status();
        const port = st.bySubject.find((s) => s.subject === "app.port");
        // 两条变体：'18888' + '0' = 6 字节（可用事实的 value 之和，不是文件大小）
        expect(port?.bytes).toBe(6);
        expect(port?.claims).toBe(1);
        expect(port?.expose).toBe("index"); // 没写 expose.yaml ⇒ 缺省档
        const sorted = [...st.bySubject].sort((a, b) => b.bytes - a.bytes);
        expect(st.bySubject).toEqual(sorted);
        expect(st.exposeBudget).toEqual({ used: 0, limit: 4000 });
    });

    it("submit 的 expose 载荷：与事实同批落盘，写出的档位可被 status 读到", () => {
        const r = store.submitPayload({
            facts: [fact("port.next", "app.port", "next", "1")],
            subjects: [],
            expose: { "app.port": "full" },
        });
        expect(r.problems.filter((p) => p.level === "error")).toEqual([]);
        expect(store.status().bySubject.find((s) => s.subject === "app.port")?.expose).toBe("full");
        // 档位文件是程序生成的（有头注），人不用手改那种形状
        expect(readFileSync(path.join(kb, "expose.yaml"), "utf8")).toContain("暴露档");
    });

    it("full 档超预算 ⇒ 整批拒写（磁盘不动，问题码 facts/expose-budget）", () => {
        const before = readFileSync(path.join(kb, "facts", "app.yaml"), "utf8");
        const r = store.submitPayload({
            facts: [fact("port.big", "app.port", "big", "x".repeat(5000))],
            subjects: [],
            expose: { "app.port": "full" },
        });
        expect(r.problems.map((p) => p.code)).toContain("facts/expose-budget");
        // `added` 仍会列出"本来会加什么"（拒写的报告要能看出被拒的是哪条），但 `files` 必空 = 没落盘
        expect(r.report.files).toEqual([]);
        // 拒写 = 真源一字未动
        expect(readFileSync(path.join(kb, "facts", "app.yaml"), "utf8")).toBe(before);
        expect(existsSync(path.join(kb, "expose.yaml"))).toBe(false);
    });

    it("expose 载荷形状错 ⇒ 报 payload-shape，不静默当空", () => {
        expect(() => store.parseSubmitPayload('{"facts":[],"expose":["app.port"]}')).toThrow(/expose 期望/);
    });

    it("get / brief 的 file 是绝对路径（cwd 是项目目录，相对 repo.root 的路径打不开）", () => {
        const g = store.get(["app.port#default"], { env: "production" });
        const file = g.resolved[0]?.facts[0]?.file ?? "";
        expect(path.isAbsolute(file)).toBe(true);
        expect(existsSync(file)).toBe(true);
        // 且它指向 **repo.root 之外**时也一样能打开（lab 与生产的差别只在这里）
        expect(file).toBe(path.join(kb, "facts", "app.yaml"));
    });
});

// ── 库不存在 = 空库（2026-10-23 大王判决）────────────────────────────────────
//
// 要治的病：同一件事有过三处保护 —— `loadRepo` 的 `allowMissing` 建目录、`status` / `project`
// 各自在门口抛「库还没建」。三者互相打架：`submit --dry-run`（自称"磁盘一个字都不动"）
// 顺手把库建了出来，而并发的另一个 `status` 又报"没库"。
// 现在：读就出空、写就直接写（目录由 `atomic-write` 顺带建出），"建库"不再是一个动作。
describe("空库语义：读就出空、写就直接写", () => {
    let home = "";
    let taskDir = "";
    let taskKb = "";
    const prevHome = process.env["DIY_HOME"];
    /** 判据用：递归列出目录内容（不存在 ⇒ []）；前后比对 = "磁盘有没有变" */
    const snapshot = (dir: string): string[] => {
        if (!existsSync(dir)) return [];
        const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
        const out: string[] = [];
        const walk = (d: string): void => {
            for (const name of readdirSync(d).sort()) {
                const abs = path.join(d, name);
                out.push(path.relative(dir, abs) + (statSync(abs).isDirectory() ? "/" : ""));
                if (statSync(abs).isDirectory()) walk(abs);
            }
        };
        walk(dir);
        return out;
    };

    beforeEach(() => {
        home = mkdtempSync(path.join(os.tmpdir(), "facts-empty-"));
        process.env["DIY_HOME"] = home;
        taskDir = path.join(home, "projects/4/tasks/999");
        mkdirSync(taskDir, { recursive: true });
        taskKb = path.join(taskDir, "knowledge");
    });
    afterEach(() => {
        if (prevHome === undefined) delete process.env["DIY_HOME"];
        else process.env["DIY_HOME"] = prevHome;
        rmSync(home, { recursive: true, force: true });
    });

    const inTask = "task:projects/4/tasks/999";
    const oneFact = { subject: "dev.test", aspect: "bail", value: "红灯即停", evidence: { source: "user" as const } };

    it("空库 + status ⇒ 零计数、不抛、磁盘一个字不动", () => {
        const before = snapshot(taskDir);
        const s = store.status({ in: inTask });
        expect(s.facts).toBe(0);
        expect(s.claims).toBe(0);
        expect(s.subjects).toBe(0);
        expect(snapshot(taskDir)).toEqual(before);
        // 关键的一半：连 `knowledge/` 都不该冒出来
        expect(existsSync(taskKb)).toBe(false);
    });

    it("空库 + submit --dry-run ⇒ 不建库（这是原来的 bug）", () => {
        const before = snapshot(taskDir);
        const r = store.submitPayload({ facts: [oneFact], subjects: [] }, { in: inTask, dryRun: true });
        expect(r.problems).toEqual([]);
        expect(snapshot(taskDir)).toEqual(before);
        expect(existsSync(taskKb)).toBe(false);
        // dry-run 也不会自称"建了库"
        expect(r.report.created).toBeUndefined();
    });

    it("空库 + submit（真写）⇒ 文件自己出现，且报告回显 created", () => {
        const r = store.submitPayload({ facts: [oneFact], subjects: [] }, { in: inTask });
        expect(r.problems).toEqual([]);
        expect(r.report.added).toEqual(["dev.test#bail"]);
        expect(r.report.created).toEqual({ dir: taskKb });
        const file = path.join(taskKb, "facts", "dev.yaml");
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, "utf8")).toContain("红灯即停");
        // 库已存在时不再回显（"新建"只发生一次）
        const again = store.submitPayload({ facts: [{ ...oneFact, value: "红灯即停。" }], subjects: [] }, { in: inTask });
        expect(again.report.created).toBeUndefined();
    });

    it("--dir 指一个不存在的路径 ⇒ 照样写，但报告 created 说出落点", () => {
        // 全新的库没有词表可继承（`--dir` 不像任务库那样回落仓库），所以词表与事实同一批提
        const fresh = path.join(root, "brand-new-kb");
        const r = store.submitPayload(
            { facts: [oneFact], subjects: [{ key: "dev.test", description: "测试" }] },
            { dir: fresh },
        );
        expect(r.problems).toEqual([]);
        // 判据：**不阻止，也不静默** —— 手敲的路径容易写错，写成功但落错库是最难查的那种
        expect(r.report.created).toEqual({ dir: fresh });
        expect(existsSync(path.join(fresh, "facts", "dev.yaml"))).toBe(true);
    });

    it("空库 + project ⇒ 不抛，返回空投影，且不建库", () => {
        const before = snapshot(taskDir);
        const p = store.projectFacts({ in: inTask });
        expect(p.shown).toEqual([]);
        expect(p.omitted).toEqual([]);
        expect(existsSync(taskKb)).toBe(false);
        // 投影更不许建库（它是**读**，每轮都跑）
        expect(snapshot(taskDir)).toEqual(before);
    });
});
