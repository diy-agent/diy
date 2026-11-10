// tests/architecture.test.ts — 并发架构的静态判据（docs/plans/2026-11-02-concurrency-actor.md）
//
// 判据 1：渲染层（UI）里出现 fs / readFile / writeFile / child_process ⇒ 架构错了。
// 判据 2：主进程侧所有「读—改—写」方法都包在 serial() 里。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const appDir = join(here, "..");
const chatPageSrc = join(appDir, "..", "..", "pkgs.ts", "ui", "chat-page", "src");
// ##505：actor 队列与 bot 领域逻辑在 @diy-agent/bot（apps/chat 只剩装配）
const botChatSrc = join(appDir, "..", "..", "pkgs.ts", "agent", "bot", "src", "chat.ts");

/**
 * 渲染层文件（会在浏览器里跑的）：chat-page 的 renderer* / store / client / style / 块渲染器 +
 * ui/*.tsx（shadcn 组件）+ apps/chat 的 renderer.ts。
 * ##526：React 版把渲染层拆成了 .tsx 与子目录，扩展名与目录都得跟着扫。
 */
function rendererSources(): { file: string; text: string }[] {
    const top = readdirSync(chatPageSrc)
        .filter(
            (name) =>
                /^(renderer|style|block-renderers|shared|blocks|store|client)\.tsx?$/.test(name) ||
                name.startsWith("renderer-"),
        )
        .map((name) => join(chatPageSrc, name));
    const uiDir = join(chatPageSrc, "ui");
    const ui = readdirSync(uiDir)
        .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
        .map((name) => join(uiDir, name));
    const files = [...top, ...ui];
    files.push(join(appDir, "renderer.ts"));
    return files.map((file) => ({ file, text: readFileSync(file, "utf-8") }));
}

/** 去掉注释行后再找（注释里提到 fs 不算违规） */
function codeOnly(text: string): string {
    return text
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");
}

describe("并发架构（##actor）", () => {
    it("判据 1：渲染层不碰文件系统 / 子进程", () => {
        const offenders = rendererSources()
            .filter(({ text }) => /\b(readFile|writeFile|readdir|mkdir|readFileSync|writeFileSync)\b|from\s+["']node:fs|require\(["']fs|child_process/.test(codeOnly(text)))
            .map(({ file }) => file);
        expect(offenders).toEqual([]);
    });

    it("判据 2：主进程侧每个「读—改—写」都走 serial（createBot / updateBot / removeBot / selectBot）", () => {
        const source = readFileSync(botChatSrc, "utf-8");
        // 四个改状态的方法都以 `return act(async () =>` 开头 —— 队列的入口是可见的
        for (const method of ["createFirstBot", "createBot", "updateBot", "removeBot", "selectBot"]) {
            // 找**方法定义**（顶格 8 空格缩进、参数表里是 input/id），不是 handleOf 里对 bot 包的调用
            const at = source.search(new RegExp(`\\n {8}${method}\\((input|id)\\b`));
            expect(at, `${method} 不见了`).toBeGreaterThan(0);
            const chunk = source.slice(at, at + 600);
            expect(chunk, `${method} 没有包进 act(...)`).toContain("return act(async () =>");
        }
    });

    it("判据：serial 的失败不污染队列（tail 吞掉异常）", async () => {
        const { createSerial } = await import("@diy-agent/bot");
        const serial = createSerial();
        const order: string[] = [];
        const a = serial(async () => {
            order.push("a");
            throw new Error("boom");
        });
        const b = serial(async () => {
            order.push("b");
            return 2;
        });
        await expect(a).rejects.toThrow("boom");
        expect(await b).toBe(2);
        expect(order).toEqual(["a", "b"]);
    });

    it("判据：serial 严格顺序执行（不交叠）", async () => {
        const { createSerial } = await import("@diy-agent/bot");
        const serial = createSerial();
        const log: string[] = [];
        const job = (name: string): Promise<void> =>
            serial(async () => {
                log.push(`${name}:start`);
                await new Promise((resolve) => setTimeout(resolve, 5));
                log.push(`${name}:end`);
            });
        await Promise.all([job("x"), job("y"), job("z")]);
        expect(log).toEqual(["x:start", "x:end", "y:start", "y:end", "z:start", "z:end"]);
    });
});
