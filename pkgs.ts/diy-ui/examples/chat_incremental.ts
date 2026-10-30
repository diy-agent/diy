/// <reference lib="dom" />
/**
 * chat_incremental.ts — **增量 chat 演示**：yield 的「增量」到底增量在哪一层？
 *
 * 结论先行（页面右侧会跑出真实数字）：
 *   ① **yield 的结果不保存**：`attachGen` 每次重跑都同步 drain 整个 generator（全量重算），
 *      不累积「这次的增量」。
 *   ② **保存的是身份表**：每个元素有 `keyedChildren: Map<key, {el, handle, rev, scope}>`，
 *      记录「当前这层有哪些 key、对应哪个真实节点」。判新增 = 拿 key 查不到（miss），不是 diff。
 *   ③ **DOM 是增量的**：keyed 子节点按 key 复用 → 追加一条消息只新建 1 个节点、0 个移除。
 *   ④ **不带 key = 每轮全量重建**：追加第 N 条 → 新建 N 个、移除 N−1 个。
 *   ⑤ **没有攒批的「时钟」**：effect 是同步的，一次 signal 写 = 一次整体重跑 + 对账 + 提交；
 *      写两次就重跑两次。要「一个 tick 只提交一次」→ 一次写完整数组。
 *   ⑥ **同一条消息内流式吐字**：靠 props getter（`text: () => …`），0 个节点新增。
 *   ⑦ **真正的「增量投递」**：`node.insert(spec)`（`.unsafe` 里拿节点）——流来一条插一条，
 *      generator 一次都不重跑。chat 的流式消息（SSE / RPC 推送）走这条最省。
 *
 * 页面：左=聊天列表，左下=流式日志（insert 路径），右=指标与按钮。
 *
 * 运行：
 *   cd pkgs.ts/diy-ui && npx vite examples --port 5199
 *   → http://localhost:5199/chat_incremental.html
 */

import { GenApp, html, mountStream, Signal, type GenNode, type Spec } from "../src/browser.js";
import { nodeOf } from "../src/providers/dom-dsl.js";

// ── 状态 ────────────────────────────────────────────────────

interface Msg {
  id: number;
  role: "user" | "bot";
  text: string;
}

const messages = new Signal<Msg[]>([]);
/** 正在流式吐字的那条（id + 当前缓冲）；同一条消息内更新不新增节点 */
const stream = new Signal<{ id: number | null; buf: string }>({ id: null, buf: "" });
/** keyed 对账开关（①/② 对比用） */
const useKeys = new Signal<boolean>(true);
/** 测出来的报告（累积多段，方便对比） */
const report = new Signal<string[]>([]);
const pushReport = (block: string): void => {
  report.value = [...report.value, block];
};

let seq = 0;
const nextId = (): number => ++seq;

// ── 指标 ────────────────────────────────────────────────────

interface Measure {
  added: number;
  removed: number;
}

let listEl: HTMLElement | null = null;
let logEl: HTMLElement | null = null;
/** 流式日志容器的 GenNode（`.unsafe` 里登记，insert 用它） */
let logNode: GenNode | null = null;
/** ⑨ 生成器驱动列表：容器 + 它的 GenNode */
let feedEl: HTMLElement | null = null;
let feedNode: GenNode | null = null;

/**
 * ⑨ 一个「可增长的消息源」：按发送按钮往里 push 一块，消费端 `for await` 不断取。
 * 这就是「列表块内不断去消费生成器」的最小实现（等价于 SSE / RPC 推送）。
 */
function createInbox<T>(): { push(v: T): void; consume(): AsyncGenerator<T> } {
  const buf: T[] = [];
  const waiters: Array<(v: T) => void> = [];
  return {
    push(v: T): void {
      const w = waiters.shift();
      if (w) w(v);
      else buf.push(v);
    },
    async *consume(): AsyncGenerator<T> {
      for (;;) {
        if (buf.length) yield buf.shift() as T;
        else yield await new Promise<T>((r) => waiters.push(r));
      }
    },
  };
}

const inbox = createInbox<Msg>();

