// tests/cli.intent.ui-chat-composer.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 聊天页两组可见性需求（任务 257 / R5 + R6）
//
// R5 输入框高度：**默认一行、随内容增长、到 view 1/3 封顶**，再多用「全文编辑」放全屏。
//    原来的固定档是 `min-h-[72px] max-h-[320px]` —— 空输入框也占 72px（三行），
//    而 320px 与 view 高度无关：矮 view 里它几乎吃掉整个对话区，高 view 里又远不到 1/3。
//    本条把口径改成**实测 view 高度的 1/3**（33vh 在多 view 并排时偏大，不用）。
//
// R6 消息时间：对话流里每条助理回复都该看得出「什么时候说的」。
//    真源是 turnId 内嵌毫秒（`t` + 13 位 epoch ms，main 侧 `t${Date.now()}` 是协议契约）；
//    Op 协议无 ts 字段、块结构也没有 —— 所以**只有**这条路径，且解析不出就**不显示**（不编时间）。
//
// 数据构造：直写 ops.jsonl（UI 重放的权威输入）。其中一个 turn 用真实毫秒 id（有时间），
// 另一个用旧形状 id（无时间）—— 同一页面同时验证"该有的有、解析不出的不编"。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { basename, dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/services/local-agent";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";

/** 固定时刻（本地 2026-09-26 14:07:09）—— 断言里直接写期望文案，不用运行时再格式化 */
const STAMP_MS = new Date(2026, 8, 26, 14, 7, 9).getTime();

beforeAll(async () => {
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
    ui = await makeUiDriver(electron.cdpUrl, async () => {
        const r = await fx.sh.getJson("./diy.sh ui inspect");
        return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
});

afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
});

async function a11yText(): Promise<string> {
    const res = await fx.sh.getJson("./diy.sh ui inspect");
    const acc: string[] = [];
    const walk = (n: any) => {
        if (n?.text) acc.push(String(n.text));
        for (const c of n?.children ?? []) walk(c);
    };
    walk((res.data as any)?.data?.tree);
    return acc.join("\n");
}

/** 输入区「正文宿主」：编辑器外层那个 overflow-auto 容器（R5 的封顶就加在它身上） */
const AREA = `(() => {
  const cm = document.querySelector('.cm-editor');
  if (!cm) return null;
  const composer = cm.closest('.rounded-field');
  return [...composer.querySelectorAll('div')]
    .find((d) => (d.className || '').toString().includes('overflow-auto')) || null;
})()`;
const areaBox = () =>
    ui.query<{ h: number; scrollH: number; maxH: string } | null>(
        `(() => { const a = ${AREA}; return a && { h: Math.round(a.getBoundingClientRect().height), scrollH: a.scrollHeight, maxH: getComputedStyle(a).maxHeight }; })()`,
    );
/** view（对话页根容器）实测高度 —— 封顶口径是它的 1/3 */
const viewBox = () =>
    ui.query<{ h: number; fs: boolean }>(
        `(() => {
           const root = document.querySelector('[data-testid=local-chat-page]');
           const cm = document.querySelector('.cm-editor');
           const composer = cm && cm.closest('.rounded-field');
           return { h: Math.round(root.getBoundingClientRect().height), fs: !!composer && composer.className.includes('fixed inset-4') };
         })()`,
    );
/** 聚焦编辑器（不点击）：内容长时 `.cm-content` 比可视宿主机高得多，
 *  元素中心点落在裁剪区外 → clickSelector 会点空（实测：60 行时点完 Meta+A 全选失效）。
 *  直接 DOM focus 让 CodeMirror 接管焦点与插入点，是稳定做法。 */
const focusEditor = async () => {
    await ui.query<boolean>("document.querySelector('.cm-content')?.focus(), true");
    await new Promise((r) => setTimeout(r, 150));
};
const setInput = async (text: string) => {
    await focusEditor();
    await ui.type(text);
    await new Promise((r) => setTimeout(r, 300));
};
/** 清空输入：全选（编辑器 keymap 的 Mod+A）+ Backspace 删掉选区（真人按键路径） */
const clearInput = async () => {
    await focusEditor();
    await ui.press("Meta+A");
    await ui.press("Backspace");
    await new Promise((r) => setTimeout(r, 300));
};

const bylines = () =>
    ui.query<{ text: string; times: { t: string; title: string }[] }[]>(
        `[...document.querySelectorAll('[data-testid=assistant-byline]')].map((b) => ({
           text: b.textContent,
           times: [...b.querySelectorAll('span')]
             .filter((s) => /^\\d\\d-\\d\\d \\d\\d:\\d\\d$/.test((s.textContent || '').trim()))
             .map((s) => ({ t: s.textContent.trim(), title: s.getAttribute('title') || '' })),
         }))`,
    );

