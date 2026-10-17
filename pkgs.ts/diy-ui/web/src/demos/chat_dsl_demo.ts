import { DslApp, defineComps, type El } from "../../../src/providers/dom-dsl.js";
import { installDevtools } from "../lib/devtools.js";
import { BlockStore, toForest, type Op, type BlockNode } from "../lib/op-fold.js";

/**
 * chat_dsl_demo —— 用 **dom-dsl（纯 TS 声明式层）** 复刻真实 diy 聊天界面，
 * 并支持「模拟发送消息」。这是 A 风格（注册式 / eager）的基线实现。
 *
 * 写法要点（对齐 dom-dsl.ts）：
 *   - 所有普通属性 + 文本走一个 props 对象：`span({ class, text })`；
 *   - 尾部函数放最后、多行，缩进即 HTML 层级；
 *   - 尾部函数 = 重跑块（读到信号就重跑），不再需要 `cell()`；
 *   - 组件用 `parent.mount(Comp, payload)`；环境式调用见 `C.Turn(t)`；
 *   - 唯一直操作 DOM 的地方：`.chat-scroll` 的滚动定位（`d.el`）。
 *
 * 参照：renderer_solid/components/LocalChatPage.tsx（配色/结构用 CDP 比对过）。
 * 对照：demos/chat_ui_demo.tsx（⚠️ 实验、未采纳的 JSX 版）。
 */

const DEFAULT_FILE = "/sessions/projects_4_tasks_262-8bc858df8037.ops.jsonl";
const MODEL = "mimo-v2.6-flash";
const THINK = "用户发来一句话，先判断意图，再给简短回应即可。";
const REPLY =
  "收到！这是 diy-ui 的模拟回复：正在流式刷新——注意每个 token 只重绘这一块，不会重建整张会话表。";

interface RowVM {
  kind: "user" | "think" | "tool" | "text" | "error";
  text: string;
  status?: string;
  output?: string;
}
interface TurnVM {
  id: string;
  model: string;
  rows: RowVM[];
  errorCount: number;
  foot: string;
}
interface LiveTurn {
  userText: string;
  think: string;
  text: string;
  done: boolean;
}

export function chatDslDemo(mount: HTMLElement): void {
  const app = new DslApp({ mount });
  const C = defineComps(app, { Turn, Head, Row, Live });

  const turns = app.signal<TurnVM[]>([]);
  const live = app.signal<LiveTurn | null>(null);
  const status = app.signal(`加载 ${DEFAULT_FILE} …`);
  const inputText = app.signal("");

  // 唯一需要直接操作 DOM 的地方：滚到底（别处一律不碰 el）
  let scrollEl: HTMLElement | null = null;
  const toBottom = (): void => {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  };

  const send = (): void => void sendMessage();

  // devtools：诊断按钮 → 亮出所有 rerun cell 数字（须在组装前装，才能采到「行」）
  installDevtools(mount);

  // ── 声明式组装 ──────────────────────────────────────
  app.div({ class: "chat-top" }, (d) => {
    d.div({ class: "chat-title", text: "💬 会话复刻（真实数据 · projects_4_tasks_262）" });
    d.div({ class: "chat-status", text: status });
  });

  app.div({ class: "chat-scroll" }, (d) => {
    scrollEl = d.el; // 逃生口：滚动定位
    // 整表重算：读 turns → 一轮集合变了才重建
    d.div({ class: "chat-list" }, () => {
      for (const t of turns.value) C.Turn(t);
    });
    // 流式直播轮：读 live → 每 token 只重建这一小块
    d.div({ class: "chat-list" }, () => {
      const l = live.value;
      if (l) C.Live(l);
    });
  });

  app.div({ class: "composer" }, (d) => {
    d.input({
      class: "diy-input",
      placeholder: "发消息…（Enter 发送，模拟流式回复）",
      value: inputText,
      onInput: (e) => (inputText.value = (e.target as HTMLInputElement).value),
      onEnter: () => send(),
    });
    d.div({ class: "composer-right" }, (r) => {
      r.span({ class: "persona-badge", text: "跟随缺省" });
      r.span({ class: "persona-name", text: `大副 · ${MODEL}` });
      r.button({ class: "diy-button", text: "发送", onClick: () => send() });
    });
  });

  // 暴露给 headless / 调试
  (window as unknown as { __chat: unknown }).__chat = {
    send: (t: string) => sendMessage(t),
    state: () => ({ turns: turns.value.length, live: !!live.value, status: status.value }),
    stats: () => app.rerunStats(), // dev：rerun 计数分布（异常 rerun 排查）
  };

  void loadReal();

  // ── 加载真实数据 ────────────────────────────────────
  async function loadReal(): Promise<void> {
    const res = await fetch(DEFAULT_FILE);
    if (!res.body) {
      status.value = "fetch 失败";
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const store = new BlockStore();
    let buf = "";
    let ops = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        store.apply(JSON.parse(line) as Op);
        ops++;
      }
    }
    if (buf.trim()) store.apply(JSON.parse(buf) as Op);
    const vms = toForest(store).map((t) => buildTurn(t));
    status.value = `${ops.toLocaleString()} ops · ${vms.length} 轮 · ${vms
      .reduce((n, t) => n + t.rows.length, 0)
      .toLocaleString()} 行`;
    turns.value = vms;
    toBottom();
  }

  // ── 模拟发送 ────────────────────────────────────────
  async function sendMessage(forced?: string): Promise<void> {
    const text = (forced ?? inputText.value).trim();
    if (!text || live.value) return;
    inputText.value = "";

    live.value = { userText: text, think: "", text: "", done: false };
    toBottom();
    await stream("think", THINK, 18);
    await stream("text", REPLY, 12);
    const l = live.value!;

    const t: TurnVM = {
      id: "local_" + Date.now(),
      model: MODEL,
      rows: [
        { kind: "user", text },
        { kind: "think", text: l.think },
        { kind: "text", text: l.text },
      ],
      errorCount: 0,
      foot: `✓ 刚刚 · 1 步 · ${(l.think.length + l.text.length).toLocaleString()} 字符 · 模拟`,
    };
    turns.value = [...turns.value, t];
    live.value = null;
    toBottom();
  }

  function stream(field: "think" | "text", full: string, step: number): Promise<void> {
    return new Promise((resolve) => {
      let i = 0;
      const tick = (): void => {
        const l = live.value;
        if (!l) {
          resolve();
          return;
        }
        i = Math.min(full.length, i + step);
        live.value = { ...l, [field]: full.slice(0, i) };
        toBottom();
        if (i < full.length) setTimeout(tick, 16);
        else resolve();
      };
      setTimeout(tick, 16);
    });
  }
}

