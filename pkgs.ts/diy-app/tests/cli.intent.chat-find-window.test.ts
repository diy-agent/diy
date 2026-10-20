// tests/cli.intent.chat-find-window.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 【现状固化 · 不是期望行为】会话页 ⌘F 搜不到**未渲染**的历史（##389 第 1 项）
//
// 本文件钉住的是**当前的能力边界**，不是"应该这样"：
//   ⌘F（##234）的实现是 `document.createTreeWalker` 走 **DOM 文本节点**（findStore.collect），
//   而会话页从 ##301 起做了视口虚拟化（`lib/chat-virtual` + `windowRange`）——
//   **窗口外的轮根本不挂 DOM**。于是：
//     · 窗口**外**的轮，即便数据（ops.jsonl / 渲染端已加载的块树）里明明有 → ⌘F 命中 0；
//     · 窗口**内**的轮 → 命中。
//   这不是 bug，是「页内查找」的语义边界（##234 定位就是"页面内"）。真解 = 数据层检索，
//   见本任务（##389）第 2 项；**别**把本文件当"已修好"的证据 —— 它红了说明虚拟化/查找链路
//   动过，绿了只说明"边界还在那儿"。
//
// 判据（本任务第 1 项验收线）：
//   1. 首载后 DOM 只挂一部分轮（虚拟化生效）—— 窗口外的轮不在 DOM；
//   2. ⌘F 搜窗口外轮的独有文本 ⇒ 0/0（**同时**在文件里断言这段数据确实存在）；
//   3. ⌘F 搜窗口内轮的独有文本 ⇒ 命中；
//   4. 滚到顶把那一轮渲染出来后，**同一个词**变成可搜 ⇒ 证明链路是"窗口"而非"数据缺失"。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

/** 会话规模：40 轮短消息（远小于 4MB 首载预算 ⇒ **数据全在渲染端 store 里**，只是 DOM 只挂一窗） */
const TURNS = 40;