let watch: MutationObserver | null = null;
let acc: Measure = { added: 0, removed: 0 };

/** 观察某个容器的直接子节点增删 */
function startMeasure(target: HTMLElement | null): void {
  acc = { added: 0, removed: 0 };
  if (!target) return;
  watch = new MutationObserver((records) => {
    for (const r of records) {
      acc.added += r.addedNodes.length;
      acc.removed += r.removedNodes.length;
    }
  });
  watch.observe(target, { childList: true });
}

function stopMeasure(): Measure {
  watch?.disconnect();
  watch = null;
  return { ...acc };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/**
 * 列表块自己的重跑次数。
 * ⚠️ 别用 `rerunStats().rerun` —— 那个字段是「重跑超过 1 次的节点数」，不是总次数。
 */
const reruns = (): number => (listEl ? (nodeOf(listEl)?.reruns ?? 0) : 0);

/** 列表容器的真实节点（dom-gen 的 GenNode；nodeOf 的类型只是它的子集）。 */
const listNode = (): GenNode | undefined =>
  listEl ? (nodeOf(listEl) as unknown as GenNode | undefined) : undefined;

/**
 * keyed 对账明细。
 * 框架**没有**保存「这次 yield 了哪些增量」；它只保存当前这层的身份表
 * `GenNode.keyedChildren: Map<key, {el, handle, rev, scope}>`。
 * 「新增」= 拿 key 去上一轮的表里查不到（miss），不是 diff。
 */
interface Reconcile {
  yielded: number;
  reused: number;
  created: number;
  removed: number;
  table: number;
}

/** 快照当前身份表（key → 真实节点实例），用于前后对比「复用 / 新建」 */
function snapshot(): Map<unknown, unknown> {
  const t = listNode()?.keyedChildren;
  return new Map(t ? [...t].map(([k, v]) => [k, v.handle] as const) : []);
}

function reconcileDelta(before: Map<unknown, unknown>): Reconcile {
  const t = listNode()?.keyedChildren;
  const after = t ? [...t].map(([k, v]) => [k, v.handle] as const) : [];
  let reused = 0;
  let created = 0;
  for (const [k, h] of after) {
    if (before.get(k) === h) reused++;
    else created++;
  }
  let removed = 0;
  for (const k of before.keys()) if (!t?.has(k)) removed++;
  return { yielded: messages.value.length, reused, created, removed, table: t?.size ?? 0 };
}

/** 跑一次「写 → 提交」，同时记录 DOM 增删 + 生成器重跑 + keyed 对账明细 */
async function commit(
  write: () => void,
  target: HTMLElement | null,
): Promise<{ m: Measure; rc: Reconcile; rewrites: number }> {
  startMeasure(target);
  const before = snapshot();
  const r0 = reruns();
  write(); // 同步：effect 立刻重跑并提交，没有「等下一个时钟」
  const rewrites = reruns() - r0;
  await tick();
  return { m: stopMeasure(), rc: reconcileDelta(before), rewrites };
}

// ── UI ──────────────────────────────────────────────────────

const app = new GenApp({ mount: "#app" });

function bubble(m: Msg, keyed: boolean): Spec {
  return html.div(
    {
      // 关键对比：keyed=用一个稳定身份（m.id）做对账；unkeyed=不给 key，每轮都是新节点。
      // 注意：消息**永远有 id**，这里只是"用不用它当 key"。
      key: keyed ? `msg:${m.id}` : undefined,
      class: ["msg", m.role === "user" ? "msg-user" : "msg-bot"],
    },
    function* () {
      yield html.span({ class: "role", text: m.role === "user" ? "你" : "助手" });
      // 流式：文本是 getter → 吐字只改 textContent，不动节点
      yield html.div({
        class: "bubble",
        text: () => {
          const s = stream.value;
          return s.id === m.id ? s.buf : m.text;
        },
      });
    },
  );
}

/**
 * 消息列表 = 重跑块：**每次重跑都全量 yield 一遍**。
 * keyed 决策只在这里读一次（切换模式 → 列表按新规则重渲染），再显式传给每一行。
 */
function* messageList(): Generator<Spec> {
  const keyed = useKeys.value;
  for (const m of messages.value) yield bubble(m, keyed);
}

const appSpec: Spec = html.div({ class: "layout" }, function* () {
  yield html.div({ class: "panel chat-panel" }, function* () {
    yield html.div({ class: "panel-title", text: "聊天（keyed 对账）" });
    yield html.div({ class: "list", ref: (el: HTMLElement) => void (listEl = el) }, function* () {
      yield* messageList();
    });

    yield html.div({ class: "stream-log" }, function* () {
      yield html.div({ class: "panel-title", text: "流式日志（node.insert，不重跑 generator）" });
      // .unsafe：不清子节点、不参与对账 → 真正的「增量投递」入口
      yield html
        .div({ class: "log-rows", ref: (el: HTMLElement) => void (logEl = el) })
        .unsafe((n: GenNode) => {
          logNode = n; // 插入由 runInsert 调 n.insert 完成
        });
    });

    // ⑨ 列表块「不断消费」一个 async generator：来一条挂一条，不重跑、不查表
    yield html.div({ class: "stream-log" }, function* () {
      yield html.div({
        class: "panel-title",
        text: "⑨ 生成器驱动列表：inbox → async generator → node.insert",
      });
      yield html
        .div({ class: "log-rows feed", ref: (el: HTMLElement) => void (feedEl = el) })
        .unsafe((n: GenNode) => {
          feedNode = n;
        });
    });
  });

  yield html.div({ class: "panel side" }, function* () {
    yield html.div({ class: "panel-title", text: "增量指标（每次操作动几个 DOM 节点）" });
    yield html.pre({ class: "report", text: () => report.value.join("\n") || "（运行中…）" });

    yield html.div({ class: "row" }, function* () {
      yield html.button({ class: "btn", text: "① 追加一条（keyed）", onClick: () => void runAppend(true) });
      yield html.button({ class: "btn", text: "② 追加一条（无 key）", onClick: () => void runAppend(false) });
    });
    yield html.div({ class: "row" }, function* () {
      yield html.button({ class: "btn", text: "③ 流式吐 20 字", onClick: () => void runStream() });
      yield html.button({ class: "btn", text: "④ insert 追加一条", onClick: () => void runInsert() });
    });
    yield html.div({ class: "row" }, function* () {
      yield html.button({ class: "btn", text: "⑤ 一次写 2 条", onClick: () => void runBulk(true) });
      yield html.button({ class: "btn", text: "⑥ 分 2 次写", onClick: () => void runBulk(false) });
    });
    yield html.div({ class: "row" }, function* () {
      yield html.button({ class: "btn", text: "⑦ 一次写 10 次", onClick: () => void runBurst() });
      yield html.button({ class: "btn", text: "⑨ 发送一条（走生成器）", onClick: () => void runFeed() });
    });
    yield html.div({ class: "row" }, function* () {
      yield html.button({ class: "btn", text: "重置", onClick: () => resetAll() });
      yield html.span({
        class: "hint",
        text: () => `keyed=${useKeys.value ? "on" : "off"} · 消息 ${messages.value.length} 条`,
      });
    });
  });
});

app.render(appSpec);

// ── ⑨ 消费循环：一行挂上「异步流 → 每条 insert」──────
// 原来这里是手写的 for await + insert（约 8 行）；封装成 mountStream 后只剩这一句。
const feed = feedNode as GenNode | null;
if (feed) {
  mountStream(feed, inbox.consume(), (m) => bubble(m, true), {
    key: (m) => `feed:${m.id}`,
  });
}

// ── 场景 ────────────────────────────────────────────────────

function addMessage(role: Msg["role"], text: string): Msg {
  const m: Msg = { id: nextId(), role, text };
  messages.value = [...messages.value, m];
  return m;
}

/** ①/② 追加一条：对比「新建 1 个节点」与「整列表重建」 */
async function runAppend(keyed: boolean): Promise<void> {
  useKeys.value = keyed;
  await tick(); // 让开关生效的这次重跑先跑完（不计入测量）
  const { m, rc, rewrites } = await commit(
    () => void addMessage("user", keyed ? "带 key 追加" : "无 key 追加"),
    listEl,
  );
  pushReport(
    [
      keyed ? "① keyed 追加（DOM 增量）" : "② 无 key 追加（DOM 全量重建）",
      `  生成器重跑: ${rewrites} 次（每次都从头 yield 整列表，yield 结果不保存）`,
      `  本轮 yield: ${rc.yielded} 个 spec → 查 key 表: 复用 ${rc.reused} / 新建 ${rc.created} / 移除 ${rc.removed}`,
      `  身份表 keyedChildren: ${rc.table} 项`,
      `  真实 DOM: 新建 ${m.added} / 移除 ${m.removed}`,
    ].join("\n"),
  );
}

/** ⑤/⑥ 对照：一次写 2 条（1 次提交）vs 分 2 次写（2 次提交） */
async function runBulk(batched: boolean): Promise<void> {
  useKeys.value = true;
  await tick();
  const mk = (i: number): Msg => ({ id: nextId(), role: "user", text: `批量消息 ${i}` });
  const sum = { added: 0, removed: 0, reused: 0, created: 0, pruned: 0, yielded: 0, rewrites: 0 };
  const apply = async (batch: Msg[]): Promise<void> => {
    const { m, rc, rewrites } = await commit(
      () => void (messages.value = [...messages.value, ...batch]),
      listEl,
    );
    sum.added += m.added;
    sum.removed += m.removed;
    sum.reused += rc.reused;
    sum.created += rc.created;
    sum.pruned += rc.removed;
    sum.yielded += rc.yielded;
    sum.rewrites += rewrites;
  };
  if (batched) await apply([mk(1), mk(2)]);
  else {
    await apply([mk(1)]);
    await apply([mk(2)]);
  }
  pushReport(
    [
      batched ? "⑤ 一次写 2 条（同一次提交）" : "⑥ 分 2 次写（两次提交）",
      `  生成器重跑: ${sum.rewrites} 次　← 每次 signal 写都**同步**重跑，没有攒批的时钟`,
      `  累计 yield: ${sum.yielded} 个 spec（每次重跑都把当前整列表 yield 一遍）`,
      `  累计查表: 复用 ${sum.reused} / 新建 ${sum.created} / 移除 ${sum.pruned}`,
      `  真实 DOM: 新建 ${sum.added} / 移除 ${sum.removed}`,
      batched ? "  → 一次写 = 一次对账：3 旧 + 2 新 → 5 个 spec，2 次 miss" : "  → 两次写 = 两次对账：(3+1) 然后 (4+1)",
    ].join("\n"),
  );
}

/** ③ 同一条消息内流式吐字：0 个节点新增 */
async function runStream(): Promise<void> {
  const bot = addMessage("bot", "");
  await tick();
  startMeasure(listEl);
  const before = reruns();
  const chars = "同一条消息内流式吐字，只改文本不动节点。".split("");
  for (let i = 0; i < 20; i++) {
    stream.value = { id: bot.id, buf: chars.slice(0, i + 1).join("") };
    await new Promise((r) => setTimeout(r, 12));
  }
  const delta = reruns() - before;
  stream.value = { id: null, buf: "" };
  await tick();
  const m = stopMeasure();
  pushReport(
    [
      "③ 同一条气泡内流式吐字（props getter）",
      `  新建 DOM 节点: ${m.added}`,
      `  移除 DOM 节点: ${m.removed}`,
      `  generator 重跑: ${delta} 次（0 = 没重跑，文本按 effect 直接 patch）`,
    ].join("\n"),
  );
}

/** ④ 真·增量投递：流来一条 insert 一条，generator 一次都不重跑 */
async function runInsert(): Promise<void> {
  if (!logNode) {
    pushReport("④ 日志容器还没挂好（等一下再点）");
    return;
  }
  startMeasure(logEl);
  const before = reruns();
  const id = nextId();
  logNode.insert(html.div({ class: "log-row", text: `stream item #${id}` }), { key: `log:${id}` });
  const delta = reruns() - before;
  await tick();
  const m = stopMeasure();
  pushReport(
    [
      "④ node.insert（真·增量投递，不经过 yield）",
      `  新建 DOM 节点: ${m.added}`,
      `  移除 DOM 节点: ${m.removed}`,
      `  generator 重跑: ${delta} 次（0 = 整棵树没重算）`,
      "  → 流式消息（SSE / RPC 推送）用这条最省",
    ].join("\n"),
  );
}

/** ⑦ 一次事件里写同一条信号 10 次：量「同步 effect 会不会攒批」 */
async function runBurst(): Promise<void> {
  useKeys.value = true;
  seed(3);
  await tick();
  startMeasure(listEl);
  const r0 = reruns();
  // 完全同步的 10 次写（模拟一个 click 处理器里反复赋值）
  for (let i = 0; i < 10; i++) {
    messages.value = [...messages.value, { id: nextId(), role: "user", text: `突发 ${i + 1}` }];
  }
  const rewrites = reruns() - r0;
  await tick();
  const m = stopMeasure();
  pushReport(
    [
      "⑦ 一个事件里同步写 10 次（10 个不同值）",
      `  生成器重跑: ${rewrites} 次　← 同步 effect：写几次就重跑几次，没有攒批`,
      `  累计 yield: ${(3 + 12) * 10 / 2} 个 spec（3+4+…+12，越写越贵）`,
      `  真实 DOM: 新建 ${m.added} / 移除 ${m.removed}`,
      "  → 一个事件里改多处状态，要么一次性写完，要么先攒在局部变量里最后赋一次",
    ].join("\n"),
  );

  // 同样写 10 次，但值不变（Object.is 跳过）
  const arr = messages.value;
  const r1 = reruns();
  for (let i = 0; i < 10; i++) messages.value = arr;
  const same = reruns() - r1;
  pushReport(
    [
      "⑧ 同样写 10 次，但值相同（同一个数组引用）",
      `  生成器重跑: ${same} 次　← Object.is 相等直接 return，一次都不触发`,
      "  → 这也是为什么追加要 `[...prev, m]`：原地 push 不改引用 = 界面不动",
    ].join("\n"),
  );
}

/** ⑨ 按按钮 → 往消息源塞一块 → 消费循环挂一条（真正的「单条增量」） */
async function runFeed(): Promise<void> {
  if (!feedNode) {
    pushReport("⑨ 容器还没挂好（等一下再点）");
    return;
  }
  startMeasure(feedEl);
  const r0 = reruns();
  const m: Msg = { id: nextId(), role: "user", text: `生成器消息 #${seq}` };
  inbox.push(m);
  await tick();
  const rewrites = reruns() - r0;
  const mm = stopMeasure();
  pushReport(
    [
      "⑨ 按钮 → 消息源 → async generator → node.insert",
      `  列表重跑块: ${rewrites} 次　← 一次都没跑（只 append）`,
      `  真实 DOM: 新建 ${mm.added} / 移除 ${mm.removed}　← 只挂这一条，无集合比对`,
      "  → 这就是「不通过集合比对就能增量增加」；代价：列表不可重排、不可整表重渲染",
    ].join("\n"),
  );
}

function resetAll(): void {
  messages.value = [];
  stream.value = { id: null, buf: "" };
  report.value = [];
}

/** 用一次写把列表铺成 n 条（不产生测量噪音） */
function seed(n: number): void {
  messages.value = Array.from({ length: n }, (_, i) => ({
    id: nextId(),
    role: "user" as const,
    text: `消息 ${i + 1}`,
  }));
}

// ── 首次自动跑一遍（页面加载就能看到数字） ──────────────────
void (async () => {
  useKeys.value = true;

  // 你举的例子：DIV 里已有 3 个 span，再 yield 2 个
  seed(3);
  await tick();
  await runBulk(true);
  seed(3);
  await tick();
  await runBulk(false);

  // 其余场景
  seed(1);
  await tick();
  await runAppend(true);
  await runAppend(false);
  await runStream();
  await runInsert();
  await runBurst();
  await runFeed();
  await runFeed();
})();
