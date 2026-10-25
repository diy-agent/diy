// tests/cli.intent.ui-chat-render.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 聊天页渲染层：code 块 / 流式不毁 DOM（滚动+选区）/ 左栏收起的铺满（##348 ①②③⑤）
//
// 三个判据各自对应一条用户反馈，且都**只能**在真实 renderer 上量：
//   ① 含 ```json 的消息按代码块渲染（等宽 + 底色），流式中与定稿后都成立
//   ② 流式 delta 不许把正文 DOM 拆了重建 —— 判据是「同一个元素对象 + 滚动位置还在」
//   ③ 同上：拖出的选区在后续 delta 到来后仍然在（定稿后也要能正常拖选）
//   ⑤ 左栏「任务详情」收起后中栏 chat 铺满内容区（无残留空白），拖过线再收起也一样
//
// 为什么需要**可控的上游桩**（同 cli.intent.steer-ui）：
//   "流式中"必须是一个能停住、能一步一推的状态。真实上游何时来 token 由它决定，
//   断言必然假红。桩把 delta 变成测试手里的 push()，每步都可等到界面跟上再量。
//   （收到请求后先发 SSE 头挂住 = UI 的 running；push 一次 = 一个 delta；finish = 定稿。）
//
// 为什么不用"直写 ops.jsonl"：那样只有加载期重放（一次性），拿不到"再来一个 delta"。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";
let server: Server;
/** 当前挂着的那次生成（收到请求即建） */
let live: ServerResponse | null = null;
/** 所有开过的响应（收尾强拆用：用例中途失败时流还挂着，server.close() 会一直等） */
const opened = new Set<ServerResponse>();

/** 长行：代码块里必须出现横向滚动条，② 才有得测 */
const LONG = "L".repeat(400);
const P_ONE = "一段正文，先到一步，等着后面接着来。";
const CODE = `\`\`\`json\n{"long":"${LONG}"}\n`;
const TAIL = "结尾一行，用来确认后面又来了新的 delta。";

