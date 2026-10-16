// tests/cli.intent.local-history-paging.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 大会话分页（##293）意图验证 —— 冷加载按字节预算 seek，上滚补段
//
// 需求（##290 遗留 3.1 → ##293）：大大会话（数十~数百 MB）冷加载不再 O(全量)：
//   · 首载按**字节预算**向上 seek 到最近轮首，只 fold / 只回包「最近一段」；
//   · 滚动上取再往前补一段（前插 —— 已有段的块对象一个都不动）；
//   · 游标 = main 签发的**不透明 token**：轮末刷新回传同游标 ⇒ 同一段的延长；
//     一旦失效（清空 / 覆盖写 / 伪造的 token）⇒ 退全量 + `stale`，
//     **绝不把两段历史缝在一起**。
//
// 分工：三条保证（偏移恒在行首 / 窗口 ≥ 预算 / 窗口内每轮完整）与游标的形式校验钉在
// `tests/services/local-ops-seek.test.ts`；本文件只验**端到端契约** —— 真实 CLI 打真实
// main、真实渲染端滚动真的补出更早的轮。单测验不了「接线了没有」，正是这里要补的。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/services/local-agent";

// 会话规模：24 轮 × ~700KB（大头是 tool 输出）≈ 16.8MB —— 渲染端首载窗口 4MB（HISTORY_WINDOW_BYTES），
// 上滚补段**也按 4MB**，于是整份 = 4 段：三条补段用例（点提示条 / 滚到顶 / 在途继续滚）各消费一段。
// 反例（踩过两次）：10 轮 / 7MB 时整份只有 2 段；16 轮 / 11MB 时只有 3 段 —— 段数不够时
// 后面的用例会拿到"没有更早的"，断言退化成恒真（第一次靠 waitUntil 超时警告才暴露）。
const TURNS = 24;
/** CLI 侧的分页预算：≈ 1 轮多一点 ⇒ 上滚一步回溯 1 轮，轮次链条便于逐段核对 */
const BUDGET = 800 * 1024;

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
/** 首段游标（后面「同游标重取 / 失效」两条用例都要它，必须在改写文件之前拿到） */
let seg1 = "";

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

/**
 * 造 N 轮会话：每轮 = 用户一问 + 助理短答 + **一个大 tool 输出**（单轮 ~700KB）。
 *
 * 体积放在 tool 输出上，是**照真实会话的形状**（大会话的字节大头就是 tool/think 的追加），
 * 也顺带让 UI 测得动：历史里过程行默认折叠（级别缺省 3 ⇒ `midExpanded` = false），
 * 700KB 只出现在**盘上**、DOM 里只有一行 `tool · 命令首行`。
 * 反例（踩过）：把 700KB 塞进单行 assistant 文本 —— 单行文本 `omitted = 0` 永不折叠，
 * 7MB 全进 DOM、几十万个 line box，`ui inspect` 直接 20s 超时。
 */
