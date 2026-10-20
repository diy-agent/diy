// tests/cli.intent.chat-find-deep.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 会话数据层检索（##389 第 2 项）的**实跑**判据 —— 真 Electron + 真 ops 文件。
//
// 与 cli.intent.chat-find-window.test.ts 的分工：
//   那个文件钉住**现状边界**（⌘F 只覆盖已渲染的 DOM、窗口外的轮搜不到）；
//   本文件钉住**新增能力**（⌘⇧F 的数据层面板能搜到窗口外、能定位过去、⌘F 语义不变）。
// 两个文件同时绿 = 「边界还在」+「有了出路」。
//
// 用例（对应拍板口径）：
//   ① 窗口外命中可搜（面板）→ 点击定位 → 该轮上屏；
//   ② 桥接**出现**：⌘F 0/0 且数据层有命中所 ⇒ 出那一行（带 N 处 / M 处未渲染）；
//   ③ 桥接**不出现**两侧：页内已找到 ⇒ 不出；数据层也 0 ⇒ 不出（不许"可能有更多"敷衍）；
//   ④ 面板关闭后 ⌘F 语义不变（##234 回归：仍是页内查找、命中数照旧）；
//   ⑤ 段跳：目标轮**不在**已加载段里（5MB 会话，首载只读末尾 4MB）⇒ 点击后能跳过去，
//      并出现「正在查看历史」条；「回到最新」能回来。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

/** 小会话：40 轮，全部落在首载 4MB 预算内 ⇒ 数据在 store、DOM 只挂一窗（虚拟化） */
const SMALL_TURNS = 40;
/** 大会话：41 轮 × ~130KB ≈ 5.3MB > 4MB 首载预算 ⇒ 首轮**不在**已加载段里（段跳才够得着） */
const BIG_TURNS = 41;
const FILLER = "填".repeat(40_000); // ~120KB UTF-8
const BIG_FIRST = "t1700000000001";
const BIG_LAST = `t${1700000000000 + BIG_TURNS}`;

