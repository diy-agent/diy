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

// 会话规模：16 轮 × ~700KB（大头是 tool 输出）≈ 11MB —— 渲染端首载窗口 4MB（HISTORY_WINDOW_BYTES），
// 上滚补段**也按 4MB**，于是整份 = 3 段：够「首载只有一部分」「滚一次还有更早的」都能在真实 UI 里看见。
// 反例（踩过）：10 轮 / 7MB 时整份只有 2 段，第 3 段不存在 ⇒ 「补段途中继续上滚」那条用例
// 会拿不到段可补，断言退化成恒真（waitUntil 超时警告暴露了它）。
const TURNS = 16;
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
function buildOps(): string {
    const lines: string[] = [];
    const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));
    // 单轮 ~700KB：14,000 行 × 50 字节（多行才可能被折叠，行数与真实工具输出同量级）
    const payload = (i: number) =>
        Array.from({ length: 14_000 }, (_, k) => `第${i}轮第${k}行 tool 输出内容 padding padding`).join("\n");
    for (let i = 1; i <= TURNS; i++) {
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

    it("滚到顶 → 补出更早的轮；位置补偿让正在看的那一行纹丝不动", async () => {
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
        // 补偿时机：同步 + 一帧 rAF（迟到布局兜底）；窗口被完全遮挡时 macOS 会把 visibilityState 打成 hidden
        // ⇒ Chromium 节流 rAF ⇒ 补偿不跑（假红，不是代码错）。bringToFront 已在前一条用例调过。
        expect(p0.vis).toBe("visible");

        await waitUntil(domTurns, (ids) => ids.length > before.length, { label: "上滚补出更早的轮" });
        // 补偿在 rAF 兜底里收尾，等一帧再量
        await new Promise((r) => setTimeout(r, 200));
        const p1 = await probe();
        expect(p1.scrollHeight).toBeGreaterThan(0);
        // 补偿 = 「距底距离」不变 ⇒ 锚点的屏幕坐标不动（前插把内容顶下去多少，就推回多少）
        expect(Math.abs(p1.top - p0.top)).toBeLessThanOrEqual(2);
        // 且补的是**更早**的轮：老段没被动过（锚点仍在），段数变多
        const ids = await domTurns();
        expect(ids).toContain(anchor);
        expect(ids.length).toBeGreaterThanOrEqual(before.length + 1);
    }, 60_000);

    it("补段途中用户继续上滚：用户那一段滚动不被吞（补偿按增量算）", async () => {
        const before = await domTurns();
        const a0 = before[0]!;
        // 「触发 → 让出一个 task（RPC 必未回）→ 继续上滚」在同一次 eval 里做完：
        // 这样用户的后半段滚动**必定**落在 RPC 在途期间（旧实现就是在补偿时
        // 按触发那一刻的位置重算，把这段吞掉）。随手记下两个时刻的锚点屏幕坐标。
        await ui.query(
            `(async () => { const el = document.querySelector('.diy-chat');` +
                ` const a = () => document.querySelector('[data-turn-id="${a0}"]');` +
                ` el.scrollTop = 239; el.dispatchEvent(new Event('scroll'));` +
                ` window.__trigTop = Math.round(a().getBoundingClientRect().top);` +
                ` await new Promise((r) => setTimeout(r, 0));` +
                ` el.scrollTop = 0; el.dispatchEvent(new Event('scroll'));` +
                ` window.__userTop = Math.round(a().getBoundingClientRect().top);` +
                ` return 'ok'; })()`,
        );
        await waitUntil(domTurns, (ids) => ids.length > before.length, { label: "上滚补出更早的轮" });
        // 显式要求真的补了段：没有这一条，下面「位置没变」的断言在"什么都没发生"时也成立
        expect((await domTurns()).length).toBeGreaterThan(before.length);
        await new Promise((r) => setTimeout(r, 250));
        const p = await ui.query<{ top: number; userTop: number; trigTop: number }>(
            `(() => { const a = document.querySelector('[data-turn-id="${a0}"]');` +
                ` return { top: Math.round(a.getBoundingClientRect().top),` +
                ` userTop: window.__userTop, trigTop: window.__trigTop }; })()`,
        );
        // 两个时刻确实不同（否则这条用例什么都没测到）
        expect(Math.abs(p.userTop - p.trigTop)).toBeGreaterThan(100);
        // 补偿后锚点应停在**用户最后停留**的位置，而不是触发那一刻的位置
        expect(Math.abs(p.top - p.userTop)).toBeLessThanOrEqual(2);
    }, 60_000);

    it("上滚到头：所有轮都进 DOM（无重无漏），顶部提示退场", async () => {
        const hasOlder = () => ui.query<boolean>(`document.body.textContent.includes("上滚加载更早的消息")`);
        // 一段一段往上补，直到没有更早的（提示行随之消失）
        for (let i = 0; i < TURNS + 2; i++) {
            const cur = await domTurns();
            if (cur.length >= TURNS) break;
            if (!(await hasOlder())) break;
            await ui.query(
                `(() => { const el = document.querySelector('.diy-chat');` +
                    ` el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); return 'ok'; })()`,
            );
            await waitUntil(domTurns, (v) => v.length > cur.length, {
                label: `第 ${i + 1} 次上滚补段`,
                timeoutMs: 10_000,
            });
        }
        const final = await domTurns();
        expect(final).toEqual(allTurns); // 到齐且按时间序（段是前插的，DOM 序 = 文件序）
        expect(final).toHaveLength(TURNS);
        expect(await hasOlder()).toBe(false); // 到顶 ⇒ 提示退场，不再白跑一次请求
    }, 120_000);
});
