// tests/core/context-config.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 划分规则的净化（读侧一律走它）。
//
// 为什么它值得单测：这份名单是**真发**用的（决定哪些变量进可缓存的 system），
// 手改文件 / 旧版本残留 / 写坏的路径都必须在这里被兜住 —— 而且要**出声**（返回 dropped），
// 不能静默半用（否则"我改了却没反应"这类排查成本极高）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { sanitizeSystemPlaces } from "../../src/shared/context/config";
import { defaultSystemPlaces } from "../../src/shared/context/delivery";

describe("sanitizeSystemPlaces", () => {
    it("正常名单：保留 + 排序（输出稳定，便于比对/落盘）", () => {
        const r = sanitizeSystemPlaces(["task.title", "diy", "project"]);
        expect(r.places).toEqual(["diy", "project", "task.title"]);
        expect(r.dropped).toEqual([]);
    });

    it("非法路径被丢弃并出现在 dropped（不静默）", () => {
        const r = sanitizeSystemPlaces(["diy", "task titl", "", "a..b"]);
        expect(r.places).toEqual(["diy"]);
        expect(r.dropped).toEqual(["", "a..b", "task titl"]);
    });

    it("互为祖先/后代的重叠被丢弃（places 的硬规则：重叠则归属没有唯一答案）", () => {
        const r = sanitizeSystemPlaces(["task", "task.body", "diy"]);
        // 排序后 task 在前 → 保留 task，丢 task.body
        expect(r.places).toEqual(["diy", "task"]);
        expect(r.dropped).toEqual(["task.body"]);
    });

    it("重复项去重（同一路径写两遍不该算两次）", () => {
        const r = sanitizeSystemPlaces(["diy", "diy"]);
        expect(r.places).toEqual(["diy"]);
        expect(r.dropped).toEqual([]);
    });

    it("★ 全空 → 回落推荐名单（保证真发永远有一份可用名单）", () => {
        expect(sanitizeSystemPlaces([]).places).toEqual(defaultSystemPlaces());
        expect(sanitizeSystemPlaces(["  非法  "]).places).toEqual(defaultSystemPlaces());
        // 空名单本身不算"丢了东西"（是"没配"，不是"配错"）
        expect(sanitizeSystemPlaces([]).dropped).toEqual([]);
    });

    it("单点划分也合法（只把 diy 放 system，其余全 runtime）", () => {
        const r = sanitizeSystemPlaces(["diy"]);
        expect(r.places).toEqual(["diy"]);
    });
});

// ── 文件层（真源读写）─────────────────────────────────────────────
// 这一层是**真发实际调用的**（runTurn → loadSystemPlaces），所以它必须有测试：
// 之前划分规则只活在页面 localStorage 里，真发写死推荐名单 —— 页面改完真发不理。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    loadInputLimitChars,
    loadSystemPlaces,
    saveInputLimitChars,
    saveSystemPlaces,
    contextConfigFile,
} from "../../src/main/core/context-config";
import { DEFAULT_INPUT_LIMIT_CHARS } from "../../src/shared/context/input-limit";

describe("context.yaml（划分规则真源）", () => {
    const home = mkdtempSync(join(tmpdir(), "diy-ctx-config-"));
    process.on("exit", () => {
        try {
            rmSync(home, { recursive: true, force: true });
        } catch {
            /* 忽略 */
        }
    });

    // 每条用例从「文件缺失」起步：本组用例有的断言缺省名单、有的依赖上一条写下的名单
    // （「写侧拒绝非法输入」断言拒绝后文件保持 `["diy","task.title"]`）。`--sequence.shuffle`
    // 打乱顺序后这个隐含前提不成立 ⇒ 各自造前置，断言不变。
    beforeEach(() => {
        rmSync(contextConfigFile(home), { force: true });
        saveSystemPlaces(home, ["diy", "task.title"]);
    });

    it("文件缺失 → 推荐名单（开箱即用，与旧行为一致）", () => {
        rmSync(contextConfigFile(home), { force: true });
        expect(loadSystemPlaces(home)).toEqual(defaultSystemPlaces());
    });

    it("写入后读回同一份（原子写 + 带说明头）", () => {
        const saved = saveSystemPlaces(home, ["diy", "task.title"]);
        expect(saved).toEqual(["diy", "task.title"]);
        expect(loadSystemPlaces(home)).toEqual(["diy", "task.title"]);
        const raw = readFileSync(contextConfigFile(home), "utf-8");
        expect(raw).toContain("唯一运行时真源");
        expect(raw).toContain("systemPlaces:");
    });

    it("★ 写侧拒绝非法输入（不允许把坏数据存下来）", () => {
        expect(() => saveSystemPlaces(home, ["task", "task.body"])).toThrow(/非法投递单元/);
        expect(() => saveSystemPlaces(home, ["不 是 路 径"])).toThrow(/非法投递单元/);
        // 拒绝后文件保持原样（没被写坏）
        expect(loadSystemPlaces(home)).toEqual(["diy", "task.title"]);
    });

    it("★ 读侧兜住手改的坏文件：逐条净化 + 出声，不整份回落", () => {
        writeFileSync(contextConfigFile(home), "systemPlaces:\n  - diy\n  - task.body\n  - task\n", "utf-8");
        // task 与 task.body 重叠 → 丢后者；diy 保留（打错一个字不该丢掉其余划分）
        expect(loadSystemPlaces(home)).toEqual(["diy", "task"]);
    });

    it("读侧兜住结构不符 / 语法坏：回落推荐名单（真发永远有名单可用）", () => {
        writeFileSync(contextConfigFile(home), "systemPlaces: 不是数组\n", "utf-8");
        expect(loadSystemPlaces(home)).toEqual(defaultSystemPlaces());
        writeFileSync(contextConfigFile(home), "{{{ 坏 yaml\n", "utf-8");
        expect(loadSystemPlaces(home)).toEqual(defaultSystemPlaces());
    });

    it("空名单 → 推荐名单（清空与没配同义）", () => {
        writeFileSync(contextConfigFile(home), "systemPlaces: []\n", "utf-8");
        expect(loadSystemPlaces(home)).toEqual(defaultSystemPlaces());
    });
});

