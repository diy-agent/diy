// tests/cli.intent.ui-chat-composer.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 聊天页两组可见性需求（任务 257 / R5 + R6）
//
// R5 输入框高度：**默认一行、随内容增长、到 view 1/3 封顶**，再多用「全文编辑」放全屏。
//    原来的固定档是 `min-h-[72px] max-h-[320px]` —— 空输入框也占 72px（三行），
//    而 320px 与 view 高度无关：矮 view 里它几乎吃掉整个对话区，高 view 里又远不到 1/3。
//    口径改成**实测 view 高度的 1/3**（33vh 在多 view 并排时偏大，不用）；封顶的**主语是整个
//    输入框**（`rounded-field` 盒子 = 正文 + 工具条），不是只算正文宿主 —— review2-2 实测：
//    只封宿主时整个输入区比 view/3 高出 50px（工具条那一条没算进去）。
//
// R6 消息时间：真源是 turnId 内嵌毫秒（`t` + 13 位 epoch ms，main 侧 `t${Date.now()}` 是协议
//    契约）；Op 协议无 ts 字段、块结构也没有。它是**轮**的事实（turnId = 该轮起点 = 用户按下
//    发送那一刻），所以一轮只显示一次，挂在该轮**首个消息块**上（正常一轮即用户那条发言）；
//    解析不出的旧 id 一律**不显示**（不编时间）。助理侧与轮底用量条都不再重复 —— review2-3
//    实测：按块渲染时一轮两步会让 '09-26 14:07' 在这一个页面上出现 4 次。
//
// 数据构造：直写 ops.jsonl（UI 重放的权威输入）。三轮：真实毫秒 id（有时间）/ 旧形状 id
//    （解析不出）/ 长模型名（窄栏截断，review2-1）—— 同一页面同时验证"该有的有、不该有的没有"。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { basename, dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/core/local-paths";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";

/** 固定时刻（本地 2026-09-26 14:07:09）—— 断言里直接写期望文案，不用运行时再格式化 */
const STAMP_MS = new Date(2026, 8, 26, 14, 7, 9).getTime();
/** 第三轮的固定时刻（本地 2026-09-27 09:15:30）：窄栏用例认它 */
const STAMP3_MS = new Date(2026, 8, 27, 9, 15, 30).getTime();
/** 真实档里模型名可以很长（`provider/model`）：窄栏下署名行该截断而不是换行/顶破容器 */
const LONG_MODEL = "opencode-go/deepseek-v4.1-flash-experimental-ultra-long-variant";

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

