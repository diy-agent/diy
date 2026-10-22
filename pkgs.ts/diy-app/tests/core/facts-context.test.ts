// tests/core/facts-context.test.ts — 事实库 → 上下文变量树单元（##404 待办 4）
//
// 压的是**接线**，不是判据（判据在 @diy/facts 已各自单测）：
//   ① 没有库 ⇒ 单元**缺席**（不是空对象 —— `facts: {}` 会被读成"库在但没事实"）
//   ② 有任务库 ⇒ claim 作 key（不是数组里塞 id）
//   ③ env 决定解析出哪个变体，并带 resolvedBy / variants
//   ④ 两种投影算法的 key 形状不同，但值同源
//   ⑤ 库坏了 ⇒ 降级为缺席，**不抛**（上下文构造失败 = 人发不出消息）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFactsContext, buildKbIndex } from "../../src/main/services/facts-context";

let root = "";
let repoKb = "";
let home = "";
const TASK = "projects/4/tasks/404";
const prevDir = process.env["DIY_FACTS_DIR"];

function write(abs: string, text: string): void {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
}

const SUBJECTS = "subjects:\n  app.port:\n    description: 端口\n  dev.test:\n    description: 测试\n";

function factsYaml(rows: string[]): string {
    return ["domain: app", "facts:", ...rows, ""].join("\n");
}

beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "facts-ctx-"));
    repoKb = path.join(root, "repo", "knowledge");
    home = path.join(root, "home");
    write(path.join(root, "repo", "K.ts"), "1\n2\n3\n");
    write(path.join(repoKb, "subjects.yaml"), SUBJECTS);
    write(
        path.join(repoKb, "facts", "app.yaml"),
        factsYaml([
            "  app.port#default:",
            "    value: '18888'",
            "    scope: { env: production }",
            "    review: accepted",
            "    lifecycle: active",
            "    evidence: { source: code, at: K.ts:2 }",
        ]),
    );
    process.env["DIY_FACTS_DIR"] = repoKb;
});
afterEach(() => {
    if (prevDir === undefined) delete process.env["DIY_FACTS_DIR"];
    else process.env["DIY_FACTS_DIR"] = prevDir;
    rmSync(root, { recursive: true, force: true });
});

describe("拆解", () => {
    it("两库都不在 ⇒ 返回 null（单元缺席，不是空对象）", () => {
        // 仓库库换成不存在的目录 + 无任务库
        process.env["DIY_FACTS_DIR"] = path.join(root, "nowhere");
        expect(buildFactsContext({ home, taskUri: TASK, env: "development" })).toBeNull();
    });

    it("只有仓库库 ⇒ 只有 project 那一支，task 缺席", () => {
        const v = buildFactsContext({ home, taskUri: TASK, env: "production" });
        expect(v).not.toBeNull();
        expect(v!.project).toBeDefined();
        expect(v!.task).toBeUndefined();
    });
});