/** 第 i 轮（1-based）的独有哨兵词：补零两位，避免 `marker-01` ⊂ `marker-010` 这类子串互撞 */
const markerOf = (i: number) => `marker-${String(i).padStart(2, "0")}`;
const turnIdOf = (i: number) => `v${3000 + i}`;

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";
let fp = "";

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

    const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/findwin --label 查找窗口`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create "查找窗口边界" ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    fp = join(HOME, sessionFileRel(uri, "ops"));
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, buildOps(), "utf-8");
}, 120_000);

afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
});

/** 造 N 轮：每轮 = 用户发言（带独有哨兵词）+ 助理短答。总量小 ⇒ 全部落在首载窗口里 */
function buildOps(turns: number = TURNS): string {
    const lines: string[] = [];
    const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));
    for (let i = 1; i <= turns; i++) {
        const tn = turnIdOf(i);
        push({ op: "start", id: tn, kind: "turn", meta: { model: "test" } });
        push({ op: "start", id: `${tn}_u`, kind: "text", parent: tn, meta: { role: "user" } });
        push({ op: "delta", id: `${tn}_u`, fields: { content: `第${i}轮提问 ${markerOf(i)}` } });
        push({ op: "stop", id: `${tn}_u` });
        push({ op: "start", id: `${tn}_a`, kind: "text", parent: tn, meta: { role: "assistant" } });
        push({ op: "delta", id: `${tn}_a`, fields: { content: `第${i}轮的答复。` } });
        push({ op: "stop", id: `${tn}_a` });
        push({ op: "stop", id: tn });
    }
    return lines.join("\n") + "\n";
}

const domTurnIds = () =>
    ui.query<string[]>(`[...document.querySelectorAll('[data-turn-id]')].map(e => e.getAttribute('data-turn-id'))`);

const scrollTo = (top: number) =>
    ui.query<number>(
        `(() => { const el = document.querySelector('.diy-chat'); el.scrollTop = ${top}; el.dispatchEvent(new Event('scroll')); return Math.round(el.scrollTop); })()`,
    );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const findBarPresent = () => ui.query<boolean>(`!!document.querySelector('input[placeholder*="页面内查找"]')`);

const badgeText = () =>
    ui.query<string>(`(() => {
        const input = document.querySelector('input[placeholder*="页面内查找"]');
        const bar = input?.closest('div');
        if (!bar) return "";
        const b = [...bar.querySelectorAll('span')].find((s) => /^\\d+\\/\\d+$/.test(s.textContent.trim()));
        return b ? b.textContent.trim() : "";
    })()`);

/** 把查找框内容换掉（沿用 cli.intent.ui-find 的做法：JS 清空 + input 事件） */
const retype = async (text: string) => {
    await ui.query(`(() => {
        const i = document.querySelector('input[placeholder*="页面内查找"]');
        i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    await ui.type(text);
};

describe("【现状固化】会话页 ⌘F 只覆盖已渲染的 DOM（虚拟窗口外搜不到，##389）", () => {
    it("前提：数据全在（文件里有窗口外轮的哨兵词），但 DOM 只挂一部分轮", async () => {
        await ui.bringToFront();
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await waitUntil(() => domTurnIds(), (ids) => ids.length > 0, { label: "会话首载上屏", timeoutMs: 20_000 });

        // 数据确实存在（这是"搜不到"的可信前提：不是没有数据，是没挂 DOM）
        const raw = readFileSync(fp, "utf-8");
        expect(raw).toContain(markerOf(1));
        expect(raw).toContain(markerOf(TURNS));

        // 等「跟随到底」落定：末尾轮上屏才说明虚拟窗口停在底部（首载帧序有先后，不能一把断言）
        await waitUntil(domTurnIds, (ids) => ids.includes(turnIdOf(TURNS)), { label: "末尾轮上屏", timeoutMs: 10_000 });
        const ids = new Set(await domTurnIds());
        console.log(`[##389] DOM 轮：${[...ids].join(",")}`);
        expect(ids.has(turnIdOf(TURNS))).toBe(true); // 末尾轮在窗口里
        expect(ids.has(turnIdOf(1))).toBe(false); // 首轮在窗口外（虚拟化）
    }, 120_000);

    it("⌘F 搜窗口外的轮 ⇒ 0/0；搜窗口内的轮 ⇒ 命中", async () => {
        await ui.press("Meta+f");
        await waitUntil(findBarPresent, (v) => v, { label: "⌘F 打开查找条" });

        await ui.type(markerOf(1));
        // ⚠️ 现状：数据在（上一用例已断言），但 DOM 里没有 → 页内查找命中 0。
        expect(await waitUntil(badgeText, (b) => /^\d+\/\d+$/.test(b), { label: "计数出现" })).toBe("0/0");

        await retype(markerOf(TURNS));
        const inWin = await waitUntil(badgeText, (b) => !b.startsWith("0/"), { label: "窗口内命中" });
        expect(inWin).toBe("1/1"); // 该词只出现一次（用户发言那处）
    }, 120_000);

    it("滚到顶把首轮渲染出来 → 同一个词变成可搜（链路是「窗口」不是「数据缺失」）", async () => {
        await ui.press("Escape");
        await waitUntil(findBarPresent, (v) => !v, { label: "关查找条", timeoutMs: 8000 });

        // 上滚到顶（数据已全在内存，只有渲染窗口要挪；仍留兜底循环：万一将来首载预算收紧）
        let mounted = false;
        for (let i = 0; i < 8; i++) {
            await scrollTo(0);
            await sleep(400);
            if ((await domTurnIds()).includes(turnIdOf(1))) {
                mounted = true;
                break;
            }
        }
        expect(mounted).toBe(true);

        await ui.press("Meta+f");
        await waitUntil(findBarPresent, (v) => v, { label: "再次打开查找条" });
        await ui.type(markerOf(1));
        expect(await waitUntil(badgeText, (b) => !b.startsWith("0/"), { label: "渲染后可搜到" })).toBe("1/1");

        await ui.press("Escape");
        await waitUntil(findBarPresent, (v) => !v, { label: "清理" });
    }, 120_000);
});
