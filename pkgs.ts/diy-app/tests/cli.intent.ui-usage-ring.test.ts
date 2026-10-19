// tests/cli.intent.ui-usage-ring.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 聊天输入区「上下文窗口圆环」的比例（##354 ②）—— 真实 renderer + 桩上游
//
// 回归对象（真机症状，##87 的 158 条原文）：「占用 9% 却画出约 60% 弧长」—— 百分比**文字**
// 是最新的，**弧长**却停在挂载那一刻的值，两者不一致。
//
// 根因（读编译产物可证）：`RingBar` 把 `--value` 的样式串算在**组件体外**，
// 而 Solid 的组件体只执行一次 ⇒ 该串被冻在挂载帧（那时 `trees` 可能还是上一个会话的）。
// 文字是响应式插值，于是只有它跟着走。修法：`style={ringStyle(...)}` 在 JSX 里现算。
//
// 本用例怎么把它钉死：先让页面**挂载时看到 60%**（种一份 60% 的历史），再跑一轮真轮次把窗口
// 占用压到 ~1% —— 冻住的那个实现会停在 60%（弧长 ≠ 文字），修好的实现两者恒等。
// 断言只看**同一时刻**的「文字 vs 弧长」，不比绝对值（绝对值随桩的 token 数走）。
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

const NL = String.fromCharCode(10);

// ─── 桩上游（chat 面 SSE，末帧带 usage）─────────────────

/** 桩报告的窗口占用：10000 / 1048576 ≈ 1%（与种子的 60% 明显不同，任何"没跟上"都看得出来） */
const STUB_PROMPT_TOKENS = 10_000;
const STUB_COMPLETION_TOKENS = 120;

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>) =>
    `data: ${JSON.stringify({
        id: "stub",
        object: "chat.completion.chunk",
        created: 0,
        model: "stub",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
    })}\n\n`;