/** SSE 一条 chat.completion.chunk */
const chunk = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({
    id: "stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "mimo-v2.6-flash",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;

async function startStub(): Promise<string> {
  const s = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": stub waiting\n\n"); // 流已开始 → UI 处于 running
      live = res;
      opened.add(res);
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  server = s;
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`;
}

/** 推一个 delta（一个"内容片段"到达） */
function push(text: string): void {
  if (!live) throw new Error("[stub] 还没有在飞的请求");
  live.write(chunk({ content: text }));
}

/** 定稿：终止事件 + 关流 */
function finish(): void {
  if (!live) throw new Error("[stub] 还没有在飞的请求");
  live.write(chunk({}));
  live.write("data: [DONE]\n\n");
  live.end();
  opened.delete(live);
  live = null;
}

/**
 * "这段文本在**本轮**（最后一个 markdown 块）里上屏了吗"。
 * 每轮推的内容相同（P_ONE / CODE / TAIL 都重复出现），裸 `body.textContent.includes`
 * 会被**上一轮残留**假满足 —— 那样用例会在旧 DOM 上量、且根本没等本轮。故一律用本函数。
 */
const LAST_BLOCK = `[...document.querySelectorAll('.markdown-body')].at(-1) ?? null`;
const lastHas = (t: string) => () =>
  ui.query<boolean>(`(() => { const m = ${LAST_BLOCK}; return !!m && m.textContent.includes(${JSON.stringify(t)}); })()`);
/** 本轮块里的元素计数（0 = 还没出现） */
const lastCount = (sel: string) => () =>
  ui.query<number>(`(() => { const m = ${LAST_BLOCK}; return m ? m.querySelectorAll(${JSON.stringify(sel)}).length : 0; })()`);

/**
 * 采样：**DOM 身份** + 滚动 + 选区。
 * 身份用"第一次见到的元素对象"当基准（挂在 window 上），后续采样比 `===` ——
 * 这正是 ②③ 的判据：同一元素对象 = 没被重建。
 */
const PROBE = `(() => {
  const w = window;
  w.__probe = w.__probe || {};
  // 取**最后一个**：聊天里的最新一条消息（第一条是上一轮的，跨用例比会假红）
  const shell = [...document.querySelectorAll('.markdown-body [data-code-block]')].at(-1) ?? null;
  const par = [...document.querySelectorAll('.markdown-body p')].filter((x) => x.textContent.includes('先到一步')).at(-1) ?? null;
  if (shell && !w.__probe.shell) w.__probe.shell = shell;
  if (par && !w.__probe.par) w.__probe.par = par;
  const pre = shell ? shell.querySelector('pre') : null;
  const cs = pre ? getComputedStyle(pre) : null;
  const shellBg = shell ? getComputedStyle(shell).backgroundColor : null;
  return JSON.stringify({
    shellSame: shell ? shell === w.__probe.shell : null,
    parSame: par ? par === w.__probe.par : null,
    scrollLeft: shell ? shell.scrollLeft : null,
    sel: window.getSelection().toString().trim(),
    preInShell: !!pre,
    mono: cs ? cs.fontFamily.includes('mono') : null,
    bg: shellBg,
    codeLen: shell ? (shell.textContent || '').replace(/[^L]/g, '').length : null,
  });
})()`;

type Sample = {
  shellSame: boolean | null;
  parSame: boolean | null;
  scrollLeft: number | null;
  sel: string;
  preInShell: boolean;
  mono: boolean | null;
  bg: string | null;
  codeLen: number | null;
};
const sample = async (): Promise<Sample> => JSON.parse(await ui.query<string>(PROBE)) as Sample;

/**
 * 等 UI「静下来」：连续两次采样看到同一个外壳对象。
 *
 * 为什么需要：应用侧在轮次边界会有**迟到的重渲染/回读**（新消息落盘后重读会话等），
 * 落点随机 —— 不等它，用例会随机地量到"半新半旧"的一帧（实测同一份代码时红时绿）。
 * 本函数把这类与本用例无关的迟到改动让过去；它只延迟"采样"，不修改基准，
 * 所以「delta 触发的重建」依旧会被 shellSame 抓住。
 */
async function waitQuiet(ms = 250, tries = 12): Promise<Sample> {
  let prev = await sample();
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, ms));
    const cur = await sample();
    if (cur.shellSame && cur.parSame) return cur;
    prev = cur;
  }
  return prev;
}

/** 拖选一段文本（真实鼠标，走命中测试） */
async function dragSelect(contains: string): Promise<void> {
  // 两个前置（都是"真实用户会有的前提"，不这么做会在别处埋假红）：
  //   1. 先清掉既有选区 —— 否则 mousedown 落在旧选区内，浏览器走的是"拖动已选文本"而非"重新拖选"；
  //   2. 先把目标滚进视口 —— 聊天区贴底滚动后，段落可能在视口外，鼠标坐标就落空了。
  const rect = await ui.query<string>(`(() => {
    getSelection().removeAllRanges();
    const p = [...document.querySelectorAll('.markdown-body p')].filter((x) => x.textContent.includes(${JSON.stringify(contains)})).at(-1);
    if (!p) return "NONE";
    p.scrollIntoView({ block: "center" });
    const r = p.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
  })()`);
  expect(rect).not.toBe("NONE");
  const r = JSON.parse(rect) as { x: number; y: number; w: number; h: number };
  await ui.drag({ x: r.x + 2, y: r.y + r.h / 2 }, { x: r.x + r.w - 2, y: r.y + r.h / 2 }, 8);
}

/** 每次生成都推同一套内容：段落 → 代码块 → 收尾 */
async function streamOnce(): Promise<void> {
  const n0 = await ui.query<number>("document.querySelectorAll('.markdown-body').length");
  void fx.sh.run(`./diy.sh agent local chat ${uri} "写一段 markdown" --model mimo-v2.6-flash`, 60_000);
  await waitUntil(async () => live !== null, (v) => v === true, { label: "桩收到请求" });
  push("## 标题\n\n");
  push(`${P_ONE}\n\n`);
  // ⚠️ 必须等**本轮**：第 2 次起，上一轮已有同样的 P_ONE / CODE / 代码块，
  //    用裸 `document.querySelector` 会被上一轮残留假满足 → 用例实际在旧 DOM 上量。
  await waitUntil(
    async () => await ui.query<number>("document.querySelectorAll('.markdown-body').length"),
    (n) => n > n0,
    { label: "本轮新块出现" },
  );
  await waitUntil(lastHas(P_ONE), (v) => v === true, { label: "本轮正文段落上屏" });
  push(CODE);
  await waitUntil(lastCount("[data-code-block] pre"), (n) => n > 0, { label: "本轮代码块上屏" });
}

beforeAll(async () => {
  const url = await startStub();
  // 桩上游 + 占位 key（main 侧 chat() 校验 key 存在，桩不看值）。同 cli.intent.steer-ui 的接缝。
  process.env["OPENCODE_API_KEY"] ||= "intent-test-dummy-key";
  process.env["DIY_ZEN_BASE_URL"] = url;
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
  // 用例中途失败时流还挂着：先强拆连接，否则 server.close() 会一直等它自然结束
  for (const r of opened) r.destroy();
  opened.clear();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await fx?.electron?.stop();
});

describe("聊天页渲染层（流式 + 布局）", () => {
  // 夹具（##434）：造任务并打开它的执行页，给本 describe 所有用例预置 `uri` 与页面。
  // 写成 `it` 时 `-t` 过滤会跳过它 ⇒ 后续用例的 `uri` 是空串（##433 同款）。
  beforeAll(async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/render --label Render`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create "渲染验收" ${pid}`);
    uri = String((t.data as any)?.data?.uri);
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
  });

  it("① 含 ```json 的消息按代码块渲染：等宽 + 底色（流式中与定稿后都成立）", async () => {
    await streamOnce();

    // 流式中（未定稿 = 纯文本呈现）：也必须是"代码块"的样子
    const streaming = await sample();
    expect(streaming.preInShell).toBe(true);
    expect(streaming.mono).toBe(true);
    expect(streaming.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(streaming.codeLen).toBeGreaterThanOrEqual(400); // 长行整条都在

    finish();
    // 定稿后换成 Shiki 高亮：仍是等宽 + 底色，且正文完整
    const settled = await waitUntil(
      sample,
      (s) => s.codeLen !== null && s.codeLen >= 400 && s.preInShell && s.mono === true,
      { label: "定稿后代码块（高亮态）", timeoutMs: 8000 },
    );
    expect(settled.mono).toBe(true);
    expect(settled.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(
      await ui.query<string>(`document.querySelector('.markdown-body [data-code-block] pre code').textContent.length`),
    ).toBeGreaterThanOrEqual(400);
  });

  it("②③ 流式 delta 不重建正文 DOM：滚动位置与选区都留在原处", async () => {
    // ② 自证：先清掉上一用例留下的基准，以**本轮**那棵树为基线
    //（否则比的是上一轮的节点，新轮一开就"必然不同"，测不到本用例要测的东西）
    await ui.query<string>("delete window.__probe; 'ok'");
    await streamOnce();
    await waitQuiet(); // 本轮块先站稳（新消息落盘后的回读落点随机）

    // 用户动作：把代码块拖到长行右侧 + 在正文段落上拖选
    // 同样必须取**最后一个**（本轮那条）：取第一个会滚到上一轮那条块上，
    // 断言时量的是本轮块 → 恒 0（这正是本用例改造前"时红时绿"的根因之一）
    await ui.query<string>(`(() => {
      const shell = [...document.querySelectorAll('.markdown-body [data-code-block]')].at(-1);
      shell.scrollLeft = 300;
      return String(shell.scrollLeft);
    })()`);
    await dragSelect("先到一步");
    const before = await sample();
    expect(before.scrollLeft).toBe(300);
    expect(before.sel.length).toBeGreaterThan(0);

    // 再来两个 delta（收尾围栏 + 新段落）——旧实现里这一下就把整棵子树换了
    push("```\n\n");
    push(TAIL);
    await waitUntil(lastHas(TAIL), (v) => v === true, { label: "本轮收尾段上屏" });

    const after = await sample();
    expect(after.shellSame).toBe(true); // 同一个滚动容器对象
    expect(after.parSame).toBe(true); // 段落节点也没被换掉
    expect(after.scrollLeft).toBe(300); // 滚动位置还在
    expect(after.sel).toBe(before.sel); // 选区没被 delta 清掉

    // 定稿（纯文本 → Shiki）：这里只验**内容仍完整、仍是代码块**。
    // ⚠️ 不断言"定稿后滚动位置还在"—— 实测（本用例改造后）轮末应用侧会把**整块消息**
    //   换成落盘版（`parSame` 同样为 false），换掉即丢滚动位置与选区。那是聊天消息
    //   列表层的换块（##348 遗留，见 body「结案」），不在本用例（md / 代码块层）的射程内。
    finish();
    await waitUntil(lastCount("[data-code-block] .shiki"), (n) => n > 0, {
      label: "本轮定稿高亮上屏",
      timeoutMs: 8000,
    });
    const done = await waitQuiet(); // 落定后再采样
    expect(done.codeLen).toBeGreaterThanOrEqual(400); // 定稿后代码内容完整
    expect(done.mono).toBe(true); // 仍是代码块的样子
  });

  it("③ 定稿消息文本可正常拖选（验收的另一半）", async () => {
    await waitUntil(lastHas(TAIL), (v) => v === true, {
      label: "本轮正文在屏幕上",
      timeoutMs: 8000,
    });
    await waitQuiet(); // 定稿切换（纯文本 → Shiki）刚发生，等它落定
    await dragSelect("先到一步");
    const s = await sample();
    expect(s.sel).toContain("先到一步");
  });

  it("⑤ 左栏收起后中栏铺满内容区（拖过线再收起也一样）", async () => {
    const geom = `(() => {
      const g = document.querySelector('.grid');
      const areas = [...g.children].filter((c) => c.className.includes('overflow-hidden'));
      const chat = document.querySelector('.diy-chat');
      return JSON.stringify({
        cols: getComputedStyle(g).gridTemplateColumns,
        gridW: Math.round(g.getBoundingClientRect().width),
        chatW: Math.round(chat.getBoundingClientRect().width),
        nVisibleAreas: areas.length,
      });
    })()`;
    const before = JSON.parse(await ui.query<string>(geom)) as { cols: string; gridW: number; chatW: number };
    expect(before.chatW).toBeLessThan(before.gridW); // 左栏在时中栏确实窄着

    // 先拖一下左边界（制造"用户尺寸覆盖"，走的是另一条解析分支：override.cols）
    const line = await ui.query<{ x: number; y: number }>(`(() => {
      const h = document.querySelector('.grid .cursor-col-resize');
      const r = h.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await ui.drag(line, { x: line.x + 60, y: line.y }, 6);
    await new Promise((r) => setTimeout(r, 200));

    // 点左栏 chrome 的「最小化」（area 列表里第一个；图标按钮，按选择器定位）
    await ui.clickSelector('[aria-label="最小化"]', { nth: 0 });
    const after = await waitUntil(
      async () => JSON.parse(await ui.query<string>(geom)) as { cols: string; gridW: number; chatW: number; nVisibleAreas: number },
      (g) => g.nVisibleAreas === 1,
      { label: "左栏收起（只剩中栏）" },
    );
    expect(after.cols.startsWith("0px")).toBe(true); // col0 真收 0（不是残留 300px）
    expect(after.chatW).toBe(after.gridW); // 中栏铺满内容区，无残留空白
  });
});