function buildOps(turns: number = TURNS): string {
    const lines: string[] = [];
    const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));
    // 单轮 ~700KB：14,000 行 × 50 字节（多行才可能被折叠，行数与真实工具输出同量级）
    const payload = (i: number) =>
        Array.from({ length: 14_000 }, (_, k) => `第${i}轮第${k}行 tool 输出内容 padding padding`).join("\n");
    for (let i = 1; i <= turns; i++) {
        const tn = `t${3000 + i}`;
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

/** 段里的轮 id（按出现序）—— 切点必须落在轮首 ⇒ 段首必是一条 turn start */
const turnsOf = (w: Win): string[] =>
    w.ops.filter((o) => o.op === "start" && o.kind === "turn").map((o) => String(o.id));

async function win(opts: { budget?: number; cursor?: string } = {}): Promise<Win> {
    let cmd = `./diy.sh agent local historyWindow ${uri}`;
    if (opts.budget !== undefined) cmd += ` --budget-bytes ${opts.budget}`;
    if (opts.cursor) cmd += ` --cursor '${opts.cursor}'`;
    const r = await fx.sh.getJson(cmd);
    return r.data as unknown as Win;
}

async function older(cursor: string, budget: number = BUDGET): Promise<Win> {
    const r = await fx.sh.getJson(
        `./diy.sh agent local historyOlder ${uri} --cursor '${cursor}' --budget-bytes ${budget}`,
    );
    return r.data as unknown as Win;
}

/**
 * 窗口不可见（macOS 遮挡跟踪把它打成 `hidden` / 无显示环境）⇒ Chromium **节流 rAF** ⇒
 * 「前插后的位置补偿」那几帧根本不跑。此时位置断言**必然假红，且不是代码错** —— 跳过并说明，
 * 别把它写成断言失败（review1 R7；无人值守的 CI 上尤其如此）。
 */
async function skipIfHidden(ctx: { skip: () => void }): Promise<boolean> {
    const vis = await ui.query<string>(`document.visibilityState`);
    if (vis === "visible") return false;
    console.warn(`[##293] 跳过位置补偿断言：document.visibilityState=${vis}（rAF 被节流，补偿不跑）`);
    ctx.skip();
    return true;
}

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

/** 渲染端当前已装载的轮（DOM 是「折叠进块树的轮」的直接投影） */
const domTurns = () =>
    ui.query<string[]>(
        `[...new Set([...document.querySelectorAll('[data-turn-id]')].map(e => e.getAttribute('data-turn-id')))]`,
    );

describe("大会话分页：CLI 契约（真实 main）", () => {
    beforeAll(async () => {
        const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/paging --label 分页`);
        const pid = String((p.data as any)?.data?.id);
        const t = await fx.sh.getJson(`./diy.sh task create "大会话分页" ${pid}`);
        uri = String((t.data as any)?.data?.uri);
        fp = join(fx.HOME, "local", basename(opsFile(uri)));
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, buildOps(), "utf-8");
        allTurns = readFileSync(fp, "utf-8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { op?: string; kind?: string; id?: string })
            .filter((o) => o.op === "start" && o.kind === "turn")
            .map((o) => String(o.id));
        expect(allTurns).toHaveLength(TURNS);
    }, 60_000);

    it("首载：按预算只取最近一段 —— 起点落在轮首、切掉的是更早的轮", async () => {
        const w = await win({ budget: BUDGET });
        expect(w.stale).toBe(false);
        expect(w.hasMore).toBe(true); // 起点不在文件头 ⇒ 前面还有更早的
        expect(w.cursor).toBeTruthy();
        const ids = turnsOf(w);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.length).toBeLessThan(TURNS); // 真的切开了，不是全量
        expect(w.ops[0]).toMatchObject({ op: "start", kind: "turn" }); // 切点 = 轮首行行首
        // 取到的一定是**尾部**那些轮（时间序尾段），且连续到文件尾
        expect(ids).toEqual(allTurns.slice(allTurns.length - ids.length));
        seg1 = w.cursor;
    }, 60_000);

    it("上滚补段：一路取回文件头 —— 轮次无重无漏、顺序即时间序", async () => {
        let cursor = seg1;
        const ids = turnsOf(await win({ budget: BUDGET }));
        expect(ids).not.toHaveLength(0);
        let steps = 0;
        for (;;) {
            const r = await older(cursor);
            expect(r.stale).toBe(false);
            const head = turnsOf(r);
            if (head.length === 0) {
                expect(r.hasMore).toBe(false); // 前面只剩非轮内容才可能空 —— 且到此收工
                break;
            }
            // 无缝：新段首轮 = 已取到的最老一轮的前一轮（既不重叠也不跳号）
            expect(head[head.length - 1]).toBe(allTurns[allTurns.indexOf(ids[0]!) - 1]);
            expect(head.some((x) => ids.includes(x))).toBe(false); // 两段永不相交
            ids.unshift(...head);
            cursor = r.cursor;
            if (!r.hasMore) break; // 已到文件头
            if (++steps > 50) throw new Error("上滚停不下来（游标没有前进）");
        }
        expect(ids).toEqual(allTurns); // 拼起来正好 = 全量：无重、无漏、序一致
    }, 120_000);

    it("同游标重取 = 同一段（轮末刷新不会让窗口起点漂移）", async () => {
        const again = await win({ cursor: seg1, budget: 0 });
        expect(again.stale).toBe(false);
        expect(turnsOf(again)).toEqual(turnsOf(await win({ budget: BUDGET })));
        // 带游标时预算被忽略：给个 0 也照样取那一段，而不是退全量
        expect(turnsOf(again).length).toBeLessThan(TURNS);
    }, 60_000);

    it("失效游标（伪造 token）→ stale + 退全量，绝不把两段历史缝在一起", async () => {
        const bad = await win({ cursor: "这不是游标-乱写的", budget: BUDGET });
        expect(bad.stale).toBe(true);
        expect(turnsOf(bad)).toEqual(allTurns); // 退全量（可见的降级，不是错位的窗口）
        expect(bad.hasMore).toBe(false); // 起点 = 文件头
    }, 60_000);

    it("预算缺省 / 0 → 全量（漏传预算绝不静默截断到单轮）", async () => {
        expect(turnsOf(await win())).toEqual(allTurns);
        expect(turnsOf(await win({ budget: 0 }))).toEqual(allTurns);
        expect(turnsOf(await win({ budget: -1 }))).toEqual(allTurns);
    }, 60_000);

    it("覆盖写（改造文件前缀）后旧游标失效 → stale + 重取全量", async () => {
        // 同长度改写：尺寸看不出来，只有前缀指纹变了 —— 正是 290 折叠整文件覆盖写的场景
        writeFileSync(fp, readFileSync(fp, "utf-8").replace("第1轮问题", "第1轮问题改写"), "utf-8");
        const r = await win({ cursor: seg1, budget: BUDGET });
        expect(r.stale).toBe(true);
        expect(turnsOf(r)).toEqual(allTurns);
        expect(JSON.stringify(r.ops)).toContain("第1轮问题改写");
    }, 60_000);
});

describe("大会话分页：渲染端（真实 UI）", () => {
    it("首载只渲染最近一段，顶部露出「上滚加载更早的消息」", async () => {
        await ui.bringToFront();
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await waitUntil(a11yText, (t) => t.includes(`第${TURNS}轮问题`), { label: "最新一轮上屏" });
        const ids = await domTurns();
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.length).toBeLessThan(TURNS); // 分页真的接到了渲染端（不是整份铺上去）
        expect(await ui.query<boolean>(`document.body.textContent.includes("上滚加载更早的消息")`)).toBe(true);
    }, 60_000);

    it("滚到顶 → 补出更早的轮；位置补偿让正在看的那一行纹丝不动", async (ctx) => {
        if (await skipIfHidden(ctx)) return;
        const before = await domTurns();
        const anchor = before[0]!;
        const probe = () =>
            ui.query<{ top: number; scrollTop: number; scrollHeight: number; vis: string }>(
                `(() => { const el = document.querySelector('.diy-chat');` +
                    ` const a = document.querySelector('[data-turn-id="${anchor}"]');` +
                    ` const r = a.getBoundingClientRect();` +
                    ` return { top: Math.round(r.top), scrollTop: Math.round(el.scrollTop),` +
                    ` scrollHeight: Math.round(el.scrollHeight), vis: document.visibilityState }; })()`,
            );

        // 触发 + 取「前插之前」的锚点位置在**同一次 eval**里做完：loadOlder 走的是 RPC，
        // 跨一次往返取基线就有机会落在补偿之后，那样断言恒真、什么都没测到。
        const p0 = await ui.query<{ top: number; scrollTop: number; vis: string }>(
            `(() => { const el = document.querySelector('.diy-chat');` +
                ` el.scrollTop = 0; el.dispatchEvent(new Event('scroll'));` +
                ` const a = document.querySelector('[data-turn-id="${anchor}"]');` +
                ` const r = a.getBoundingClientRect();` +
                ` return { top: Math.round(r.top), scrollTop: Math.round(el.scrollTop), vis: document.visibilityState }; })()`,
        );
        expect(p0.vis).toBe("visible"); // 上面已按可见性提前跳过，走到这里必为 visible

        await waitUntil(domTurns, (ids) => ids.length > before.length, { label: "上滚补出更早的轮" });
        // 补偿在 rAF 兜底里收尾，等一帧再量
        await new Promise((r) => setTimeout(r, 200));
        const p1 = await probe();
        expect(p1.scrollHeight).toBeGreaterThan(0);
        // 补偿 = 「距底距离」不变 ⇒ 锚点的屏幕坐标不动（前插把内容顶下去多少，就推回多少）
        expect(Math.abs(p1.top - p0.top)).toBeLessThanOrEqual(2);
        // 且补的是**更早**的轮：老段没被动过（锚点仍在），段数变多
        const ids = await domTurns();
        expect(ids).toContain(anchor); // 锚点仍在窗口里（用户正看着它）
        // ##301：DOM 只挂视口附近一段 ⇒「轮数变多」不再等价于「补出了更早的轮」；
        // 判据换成**窗口第一行落到了更早的轮**（内容真的往上扩了）。
        expect(allTurns.indexOf(ids[0]!)).toBeLessThan(allTurns.indexOf(anchor));
    }, 60_000);

    it("补段途中用户继续上滚：补段完成后视口仍停在用户滚到的地方（不被拽回）", async (ctx) => {
        if (await skipIfHidden(ctx)) return;
        const before = await domTurns();
        // 「触发 → 让出一个 task（RPC 必未回）→ 继续上滚到顶」：后一段滚动**必定**落在
        // RPC 在途期间（旧实现按触发那一刻的位置重算补偿，会把这段滚动吞掉）。
        await ui.query(
            `(async () => { const el = document.querySelector('.diy-chat');` +
                ` el.scrollTop = 239; el.dispatchEvent(new Event('scroll'));` +
                ` await new Promise((r) => setTimeout(r, 0));` +
                ` el.scrollTop = 0; el.dispatchEvent(new Event('scroll'));` +
                ` return 'ok'; })()`,
        );
        // 记下「用户滚到顶」那一刻他看到的**第一行**及其屏幕位置（补段后要回到这里）
        const p0 = await ui.query<{ first: string | null; top: number }>(
            `(() => { const el = document.querySelector('.diy-chat');` +
                ` const f = el.querySelector('[data-turn-id]');` +
                ` return { first: f?.getAttribute('data-turn-id') ?? null,` +
                ` top: f ? Math.round(f.getBoundingClientRect().top) : 0 }; })()`,
        );
        expect(p0.first).toBeTruthy();
        const earlier = async () => {
            const ids = await domTurns();
            return allTurns.indexOf(ids[0] ?? "") < allTurns.indexOf(before[0]!);
        };
        await waitUntil(earlier, (v) => v, { label: "上滚补出更早的轮" });
        await new Promise((r) => setTimeout(r, 300));
        // 显式要求真的补了段（否则下面「位置没变」在"什么都没发生"时也恒真）
        expect(await earlier()).toBe(true);
        const p1 = await ui.query<{ top: number | null }>(
            `(() => { const f = document.querySelector('[data-turn-id="${p0.first}"]');` +
                ` return { top: f ? Math.round(f.getBoundingClientRect().top) : null }; })()`,
        );
        // ##301：那一行必须**仍在窗口里**（被摘出 = 视口已被新内容顶走），且屏幕位置不变。
        expect(p1.top).not.toBeNull();
        expect(Math.abs((p1.top ?? 0) - p0.top)).toBeLessThanOrEqual(4);
    }, 60_000);

    it("上滚到头：补到文件头（提示退场），DOM 仍只挂视口附近一段（##301）", async () => {
        const hasOlder = () => ui.query<boolean>(`document.body.textContent.includes("上滚加载更早的消息")`);
        // 一段一段往上补，直到没有更早的（提示行随之消失）
        for (let i = 0; i < TURNS + 2 && (await hasOlder()); i++) {
            await ui.query(
                `(() => { const el = document.querySelector('.diy-chat');` +
                    ` el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); return 'ok'; })()`,
            );
            await new Promise((r) => setTimeout(r, 400));
        }
        // 补到文件头了（提示退场、main 说没有更早的）
        expect(await hasOlder()).toBe(false);
        // ##301：DOM 里**只有视口附近一段** ⇒ "所有轮都进 DOM"不再成立；改成验
        // 「窗口里的轮是时间序上的**连续一段**」（DOM 序 = 时间序，不许错位/乱序）
        const win = await domTurns();
        expect(win.length).toBeGreaterThan(0);
        expect(win.length).toBeLessThan(TURNS);
        const i0 = allTurns.indexOf(win[0]!);
        expect(i0).toBeGreaterThanOrEqual(0);
        expect(win).toEqual(allTurns.slice(i0, i0 + win.length));
        // 且**滚到顶**能看到最早那一轮（补出来的历史真的可读）
        await ui.query(
            `(() => { const el = document.querySelector('.diy-chat');` +
                ` el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); return 'ok'; })()`,
        );
        await new Promise((r) => setTimeout(r, 300));
        expect((await domTurns())[0]).toBe(allTurns[0]);
    }, 120_000);

    /**
     * review1 R5：补段原先**只有** `onScroll` 一条触发路。若首载窗口的渲染高度 ≤ 视口，
     * 用户根本滚不出 scroll 事件 ⇒ 补段永不发生、而提示条一直挂着 = **死角**。
     *
     * 造这个前提的办法：**先把视口拉高**（窗口撑不满一屏），**再首次进入会话** ——
     * 顺序不能反：先进入再拉高时，容器会从已滚动的位置被 clamp 回 0，**那一下就会派发
     * 一次 scroll**、走滚动路径把段补掉，就测不到"点也能补"了。故本用例用**独立会话**，
     * 且排在最后（它会切走当前 tab）。
     */
    it("窗口不满一屏时点顶部提示条：照样补出更早的轮（补段不再只有滚动一条路）", async () => {
        const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/clickolder --label 点击补段`);
        const pid = String((p.data as any)?.data?.id);
        const t = await fx.sh.getJson(`./diy.sh task create "点击补段" ${pid}`);
        const uri2 = String((t.data as any)?.data?.uri);
        const fp2 = join(fx.HOME, "local", basename(opsFile(uri2)));
        mkdirSync(dirname(fp2), { recursive: true });
        // 8 轮 ≈ 5.6MB ⇒ 2 段（首载 4MB 一段，剩下的一段等点击）
        writeFileSync(fp2, buildOps(8), "utf-8");

        await ui.setViewport(1280, 3000); // 拉高：让"窗口不满一屏"成为既定前提
        try {
            await fx.sh.getJson(`./diy.sh ui tab open ${uri2}`);
            await waitUntil(domTurns, (ids) => ids.length > 0, { label: "新会话首载上屏" });
            await new Promise((r) => setTimeout(r, 300));
            const before = await domTurns();
            const m = await ui.query<{ scrollHeight: number; clientHeight: number; scrollTop: number }>(
                `(() => { const el = document.querySelector('.diy-chat');` +
                    ` return { scrollHeight: Math.round(el.scrollHeight), clientHeight: Math.round(el.clientHeight),` +
                    ` scrollTop: Math.round(el.scrollTop) }; })()`,
            );
            // 前提自证：**不可滚**（内容撑不满视口）⇒ 用户造不出 scroll 事件 ⇒
            // 接下来新出现的轮只可能来自那次点击。前提不成立就**跳过**而不是假绿。
            if (m.scrollHeight > m.clientHeight + 1) {
                console.warn(
                    `[##293] 跳过点击补段用例：窗口仍可滚（scrollHeight=${m.scrollHeight} > clientHeight=${m.clientHeight}），` +
                        `"滚不出 scroll 事件"这个死角前提没造出来`,
                );
                return;
            }
            expect(before.length).toBeGreaterThan(0);
            expect(before.length).toBeLessThan(8); // 首载确实只铺了一段
            expect(await ui.query<boolean>(`!!document.querySelector('[data-load-older]')`)).toBe(true);

            await ui.clickSelector("[data-load-older]"); // 真实鼠标手势

            await waitUntil(domTurns, (ids) => ids[0] === "t3001", {
                label: "点提示条补出更早的轮",
                timeoutMs: 15_000,
            });
            const after = await domTurns();
            // ##301：DOM 只挂视口附近一段 ⇒「到齐」的判据是**最早那一轮进了窗口**，
            // 而不是「8 轮全在 DOM」。
            expect(after[0]).toBe("t3001");
            // 全程没有被"弹"到别处：不可滚的容器里 scrollTop 恒为 0
            const st = await ui.query<{ st: number }>(
                `(() => ({ st: Math.round(document.querySelector('.diy-chat').scrollTop) }))()`,
            );
            expect(st.st).toBe(0);
        } finally {
            await ui.clearViewport();
        }
    }, 120_000);
});
