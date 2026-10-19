// tests/cli.intent.ui-chat-read.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 聊天页「阅读体验」三条（##331）—— 真实 renderer + 桩上游
//
//   ① 末条 text 刷出时视口被钉到该块**末行**（要上翻才看得到开头）
//   ② user 发言没有任何日期时间 label（agent 侧有：轮尾状态行 / 轮首署名）
//   ③ 切走再切回任务，阅读行定位丢失（向下偏移几段）
//
// 为什么用桩上游：① 要的是「一条远高于视口的正文被刷出来」这个确定场景，
// 真模型既不稳定也不可控（何时来 token / 来多少由上游决定）；桩让「一次长正文刷出」
// 变成可重复的事实。②③ 与上游无关，桩只是让会话内容形状确定。
//
// 位置断言一律走 `getBoundingClientRect` 相对**滚动容器**（`.diy-chat`），
// 不写死像素 —— 对齐 ##293 的做法（容器在页面里偏下，页面坐标会骗人）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/services/local-agent";

// ─── 桩上游（chat 面 SSE）─────────────────────────────

/** 正文行数与单行长度：撑到远超一屏（视口 ~800px，正文 ~60×24px ≈ 1440px） */
const REPLY_LINES = 60;
const replyText = () =>
    Array.from({ length: REPLY_LINES }, (_, i) => `正文第 ${i + 1} 行：把这一块撑到远超一屏的填充内容。`).join("\n");

interface Stub {
    url: string;
    requests: Array<Record<string, unknown>>;
    close(): Promise<void>;
}

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
        id: "stub",
        object: "chat.completion.chunk",
        created: 0,
        model: "stub",
        choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