const markerOf = (i: number) => `marker-${String(i).padStart(2, "0")}`;
const turnIdOf = (i: number) => `t${1700000000000 + i}`;

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let smallUri = "";
let bigUri = "";

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

    const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/finddeep --label 深层检索`);
    const pid = String((p.data as any)?.data?.id);

    const t1 = await fx.sh.getJson(`./diy.sh task create "深层检索小会话" ${pid}`);
    smallUri = String((t1.data as any)?.data?.uri);
    writeOps(smallUri, buildSmall());

    const t2 = await fx.sh.getJson(`./diy.sh task create "深层检索大会话" ${pid}`);
    bigUri = String((t2.data as any)?.data?.uri);
    writeOps(bigUri, buildBig());
}, 180_000);

afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
});

function writeOps(uri: string, text: string): void {
    const fp = join(fx.HOME, sessionFileRel(uri, "ops"));
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, text, "utf-8");
}

/**
 * 小会话：每轮 = 用户发言（带独有哨兵词）+ 助理短答。
 * 第 5 轮额外挂一个工具块（输出独有词）、第 6 轮挂一段推理（独有词）—— 对应范围开关与「工具默认搜」。
 */
function buildSmall(): string {
    const lines: string[] = [];
    const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));
    for (let i = 1; i <= SMALL_TURNS; i++) {
        const tn = turnIdOf(i);
        push({ op: "start", id: tn, kind: "turn", meta: { model: "test" } });
        push({ op: "start", id: `${tn}_u`, kind: "text", parent: tn, meta: { role: "user" } });
        push({ op: "delta", id: `${tn}_u`, fields: { content: `第${i}轮提问 ${markerOf(i)}` } });
        push({ op: "stop", id: `${tn}_u` });
        push({ op: "start", id: `${tn}_a`, kind: "text", parent: tn, meta: { role: "assistant" } });
        push({ op: "delta", id: `${tn}_a`, fields: { content: `第${i}轮的答复。` } });
        push({ op: "stop", id: `${tn}_a` });
        if (i === 5) {
            push({ op: "start", id: `${tn}_t`, kind: "tool", parent: tn, meta: { tool: "bash", title: "跑冒烟" } });
            push({ op: "delta", id: `${tn}_t`, fields: { output: "ok toolneedle-05" } });
            push({ op: "stop", id: `${tn}_t` });
        }
        if (i === 6) {
            push({ op: "start", id: `${tn}_k`, kind: "think", parent: tn });
            push({ op: "delta", id: `${tn}_k`, fields: { content: "thinkneedle-06 先想想" } });
            push({ op: "stop", id: `${tn}_k` });
        }
        push({ op: "stop", id: tn });
    }
    return lines.join("\n") + "\n";
}

/** 大会话：第 1 轮是**段跳目标**（独有词 far-needle），后面 40 轮各 ~120KB ⇒ 首轮在首载窗口外 */
function buildBig(): string {
    const lines: string[] = [];
    const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));
    for (let i = 1; i <= BIG_TURNS; i++) {
        const tn = `t${1700000000000 + i}`;
        push({ op: "start", id: tn, kind: "turn", meta: { model: "test" } });
        push({ op: "start", id: `${tn}_u`, kind: "text", parent: tn, meta: { role: "user" } });
        push({
            op: "delta",
            id: `${tn}_u`,
            fields: { content: i === 1 ? "最早那一轮：far-needle 就在这里" : `第${i}轮的开场。` },
        });
        push({ op: "stop", id: `${tn}_u` });
        push({ op: "start", id: `${tn}_a`, kind: "text", parent: tn, meta: { role: "assistant" } });
        push({ op: "delta", id: `${tn}_a`, fields: { content: `${i} ${FILLER}` } });
        push({ op: "stop", id: `${tn}_a` });
        push({ op: "stop", id: tn });
    }
    return lines.join("\n") + "\n";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const domTurnIds = () =>
    ui.query<string[]>(`[...document.querySelectorAll('[data-turn-id]')].map(e => e.getAttribute('data-turn-id'))`);

const panelPresent = () => ui.query<boolean>(`!!document.querySelector('[data-chat-find]')`);
const bridgeText = () =>
    ui.query<string>(`document.querySelector('[data-find-bridge]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ""`);
const panelQuery = () =>
    ui.query<string>(`document.querySelector('[data-chat-find] input[type="search"]')?.value ?? ""`);
const panelHitTexts = () =>
    ui.query<string[]>(
        `[...document.querySelectorAll('[data-chat-find] button[title="点击定位到这一轮"]')].map(e => e.textContent.replace(/\\s+/g,' ').trim())`,
    );
/** 面板里第一个结果项（真实点击：走命中测试，不是合成事件） */
const clickFirstHit = () => ui.clickSelector('[data-chat-find] button[title="点击定位到这一轮"]');

/** 滚到会话底部（让虚拟窗口回到末尾）：定位用例会把窗口挪到前面，后续用例必须先复位 */
const scrollToBottom = () =>
    ui.query<number>(
        `(() => { const el = document.querySelector('.diy-chat'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); return Math.round(el.scrollTop); })()`,
    );

const openTab = async (uri: string) => {
    await ui.bringToFront();
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
};

describe("①② 会话数据层面板：窗口外命中可搜，点击能定位过去", () => {
    it("⌘⇧F 搜窗口外的轮 → 出结果 → 点击 → 该轮上屏", async () => {
        await openTab(smallUri);
        await waitUntil(domTurnIds, (ids) => ids.includes(turnIdOf(SMALL_TURNS)), {
            label: "小会话首载（末尾轮上屏）",
            timeoutMs: 20_000,
        });
        // 前提：目标轮在窗口**外**（数据在 store 里 —— 上一文件已钉住这个边界）
        expect(await domTurnIds()).not.toContain(turnIdOf(1));

        await ui.press("Meta+Shift+f");
        await waitUntil(panelPresent, (v) => v, { label: "⌘⇧F 打开检索面板" });

        await ui.type(markerOf(1));
        const hits = await waitUntil(panelHitTexts, (v) => v.length > 0, { label: "面板出结果" });
        expect(hits[0]).toContain(markerOf(1));

        await clickFirstHit();
        // 定位闭环：目标轮必须真的上屏（不是"滚了一下就算成功"）
        await waitUntil(domTurnIds, (ids) => ids.includes(turnIdOf(1)), {
            label: "定位到窗口外的轮",
            timeoutMs: 8000,
        });
        // 定位后收起面板（用户要看的是那一轮，不是列表）
        await waitUntil(panelPresent, (v) => !v, { label: "定位后面板收起" });
    }, 120_000);

    it("范围开关：工具默认能搜到，推理默认搜不到（勾上才出）", async () => {
        await ui.press("Meta+Shift+f");
        await waitUntil(panelPresent, (v) => v, { label: "再开面板" });

        // 工具输出（默认开）
        await ui.query(`(() => { const i = document.querySelector('[data-chat-find] input[type=search]'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
        await ui.type("toolneedle-05");
        const toolHits = await waitUntil(panelHitTexts, (v) => v.length > 0, { label: "工具输出命中" });
        expect(toolHits[0]).toContain("toolneedle-05");
        expect(toolHits[0]).toContain("跑冒烟"); // 结果项标的是工具标题（认得出是哪次调用）

        // 推理（默认关）：同样的词 ⇒ 没有命中
        await ui.query(`(() => { const i = document.querySelector('[data-chat-find] input[type=search]'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
        await ui.type("thinkneedle-06");
        await sleep(600); // 防抖 120ms + RPC：等它跑完再看"没有结果"
        expect(await panelHitTexts()).toHaveLength(0);

        // 勾上「推理」⇒ 出现
        await ui.query(`(() => {
            const labels=[...document.querySelectorAll('[data-chat-find] label')];
            const t=labels.find(l=>l.textContent.includes('推理'));
            const box=t?.querySelector('input'); if(!box) return false;
            box.checked=true; box.dispatchEvent(new Event('change',{bubbles:true})); return true;
        })()`);
        const thinkHits = await waitUntil(panelHitTexts, (v) => v.length > 0, { label: "勾上推理后命中" });
        expect(thinkHits[0]).toContain("thinkneedle-06");

        await ui.press("Escape");
        await waitUntil(panelPresent, (v) => !v, { label: "Esc 关面板" });
    }, 120_000);
});

describe("②③ 桥接：⌘F 0/0 且数据层有命中所才出现", () => {
    it("页内 0/0 + 数据层有命中所 → 出桥接行，点它带查询进面板", async () => {
        // 复位窗口到末尾：上一个用例把视口定位到了首轮，此刻 marker-01 **正在** DOM 里，
        // 而本用例要的正是"窗口外的轮"（否则测的是页内命中，桥接本就不该出现）。
        await scrollToBottom();
        await waitUntil(domTurnIds, (ids) => ids.includes(turnIdOf(SMALL_TURNS)), { label: "复位到末尾" });
        expect(await domTurnIds()).not.toContain(turnIdOf(1));

        await ui.press("Meta+f");
        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('input[placeholder*="页面内查找"]')`),
            (v) => v,
            { label: "⌘F 打开查找条" },
        );
        await ui.type(markerOf(1)); // 窗口外的轮
        const probe = () =>
            ui.query<string>(`(() => {
                try {
                    const outer = document.querySelector('[data-probe-hits]');
                    const input = document.querySelector('input[placeholder*="页面内查找"]');
                    const badge = [...document.querySelectorAll('span')]
                        .map((s) => s.textContent.trim())
                        .find((t) => t.includes('/') && !/[^0-9/]/.test(t)) ?? '';
                    return JSON.stringify({
                        outer: !!outer,
                        q: outer ? outer.getAttribute('data-probe-query') : null,
                        hits: outer ? outer.getAttribute('data-probe-hits') : null,
                        un: outer ? outer.getAttribute('data-probe-unrendered') : null,
                        input: input ? input.value : null,
                        badge,
                    });
                } catch (e) { return 'ERR ' + String(e); }
            })()`);
        const bridge = await waitUntil(bridgeText, (t) => t.length > 0, { label: "桥接行出现", timeoutMs: 8000 });
        if (!bridge) console.log("[##389 诊断] 探针状态：", await probe());
        expect(bridge).toContain("本会话另有 1 处命中");
        expect(bridge).toContain("未渲染"); // 命中的那一轮当前没挂 DOM

        await ui.clickSelector("[data-find-bridge]");
        await waitUntil(panelPresent, (v) => v, { label: "点桥接 → 面板打开" });
        expect(await panelQuery()).toBe(markerOf(1)); // 带查询过去，不让人重打
        const hits = await waitUntil(panelHitTexts, (v) => v.length > 0, { label: "面板已按该查询出结果" });
        expect(hits[0]).toContain(markerOf(1));
        await ui.press("Escape");
        await waitUntil(panelPresent, (v) => !v, { label: "收起面板" });
    }, 120_000);

    it("两侧不出现：页内已找到 / 数据层也 0 ⇒ 都没有那一行", async () => {
        await ui.press("Meta+f");
        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('input[placeholder*="页面内查找"]')`),
            (v) => v,
            { label: "⌘F 打开查找条" },
        );
        // ① 页内能搜到（末尾轮在窗口里）⇒ 不出桥接
        await ui.type(markerOf(SMALL_TURNS));
        await waitUntil(
            () =>
                ui.query<string>(`(() => {
                    const input=document.querySelector('input[placeholder*="页面内查找"]');
                    const bar=input?.closest('div');
                    const b=[...(bar?.parentElement?.querySelectorAll('span')??[])].find(s=>/^\\d+\\/\\d+$/.test(s.textContent.trim()));
                    return b?b.textContent.trim():"";
                })()`),
            (t) => t !== "" && !t.startsWith("0/"),
            { label: "页内命中", timeoutMs: 8000 },
        );
        await sleep(300);
        expect(await bridgeText()).toBe("");

        // ② 两边都没有 ⇒ 也不出（不许"可能有更多"敷衍）
        await ui.query(`(() => { const i=document.querySelector('input[placeholder*="页面内查找"]'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
        await ui.type("zzz-不存在的东西");
        await sleep(900); // 防抖 + RPC：等探针回来
        expect(await bridgeText()).toBe("");

        await ui.press("Escape");
        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('input[placeholder*="页面内查找"]')`),
            (v) => !v,
            { label: "关查找条", timeoutMs: 8000 },
        );
    }, 120_000);
});

describe("④ 面板关闭后 ⌘F 语义不变（##234 回归）", () => {
    it("Esc 关掉面板 → ⌘F 仍是页内查找条，命中数照旧", async () => {
        await ui.bringToFront();
        await scrollToBottom();
        await waitUntil(domTurnIds, (ids) => ids.includes(turnIdOf(SMALL_TURNS)), { label: "复位到末尾" });

        // 清场：查找条可能在**上一个用例**里还开着（那条用例只关了面板）。
        // 用 ✕ 关（真实点击），并**断言**关掉了 —— 不靠"下一句 ⌘F 反正也能开"糊过去。
        const barOpen = () => ui.query<boolean>(`!!document.querySelector('input[placeholder*="页面内查找"]')`);
        if (await barOpen()) await ui.clickSelector('button[title="关闭（Esc）"]');
        expect(await waitUntil(barOpen, (v) => !v, { label: "清场：关掉残留查找条", timeoutMs: 5000 })).toBe(false);

        // ⌘⇧F 开面板 → Esc 关面板（Esc **只**关面板，不碰 ⌘F 那一层）
        await ui.press("Meta+Shift+f");
        await waitUntil(panelPresent, (v) => v, { label: "开面板" });
        await ui.press("Escape");
        expect(await waitUntil(panelPresent, (v) => !v, { label: "关面板" })).toBe(false);
        expect(await barOpen()).toBe(false); // 关面板没把查找条带出来

        // ⌘F：打开的是**页内查找条**，且输入框拿到焦点（⌘F 后直接打字，不用再点一下）
        await ui.press("Meta+f");
        expect(await waitUntil(barOpen, (v) => v, { label: "⌘F 打开页内查找条" })).toBe(true);
        const focused = await ui.query<boolean>(
            `document.activeElement === document.querySelector('input[placeholder*="页面内查找"]')`,
        );
        expect(focused).toBe(true); // 焦点必须自己落进来 —— 否则用户"敲了没反应"

        await ui.type(markerOf(SMALL_TURNS));
        const badge = await waitUntil(
            () =>
                ui.query<string>(`(() => {
                    const input=document.querySelector('input[placeholder*="页面内查找"]');
                    const bar=input?.closest('div');
                    const b=[...(bar?.parentElement?.querySelectorAll('span')??[])].find(s=>/^\\d+\\/\\d+$/.test(s.textContent.trim()));
                    return b?b.textContent.trim():"";
                })()`),
            (t) => /^\d+\/\d+$/.test(t) && !t.startsWith("0/"),
            { label: "页内命中计数" },
        );
        expect(badge).toBe("1/1");
        await ui.clickSelector('button[title="关闭（Esc）"]');
        expect(await waitUntil(barOpen, (v) => !v, { label: "清理：关掉查找条" })).toBe(false);
    }, 120_000);
});

describe("⑤ 段跳：目标轮不在已加载段里（>4MB 会话）", () => {
    it("首载只读末尾一段 ⇒ 首轮搜得到、点得过去、能回到最新", async () => {
        await openTab(bigUri);
        await waitUntil(domTurnIds, (ids) => ids.includes(BIG_LAST), {
            label: "大会话首载（末尾轮上屏）",
            timeoutMs: 30_000,
        });
        // 前提：首轮既不在 DOM，**也不在已加载段里**（否则走不到段跳那条路）
        expect(await domTurnIds()).not.toContain(BIG_FIRST);

        await ui.press("Meta+Shift+f");
        const opened = await waitUntil(panelPresent, (v) => v, { label: "开面板" });
        console.log(
            "[##389 诊断] ⑤ 面板：",
            JSON.stringify({
                opened,
                active: await ui.query<string>(`document.activeElement.tagName`),
                tab: await ui.query<string>(`document.title`).catch(() => ""),
            }),
        );
        expect(opened).toBe(true);
        // 面板会保留上一次的查询（跨会话也保留 —— 那是使用者的检索意图），故先全选再打字，
        // 否则会追加成 "marker-01far-needle"（实测踩过，一次就够）
        await ui.press("Meta+A");
        await ui.type("far-needle");
        const hits = await waitUntil(panelHitTexts, (v) => v.length > 0, { label: "大会话里搜到首轮", timeoutMs: 20_000 });
        expect(hits[0]).toContain("far-needle");

        await clickFirstHit();
        // 段跳之后：目标轮上屏 + 出现「正在查看历史」条（尾部不在树里，必须给出显式出口）
        await waitUntil(domTurnIds, (ids) => ids.includes(BIG_FIRST), { label: "段跳到首轮", timeoutMs: 20_000 });
        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('[data-chat-detached]')`),
            (v) => v,
            { label: "历史视图条出现" },
        );

        // 回到最新：尾部重新加载，历史条消失
        await ui.clickSelector('[data-chat-detached] button');
        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('[data-chat-detached]')`),
            (v) => !v,
            { label: "历史视图条消失", timeoutMs: 20_000 },
        );
        await waitUntil(domTurnIds, (ids) => ids.includes(BIG_LAST), { label: "回到末尾轮", timeoutMs: 20_000 });
    }, 180_000);
});