describe("R5 聊天输入框高度：一行起、随内容长、view 1/3 封顶", () => {
    it("setup: 造任务并打开执行页", async () => {
        const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/composer --label Composer`);
        const pid = String((p.data as any)?.data?.id);
        const t = await fx.sh.getJson(`./diy.sh task create "输入框高度 + 消息时间" ${pid}`);
        uri = String((t.data as any)?.data?.uri);
        expect(uri).toMatch(/^projects\/.+\/tasks\/.+$/);

        const file = join(fx.HOME, "local", basename(opsFile(uri)));
        mkdirSync(dirname(file), { recursive: true });
        const ops = [
            // ① 真实毫秒 turnId：有时间
            { op: "start", id: `t${STAMP_MS}`, kind: "turn", meta: { model: "test-model" } },
            { op: "start", id: `t${STAMP_MS}_u`, kind: "text", parent: `t${STAMP_MS}`, meta: { role: "user" } },
            { op: "delta", id: `t${STAMP_MS}_u`, fields: { content: "第一句" } },
            { op: "stop", id: `t${STAMP_MS}_u` },
            { op: "start", id: `t${STAMP_MS}_a1`, kind: "text", parent: `t${STAMP_MS}`, meta: { role: "assistant" } },
            { op: "delta", id: `t${STAMP_MS}_a1`, fields: { content: "第一轮回复" } },
            { op: "stop", id: `t${STAMP_MS}_a1` },
            { op: "stop", id: `t${STAMP_MS}` },
            // ② 旧形状 turnId（迁移前日志）：解析不出 —— 不显示时间，也不编一个出来
            { op: "start", id: "t1", kind: "turn", meta: { model: "legacy-model" } },
            { op: "start", id: "t1_u", kind: "text", parent: "t1", meta: { role: "user" } },
            { op: "delta", id: "t1_u", fields: { content: "第二句" } },
            { op: "stop", id: "t1_u" },
            { op: "start", id: "t1_a1", kind: "text", parent: "t1", meta: { role: "assistant" } },
            { op: "delta", id: "t1_a1", fields: { content: "第二轮回复" } },
            { op: "stop", id: "t1_a1" },
            { op: "stop", id: "t1" },
        ];
        writeFileSync(file, ops.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");

        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await waitUntil(a11yText, (t) => t.includes("第一轮回复") && t.includes("第二轮回复"), {
            label: "两轮对话上屏",
        });
    });

    it("空输入：就一行高（不再是 72px 起）", async () => {
        const box = await waitUntil(areaBox, (b) => b != null, { label: "输入区上屏" });
        expect(box!.h).toBeLessThan(40); // 旧实现是 min-h-[72px]
    });

    it("随内容增长：多行 → 明显高于一行", async () => {
        const one = (await areaBox())!.h;
        await setInput("甲\n乙\n丙\n丁");
        const grown = await waitUntil(areaBox, (b) => b != null && b.h > one, { label: "输入区随内容长高" });
        expect(grown!.h).toBeGreaterThan(one);
    });

    it("封顶 = view 高度的 1/3，超出后内部滚动", async () => {
        const viewH = (await viewBox()).h;
        const capNum = (b: { maxH: string }) => Number.parseFloat(b.maxH);
        const many = Array.from({ length: 60 }, (_, i) => `第${i + 1}行`).join("\n");
        await setInput(`\n${many}`);
        // 容差 ±1.5px：view 高度带小数、clientHeight 取整，两边算出来可能差 1px
        const box = await waitUntil(
            areaBox,
            (b) => b != null && Number.isFinite(capNum(b)) && Math.abs(capNum(b) - viewH / 3) <= 1.5,
            { label: `输入区 max-height 收到 view 1/3（≈${Math.round(viewH / 3)}px）` },
        );
        expect(Math.abs(capNum(box!) - viewH / 3)).toBeLessThanOrEqual(1.5);
        expect(box!.maxH).not.toBe("none");
        expect(box!.h).toBeLessThanOrEqual(Math.ceil(viewH / 3));
        expect(box!.scrollH).toBeGreaterThan(box!.h); // 溢出走内部滚动，不撑破对话区
    });

    it("「全文编辑」不受该封顶约束（放全屏才是超长文本的出口）", async () => {
        // 用 aria-label 精确定位：`label.swap` 还会命中 ViewGrid area chrome 的「最大化」按钮（同类名）
        await ui.clickSelector('[aria-label="全文编辑"]'); // 输入框右上角的放大/还原开关
        const fs = await waitUntil(viewBox, (v) => v.fs, { label: "全屏编辑态" });
        expect(fs.fs).toBe(true);
        const box = await areaBox();
        expect(box!.maxH).toBe("none"); // 全屏时由 flex-1 接管，不再压 1/3
        await ui.clickSelector('[aria-label="退出全文编辑"]');
        await waitUntil(viewBox, (v) => !v.fs, { label: "退出全屏" });
    });

    it("清空后回到一行（长高不是一次性的）", async () => {
        await clearInput();
        const box = await waitUntil(areaBox, (b) => b != null && b.h < 40, { label: "清空后收回一行" });
        expect(box!.h).toBeLessThan(40);
    });
});

describe("R6 对话消息显示时间：真源 = turnId 内嵌毫秒", () => {
    it("助理署名行尾显示该轮时刻；hover 出精确到秒的完整时间", async () => {
        const rows = await waitUntil(bylines, (b) => b.some((x) => x.times.length > 0), {
            label: "时间戳上屏",
        });
        // 两轮里只有「真实毫秒 id」那轮有时间
        const stamped = rows.filter((r) => r.times.length > 0);
        expect(stamped).toHaveLength(1);
        expect(stamped[0]!.times[0]!.t).toBe("09-26 14:07");
        expect(stamped[0]!.times[0]!.title).toBe("2026-09-26 14:07:09");
    });

    it("解析不出时刻的旧 turnId：不显示时间，也不编一个（不显示 NaN/占位）", async () => {
        const rows = await bylines();
        expect(rows).toHaveLength(2);
        const bare = rows.filter((r) => r.times.length === 0);
        expect(bare).toHaveLength(1);
        expect(bare[0]!.text).toContain("legacy-model"); // 是旧形状那轮（byline 只含模型名）
        // 界面上不该有任何"假时间"
        expect(await ui.query<boolean>("document.body.textContent.includes('NaN')")).toBe(false);
    });
});
