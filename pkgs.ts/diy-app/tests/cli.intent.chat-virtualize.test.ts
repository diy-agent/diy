// tests/cli.intent.chat-virtualize.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 大会话 DOM 虚拟化（##301）意图验证 —— 只挂视口附近的轮，高度走实测账
//
// 需求（##290 遗留 → 本任务）：##293 已把**首载**收成尾部窗口，但**上滚累积**会把
// 前面每一段都前插进 DOM，最终仍可能回到 48 轮全铺 —— DOM 节点数与堆随会话长度无界。
// 本任务：只挂视口附近若干轮；未渲染轮的高度用**实测账**（随滚动修正），滚动位置不跳。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { basename, dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/services/local-agent";

/** 会话规模：48 轮（> 首载窗口 + 视口窗口，确保"虚拟化与否"可分辨） */
const TURNS = 48;

interface Win {
    ops: Array<{ op?: string; kind?: string; id?: string }>;
    cursor: string;
    hasMore: boolean;
    stale: boolean;
}

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";
let fp = "";
let allTurns: string[] = [];
/** 48 轮会话"滚到顶"后的 DOM 节点数（小会话用例的对照基准） */
let bigNodes = 0;

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
}, 120_000);

afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
});

/** 造 N 轮会话：每轮 = 用户一问 + 助理短答 + 一个大 tool 输出（单轮 ~700KB，折叠成 1 行） */
function buildOps(turns: number = TURNS): string {
    const lines: string[] = [];
    const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));
    const payload = (i: number) =>
        Array.from({ length: 14_000 }, (_, k) => `第${i}轮第${k}行 tool 输出内容 padding padding`).join("\n");
    for (let i = 1; i <= turns; i++) {
        const tn = `v${3000 + i}`;
        push({ op: "start", id: tn, kind: "turn", meta: { model: "test" } });
        push({ op: "start", id: `${tn}_u`, kind: "text", parent: tn, meta: { role: "user" } });
        push({ op: "delta", id: `${tn}_u`, fields: { content: `第${i}轮问题` } });
        push({ op: "stop", id: `${tn}_u` });
        push({ op: "start", id: `${tn}_a`, kind: "text", parent: tn, meta: { role: "assistant" } });
        push({ op: "delta", id: `${tn}_a`, fields: { content: `第${i}轮回答：结论如下。` } });
        push({ op: "stop", id: `${tn}_a` });
        push({ op: "start", id: `${tn}_r`, kind: "tool", parent: tn, meta: { tool: "bash" } });
        push({
            op: "patch",
            id: `${tn}_r`,
            fields: { args: { command: `第${i}轮的命令` }, status: "done", title: `第${i}轮的命令` },
        });
        push({ op: "delta", id: `${tn}_r`, fields: { output: payload(i) } });
        push({ op: "stop", id: `${tn}_r` });
        push({ op: "stop", id: tn });
    }
    return lines.join("\n") + "\n";
}

/** 渲染端 DOM 统计：已装载轮数 / 节点总数 / 滚动几何 / JS 堆 */
interface DomStats {
    turns: number;
    nodes: number;
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
    heapMB: number;
}
const domStats = (): Promise<DomStats> =>
    ui.query<DomStats>(
        `(() => { const el = document.querySelector('.diy-chat');` +
            ` const turns = el ? [...new Set([...el.querySelectorAll('[data-turn-id]')].map(e => e.getAttribute('data-turn-id')))] : [];` +
            ` return { turns: turns.length, nodes: el ? el.querySelectorAll('*').length : 0,` +
            ` scrollHeight: Math.round(el?.scrollHeight ?? 0), clientHeight: Math.round(el?.clientHeight ?? 0),` +
            ` scrollTop: Math.round(el?.scrollTop ?? 0),` +
            ` heapMB: Math.round(((performance).memory?.usedJSHeapSize ?? 0) / 1048576) }; })()`,
    );

const domTurns = () => ui.query<string[]>(`[...document.querySelectorAll('[data-turn-id]')].map(e => e.getAttribute('data-turn-id'))`);

const scrollTo = (top: number) =>
    ui.query<number>(
        `(() => { const el = document.querySelector('.diy-chat'); el.scrollTop = ${top}; el.dispatchEvent(new Event('scroll')); return Math.round(el.scrollTop); })()`,
    );

async function skipIfHidden(ctx: { skip: () => void }): Promise<boolean> {
    const vis = await ui.query<string>(`document.visibilityState`);
    if (vis === "visible") return false;
    console.warn(`[##301] 跳过位置断言：document.visibilityState=${vis}（rAF 被节流）`);
    ctx.skip();
    return true;
}