interface Stub {
    url: string;
    close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
    const server: Server = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(chatChunk({ role: "assistant" }));
            for (const line of ["桩上游正文第 1 行", "桩上游正文第 2 行"]) res.write(chatChunk({ content: `${line}${NL}` }));
            res.write(
                chatChunk({}, "stop", {
                    prompt_tokens: STUB_PROMPT_TOKENS,
                    completion_tokens: STUB_COMPLETION_TOKENS,
                    total_tokens: STUB_PROMPT_TOKENS + STUB_COMPLETION_TOKENS,
                    prompt_tokens_details: { cached_tokens: 8000 },
                }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ─── 夹具 ─────────────────────────────────────────────

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let stub: Stub;
let ui: UiDriver;
let uri = "";

beforeAll(async () => {
    stub = await startStub();
    process.env["OPENCODE_API_KEY"] ||= "intent-test-dummy-key";
    process.env["DIY_ZEN_BASE_URL"] = stub.url;
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
    const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/ring --label 圆环`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 圆环比例 ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    seedSixtyPercentTurn(uri);
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

/**
 * 种一轮「窗口占用 60%」的历史（UI 打开时走 historyWindow 读它）。
 * turnId 取**过去的固定时刻**：`currentWindow` 取 id 最大的轮，后续真轮次必须比它新。
 */
function seedSixtyPercentTurn(taskUri: string): void {
    const tid = "t1767225600000"; // 2026-01-01
    const usage = {
        inputTotal: 600000, outputTotal: 100, cacheRead: 500000, total: 600100, noCache: 100000,
        cacheWrite: null, text: 70, reasoning: 30, windowTotal: 600100, lastInputTotal: 600000,
        lastOutputTotal: 100, steps: 1, lastStepRate: 120.5, contextLimit: 1000000,
        cost: { noCache: 0.014, cacheRead: 0.0014, cacheWrite: null, text: 0.00002, reasoning: 0.000008, total: 0.015428 },
    };
    const o = (v: unknown) => JSON.stringify(v);
    const lines = [
        o({ op: "start", id: tid, kind: "turn", meta: { model: "mimo-v2.6-flash" } }),
        o({ op: "start", id: `${tid}_u`, kind: "text", parent: tid, meta: { role: "user" } }),
        o({ op: "delta", id: `${tid}_u`, fields: { content: "种子问题：窗口占用 60.0%" } }),
        o({ op: "stop", id: `${tid}_u` }),
        o({ op: "start", id: `${tid}_a`, kind: "text", parent: tid, meta: { role: "assistant" } }),
        o({ op: "delta", id: `${tid}_a`, fields: { content: "种子回答。" } }),
        o({ op: "stop", id: `${tid}_a` }),
        o({ op: "patch", id: tid, fields: { usage } }),
        o({ op: "stop", id: tid }),
    ];
    const fp = join(fx.HOME, sessionFileRel(taskUri, "ops"));
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, `${lines.join(NL)}${NL}`, "utf-8");
}

/** 圆环探针：文字百分比 + 弧长百分比（从 ::before 的 conic-gradient 解析）+ `--value` */
const ringProbe = () =>
    ui.query<{ text: string; arc: number | null; val: string } | null>(
        `(() => { const b = document.querySelector('[aria-label^="窗口占用"]'); if (!b) return null;` +
            ` const rs = [...b.querySelectorAll('.radial-progress')]; const el = rs[rs.length - 1];` +
            ` const bg = getComputedStyle(el, '::before').backgroundImage;` +
            ` const seg = bg.slice(bg.indexOf('conic-gradient'));` +
            ` const m = seg.match(/([0-9.]+)%/);` +
            ` return { text: b.textContent.trim(), arc: m ? Number(m[1]) : null, val: el.style.getPropertyValue('--value') }; })()`,
    );

/**
 * 等「文字与弧长一致」。
 *
 * ⚠️ daisyUI 的 `.radial-progress` 带 `transition: --radialprogress .3s linear`：`--value` 立刻是
 * 新值，**计算出来的** conic-gradient 会花 0.3s 追上去 —— 所以判据必须是"追平后仍一致"，
 * 而不是"读一次就相等"（第一版就是这么假红的：读到动画途中的 6.4%）。
 * 冻住弧长的实现永远追不平 ⇒ 这里到上限即报错（正是回归要抓的）。
 */
const waitArcConsistent = async (ok: (textPct: number) => boolean) => {
    const consistent = (v: { text: string; arc: number | null } | null): boolean => {
        if (!v) return false;
        const textPct = Number(v.text.replace("%", ""));
        if (!Number.isFinite(textPct)) return false;
        if (v.arc == null || Math.abs(v.arc - textPct) > 0.6) return false;
        return ok(textPct);
    };
    // 注意：waitUntil 到上限**不抛错**（交回末次值，见 wait.ts）—— 一致性判据在此显式复检，
    // 好让失败信息带上"最后一次读到的文字/弧长"，而不是干巴巴一句超时。
    const r = await waitUntil(ringProbe, consistent, { label: "弧长与文字一致", timeoutMs: 20_000 });
    if (!consistent(r)) {
        throw new Error(`弧长与文字不一致（或未上屏）；最后一次读到 ${JSON.stringify(r)}`);
    }
    return r as { text: string; arc: number | null; val: string };
};

/** 打开某任务页并等它上屏 */
async function openTask(u: string, marker: string): Promise<void> {
    await fx.sh.getJson(`./diy.sh ui tab open ${u}`);
    await waitUntil(
        () => ui.query<boolean>(`document.body.textContent.includes(${JSON.stringify(marker)})`),
        (v) => v,
        { label: `会话上屏（${marker}）`, timeoutMs: 20_000 },
    );
}

describe("##354 ② 窗口圆环：弧长与百分比同源同刻", () => {
    it("挂载即 60%：文字与弧长一致", async () => {
        await openTask(uri, "种子问题：窗口占用 60.0%");
        const r = await waitArcConsistent((t) => t === 60);
        expect(r.text).toBe("60.0%");
        expect(r.arc).toBeCloseTo(60, 0);
    }, 60_000);

    it("真轮次落地后：弧长跟着新的占比走（修复前冻在 60%）", async () => {
        await fx.sh.run(`./diy.sh agent local chat ${uri} "桩上游测试：回一句" --model mimo-v2.6-flash`, 60_000);
        // 等新轮次的正文上屏（= 这一轮的 usage patch 也已落地）
        await waitUntil(
            () => ui.query<boolean>(`document.body.textContent.includes(${JSON.stringify("桩上游正文第 2 行")})`),
            (v) => v,
            { label: "桩轮次上屏", timeoutMs: 20_000 },
        );
        // 核心断言：弧长跟着新占比走、且与文字一致（修复前弧长冻在 60，这里必然超时）
        const r = await waitArcConsistent((t) => t !== 60 && t < 5);
        const textPct = Number(r.text.replace("%", ""));
        expect(textPct).toBeLessThan(5); // 新占比 ≈ 1%（桩的 10120 / 1.05M）
        expect(r.arc).toBeCloseTo(textPct, 1);
        expect(Number(r.val)).toBeCloseTo(textPct, 1);
    }, 120_000);
});