async function startStub(): Promise<Stub> {
    const requests: Array<Record<string, unknown>> = [];
    const server: Server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            try {
                requests.push(JSON.parse(raw) as Record<string, unknown>);
            } catch {
                requests.push({ __unparsed: raw });
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(chatChunk({ role: "assistant" }));
            for (const line of replyText().split("\n")) res.write(chatChunk({ content: `${line}\n` }));
            res.write(chatChunk({}, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

// ─── 夹具 ─────────────────────────────────────────────

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let stub: Stub;
let ui: UiDriver;
let uriA = "";
let uriB = "";

beforeAll(async () => {
    stub = await startStub();
    // 桩上游 + 占位 key：main 侧 chat() 校验 key 存在，桩不看它的值（同 cli.intent.steer-ui）
    process.env["OPENCODE_API_KEY"] ||= "intent-test-dummy-key";
    process.env["DIY_ZEN_BASE_URL"] = stub.url;
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
    const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/chat-read --label 阅读体验`);
    const pid = String((p.data as any)?.data?.id);
    const ta = await fx.sh.getJson(`./diy.sh task create 阅读体验A ${pid}`);
    uriA = String((ta.data as any)?.data?.uri);
    const tb = await fx.sh.getJson(`./diy.sh task create 阅读体验B ${pid}`);
    uriB = String((tb.data as any)?.data?.uri);
    seedOps(uriA, 20);
    seedOps(uriB, 3);
    ui = await makeUiDriver(electron.cdpUrl, async () => {
        const r = await fx.sh.getJson("./diy.sh ui inspect");
        return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    await ui.bringToFront();
}, 120_000);

afterAll(async () => {
    ui?.close();
    await stub?.close();
    await fx?.electron?.stop();
});

/** 一轮的 ops：user 一问 + 助理一段 8 行正文（撑高度；turnId 内嵌毫秒 = 时间真源） */
function turnOps(turnId: string, i: number): string[] {
    const body = [`第 ${i} 轮正文开头。`, ...Array.from({ length: 8 }, (_, k) => `第 ${i} 轮第 ${k + 1} 行 padding padding padding`)].join(
        "\n",
    );
    const o = (v: unknown) => JSON.stringify(v);
    return [
        o({ op: "start", id: turnId, kind: "turn", meta: { model: "mimo-v2.6-flash" } }),
        o({ op: "start", id: `${turnId}_u`, kind: "text", parent: turnId, meta: { role: "user" } }),
        o({ op: "delta", id: `${turnId}_u`, fields: { content: `第 ${i} 轮问题` } }),
        o({ op: "stop", id: `${turnId}_u` }),
        o({ op: "start", id: `${turnId}_a`, kind: "text", parent: turnId, meta: { role: "assistant" } }),
        o({ op: "delta", id: `${turnId}_a`, fields: { content: body } }),
        o({ op: "stop", id: `${turnId}_a` }),
        o({ op: "stop", id: turnId }),
    ];
}

/** 种一份历史会话（UI 打开时走 historyWindow 读它） */
function seedOps(taskUri: string, turns: number): void {
    const lines: string[] = [];
    for (let i = 1; i <= turns; i++) lines.push(...turnOps(`t${1790000000000 + i * 1000}`, i));
    const fp = join(fx.HOME, sessionFileRel(taskUri, "ops"));
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, `${lines.join("\n")}\n`, "utf-8");
}

/** a11y 树文本（ui inspect 是 DOM 树；ui tree 是任务树） */
function collectText(nodes: any, acc: string[] = []): string[] {
    for (const n of nodes ?? []) {
        if (n?.text) acc.push(String(n.text));
        if (n?.children) collectText(n.children, acc);
    }
    return acc;
}
async function a11yText(): Promise<string> {
    const res = await fx.sh.getJson("./diy.sh ui inspect");
    return collectText([(res.data as any)?.data?.tree]).join("\n");
}

/** 打开某任务的执行页并等它上屏 */
async function openTask(u: string, marker: string): Promise<void> {
    await fx.sh.getJson(`./diy.sh ui tab open ${u}`);
    await waitUntil(a11yText, (t) => t.includes(marker), { label: `会话上屏（${marker}）`, timeoutMs: 20_000 });
}

/** 滚动容器与「视口顶部那一块」的几何探针（不含块身份，供 ③ 每次现取） */
const chatProbe = () =>
    ui.query<{ cTop: number; cBottom: number; scrollTop: number; scrollHeight: number; clientHeight: number; turns: number }>(
        `(() => { const el = document.querySelector('.diy-chat'); const r = el.getBoundingClientRect();` +
            ` return { cTop: Math.round(r.top), cBottom: Math.round(r.bottom), scrollTop: Math.round(el.scrollTop),` +
            ` scrollHeight: Math.round(el.scrollHeight), clientHeight: Math.round(el.clientHeight),` +
            ` turns: document.querySelectorAll('[data-turn-id]').length }; })()`,
    );

/** 视口顶部那一轮（第一个底边进入容器的轮）+ 它在容器内的相对纵坐标 */
const topTurnProbe = () =>
    ui.query<{ id: string; top: number } | null>(
        `(() => { const el = document.querySelector('.diy-chat'); const c = el.getBoundingClientRect();` +
            ` const turns = [...document.querySelectorAll('[data-turn-id]')];` +
            ` const hit = turns.find((n) => n.getBoundingClientRect().bottom > c.top + 1);` +
            ` if (!hit) return null;` +
            ` return { id: hit.getAttribute('data-turn-id'), top: Math.round(hit.getBoundingClientRect().top - c.top) }; })()`,
    );

describe("##331 聊天页阅读体验", () => {
    it("② user 发言带日期时间 label（与 agent 侧同一格式）", async () => {
        await openTask(uriB, "第 3 轮问题");
        const stamps = await waitUntil(
            () =>
                ui.query<string[]>(
                    `[...document.querySelectorAll('[data-user-stamp]')].map((e) => e.textContent.trim())`,
                ),
            (v) => v.length > 0,
            { label: "user 气泡的时间 label", timeoutMs: 10_000 },
        );
        expect(stamps.length).toBe(3);
        for (const s of stamps) expect(s).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
        // 与 agent 侧同一格式（复用 fmtTurnStamp）：轮尾状态行的时刻也是一模一样的形状
        const text = await a11yText();
        expect(text).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    }, 60_000);

    it("① 末条 text 刷出后不钉末行：这条正文的开头仍可读", async () => {
        await openTask(uriA, "第 20 轮问题");
        const before = await chatProbe();
        expect(before.turns).toBeGreaterThan(3);
        await fx.sh.run(`./diy.sh agent local chat ${uriA} "给一条长结论" --model mimo-v2.6-flash`, 60_000);
        expect(stub.requests.length).toBeGreaterThan(0);
        // 等这一轮的正文上屏（桩的 60 行）并让布局稳定。
        // ⚠️ 用 DOM 文本而不是 a11y 树：a11y 树对超长正文有截断/合并，实测匹配不到末行
        //（第一版就踩了：断言拿到了位置，却先白等满 20s 超时）。
        await waitUntil(
            () => ui.query<boolean>(`document.body.textContent.includes(${JSON.stringify("正文第 60 行")})`),
            (v) => v,
            { label: "长正文上屏", timeoutMs: 20_000 },
        );
        await new Promise((r) => setTimeout(r, 800));
        // 测**这一轮的正文块**（末尾那一片叶子）：轮首的 user 气泡在它上面，
        // 判"能不能读到开头"必须锚在正文本身（第一版锚在轮内第一个块上，读到的其实是气泡）。
        const m = await ui.query<{ cTop: number; cBottom: number; textTop: number; text: string }>(
            `(() => { const el = document.querySelector('.diy-chat'); const c = el.getBoundingClientRect();` +
                ` const turns = [...document.querySelectorAll('[data-turn-id]')]; const last = turns[turns.length - 1];` +
                ` const blocks = [...last.querySelectorAll('[data-block-id]')];` +
                ` const block = blocks[blocks.length - 1];` +
                ` return { cTop: Math.round(c.top), cBottom: Math.round(c.bottom),` +
                ` textTop: Math.round(block.getBoundingClientRect().top),` +
                ` text: (block.textContent ?? '').slice(0, 40) }; })()`,
        );
        expect(m.text).toContain("正文第 1 行"); // 前提自证：锚到的是桩那条正文
        // 正文的开头必须在视口里（期望「从屏幕下方自然延续」；旧实现是钉在末行 ⇒ 首行被推到视口上方 265px）
        expect(m.textTop).toBeGreaterThanOrEqual(m.cTop - 2);
        expect(m.textTop).toBeLessThan(m.cBottom);
    }, 120_000);

    it("③ 切走再切回：视口顶部仍是同一块（容差 2px）", async () => {
        await openTask(uriA, "第 20 轮问题");
        const el = await chatProbe();
        expect(el.scrollHeight).toBeGreaterThan(el.clientHeight + 200); // 前提自证：可滚
        // 滚到中间（不贴底）：上翻阅读的人不该被跟随打扰
        await ui.query(
            `(() => { const el = document.querySelector('.diy-chat');` +
                ` el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.45);` +
                ` el.dispatchEvent(new Event('scroll')); return 1; })()`,
        );
        await new Promise((r) => setTimeout(r, 300));
        const before = await topTurnProbe();
        expect(before).not.toBeNull();
        // 切走 → 切回
        await openTask(uriB, "第 3 轮问题");
        await openTask(uriA, "第 20 轮问题");
        // 恢复后要留出高度稳定（content-visibility 实测高度回填 / Markdown 撑高）的时间
        await new Promise((r) => setTimeout(r, 800));
        const after = await topTurnProbe();
        console.error(`[##331 ③] 视口顶部块：切走前=${JSON.stringify(before)} 切回后=${JSON.stringify(after)}`);
        expect(after).not.toBeNull();
        expect(after!.id).toBe(before!.id);
        expect(Math.abs(after!.top - before!.top)).toBeLessThanOrEqual(2);
    }, 120_000);

    // review1 R1：恢复锚点后会连校几帧（高度估算值换实测值会挪位置）。旧实现在"发现用户在滚"
    // 那一帧只更新基准、**没 latch** ⇒ 用户滚完停手的下一帧就被 drift 推回锚点（与注释"绝不抢"相反）。
    // 这里在**连校窗口内**由用户自己跳到顶部，然后看它会不会被拽回锚点。
    it("③R1 恢复窗口内用户自己滚动 → 不被拉回锚点（review1 R1）", async () => {
        await openTask(uriA, "第 20 轮问题");
        await ui.query(
            `(() => { const el = document.querySelector('.diy-chat');` +
                ` el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.75);` +
                ` el.dispatchEvent(new Event('scroll')); return 1; })()`,
        );
        await new Promise((r) => setTimeout(r, 300));
        const anchor = await topTurnProbe();
        expect(anchor).not.toBeNull();
        // 切走 → 切回：restore 开始按锚点定位，连校窗口随之打开
        await openTask(uriB, "第 3 轮问题");
        await openTask(uriA, "第 20 轮问题");
        // 窗口内**立刻**由用户自己往上跳（这是"用户接管"的硬证据，不看时序巧合）
        await ui.query(
            `(() => { const el = document.querySelector('.diy-chat'); el.scrollTop = 0;` +
                ` el.dispatchEvent(new Event('scroll')); return 1; })()`,
        );
        await new Promise((r) => setTimeout(r, 900));
        const after = await chatProbe();
        const top = await topTurnProbe();
        console.error(`[##331 ③R1] 锚点=${JSON.stringify(anchor)} 用户跳顶后=${JSON.stringify(after)} 顶部块=${JSON.stringify(top)}`);
        expect(after.scrollTop).toBeLessThanOrEqual(2); // 用户到顶了（不是被拽回 75% 处）
        expect(top!.id).not.toBe(anchor!.id); // 也没停在锚点那一轮
    }, 120_000);
});
