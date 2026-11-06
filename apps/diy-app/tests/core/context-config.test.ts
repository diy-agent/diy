// tests/core/context-config.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 输入上限（##426 B）的净化与文件层。
//
// 为什么它值得单测：阈值决定「发送前要不要弹门禁框」，手改文件 / 旧版本残留 /
// 写坏的值都必须在这里被兜住 —— 坏值只该让它自己回落缺省，不能把门禁整个弄没。
//
// ##520：原先「哪些变量进 system」的名单已删（信封只有一份全量），
// 这里只剩与投递无关的 `inputLimitChars`（单独一份 `input-limit.yaml`）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    loadInputLimitChars,
    saveInputLimitChars,
    inputLimitConfigFile,
} from "../../src/main/core/input-limit-config";
import { DEFAULT_INPUT_LIMIT_CHARS, sanitizeInputLimitChars } from "../../src/shared/context/input-limit";

describe("sanitizeInputLimitChars", () => {
    it("正常值：取整保留", () => {
        expect(sanitizeInputLimitChars(50_000)).toBe(50_000);
        expect(sanitizeInputLimitChars(5_000.9)).toBe(5_000);
    });

    it("★ 非数字 / NaN / Infinity 一律回落缺省（门禁永远有一个可用阈值）", () => {
        for (const bad of ["1000", null, undefined, {}, NaN, Infinity, -Infinity]) {
            expect(sanitizeInputLimitChars(bad), String(bad)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
        }
    });

    it("★ 0 / 负数回落缺省（阈值不存在「0 字」这种档）", () => {
        expect(sanitizeInputLimitChars(0)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
        expect(sanitizeInputLimitChars(-1)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
    });

    it("极小正数也接受（阈值多严是用户自己的事）", () => {
        expect(sanitizeInputLimitChars(1)).toBe(1);
    });
});

describe("input-limit.yaml（阈值真源）", () => {
    const home = mkdtempSync(join(tmpdir(), "diy-input-limit-"));
    process.on("exit", () => {
        try {
            rmSync(home, { recursive: true, force: true });
        } catch {
            /* 忽略 */
        }
    });

    beforeEach(() => {
        rmSync(inputLimitConfigFile(home), { force: true });
    });

    it("文件缺失 → 缺省 100_000（开箱即用）", () => {
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
    });

    it("空文件 / 空文档 → 缺省（不当成 0）", () => {
        writeFileSync(inputLimitConfigFile(home), "", "utf-8");
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
        writeFileSync(inputLimitConfigFile(home), "---\n", "utf-8");
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
    });

    it("写入后读回同一份（原子写 + 带说明头）", () => {
        expect(saveInputLimitChars(home, 200_000)).toBe(200_000);
        expect(loadInputLimitChars(home)).toBe(200_000);
        const raw = readFileSync(inputLimitConfigFile(home), "utf-8");
        expect(raw).toContain("字符上限");
        expect(raw).toContain("inputLimitChars: 200000");
    });

    it("★ 写侧净化：非法输入存下去的就是缺省值（不把坏数据写进文件）", () => {
        expect(saveInputLimitChars(home, -5)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
    });

    it("★ 读侧兜住手改的坏值：只有它自己回落缺省", () => {
        writeFileSync(inputLimitConfigFile(home), "inputLimitChars: 不是数\n", "utf-8");
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
    });

    it("读侧兜住语法坏 / 结构不符：回落缺省（不让门禁消失）", () => {
        writeFileSync(inputLimitConfigFile(home), "{{{ 坏 yaml\n", "utf-8");
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
        writeFileSync(inputLimitConfigFile(home), "inputLimitChars: []\n", "utf-8");
        expect(loadInputLimitChars(home)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
    });

    it("★ 保住别的键：写阈值不会顺手把同文件里的其它配置抹掉", () => {
        writeFileSync(inputLimitConfigFile(home), "inputLimitChars: 1000\nother: keep-me\n", "utf-8");
        saveInputLimitChars(home, 2_000);
        const raw = readFileSync(inputLimitConfigFile(home), "utf-8");
        expect(raw).toContain("inputLimitChars: 2000");
        expect(raw).toContain("other: keep-me");
    });
});
