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
 * 每条消息 meta 行（user-byline / assistant-byline）：时刻 span + 几何。
 *
 * 几何一次性取全，是因为窄栏断言要的是**相对关系**（行高 vs 图标高、内容宽 vs 自身宽），
 * 分多次查会拿到不同帧的值。
 */
const metaRows = () =>
    ui.query<
        Array<{
            who: "user" | "assistant";
            text: string;
            time: string | null;
            title: string;
            rowH: number;
            rowW: number;
            scrollW: number;
            iconH: number;
            timeH: number;
            timeRight: number;
            contRight: number;
            modelW: number;
            modelScrollW: number;
        }>
    >(
        `[...document.querySelectorAll('[data-testid=user-byline],[data-testid=assistant-byline]')].map((b) => {
           const spans = [...b.querySelectorAll('span')];
           const t = spans.find((s) => /^\\d\\d-\\d\\d \\d\\d:\\d\\d$/.test((s.textContent || '').trim()));
           const ic = spans.find((s) => s.getAttribute('aria-hidden') === 'true');
           const mdl = spans.find((s) => (s.textContent || '').includes('experimental')) || null;
           const cont = b.closest('.overflow-auto') || b.parentElement;
           const br = b.getBoundingClientRect(), cr = cont.getBoundingClientRect();
           const tr = t && t.getBoundingClientRect();
           return {
             who: b.getAttribute('data-testid') === 'user-byline' ? 'user' : 'assistant',
             text: b.textContent || '',
             time: t ? t.textContent.trim() : null,
             title: (t && t.getAttribute('title')) || '',
             rowH: Math.round(br.height),
             rowW: Math.round(br.width),
             scrollW: Math.round(b.scrollWidth),
             iconH: Math.round(ic ? ic.getBoundingClientRect().height : 0),
             timeH: Math.round(tr ? tr.height : 0),
             timeRight: Math.round(tr ? tr.right : 0),
             contRight: Math.round(cr.right),
             modelW: Math.round(mdl ? mdl.getBoundingClientRect().width : 0),
             modelScrollW: Math.round(mdl ? mdl.scrollWidth : 0),
           };
         })`,
    );

describe("R5 聊天输入框高度：一行起、随内容长、整个输入区 view 1/3 封顶", () => {
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
    it("一轮一处：时刻挂在该轮首个消息块（用户发言）上，助理侧与用量条都不重复", async () => {
        const rows = await waitUntil(metaRows, (r) => r.length >= 5, { label: "三轮消息上屏" });
        // 真实毫秒 id 那轮：时刻只出现在**用户发言那一行**，全页（innerText）也只有这一处
        const stamped = rows.filter((r) => r.time === "09-26 14:07");
        expect(stamped).toHaveLength(1);
        expect(stamped[0]!.who).toBe("user");
        expect(stamped[0]!.title).toBe("2026-09-26 14:07:09"); // hover 出精确到秒
        expect(await ui.query<number>("(document.body.innerText.match(/09-26 14:07/g) || []).length")).toBe(1);

        // 助理署名行：一轮里每一块都渲染它（"谁答的"确实是块的属性），但**不挂时刻**
        // （review2-3：按块挂时一轮两步就有两条带时刻的署名行 + 用户行 + 用量条 = 同一轮 4 声）
        expect(rows.filter((r) => r.who === "assistant" && r.time != null)).toHaveLength(0);

        // 轮底用量条：同样不重复（它的维度是 token/金额，不是时间）
        const bar = '[aria-label="本轮用量（悬停看汇总，点击开逐步明细）"]';
        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('${bar}')`),
            (v) => v === true,
            { label: "用量条上屏" },
        );
        expect(await ui.query<string>(`document.querySelector('${bar}')?.textContent ?? ''`)).not.toMatch(
            /\d\d-\d\d \d\d:\d\d/,
        );

        // 位置：user 那一刻在气泡**上方**、与气泡**右缘对齐**（每条消息块以一行 meta 开头，时间在最右）。
        const geo = await ui.query<{
            rowBottom: number;
            rowRight: number;
            bubbleTop: number;
            bubbleRight: number;
            vw: number;
        }>(
            `(() => {
               const row = document.querySelector('[data-testid=user-byline]');
               const bubble = row.nextElementSibling.querySelector('div');
               const rr = row.getBoundingClientRect();
               const br = bubble.getBoundingClientRect();
               return { rowBottom: rr.bottom, rowRight: rr.right, bubbleTop: br.top, bubbleRight: br.right, vw: innerWidth };
             })()`,
        );
        expect(geo.rowBottom).toBeLessThanOrEqual(geo.bubbleTop + 1); // 在气泡上方
        expect(Math.abs(geo.rowRight - geo.bubbleRight)).toBeLessThanOrEqual(2); // 右缘对齐
        expect(geo.rowRight).toBeGreaterThan(geo.vw / 2); // 确在右半区（不是左边残留）
    });

    it("解析不出时刻的旧 turnId：不显示时间，也不编一个（更不显示空行）", async () => {
        const rows = await metaRows();
        // 旧轮的助理署名行照旧（它承载"谁答的"），但没有时刻
        const legacy = rows.find((r) => r.who === "assistant" && r.text.includes("legacy-model"));
        expect(legacy).toBeTruthy();
        expect(legacy!.time).toBeNull();
        // 时刻行只在**解析得出**时才渲染：三块 user 内容里只有两块（两个真实毫秒 id）有这种行
        const userRows = rows.filter((r) => r.who === "user");
        expect(userRows).toHaveLength(2);
        expect(userRows.every((r) => r.time != null)).toBe(true);
        // 界面上不该有任何"假时间"
        expect(await ui.query<boolean>("document.body.textContent.includes('NaN')")).toBe(false);
    });

    it("窄栏（420px）下长模型署名行仍一行、被截断而非溢出；轮首时刻完整可见（review2-1）", async () => {
        const viewport = await ui.query<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })");
        await ui.setViewport(420, 720);
        try {
            const rows = await waitUntil(
                async () => {
                    const r = await metaRows();
                    return r.some((x) => x.who === "assistant" && x.text.includes("experimental")) ? r : null;
                },
                (v) => v != null,
                { label: "窄栏下长模型署名行上屏" },
            );
            const long = rows!.find((x) => x.who === "assistant" && x.text.includes("experimental"))!;
            // ① 不换行：行高仍是单行（截图里换行会到图标高的两倍）
            expect(long.rowH).toBeLessThanOrEqual(long.iconH + 4);
            // ② 不溢出容器：内容被截在行内（撑破时 scrollWidth 会大于自身宽度）
            expect(long.scrollW).toBeLessThanOrEqual(long.rowW + 2);
            // ③ 截断**真的发生了**（而不是这次内容恰好短）：模型名比它那块可见宽度长
            expect(long.modelScrollW).toBeGreaterThan(long.modelW + 4);
            // ④ 该轮的轮首时刻完整可见：右缘没越过容器右缘，且没被挤成两行
            const timeRow = rows!.find((x) => x.who === "user" && x.time === "09-27 09:15")!;
            expect(timeRow).toBeTruthy();
            expect(timeRow.timeRight).toBeLessThanOrEqual(timeRow.contRight + 1);
            expect(timeRow.rowH).toBeLessThanOrEqual(timeRow.timeH + 4);
        } finally {
            await ui.setViewport(viewport.w, viewport.h);
        }
    });
});