describe("大会话 DOM 虚拟化（##301）：渲染端", () => {
    beforeAll(async () => {
        const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/virt --label 虚拟化`);
        const pid = String((p.data as any)?.data?.id);
        const t = await fx.sh.getJson(`./diy.sh task create "大会话虚拟化" ${pid}`);
        uri = String((t.data as any)?.data?.uri);
        fp = join(fx.HOME, sessionFileRel(uri, "ops"));
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, buildOps(), "utf-8");
        allTurns = Array.from({ length: TURNS }, (_, i) => `v${3001 + i}`);
    }, 120_000);

    it("首载：DOM 只装视口附近的轮，与总会话轮数无关", async () => {
        await ui.bringToFront();
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await waitUntil(async () => (await domStats()).turns, (n) => n > 0, { label: "首载上屏" });
        const s = await domStats();
        console.log(`[##301] 首载：turns=${s.turns}/${TURNS} nodes=${s.nodes} heap=${s.heapMB}MB`);
        expect(s.turns).toBeGreaterThan(0);
        expect(s.turns).toBeLessThan(TURNS);
    }, 120_000);

    it("上滚到顶：DOM 轮数仍与总数无关（不是全铺），节点数不随会话增长", async () => {
        const diag = () =>
            ui.query<{ st: number; sh: number; ch: number; first: string | null }>(
                `(() => { const el = document.querySelector('.diy-chat');` +
                    ` return { st: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), ch: Math.round(el.clientHeight),` +
                    ` first: el.querySelector('[data-turn-id]')?.getAttribute('data-turn-id') ?? null }; })()`,
            );
        // 先滚到底：保证"上面还有"（否则这段用例在"已到顶"时什么都测不到）
        await scrollTo(99999999);
        await new Promise((r) => setTimeout(r, 400));
        // 一段段补到文件头
        for (let i = 0; i < TURNS + 2; i++) {
            const hasOlder = await ui.query<boolean>(`document.body.textContent.includes("上滚加载更早的消息")`);
            if (!hasOlder) break;
            const before = (await domTurns()).length;
            const d0 = await diag();
            await scrollTo(0);
            await new Promise((r) => setTimeout(r, 400));
            const after = (await domTurns()).length;
            const d1 = await diag();
            console.log(
                `[##301] 补段 ${i}: dom ${before}->${after}；before ${JSON.stringify(d0)}；after ${JSON.stringify(d1)}`,
            );
        }
        const s = await domStats();
        console.log(`[##301] 滚到顶：turns=${s.turns}/${TURNS} nodes=${s.nodes} heap=${s.heapMB}MB`);
        expect(s.turns).toBeGreaterThan(0);
        expect(s.turns).toBeLessThan(TURNS);
        bigNodes = s.nodes;
    }, 180_000);

    it("DOM 规模与会话轮数无关：12 轮会话与 48 轮会话同量级（这是「虚拟化」的字面验证）", async () => {
        const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/small --label 小会话`);
        const pid = String((p.data as any)?.data?.id);
        const t = await fx.sh.getJson(`./diy.sh task create "小会话" ${pid}`);
        const uri2 = String((t.data as any)?.data?.uri);
        const fp2 = join(fx.HOME, sessionFileRel(uri2, "ops"));
        mkdirSync(dirname(fp2), { recursive: true });
        writeFileSync(fp2, buildOps(12), "utf-8");

        await fx.sh.getJson(`./diy.sh ui tab open ${uri2}`);
        await waitUntil(async () => (await domStats()).turns, (n) => n > 0, { label: "小会话首载上屏" });
        // 也滚到顶（补完全部段）—— 与非虚拟化版"上滚累积到全铺"是同一场景
        for (let i = 0; i < 12 + 2; i++) {
            const hasOlder = await ui.query<boolean>(`document.body.textContent.includes("上滚加载更早的消息")`);
            if (!hasOlder) break;
            await scrollTo(0);
            await new Promise((r) => setTimeout(r, 400));
        }
        const small = await domStats();
        console.log(`[##301] 12 轮会话滚到顶：turns=${small.turns}/12 nodes=${small.nodes}；48 轮会话：nodes=${bigNodes}`);
        // 判据（本任务的验收线）：DOM 节点数**与会话轮数无关** ⇒ 两者同量级。
        // 非虚拟化版这里是 4 倍关系（12 轮 ≈ 360 节点 / 48 轮 ≈ 1441 节点）。
        expect(small.nodes).toBeGreaterThan(0);
        expect(small.nodes).toBeLessThan(bigNodes * 2);
        expect(bigNodes).toBeLessThan(small.nodes * 2);
    }, 180_000);

    it("反复上滚 / 下拉：正在看的那一行不跳", async (ctx) => {
        if (await skipIfHidden(ctx)) return;
        const anchor = (await domTurns())[0]!;
        const probe = () =>
            ui.query<number>(
                `(() => { const a = document.querySelector('[data-turn-id="${anchor}"]'); return a ? Math.round(a.getBoundingClientRect().top) : -99999; })()`,
            );
        const t0 = await probe();
        const el = await domStats();
        await ui.query(
            `(async () => { const el = document.querySelector('.diy-chat');` +
                ` el.scrollTop = ${Math.max(0, el.scrollTop - 600)}; el.dispatchEvent(new Event('scroll'));` +
                ` await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return 'ok'; })()`,
        );
        await scrollTo(Math.max(0, el.scrollTop - 600));
        await new Promise((r) => setTimeout(r, 300));
        await scrollTo(el.scrollTop);
        await new Promise((r) => setTimeout(r, 300));
        const t1 = await probe();
        console.log(`[##301] 上滚/下拉往返：anchor=${anchor} top=${t0} -> ${t1}`);
        expect(Math.abs(t1 - t0)).toBeLessThanOrEqual(4);
    }, 120_000);
});