describe("投影形状", () => {
    it("claim 作 map 的 key；值为已解析值 + resolvedBy + variants", () => {
        const v = buildFactsContext({ home, taskUri: "", env: "production" })!;
        const cell = v.project!["app.port#default"]!;
        expect(cell.value).toBe("18888");
        expect(cell.resolvedBy).toContain("env=production");
        expect(cell.variants).toBe(1);
    });

    it("当前 env 下无匹配 ⇒ 该 claim 不出现（skipped 不当问题）", () => {
        const v = buildFactsContext({ home, taskUri: "", env: "development" })!;
        expect(v.project?.["app.port#default"]).toBeUndefined();
        expect(v.problems).toEqual([]);
        expect(v.omitted).toBe(0);
    });

    it("flat-gid 算法 ⇒ key 带命名空间前缀（同一个 claim 在两个库里分得开）", () => {
        const dir = path.join(home, TASK, "knowledge");
        write(path.join(dir, "subjects.yaml"), SUBJECTS);
        write(
            path.join(dir, "facts", "app.yaml"),
            factsYaml([
                "  app.port#default:",
                "    value: '0'",
                "    scope: { env: production }",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:2 }",
            ]),
        );
        const v = buildFactsContext({ home, taskUri: TASK, env: "production", algorithm: "flat-gid" })!;
        // 同名 claim 跨库**只出高层一条**（task > project > global）——局部覆盖全局
        expect(Object.keys(v.task ?? {})).toEqual([`task:${TASK}:app.port#default`]);
        expect(v.project ?? {}).toEqual({});
        expect(v.task![`task:${TASK}:app.port#default`]!.value).toBe("0");
        expect(v.problems).toEqual([]);
    });

    it("同 claim 两库同值 ⇒ 只出一条（省预算，不重复展示）", () => {
        // beforeEach 已在 project 库写了 app.port#default = 18888；这里在 global 库写同值
        const globalKb = path.join(home, "knowledge");
        write(path.join(globalKb, "subjects.yaml"), SUBJECTS);
        write(
            path.join(globalKb, "facts", "app.yaml"),
            factsYaml([
                "  app.port#default:",
                "    value: '18888'",
                "    scope: { env: production }",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:2 }",
            ]),
        );
        const v = buildFactsContext({ home, taskUri: "", env: "production", algorithm: "flat-gid" })!;
        // project 胜过 global（ns 优先级），global 那条不重复出现
        expect(Object.keys(v.project ?? {})).toEqual(["project:app.port#default"]);
        expect(Object.keys(v.global ?? {})).toEqual([]);
    });

    it("md-list 算法 ⇒ 只出一段 text，不再给 task/project 两棵树", () => {
        const v = buildFactsContext({ home, taskUri: "", env: "production", algorithm: "md-list" })!;
        expect(typeof v.text).toBe("string");
        expect(v.text).toContain("app.port#default");
        expect(v.task).toBeUndefined();
        expect(v.project).toBeUndefined();
    });
});

describe("降级", () => {
    it("真源 YAML 坏了 ⇒ 当没有这个库（不抛）——上下文构造失败 = 人发不出消息", () => {
        write(path.join(repoKb, "facts", "broken.yaml"), "domain: [\n  bad yaml here\n");
        expect(() => buildFactsContext({ home, taskUri: TASK, env: "production" })).not.toThrow();
        // 坏文件让整个库读不出来 ⇒ 降级为缺席
        expect(buildFactsContext({ home, taskUri: TASK, env: "production" })).toBeNull();
    });
});

// ── kb 索引（##5 报送的需求 5：这段原先零测试，而它决定「链上正文能不能删」）──
//
// 索引的用途是**让人知道该查哪个主题**，所以压的是三条会被误读成"正常"的边界：
// 没有库 ≠ 空库、无 description 的主题不进 entries（但条目仍被计数）、计数口径与投影同源。
describe("kb 索引", () => {
    it("没有库 ⇒ null（整节缺席，不是 claims: 0 的空对象）", () => {
        process.env["DIY_FACTS_DIR"] = path.join(root, "nowhere");
        expect(buildKbIndex()).toBeNull();
    });

    it("主题缺 description ⇒ 不进 entries，但其条目仍计入 claims（两者不等 = 有主题没登记）", () => {
        // dev.test 有描述、app.port 有描述；再塞一个无描述主题带 2 条事实
        write(path.join(repoKb, "subjects.yaml"), SUBJECTS + "  ghost.topic:\n    aliases: [g]\n");
        write(
            path.join(repoKb, "facts", "ghost.yaml"),
            factsYaml([
                "  ghost.topic#a:",
                "    value: 'x'",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:1 }",
                "  ghost.topic#b:",
                "    value: 'y'",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:1 }",
            ]),
        );
        const kb = buildKbIndex()!;
        expect(kb.entries.map((e) => e.subject)).not.toContain("ghost.topic");
        const listed = kb.entries.reduce((n, e) => n + e.claims, 0);
        // 差额 = 没登记 description 的主题条目数（索引里看不见，但库里有）
        expect(kb.claims - listed).toBe(2);
    });

    it("claims 与事实投影同一口径（同一仓库同一时刻：索引总数 = 投影条目数）", () => {
        const kb = buildKbIndex()!;
        expect(kb.claims).toBe(1);
        // 投影只取"当前作用域解析得出"的条目，默认 env 下 app.port#default 取到 1 条
        const v = buildFactsContext({ home, taskUri: "", env: "production" })!;
        expect(Object.keys(v.project ?? {}).length).toBe(kb.claims);
    });
});

