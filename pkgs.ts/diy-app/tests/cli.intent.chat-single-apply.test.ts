// tests/cli.intent.chat-single-apply.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 会话实时输出的**叠字回归**（任务 ##327）—— 真实 renderer + 桩上游
//
// 需求（用户实测现场）：一轮含多段 delta 的对话，**UI 文本与 ops.jsonl 逐字一致**，
// 不许出现「大王大王，，先把现场先把现场看清楚看清楚。」这种整段 ×2。
//
// 为什么用桩上游而不是真模型：本用例量的是**渲染端一次也没多落地**，
// 与模型强弱无关；真模型的 delta 切分时机不可控（断言会假红），桩可以把
// "一段话被切成 5 个 delta" 这件事变成确定的输入。
//
// 为什么必须是**界面**用例：main 的 chat 流与 opsWatch 订阅都在送同一批 op，
// 只有开着真 renderer（subscribe 建起来）走一遍「点发送 → 流式渲染」才碰得到双通道。
// store 层的单测见 tests/core/local-chat-store-single-channel.test.ts。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { opsFile } from "../src/main/core/local-paths";

/** 一段回复被切成的 delta 片段（逐个发 chunk ⇒ 逐个 text-delta op） */
const FRAGMENTS = ["大王", "，", "先把现场", "看清楚", "。"];
/** 原文（UI 与 ops.jsonl 都必须逐字等于它） */
const EXPECTED = FRAGMENTS.join("");
/** 双通道各 apply 一次会造出的叠字（每个片段各自 ×2）—— 本用例的黑名单 */
const DOUBLED = FRAGMENTS.map((f) => f + f).join("");

interface ChatStub {
    url: string;
    requests: Array<Record<string, unknown>>;
    close(): Promise<void>;
}

/** chat 面桩上游：一段合法 SSE，正文按 FRAGMENTS 逐个 chunk 下发 */
async function startChatStub(): Promise<ChatStub> {
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
            const chunk = (delta: Record<string, unknown>, finish: string | null) =>
                `data: ${JSON.stringify({
                    id: "stub",
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: "mimo-v2.6-flash",
                    choices: [{ index: 0, delta, finish_reason: finish }],
                })}\n\n`;
            for (const f of FRAGMENTS) res.write(chunk({ content: f }, null));
            res.write(chunk({}, "stop"));
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

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let stub: ChatStub;
let uri = "";
let ui: UiDriver;

beforeAll(async () => {
    stub = await startChatStub();
    // 桩上游 + 占位 key：main 侧 chat() 只校验 key 存在，桩不看 key 的值
    process.env["OPENCODE_API_KEY"] ||= "intent-test-dummy-key";
    process.env["DIY_ZEN_BASE_URL"] = stub.url;
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
    const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/chat-single --label ChatSingle`);
    const pid = String(((p.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "");
    const t = await fx.sh.getJson(`./diy.sh task create 单通道渲染 ${pid}`);
    uri = String(((t.data as Record<string, unknown>)?.data as Record<string, unknown>)?.uri ?? "");
}, 120_000);

afterAll(async () => {
    ui?.close();
    await stub?.close();
    await fx?.electron?.stop();
});

/** a11y 树文本（页面上真正呈现出来的字） */
function collectText(nodes: A11yNode[] | undefined, acc: string[] = []): string[] {
    for (const n of nodes ?? []) {
        const t = (n as unknown as { text?: string }).text;
        if (t) acc.push(String(t));
        const kids = (n as unknown as { children?: A11yNode[] }).children;
        if (kids) collectText(kids, acc);
    }
    return acc;
}

/** a11y 树文本（`ui inspect`）—— 判"页面就位"用它，读是否有"发送"按钮 */
async function a11yText(): Promise<string> {
    const res = await fx.sh.getJson("./diy.sh ui inspect");
    const tree = ((res.data as Record<string, unknown>)?.data as Record<string, unknown>)?.tree as A11yNode | undefined;
    return collectText(tree ? [tree] : []).join("\n");
}

/** 页面正文（DOM 直读：a11y 树对超长文本有截断，逐字比对必须读真 DOM） */
const bodyText = () => ui.query<string>("document.body.textContent || ''");

/** 盘上那份 ops 日志（权威事实）。文件名只取 basename：本进程的 DIY_HOME 是测试隔离根，
 *  而实例的数据根是 fx.HOME —— 两者不同，路径必须由 fx.HOME 拼。 */
function readOps(): Array<Record<string, unknown>> {
    const fp = join(fx.HOME, sessionFileRel(uri, "ops"));
    return readFileSync(fp, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
}
/** 盘上 assistant 正文 = 该块各 delta 的逐条拼接（权威原文） */
function assistantTextOnDisk(): { text: string; deltas: number } {
    const ops = readOps() as Array<{ op?: string; kind?: string; id?: string; meta?: Record<string, unknown>; fields?: Record<string, unknown> }>;
    const ids = new Set(
        ops
            .filter((o) => o.op === "start" && o.kind === "text" && o.meta?.["role"] === "assistant")
            .map((o) => String(o.id)),
    );
    const got = ops.filter((o) => o.op === "delta" && ids.has(String(o.id)));
    return { text: got.map((o) => String(o.fields?.["content"] ?? "")).join(""), deltas: got.length };
}

describe("会话流式输出的单通道落地（真实界面）", () => {
    it("setup: 打开该任务的对话视图", async () => {
        ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
            const r = await fx.sh.getJson("./diy.sh ui inspect");
            return ((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.tree as A11yNode;
        });
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await fx.sh.getJson(`./diy.sh ui view set chat.local open --ctx ${uri}`);
        const text = await waitUntil(a11yText, (s) => s.includes("发送"), { label: "对话页就位" });
        expect(text).toContain("发送");
    }, 60_000);

    it("一轮含多段 delta：UI 文本与 ops.jsonl 逐字一致，不出现整段叠字", async () => {
        await ui.clickSelector(".cm-content");
        await ui.type("说一遍");
        await ui.click((t, node) => (node as unknown as { role?: string }).role === "button" && t.includes("发送"));

        // 等到那一轮的正文在页面上长全（桩是即时的，等的是渲染链）
        const shown = await waitUntil(bodyText, (s) => s.includes(EXPECTED), { label: "流式正文渲染完成" });
        expect(shown).toContain(EXPECTED);

        // ① 盘上是权威：逐条 delta 拼起来必须是原文，且确实是**多段**（多段才谈得上叠字）
        const disk = assistantTextOnDisk();
        expect(disk.deltas).toBe(FRAGMENTS.length);
        expect(disk.text).toBe(EXPECTED);

        // ② 界面不许出现叠字：双通道各 apply 一次会正好造出 DOUBLED
        expect(shown).not.toContain(DOUBLED);
        // ③ 界面上这句话只该出现一次（叠字之外，"重复整块"同样是双通道的症状）
        expect(shown.split(EXPECTED).length - 1).toBe(1);
    }, 60_000);
});