// ── 视图组件（纯函数：(父节点, 载荷) => void） ──────────────

function Turn(d: El, t: TurnVM): void {
  d.div({ class: "turn" }, (turn) => {
    turn.mount(Head, { model: t.model, errors: t.errorCount });
    turn.div({ class: "turn-body" }, (body) => {
      for (const r of t.rows) body.mount(Row, r);
    });
    if (t.foot) {
      turn.div({ class: "turn-foot" }, (f) => {
        f.span({ class: "foot", text: t.foot });
      });
    }
  });
}

function Live(d: El, l: LiveTurn): void {
  d.div({ class: "turn live" }, (turn) => {
    turn.mount(Head, { model: MODEL, errors: 0 });
    turn.div({ class: "turn-body" }, (body) => {
      body.mount(Row, { kind: "user", text: l.userText });
      if (l.think) body.mount(Row, { kind: "think", text: l.think });
      if (l.text) body.mount(Row, { kind: "text", text: l.text + (l.done ? "" : " ▌") });
    });
  });
}

function Head(d: El, p: { model: string; errors: number }): void {
  d.div({ class: "turn-head" }, (head) => {
    head.span({ class: "avatar", text: "🤖" });
    head.span({ class: "sep", text: "·" });
    head.span({ class: "model", text: p.model });
    if (p.errors > 0) head.span({ class: "err-badge", text: `✗ ${p.errors}` });
  });
}

function Row(d: El, r: RowVM): void {
  if (r.kind === "user") {
    d.div({ class: "row-r" }, (row) => {
      row.div({ class: "bubble bubble-user" }, (b) => {
        b.div({ class: "bubble-text", text: r.text });
      });
    });
  } else if (r.kind === "think") {
    d.div({ class: "think-row" }, (row) => {
      row.span({ class: "think-icon", text: "🧠" });
      row.span({ class: "think-text", text: r.text });
    });
  } else if (r.kind === "tool") {
    d.div({ class: "tool-row" }, (row) => {
      row.div({ class: "tool-head" }, (h) => {
        h.span({ class: "tool-icon", text: "🛠" });
        h.span({ class: "tool-name", text: r.text });
        if (r.status) h.span({ class: "tool-status", text: r.status });
      });
      if (r.output) row.div({ class: "tool-output", text: r.output.slice(0, 400) });
    });
  } else if (r.kind === "error") {
    d.div({ class: "err-card" }, (card) => {
      card.div({ class: "err-title", text: "✗ 出错现场" });
      card.div({ class: "err-body", text: r.text });
    });
  } else {
    d.div({ class: "bubble bubble-ai" }, (b) => {
      b.div({ class: "bubble-text", text: r.text });
    });
  }
}

// ── 数据 → 视图模型 ─────────────────────────────────────────

function buildTurn(turn: BlockNode): TurnVM {
  const rows: RowVM[] = [];
  let model = String(turn.attrs.model ?? "");
  let errorCount = 0;
  const walk = (n: BlockNode): void => {
    if (n.tag === "step" && !model && n.attrs.model) model = String(n.attrs.model);
    const a = n.attrs as Record<string, unknown>;
    if (n.tag === "text")
      rows.push({ kind: String(a.role) === "user" ? "user" : "text", text: String(a.content ?? "") });
    else if (n.tag === "think") rows.push({ kind: "think", text: String(a.content ?? "") });
    else if (n.tag === "tool")
      rows.push({
        kind: "tool",
        text: String(a.tool ?? "tool"),
        status: String(a.status ?? ""),
        output: String(a.output ?? a.input ?? ""),
      });
    else if (n.tag === "error") {
      errorCount++;
      rows.push({ kind: "error", text: String(a.message ?? "") });
    }
    for (const c of n.children) walk(c);
  };
  for (const c of turn.children) walk(c);

  const usage = turn.attrs.usage as
    | { total?: number; steps?: number; cost?: { total?: number } }
    | undefined;
  const d = turn.attrs.durationMs;
  const bits: string[] = [];
  if (typeof d === "number") bits.push(`${(d / 1000).toFixed(0)}秒`);
  if (usage?.steps) bits.push(`${usage.steps} 步`);
  if (usage?.total) bits.push(`${usage.total.toLocaleString()} tok`);
  const cost = usage?.cost?.total;
  if (typeof cost === "number") bits.push(`$${cost.toFixed(6)}`);
  const ok = errorCount === 0;
  const foot = bits.length ? `${ok ? "✓" : "✗"} ${bits.join(" · ")}` : "";

  return { id: turn.id, model: model || MODEL, rows, errorCount, foot };
}
