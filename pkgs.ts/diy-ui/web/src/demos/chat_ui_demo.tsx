import { DomApp } from "../../../src/providers/dom.js";
import { Fragment, h, mount, type VNode } from "../../../src/providers/dom-jsx.js";
import { BlockStore, toForest, type Op, type BlockNode } from "../lib/op-fold.js";

/**
 * ⚠️ 实验代码（未采纳，留作参考）——JSX 版声明式 demo。
 * 仅供对比；正式方向是**纯 TS builder**（见讨论）。相关依赖见 src/providers/dom-jsx.ts 顶部备注。
 *
 * chat_ui_demo —— 按**真实 diy 聊天界面**的样子渲染大会话，并支持「模拟发送消息」。
 *
 * 声明式写法（见 src/providers/dom-jsx.ts）：业务代码里**不再出现 `el`**，
 * 结构用 JSX、样式走 `class`/`style` 参数、响应式走 `{signal}` 绑定 / `cell={() => ...}`。
 * 唯一的直接 DOM 操作是 `.chat-scroll` 的 `ref`（滚动定位，属于必须直操作的场景）。
 *
 * 参照：renderer_solid/components/LocalChatPage.tsx（用 CDP 连运行中的实例比对过配色与结构）。
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

export function chatUiDemo(el: HTMLElement): void {
  const app = new DomApp({ mount: el });

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

  // ── 声明式挂载 ──────────────────────────────────────
  mount(
    app,
    (
      <>
        <div class="chat-top">
          <div class="chat-title">💬 会话复刻（真实数据 · projects_4_tasks_262）</div>
          <div class="chat-status">{status}</div>
        </div>

        <div class="chat-scroll" ref={(e) => (scrollEl = e)}>
          {/* 整表重算：一轮集合变了才重建 */}
          <div class="chat-list" cell={() => turns.value.map((t) => <Turn t={t} />)} />
          {/* 流式直播轮：每 token 只重建这一小块 */}
          <div
            class="chat-list"
            cell={() => {
              const l = live.value;
              return l ? <Live l={l} /> : null;
            }}
          />
        </div>

        <div class="composer">
          <input
            class="diy-input"
            placeholder="发消息…（Enter 发送，模拟流式回复）"
            value={inputText}
            onInput={(e) => (inputText.value = (e.target as HTMLInputElement).value)}
            onEnter={() => send()}
          />
          <div class="composer-right">
            <span class="persona-badge">跟随缺省</span>
            <span class="persona-name">大副 · {MODEL}</span>
            <button class="diy-button" onClick={() => send()}>
              发送
            </button>
          </div>
        </div>
      </>
    ),
  );

  // 暴露给 headless / 调试
  (window as unknown as { __chat: unknown }).__chat = {
    send: (t: string) => sendMessage(t),
    state: () => ({ turns: turns.value.length, live: !!live.value, status: status.value }),
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

// ── 视图（纯声明式） ────────────────────────────────────────

function Turn({ t }: { t: TurnVM }): VNode {
  return (
    <div class="turn">
      <Head model={t.model} errors={t.errorCount} />
      <div class="turn-body">
        {t.rows.map((r) => (
          <Row r={r} />
        ))}
      </div>
      {t.foot ? (
        <div class="turn-foot">
          <span class="foot">{t.foot}</span>
        </div>
      ) : null}
    </div>
  );
}

function Live({ l }: { l: LiveTurn }): VNode {
  return (
    <div class="turn live">
      <Head model={MODEL} errors={0} />
      <div class="turn-body">
        <Row r={{ kind: "user", text: l.userText }} />
        {l.think ? <Row r={{ kind: "think", text: l.think }} /> : null}
        {l.text ? <Row r={{ kind: "text", text: l.text + (l.done ? "" : " ▌") }} /> : null}
      </div>
    </div>
  );
}

function Head({ model, errors }: { model: string; errors: number }): VNode {
  return (
    <div class="turn-head">
      <span class="avatar">🤖</span>
      <span class="sep">·</span>
      <span class="model">{model}</span>
      {errors > 0 ? <span class="err-badge">✗ {errors}</span> : null}
    </div>
  );
}

function Row({ r }: { r: RowVM }): VNode {
  if (r.kind === "user") {
    return (
      <div class="row-r">
        <div class="bubble bubble-user">
          <div class="bubble-text">{r.text}</div>
        </div>
      </div>
    );
  }
  if (r.kind === "think") {
    return (
      <div class="think-row">
        <span class="think-icon">🧠</span>
        <span class="think-text">{r.text}</span>
      </div>
    );
  }
  if (r.kind === "tool") {
    return (
      <div class="tool-row">
        <div class="tool-head">
          <span class="tool-icon">🛠</span>
          <span class="tool-name">{r.text}</span>
          {r.status ? <span class="tool-status">{r.status}</span> : null}
        </div>
        {r.output ? <div class="tool-output">{r.output.slice(0, 400)}</div> : null}
      </div>
    );
  }
  if (r.kind === "error") {
    return (
      <div class="err-card">
        <div class="err-title">✗ 出错现场</div>
        <div class="err-body">{r.text}</div>
      </div>
    );
  }
  return (
    <div class="bubble bubble-ai">
      <div class="bubble-text">{r.text}</div>
    </div>
  );
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