// ── 手改过的 home 一字不改（##426 的硬边界）──────────────────────
describe("已手改的名单不被默认值改写", () => {
    const home = mkdtempSync(join(tmpdir(), "diy-ctx-handedit-"));
    process.on("exit", () => {
        try {
            rmSync(home, { recursive: true, force: true });
        } catch {
            /* 忽略 */
        }
    });

    // 生产 home 那份（用户手调，8 项）—— 一字不动是本次改默认值的硬约束
    const HAND_EDITED = "systemPlaces:\n  - chain\n  - cwd\n  - diy\n  - guard\n  - project\n  - rules\n  - task.dir\n  - task.uri\n";

    it("★ 读侧原样返回手改名单（不掺默认、不改文件）", () => {
        writeFileSync(contextConfigFile(home), HAND_EDITED, "utf-8");
        expect(loadSystemPlaces(home)).toEqual([
            "chain",
            "cwd",
            "diy",
            "guard",
            "project",
            "rules",
            "task.dir",
            "task.uri",
        ]);
        // 读不会写：文件逐字不变
        expect(readFileSync(contextConfigFile(home), "utf-8")).toBe(HAND_EDITED);
        rmSync(contextConfigFile(home), { force: true });
    });
});

// ── 输入上限（##426 B）────────────────────────────────────────────
describe("context.yaml 的 inputLimitChars", () => {
    const home = mkdtempSync(join(tmpdir(), "diy-ctx-limit-"));
    process.on("exit", () => {
        try {
            rmSync(home, { recursive: true, force: true });
        } catch {
            /* 忽略 */
        }
    });

    it("文件缺失 / 键缺失 → 缺省 100_000（老文件不因新键缺失就坏）", () => {
        rmSync(contextConfigFile(home), { force: true });
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
        saveSystemPlaces(home, ["diy"]);
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
    });

    it("写后读回（原子写 + 说明头）", () => {
        saveSystemPlaces(home, ["diy"]);
        expect(saveInputLimitChars(home, 200_000)).toBe(200_000);
        expect(loadInputLimitChars(home)).toBe(200_000);
        expect(readFileSync(contextConfigFile(home), "utf-8")).toContain("inputLimitChars: 200000");
    });

    it("★ 两个写入口互相保键：改划分不丢阈值，改阈值不丢划分", () => {
        saveSystemPlaces(home, ["diy", "chain"]);
        saveInputLimitChars(home, 5_000);
        saveSystemPlaces(home, ["diy"]);
        expect(loadSystemPlaces(home)).toEqual(["diy"]);
        expect(loadInputLimitChars(home)).toBe(5_000);
        saveInputLimitChars(home, 7_000);
        expect(loadSystemPlaces(home)).toEqual(["diy"]);
    });

    it("非法值读回缺省（手改坏了不至于让门禁消失）", () => {
        writeFileSync(contextConfigFile(home), "systemPlaces:\n  - diy\ninputLimitChars: 不是数\n", "utf-8");
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
        // 但划分照样可用
        expect(loadSystemPlaces(home)).toEqual(["diy"]);
    });
});
