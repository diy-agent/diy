import { GenApp, html, type Spec } from "../../../src/providers/dom-gen.js";
import { installDevtools } from "../lib/devtools.js";
import { BlockStore, toForest, type Op, type BlockNode } from "../lib/op-fold.js";

/**
 * chat_gen_demo —— 用 **dom-gen（generator/pull 声明式层，B 风格）** 复刻同一聊天界面。
 * 与 demos/chat_dsl_demo.ts（A 风格）同功能，用于对照可读性。
 *
 * 写法要点（对齐 dom-gen.ts）：
 *   - `html.xxx(props, function* (d) { yield ... })`：工厂只产 Spec，`yield` 出子 Spec；
 *   - 组件 = 返回 `Spec` 的纯函数（`Turn(t)` / `Row(r)`），`yield Turn(t)` 直接嵌；
 *   - 尾生成器 = 重跑块（读到信号就重跑），依赖在生成器里同步读；
 *   - `ref` 逃生口给滚动定位；
 *   - `app.render(...roots)`：离屏构建 → 一次性提交。
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

export function chatGenDemo(mount: HTMLElement): void {
  const app = new GenApp({ mount });

  const turns = app.signal<TurnVM[]>([]);
  const live = app.signal<LiveTurn | null>(null);
  const status = app.signal(`加载 ${DEFAULT_FILE} …`);
  const inputText = app.signal("");

  // 唯一需要直接操作 DOM 的地方：滚到底（走 ref 逃生口）
  let scrollEl: HTMLElement | null = null;
  const toBottom = (): void => {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  };

  const send = (): void => void sendMessage();

  // devtools：诊断按钮 → 亮出所有 rerun cell 数字（须在 render 前装，才能采到「行」）
  installDevtools(mount);

  // ── 声明式组装（一片 spec 森林） ────────────────────
  app.render(
    html.div({ class: "chat-top" }, function* () {
      yield html.div({ class: "chat-title", text: "💬 会话复刻（真实数据 · projects_4_tasks_262）" });
      yield html.div({ class: "chat-status", text: status });
    }),

    html.div({ class: "chat-scroll", ref: (el) => (scrollEl = el) }, function* () {
      // 整表重算：读 turns → 一轮集合变了才重建
      yield html.div({ class: "chat-list" }, function* () {
        for (const t of turns.value) yield Turn(t);
      });
      // 流式直播轮：读 live → 每 token 只重建这一小块
      yield html.div({ class: "chat-list" }, function* () {
        const l = live.value;
        if (l) yield Live(l);
      });
    }),

    html.div({ class: "composer" }, function* () {
      yield html.input({
        class: "diy-input",
        placeholder: "发消息…（Enter 发送，模拟流式回复）",
        value: inputText,
        onInput: (e) => (inputText.value = (e.target as HTMLInputElement).value),
        onEnter: () => send(),
      });
      yield html.div({ class: "composer-right" }, function* () {
        yield html.span({ class: "persona-badge", text: "跟随缺省" });
        yield html.span({ class: "persona-name", text: `大副 · ${MODEL}` });
        yield html.button({ class: "diy-button", text: "发送", onClick: () => send() });
      });
    }),
  );

  // 暴露给 headless / 调试
  (window as unknown as { __chat: unknown }).__chat = {
    send: (t: string) => sendMessage(t),
    state: () => ({ turns: turns.value.length, live: !!live.value, status: status.value }),
    stats: () => app.rerunStats(),
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

// ── 视图组件（纯函数：载荷 → Spec） ─────────────────────────

function Turn(t: TurnVM): Spec {
  return html.div({ class: "turn" }, function* () {
    yield Head({ model: t.model, errors: t.errorCount });
    yield html.div({ class: "turn-body" }, function* () {
      for (const r of t.rows) yield Row(r);
    });
    if (t.foot) {
      yield html.div({ class: "turn-foot" }, function* () {
        yield html.span({ class: "foot", text: t.foot });
      });
    }
  });
}

function Live(l: LiveTurn): Spec {
  return html.div({ class: "turn live" }, function* () {
    yield Head({ model: MODEL, errors: 0 });
    yield html.div({ class: "turn-body" }, function* () {
      yield Row({ kind: "user", text: l.userText });
      if (l.think) yield Row({ kind: "think", text: l.think });
      if (l.text) yield Row({ kind: "text", text: l.text + (l.done ? "" : " ▌") });
    });
  });
}

function Head(p: { model: string; errors: number }): Spec {
  return html.div({ class: "turn-head" }, function* () {
    yield html.span({ class: "avatar", text: "🤖" });
    yield html.span({ class: "sep", text: "·" });
    yield html.span({ class: "model", text: p.model });
    if (p.errors > 0) yield html.span({ class: "err-badge", text: `✗ ${p.errors}` });
  });
}

function Row(r: RowVM): Spec {
  if (r.kind === "user") {
    return html.div({ class: "row-r" }, function* () {
      yield html.div({ class: "bubble bubble-user" }, function* () {
        yield html.div({ class: "bubble-text", text: r.text });
      });
    });
  }
  if (r.kind === "think") {
    return html.div({ class: "think-row" }, function* () {
      yield html.span({ class: "think-icon", text: "🧠" });
      yield html.span({ class: "think-text", text: r.text });
    });
  }
  if (r.kind === "tool") {
    return html.div({ class: "tool-row" }, function* () {
      yield html.div({ class: "tool-head" }, function* () {
        yield html.span({ class: "tool-icon", text: "🛠" });
        yield html.span({ class: "tool-name", text: r.text });
        if (r.status) yield html.span({ class: "tool-status", text: r.status });
      });
      if (r.output) yield html.div({ class: "tool-output", text: r.output.slice(0, 400) });
    });
  }
  if (r.kind === "error") {
    return html.div({ class: "err-card" }, function* () {
      yield html.div({ class: "err-title", text: "✗ 出错现场" });
      yield html.div({ class: "err-body", text: r.text });
    });
  }
  return html.div({ class: "bubble bubble-ai" }, function* () {
    yield html.div({ class: "bubble-text", text: r.text });
  });
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