/** 输入区「正文宿主」：编辑器外层那个 overflow-auto 容器（内容与内部滚动看它） */
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
/** 整个输入框（`rounded-field` 盒子）：封顶就加在它身上；`cap` = 它的 max-height */
const composerBox = () =>
    ui.query<{ boxH: number; hostH: number; cap: string; viewH: number } | null>(
        `(() => {
           const cm = document.querySelector('.cm-editor');
           if (!cm) return null;
           const box = cm.closest('.rounded-field');
           const host = ${AREA};
           const root = document.querySelector('[data-testid=local-chat-page]');
           return { boxH: Math.round(box.getBoundingClientRect().height),
                    hostH: Math.round(host.getBoundingClientRect().height),
                    cap: getComputedStyle(box).maxHeight,
                    viewH: Math.round(root.getBoundingClientRect().height) };
         })()`,
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

/** 全屏面板与正文编辑区的尺寸（面板 = 输入区宿主的 `fixed inset-4` 祖先） */
const panelBox = () =>
    ui.query<{ panelH: number; cmH: number; hostH: number } | null>(
        `(() => {
           const cm = document.querySelector('.cm-editor');
           const panel = cm && cm.closest('.rounded-field.fixed');
           if (!cm || !panel) return null;
           const host = cm.parentElement;
           return {
             panelH: Math.round(panel.getBoundingClientRect().height),
             cmH: Math.round(cm.getBoundingClientRect().height),
             hostH: Math.round(host.getBoundingClientRect().height),
           };
         })()`,
    );
const inFullscreen = () =>
    ui.query<boolean>("!!document.querySelector('.cm-editor')?.closest('.rounded-field.fixed')");

/**
 * 每轮的**两行**（v4 契约，##253「身份上移」+ 轮尾状态行）：一轮各一处，同序（文档序 = 时间序）。
 *
 *   ① 轮首署名行 `turn-header` —— 头像 + 名字 + 该轮模型（窄栏截断纪律在这一行）
 *   ② 轮尾状态行 `[data-turn-status]` —— 时刻 + 统计 + 速度 + 用量（**时刻一轮只在这里出现一次**）
 *
 * 几何一次性取全，是因为窄栏断言要的是**相对关系**（行高 vs 图标高、内容宽 vs 自身宽），
 * 分多次查会拿到不同帧的值。
 */
const turnRows = () =>
    ui.query<
        Array<{
            text: string;
            turnId: string | null;
            time: string | null;
            statusH: number;
            statusW: number;
            statusScrollW: number;
            rowH: number;
            rowW: number;
            scrollW: number;
            iconH: number;
            timeH: number;
            timeW: number;
            timeRight: number;
            contRight: number;
            modelW: number;
            modelScrollW: number;
        }>
    >(
        `(() => {
           const rows = [...document.querySelectorAll('[data-turn-id]')].map((root) => {
             const b = root.querySelector('[data-testid="turn-header"]');
             if (!b) return null;
             const s = root.querySelector('[data-turn-status]'); // 没有 usage 记录的旧轮根本没这行
             const spans = [...b.querySelectorAll('span')];
             const ic = spans.find((x) => x.getAttribute('aria-hidden') === 'true');
             const mdl = spans.find((x) => (x.textContent || '').includes('experimental')) || null;
             const t = s
               ? [...s.querySelectorAll('span')].find((x) => /^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d$/.test((x.textContent || '').trim()))
               : null;
             const cont = b.closest('.overflow-auto') || b.parentElement;
             const br = b.getBoundingClientRect(), cr = cont.getBoundingClientRect();
             const sr = s && s.getBoundingClientRect();
             const tr = t && t.getBoundingClientRect();
             return {
               turnId: root.getAttribute('data-turn-id'),
               text: b.textContent || '',
               time: t ? t.textContent.trim() : null,
               statusH: Math.round(sr ? sr.height : 0),
               statusW: Math.round(sr ? sr.width : 0),
               statusScrollW: s ? Math.round(s.scrollWidth) : 0,
               rowH: Math.round(br.height),
               rowW: Math.round(br.width),
               scrollW: Math.round(b.scrollWidth),
               iconH: Math.round(ic ? ic.getBoundingClientRect().height : 0),
               timeH: Math.round(tr ? tr.height : 0),
               timeW: Math.round(tr ? tr.width : 0),
               timeRight: Math.round(tr ? tr.right : 0),
               contRight: Math.round(cr.right),
               modelW: Math.round(mdl ? mdl.getBoundingClientRect().width : 0),
               modelScrollW: Math.round(mdl ? mdl.scrollWidth : 0),
             };
           });
           return rows.filter(Boolean);
         })()`,
    );

describe("R5 聊天输入框高度：一行起、随内容长、整个输入区 view 1/3 封顶", () => {
    it("setup: 造任务并打开执行页", async () => {
        const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/composer --label Composer`);
        const pid = String((p.data as any)?.data?.id);
        const t = await fx.sh.getJson(`./diy.sh task create "输入框高度 + 消息时间" ${pid}`);
        uri = String((t.data as any)?.data?.uri);
        expect(uri).toMatch(/^projects\/.+\/tasks\/.+$/);

        const file = join(fx.HOME, sessionFileRel(uri, "ops"));
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
            // 用量补丁：让 turn 底 bar 上屏 —— 用来钉住"它也不再重复时刻"（review2-3）
            {
                op: "patch",
                id: `t${STAMP_MS}`,
                fields: {
                    usage: {
                        inputTotal: 100,
                        outputTotal: 20,
                        cacheRead: 0,
                        noCache: 100,
                        cacheWrite: null,
                        text: 20,
                        reasoning: 0,
                        total: 120,
                        windowTotal: 120,
                        lastInputTotal: 100,
                        lastOutputTotal: 20,
                        steps: 1,
                        contextLimit: 200000,
                        cost: null,
                    },
                },
            },
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
            // ③ 长模型名的轮次：窄栏下署名行必须截断，而不是换行/顶破容器（review2-1）
            { op: "start", id: `t${STAMP3_MS}`, kind: "turn", meta: { model: LONG_MODEL } },
            { op: "start", id: `t${STAMP3_MS}_u`, kind: "text", parent: `t${STAMP3_MS}`, meta: { role: "user" } },
            { op: "delta", id: `t${STAMP3_MS}_u`, fields: { content: "第三句" } },
            { op: "stop", id: `t${STAMP3_MS}_u` },
            { op: "start", id: `t${STAMP3_MS}_a1`, kind: "text", parent: `t${STAMP3_MS}`, meta: { role: "assistant" } },
            { op: "delta", id: `t${STAMP3_MS}_a1`, fields: { content: "第三轮回复" } },
            { op: "stop", id: `t${STAMP3_MS}_a1` },
            // 用量补丁：轮尾状态行（时刻 + 统计 + 用量）要 `usage` 或"直播中"才渲染，
            // 真实轮次必有（main 在 finish-step 下发）；不给的话这轮连时刻都看不到
            {
                op: "patch",
                id: `t${STAMP3_MS}`,
                fields: {
                    usage: {
                        inputTotal: 100,
                        outputTotal: 20,
                        cacheRead: 0,
                        noCache: 100,
                        cacheWrite: null,
                        text: 20,
                        reasoning: 0,
                        total: 120,
                        windowTotal: 120,
                        lastInputTotal: 100,
                        lastOutputTotal: 20,
                        steps: 1,
                        contextLimit: 200000,
                        cost: null,
                    },
                },
            },
            { op: "stop", id: `t${STAMP3_MS}` },
        ];
        writeFileSync(file, ops.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");

        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await waitUntil(
            a11yText,
            (t) => t.includes("第一轮回复") && t.includes("第二轮回复") && t.includes("第三轮回复"),
            { label: "三轮对话上屏" },
        );
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

    it("封顶 = view 高度的 1/3（主语是**整个输入框**），超出后正文内部滚动", async () => {
        const viewH = (await viewBox()).h;
        const capNum = (b: { cap: string }) => Number.parseFloat(b.cap);
        const many = Array.from({ length: 60 }, (_, i) => `第${i + 1}行`).join("\n");
        await setInput(`\n${many}`);
        // 容差 ±1.5px：view 高度带小数、clientHeight 取整，两边算出来可能差 1px
        const box = await waitUntil(
            composerBox,
            (b) => b != null && Number.isFinite(capNum(b)) && Math.abs(capNum(b) - viewH / 3) <= 1.5,
            { label: `输入区 max-height 收到 view 1/3（≈${Math.round(viewH / 3)}px）` },
        );
        expect(Math.abs(capNum(box!) - viewH / 3)).toBeLessThanOrEqual(1.5);
        expect(box!.cap).not.toBe("none");
        // ① **整个输入框**（正文 + 底部工具条）都不超过 view/3。
        //    review2-2：封顶原先只加在正文宿主上，工具条（py-2 + 按钮）没算 → 整体超 50px。
        expect(box!.boxH).toBeLessThanOrEqual(Math.ceil(viewH / 3));
        expect(box!.boxH).toBeGreaterThan(box!.hostH); // 工具条确实被算进了这个盒子里
        // ② 溢出走正文宿主的**内部滚动**，不撑破对话区
        const host = (await areaBox())!;
        expect(host.scrollH).toBeGreaterThan(host.h);
    });

    it("「全文编辑」不受该封顶约束，且正文区真的铺满面板", async () => {
        // 幂等：vitest retry 会复用同一实例，先确保从非全屏点进全屏
        if (await inFullscreen()) {
            await ui.clickSelector('[aria-label="退出全文编辑"]');
            await waitUntil(inFullscreen, (v) => v === false, { label: "退出全屏（复位）" });
        }
        // 用 aria-label 精确定位：`label.swap` 还会命中 ViewGrid area chrome 的「最大化」按钮（同类名）
        await ui.clickSelector('[aria-label="全文编辑"]'); // 输入框右上角的放大/还原开关
        const fs = await waitUntil(viewBox, (v) => v.fs, { label: "全屏编辑态" });
        expect(fs.fs).toBe(true);
        expect((await composerBox())!.cap).toBe("none"); // 全屏不再压 1/3（高度交给 flex-1）
        expect((await areaBox())!.maxH).toBe("none");

        // ⚠️ 只断言 max-height 是不够的（review1-1 的教训：flex-1 丢了，max-height 照样是 none，
        // 面板 683px 而编辑区只剩 23px —— 断言"没封顶"却放过了"没铺满"）。
        // 这里断言**铺满**：编辑区高度 ≥ 面板 60%（避开 SteerBar/工具条/padding 的具体数值）。
        const m = await waitUntil(panelBox, (v) => v != null && v.panelH > 100, { label: "全屏面板上屏" });
        expect(m!.panelH).toBeGreaterThan(300);
        expect(m!.cmH).toBeGreaterThan(m!.panelH * 0.6);

        await ui.clickSelector('[aria-label="退出全文编辑"]');
        await waitUntil(viewBox, (v) => !v.fs, { label: "退出全屏" });
    });

    it("view 高度变化后封顶跟着重算（不只首帧那一次）", async () => {
        const capOf = (b: { cap: string }) => Number.parseFloat(b.cap);
        const before = await composerBox();
        expect(Number.isFinite(capOf(before!))).toBe(true);

        const viewport = await ui.query<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })");
        // 视口压矮 150px → 页面变矮 → ResizeObserver 回调 → 封顶重算（首帧那条路径的补充）
        await ui.setViewport(viewport.w, Math.max(500, viewport.h - 150));
        try {
            const after = await waitUntil(
                async () => {
                    const box = await composerBox();
                    const view = await viewBox();
                    return box && view ? { cap: capOf(box), viewH: view.h } : null;
                },
                (v) => v != null && Number.isFinite(v.cap) && Math.abs(v.cap - v.viewH / 3) <= 1.5,
                { label: "封顶随新 view 高度重算" },
            );
            expect(Math.abs(after!.cap - after!.viewH / 3)).toBeLessThanOrEqual(1.5);
            expect(after!.cap).toBeLessThan(capOf(before!)); // 确实跟着变小，而不是停在旧值
        } finally {
            await ui.clearViewport();
        }
    });

    it("清空后回到一行（长高不是一次性的）", async () => {
        await clearInput();
        const box = await waitUntil(areaBox, (b) => b != null && b.h < 40, { label: "清空后收回一行" });
        expect(box!.h).toBeLessThan(40);
    });
});

describe("R6 对话消息显示时间：真源 = turnId 内嵌毫秒", () => {
    it("一轮一处：时刻挂在**轮尾状态行**，轮首署名行与用量条都不再各说一次", async () => {
        const rows = await waitUntil(turnRows, (r) => r.length >= 3, { label: "三轮上屏" });
        // 三个轮里两个是真实毫秒 id → 恰好两处时刻，一轮一处
        expect(rows.filter((r) => r.time != null)).toHaveLength(2);
        const stamped = rows.filter((r) => r.time === "2026-09-26 14:07:09");
        expect(stamped).toHaveLength(1);
        // 全页（innerText）也只此一处：消息块与轮首署名行都不挂时刻（v4：时刻收敛到状态行）
        expect(await ui.query<number>("(document.body.innerText.match(/2026-09-26 14:07:09/g) || []).length")).toBe(1);

        // 轮首署名行：承载"谁答的"（头像 + 名字 + 该轮模型），**不挂时刻**
        // （review2-3：按块/按行挂时一轮会有好几声时刻，用户 2026-10-11 口径：一轮一处）
        expect(rows.every((r) => !/\d{4}-\d\d-\d\d \d\d:\d\d/.test(r.text))).toBe(true);

        // 轮尾状态行：时刻 + 统计 + 速度 + 用量在**同一行**；用量条自己不再重复时刻
        const bar = '[aria-label="本轮用量（悬停看汇总，点击开逐步明细）"]';
        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('${bar}')`),
            (v) => v === true,
            { label: "用量条上屏" },
        );
        expect(await ui.query<string>(`document.querySelector('${bar}')?.textContent ?? ''`)).not.toMatch(
            /\d{4}-\d\d-\d\d \d\d:\d\d/,
        );
        // 但时刻与用量在**同一个状态行**里（v4：一行 = 时刻 + 统计 + 速度 + 用量，一轮一行）
        expect(
            await ui.query<string>(
                `(() => {
                   const row = document.querySelector('${bar}')?.closest('[data-turn-status]');
                   return row ? row.textContent : '';
                 })()`,
            ),
        ).toContain("2026-09-26 14:07:09");

        // 位置：状态行排在轮首署名行**之后**（文档序 = 时间序 —— "轮尾"）
        expect(
            await ui.query<boolean>(
                `(() => {
                   const h = document.querySelector('[data-testid="turn-header"]');
                   const s = document.querySelector('[data-turn-status]');
                   return !!(h && s && (h.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING));
                 })()`,
            ),
        ).toBe(true);
    });

    it("解析不出时刻的旧 turnId：不显示时间，也不编一个（更不显示空行）", async () => {
        const rows = await turnRows();
        // 旧轮的署名行照旧（它承载"谁答的"），但它的状态行里**没有**时刻
        const legacy = rows.find((r) => r.text.includes("legacy-model"));
        expect(legacy).toBeTruthy();
        expect(legacy!.time).toBeNull();
        // 时刻只在**解析得出**时才渲染：三个轮里只有两个（真实毫秒 id）有
        expect(rows.filter((r) => r.time != null)).toHaveLength(2);
        expect(rows.filter((r) => r.time == null)).toHaveLength(1);
        // 界面上不该有任何"假时间"
        expect(await ui.query<boolean>("document.body.textContent.includes('NaN')")).toBe(false);
    });

    it("窄栏下长模型署名行仍一行、被截断而非溢出；状态行不横向溢出（review2-1）", async () => {
        const viewport = await ui.query<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })");
        const longRow = async () => {
            const rows = await waitUntil(
                async () => {
                    const r = await turnRows();
                    return r.some((x) => x.text.includes("experimental")) ? r : null;
                },
                (v) => v != null,
                { label: "长模型署名行上屏" },
            );
            return rows!.find((x) => x.text.includes("experimental"))!;
        };
        try {
            // ── 极窄栏：窗口 420px，侧栏占满后内容列只剩 ~88px ─────────────────────
            await ui.setViewport(420, 720);
            const narrow = await longRow();
            // ① 轮首行不换行（换行会到图标高的两倍）
            expect(narrow.rowH).toBeLessThanOrEqual(narrow.iconH + 4);
            // ② 不溢出容器：内容被截在行内（撑破时 scrollWidth 会大于自身宽度）
            expect(narrow.scrollW).toBeLessThanOrEqual(narrow.rowW + 2);
            // ③ 截断**真的发生了**（而不是这次内容恰好短）：模型名比它那块可见宽度长
            expect(narrow.modelScrollW).toBeGreaterThan(narrow.modelW + 4);
            // ④ 时刻文本仍是完整到秒的（`truncate` 只剪**可见宽度**，不改 DOM 文本 ——
            //    截断后靠 title 给全量，"看不见"不等于"没给"）
            expect(narrow.time).toBe("2026-09-27 09:15:30");

            // ⑤ **状态行在这里也不横向溢出、也不被挤成两行**（##298 的病灶）：原先这一档
            //    只钉时刻文本，就是因为几个 shrink-0 兄弟（时刻/统计/速度/用量）互不相让
            //    —— 行右缘越过容器 36px，且文本在 span 内折行把行高从 21px 顶到 37px。
            //    截断纪律（每一段 min-w-0 truncate）+ 按**行宽**退场（`@container`）落地后，
            //    这一档与 700px 档同口径锁死。
            expect(narrow.statusScrollW).toBeLessThanOrEqual(narrow.statusW + 2);
            expect(narrow.statusH).toBeLessThanOrEqual(24);
            // ⑥ 退场是**有序**的：这一段里内容列只剩 48px（侧栏被拖宽 > 窗口宽的病态走廊），
            //    速度/统计/用量条先后让位（`@container`，见 index.css 状态行段），
            //    但**时刻不是被挤成 0**，而是拿到整行去截断 —— 定住这条，免得日后有人
            //    用一句 `overflow-hidden` 把病灶盖掉（"看不见"≠"修好了"）。
            expect(narrow.timeW).toBeGreaterThanOrEqual(8);
            expect(await ui.query<boolean>("!!document.querySelector('[data-turn-status] [data-turn-clock]')")).toBe(true);

            // ── 日常窄栏：窗口 700px（内容列 ~368px）——状态行的下限档 ────────────
            await ui.setViewport(700, 720);
            const long = await longRow();
            // ⑤ 状态行自己也不横向溢出，且没被挤成两行（挤成两行会到 ~37px）
            expect(long.statusScrollW).toBeLessThanOrEqual(long.statusW + 2);
            expect(long.statusH).toBeLessThanOrEqual(24);
            // ⑥ 时刻在容器内完整可见（右缘没越过容器右缘）
            expect(long.timeRight!).toBeLessThanOrEqual(long.contRight! + 1);
        } finally {
            await ui.setViewport(viewport.w, viewport.h);
        }
    });
});