describe("kb 索引按前缀折叠（##5 第 9 轮：索引成了新的固定前缀成本）", () => {
    // 三个同前缀主题 ⇒ 索引里只留一条 `app.*`，展开靠 `diy facts brief app.*`
    const threeAppSubjects = () =>
        write(
            path.join(repoKb, "subjects.yaml"),
            "subjects:\n  app.find:\n    description: 去哪找\n  app.rule:\n    description: 硬约束\n  app.tool:\n    description: 命令\n",
        );

    it("同前缀 ≥3 ⇒ 折成一条，desc 自带展开命令", () => {
        threeAppSubjects();
        write(
            path.join(repoKb, "facts", "app.yaml"),
            factsYaml([
                "  app.find#x:",
                "    value: '1'",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:1 }",
                "  app.rule#x:",
                "    value: '2'",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:2 }",
                "  app.tool#x:",
                "    value: '3'",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:3 }",
            ]),
        );
        const kb = buildKbIndex()!;
        expect(kb.entries.map((e) => e.subject)).toEqual(["app.*"]);
        expect(kb.entries[0]?.claims).toBe(3);
        expect(kb.entries[0]?.desc).toContain("diy facts brief app.*");
        // 折叠**不改** claims 口径（总数仍是全库条目数）
        expect(kb.claims).toBe(3);
    });

    it("不足 3 个同前缀主题 ⇒ 不折（索引里还是逐个列出）", () => {
        write(path.join(repoKb, "subjects.yaml"), "subjects:\n  app.find:\n    description: 去哪找\n  dev.test:\n    description: 测试\n");
        const kb = buildKbIndex()!;
        // app 前缀只有 1 个主题 ⇒ 不折；dev.test 是 beforeEach 里就在的词表项（0 条事实）
        expect(kb.entries.map((e) => e.subject)).toEqual(["app.find", "dev.test"]);
    });
});

describe("expose 暴露档（##5 第 7 轮：subject 级 = 正文预算的开关）", () => {
    const twoSubjects = () =>
        factsYaml([
            "  app.port#default:",
            "    value: '18888'",
            "    review: accepted",
            "    lifecycle: active",
            "    evidence: { source: code, at: K.ts:2 }",
            "  dev.test#cmd:",
            "    value: 'npm test'",
            "    review: accepted",
            "    lifecycle: active",
            "    evidence: { source: code, at: K.ts:3 }",
        ]);

    it("没写 expose.yaml ⇒ 回落到旧行为（全部进正文）", () => {
        // 兼容窗口：升级当天不能把存量库的正文一起清空
        write(path.join(repoKb, "facts", "app.yaml"), twoSubjects());
        const v = buildFactsContext({ home, taskUri: "" });
        expect(Object.keys(v?.project ?? {})).toEqual(["app.port#default", "dev.test#cmd"]);
    });

    it("写了 expose.yaml ⇒ 声明式生效：只有 full 进正文，没列出的是 index", () => {
        write(path.join(repoKb, "facts", "app.yaml"), twoSubjects());
        write(path.join(repoKb, "expose.yaml"), "expose:\n  app.port: full\n");
        const v = buildFactsContext({ home, taskUri: "" });
        expect(Object.keys(v?.project ?? {})).toEqual(["app.port#default"]);
        // index 档仍在 kb 索引里（知道有、要值就查）
        expect(buildKbIndex({ home })?.entries.map((e) => e.subject)).toContain("dev.test");
    });

    it("none ⇒ 索引也不给（两处都不出现）", () => {
        write(path.join(repoKb, "facts", "app.yaml"), twoSubjects());
        write(path.join(repoKb, "expose.yaml"), "expose:\n  app.port: full\n  dev.test: none\n");
        const v = buildFactsContext({ home, taskUri: "" });
        expect(Object.keys(v?.project ?? {})).toEqual(["app.port#default"]);
        expect(buildKbIndex({ home })?.entries.map((e) => e.subject)).not.toContain("dev.test");
    });

    it("full 档字节和超预算 ⇒ 投影带 facts/expose-budget 问题（不抛：构造失败更糟）", () => {
        write(
            path.join(repoKb, "facts", "app.yaml"),
            factsYaml([
                "  app.port#default:",
                `    value: '${"x".repeat(120)}'`,
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:2 }",
            ]),
        );
        write(path.join(repoKb, "expose.yaml"), "expose:\n  app.port: full\n");
        const v = buildFactsContext({ home, taskUri: "", maxBytes: 100 });
        expect(v?.problems.map((p) => p.code)).toContain("facts/expose-budget");
    });
});

