// tests/cli.intent.steer-ui.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 插话（steer）的**界面**契约 —— 真实 renderer + 桩上游
//
// 需求（用户原话的界面部分）：
//   · 生成中能打字并插嘴；「停止」按钮不变，输入框有内容时**多出**两个按钮：
//     「插到下一步」「插到下一轮」
//   · 提交的插话显示在聊天窗口上方一行待发送横条，可取消，并标明投递时机
//   · 插话必须持久化（进程重启/换模式后仍在）
//
// 为什么需要桩上游：两个插话按钮**只在生成中**出现（`Show when={running}`），
// 而 running 来自一条真的在跑的 LLM 流。真实 zen/go 既不稳定也不可控（何时来 token 由上游决定），
// 断言必然假红。桩（本地 HTTP，SSE 挂着不回）让"生成中"变成一个可自由保持的状态。
// 落盘/契约层由 cli.intent.agent-local.test.ts 与 tests/core/* 覆盖，本文件只管界面。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

// ─── 桩上游：把"生成中"变成可控状态 ───────────────────

interface Stub {
    url: string;
    /** 收到的每个请求的 body（按到达顺序） */
    requests: Array<Record<string, unknown>>;
    /** 放开第 i 个挂起的请求（缺省全部）：回一段合法终止事件并结束响应 */
    release(index?: number): void;
    /** 挂起的响应数 */
    pending(): number;
    close(): Promise<void>;
}

