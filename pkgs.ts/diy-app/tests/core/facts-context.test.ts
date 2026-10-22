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
        expect(Object.keys(v.task ?? {})).toEqual([`task:${TASK}:app.port#default`]);
        expect(Object.keys(v.project ?? {})).toEqual(["project:app.port#default"]);
        // 同名 claim 两库各有值 —— 任务库优先且**没有**互相覆盖
        expect(v.task![`task:${TASK}:app.port#default`]!.value).toBe("0");
        expect(v.project!["project:app.port#default"]!.value).toBe("18888");
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