describe("按库解析暴露档（##5 第 8 轮：合表会把任务库一起降级）", () => {
    function taskLib(): string {
        const kb = path.join(home, TASK, "knowledge");
        write(
            path.join(kb, "facts", "diy.facts.yaml"),
            factsYaml([
                "  diy.facts#scope:",
                "    value: '任务库的结论'",
                "    review: accepted",
                "    lifecycle: active",
                "    evidence: { source: code, at: K.ts:1 }",
            ]),
        );
        return kb;
    }

    it("项目库写了 expose.yaml ⇒ **任务库的条目仍在正文**（缺省档 task = full）", () => {
        // 铁证场景：只声明 `app.port: full` 的那次，任务库 4 条结论被静默降级。
        // 判据：每个库各读自己的 expose.yaml，各按**库类型**缺省档回落。
        write(path.join(repoKb, "facts", "app.yaml"), factsYaml([
            "  app.port#default:",
            "    value: '18888'",
            "    review: accepted",
            "    lifecycle: active",
            "    evidence: { source: code, at: K.ts:2 }",
            "  dev.test#cmd:",
            "    value: 'npm test'",
            "    review: accepted",
            "    lifecycle: active",
            "    evidence: { source: code, at: K.ts:3 }",
        ]));
        write(path.join(repoKb, "expose.yaml"), "expose:\n  app.port: full\n");
        taskLib();
        const v = buildFactsContext({ home, taskUri: TASK })!;
        expect(Object.keys(v.task ?? {})).toEqual(["diy.facts#scope"]);
        expect(Object.keys(v.project ?? {})).toEqual(["app.port#default"]);
    });

    it("任务库自己的 expose.yaml 能覆盖它的缺省档（none ⇒ 正文与索引都不给）", () => {
        const kb = taskLib();
        write(path.join(kb, "expose.yaml"), "expose:\n  diy.facts: none\n");
        write(path.join(repoKb, "expose.yaml"), "expose:\n  app.port: full\n");
        const v = buildFactsContext({ home, taskUri: TASK })!;
        expect(v.task).toBeUndefined();
    });

    it("谁都没写 expose.yaml ⇒ 旧行为（三库全进正文）", () => {
        taskLib();
        // beforeEach 那条 app.port 带 `scope.env: production`，显式给 env 才解析得出来
        const v = buildFactsContext({ home, taskUri: TASK, env: "production" })!;
        expect(Object.keys(v.task ?? {})).toEqual(["diy.facts#scope"]);
        expect(Object.keys(v.project ?? {})).toEqual(["app.port#default"]);
    });
});