/** responses 面（默认模型 gpt-5.6-luna）的终止事件；写法与 local-agent 的预览桩一致 */
const RESPONSES_DONE = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: "stub", object: "response", status: "completed", output: [], usage: null },
})}\n\n`;

async function startStub(): Promise<Stub> {
    const requests: Array<Record<string, unknown>> = [];
    const held: Array<{ res: import("node:http").ServerResponse; path: string }> = [];
    const server: Server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            try {
                requests.push(JSON.parse(raw) as Record<string, unknown>);
            } catch {
                requests.push({ __unparsed: raw });
            }
            // SSE 头先发出去（流已经"开始"），内容挂着 —— 客户端处于流式等待中 = UI 的 running
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(": stub waiting\n\n");
            held.push({ res, path: req.url ?? "" });
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        pending: () => held.length,
        release(index) {
            const targets = index === undefined ? held.splice(0) : held.splice(index, 1);
            for (const h of targets) {
                h.res.write(h.path.endsWith("/responses") ? RESPONSES_DONE : "data: [DONE]\n\n");
                h.res.end();
            }
        },
        close: () =>
            new Promise<void>((r) => {
                for (const h of held.splice(0)) h.res.end();
                server.close(() => r());
            }),
    };
}

// ─── 夹具 ─────────────────────────────────────────────

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let stub: Stub;
let uri = "";
let ui: UiDriver;

beforeAll(async () => {
    stub = await startStub();
    // 桩上游 + 占位 key：main 侧 chat() 会校验 key 存在，桩不看 key 的值
    process.env["OPENCODE_ZEN_API_KEY"] ||= "intent-test-dummy-key";
    process.env["DIY_ZEN_BASE_URL"] = stub.url;
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
    const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/steer-ui --label SteerUI`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 插话界面 ${pid}`);
    uri = String((t.data as any)?.data?.uri);
}, 120_000);

afterAll(async () => {
    ui?.close();
    await stub?.close();
    await fx?.electron?.stop();
});

/** a11y 树文本（ui inspect 才是 DOM 树；ui tree 是任务树） */
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

/**
 * 点**按钮**（按文本，但限定 role=button）。
 *
 * 为什么不能只按文本：横条出现后，标题「⏳ 待发送插话 1 条」里就含「发送」二字，
 * 而 ui-drive 的文本匹配取的是**文档序第一个**命中节点 —— 会点到横条标题上，
 * 表现为「点了发送没反应」。真实用户点的是按钮，测试也必须点到按钮。
 */
const clickButton = (text: string) =>
    ui.click((t, node) => node.role === "button" && t.includes(text));

/** 草稿文件（插话与聊天草稿同文件：任务目录 .diy/drafts.yaml） */
const draftsFile = () => join(fx.HOME, uri, ".diy", "drafts.yaml");
const draftsRaw = () => (existsSync(draftsFile()) ? readFileSync(draftsFile(), "utf-8") : "");

describe("插话界面 —— 生成中插嘴、横条、取消", () => {
    it("setup: 任务执行页打开对话视图", async () => {
        ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
            const r = await fx.sh.getJson("./diy.sh ui inspect");
            return (r.data as any)?.data?.tree as A11yNode | undefined;
        });
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await fx.sh.getJson(`./diy.sh ui view set chat.local open --ctx ${uri}`);
        const text = await waitUntil(a11yText, (s) => s.includes("发送"), { label: "对话页就位" });
        expect(text).toContain("发送");
        // 没在生成：不该出现插话按钮（它们只在生成中有意义）
        expect(text).not.toContain("停止");
        expect(text).not.toContain("插到下一步");
    });

    it("非生成态：打字只有「发送」，没有插话按钮", async () => {
        await ui.clickSelector(".cm-content");
        await ui.type("先问个问题");
        const text = await waitUntil(a11yText, (s) => s.includes("发送"), { label: "输入框有内容" });
        expect(text).toContain("发送");
        expect(text).not.toContain("插到下一步");
        expect(text).not.toContain("插到下一轮");
    });

    it("点「发送」→ 进入生成中（桩上游挂着不回）：停止在、插话按钮仍未出现（此时输入框空）", async () => {
        await clickButton("发送");
        const running = await waitUntil(a11yText, (s) => s.includes("停止"), { label: "进入生成中" });
        expect(running).toContain("停止");
        // 上游确实收到了请求（桩记录）
        expect(stub.requests.length).toBe(1);
        // 输入框已清空 → 没有可插的内容 → 两个插话按钮按设计不出现（不占位）
        expect(running).not.toContain("插到下一步");
        expect(running).not.toContain("插到下一轮");
        // 没有排队插话 → 横条不渲染（不做空条常驻）
        expect(running).not.toContain("待发送插话");
    });

    it("生成中打字 → 多出「插到下一步 / 插到下一轮」，「停止」保持不变", async () => {
        await ui.clickSelector(".cm-content");
        await ui.type("插一句：记得跑测试");
        const text = await waitUntil(a11yText, (s) => s.includes("插到下一步"), { label: "插话按钮出现" });
        expect(text).toContain("插到下一步");
        expect(text).toContain("插到下一轮");
        // 「停止」仍在（功能没被顶掉），「发送」不在（生成中不该又能发一条）
        expect(text).toContain("停止");
        expect(text).not.toContain("发送");
    });

    it("点「插到下一步」→ 上方横条出现该条 + 标注投递时机 + 已落盘", async () => {
        await clickButton("插到下一步");
        const text = await waitUntil(a11yText, (s) => s.includes("待发送插话"), { label: "横条出现" });
        expect(text).toContain("插一句：记得跑测试");
        expect(text).toContain("下一步后"); // 模式徽标（说人话，不是内部枚举 step）
        // 输入框已清空 → 插话按钮随之收起（没内容就没得插）
        expect(text).not.toContain("插到下一步");
        expect(text).not.toContain("插到下一轮");
        // 持久化：真落在任务目录里，而非只活在内存
        expect(draftsRaw()).toContain("插一句：记得跑测试");
        expect(draftsRaw()).toContain("mode: step");
        // 契约层看到同一条（UI 与服务端同源）
        const list = await fx.sh.getJson(`./diy.sh agent local steer list ${uri}`);
        expect((list.data as any[]).map((i) => i.text)).toEqual(["插一句：记得跑测试"]);
    });

    it("再插一条「插到下一轮」→ 两条并存、各自标注时机", async () => {
        await ui.clickSelector(".cm-content");
        await ui.type("再做一件事");
        await waitUntil(a11yText, (s) => s.includes("插到下一轮"), { label: "按钮再现" });
        await clickButton("插到下一轮");
        const text = await waitUntil(a11yText, (s) => s.includes("下一轮后"), { label: "第二条进横条" });
        expect(text).toContain("插一句：记得跑测试");
        expect(text).toContain("再做一件事");
        expect(text).toContain("下一步后");
        expect(text).toContain("下一轮后");
    });

    it("点横条上的 ✕ → 该条被取消（另一条不受影响）", async () => {
        const before = await fx.sh.getJson(`./diy.sh agent local steer list ${uri}`);
        expect(before.data).toHaveLength(2);
        // ✕ 的 aria-label 是「取消这条插话」：按 DOM 定位（a11y 树里只有 ✕ 字符，两条会重名）
        await ui.clickSelector('button[aria-label="取消这条插话"]');
        const text = await waitUntil(a11yText, (s) => !s.includes("插一句：记得跑测试"), {
            label: "第一条被取消",
        });
        expect(text).toContain("再做一件事");
        const after = await fx.sh.getJson(`./diy.sh agent local steer list ${uri}`);
        expect((after.data as any[]).map((i) => i.text)).toEqual(["再做一件事"]);
    });

    it("「停止」照旧能中断（按钮不变；被中断的轮次不投递插话）", async () => {
        await clickButton("停止");
        await waitUntil(a11yText, (s) => !s.includes("停止"), { label: "生成已停止" });
        // 本轮被中断 → turn 插话没被投递：仍排在队列里（横条继续显示待发送）
        const list = await fx.sh.getJson(`./diy.sh agent local steer list ${uri}`);
        expect((list.data as any[]).map((i) => i.text)).toEqual(["再做一件事"]);
        expect(await a11yText()).toContain("待发送插话");
    });

    it("插话被投递后横条自动下架（模型看见后不再挂着「待发送」）", async () => {
        // 再从界面发起一轮（顺带验证「停止之后仍能正常输入并发送」这条真实路径）
        await ui.clickSelector(".cm-content");
        await ui.type("再聊一句");
        expect(await ui.query<string>("document.querySelector('.cm-content')?.textContent ?? ''")).toContain(
            "再聊一句",
        );
        await clickButton("发送");
        await waitUntil(a11yText, (s) => s.includes("停止"), { label: "新一轮跑起来" });

        // 放开桩响应 → 本轮收尾 → 轮末取走 turn 插话并开新一轮（新一轮请求再次被桩挂住）
        stub.release();
        const text = await waitUntil(a11yText, (s) => !s.includes("待发送插话"), {
            label: "投递后横条消失",
            timeoutMs: 20_000,
        });
        expect(text).not.toContain("待发送插话");
        // 服务端视角同源：队列真的空了（不是界面自己藏起来）
        const list = await fx.sh.getJson(`./diy.sh agent local steer list ${uri}`);
        expect(list.data).toEqual([]);

        // 投递留下的是对话流里的 user 块（带插话标记）+ 自动续起来的下一轮
        const flow = await waitUntil(a11yText, (s) => s.includes("⤵ 插话") && s.includes("停止"), {
            label: "插话进对话流且续起下一轮",
            timeoutMs: 30_000,
        });
        expect(flow).toContain("再做一件事");
        expect(flow).toContain("下一轮后"); // 标记说出投递时机
    }, 120_000); // 本用例要跑完「一轮收尾 → 自动续轮」，且每次断言都要一次 CLI 往返：给足预算
});
