// tests/ui-drive.ts
// 🎯 第二种测试能力：**真实 UI 操作**（点击 / 拖动 / 输入），走 CDP 的 Input 域。
//
// 为什么要有这一层（两种测试分工，见 133 的讨论）：
//   ① CLI 操纵 UI 状态（`ui tab open` / `ui view set` / `ui layout set`）
//      —— 验证**核心能力**：状态机、契约、数据流。快、稳、可断言细节。
//   ② 真实 UI 操作（本文件）
//      —— 验证**界面真的可交互**：按钮点得动、拖线服帖、输入框收字。
//      没有 ① 就验不了核心能力，没有 ② 就不知道界面是否真的有效。
//
// 机制：`Input.dispatchMouseEvent` 是 Chromium 的**原生输入注入**，事件走完整
// 命中测试 → 捕获/冒泡 → 默认行为链，与真人点鼠标同路径（不是 `element.click()`
// 那种绕过命中测试的合成调用）。坐标从 `ui inspect` 的 a11y 树 rect 来。
//
// 为什么不用 element.click()：它跳过分层/遮挡判断，点击被浮层挡住也「成功」，
// 于是测试永远绿 —— 这类假绿正是要避免的。
import WebSocket from "ws";
import { waitUntil } from "./wait";

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** 极简 CDP 客户端：够用即止（只要 Input / Runtime 两个域） */
class Cdp {
  private ws!: WebSocket;
  private seq = 1;
  private pending = new Map<number, (v: unknown) => void>();

  static async attach(baseWsUrl: string): Promise<Cdp> {
    // 浏览器级 ws 不能直接 dispatch 输入事件 —— 要附到具体的 page target 上
    const port = new URL(baseWsUrl).port;
    const list: CdpTarget[] = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("[ui-drive] 没有可用的 page target");

    const cdp = new Cdp();
    cdp.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      cdp.ws.once("open", () => res());
      cdp.ws.once("error", (e) => rej(e));
    });
    cdp.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; result?: unknown };
      if (msg.id && cdp.pending.has(msg.id)) {
        cdp.pending.get(msg.id)!(msg.result);
        cdp.pending.delete(msg.id);
      }
    });
    return cdp;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.seq++;
    return new Promise<T>((res) => {
      this.pending.set(id, (v) => res(v as T));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在 renderer 里求值（拿 DOM 尺寸、读状态用） */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result?: { value?: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

/** a11y 树节点（`ui inspect` 的输出结构） */
export interface A11yNode {
  role: string;
  text: string;
  value?: string;
  rect?: { x: number; y: number; w: number; h: number };
  children?: A11yNode[];
}

/**
 * 在 a11y 树里找一个节点（深度优先，先子后…… 不，按出现顺序）。
 * `match` 收到的 text 已 trim；返回 rect 中心点（点击用）。
 */
export function findClickable(
  tree: A11yNode | undefined,
  match: (text: string, node: A11yNode) => boolean,
): { text: string; x: number; y: number } | undefined {
  if (!tree) return undefined;
  // 有 rect 且不退化（0×0 的不可点）
  if (tree.rect && tree.rect.w > 0 && tree.rect.h > 0 && match(tree.text.trim(), tree)) {
    return { text: tree.text.trim(), x: tree.rect.x + tree.rect.w / 2, y: tree.rect.y + tree.rect.h / 2 };
  }
  for (const c of tree.children ?? []) {
    const hit = findClickable(c, match);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 真实点击的驱动器。用法：
 *   const ui = await makeUiDriver(electron.cdpUrl, () => fx.sh.getJson("./diy.sh ui inspect"));
 *   await ui.click("① left");            // 按可见文本找元素并点击
 *   await ui.drag(from, to);             // 拖线（拖动不了时的退路是只点全屏/开合）
 */
export interface UiDriver {
  /** 按文本找元素并真实点击（找不到 / 不可见 → 抛错，不静默跳过） */
  click(text: TextMatch): Promise<void>;
  /**
   * 悬停到元素上（发 mouseMoved）。
   *
   * ⚠️ 实测局限：CDP 的 `Input.dispatchMouseEvent` **不会**让 Chromium 更新
   * CSS `:hover` 状态（`:hover` 由真实输入设备的鼠标位置驱动，DevTools 注入的事件
   * 只做命中测试与派发）。所以对「hover 才显形」的控件（tab 的 ✕、
   * `group-hover:opacity-70` 之类），本方法**不足以**让它们进 a11y 树。
   * 这类元素用 `clickSelector` 按 DOM 坐标点（见下）。
   */
  hover(text: TextMatch): Promise<void>;
  /**
   * 按 CSS 选择器定位 → 在**元素中心真实派发**鼠标按下/抬起。
   *
   * 为什么需要（不是绕路）：`ui inspect` 的 a11y 树会剔除 `opacity: 0` 的元素，
   * 而这类元素（tab 的 ✕、area 角标）**仍然命中测试正常**（opacity 不关闭 pointer
   * events），真人也是 hover 后直接点的。a11y 树看不到 ≠ 点不到。
   * 定位用 DOM、发送用 CDP 原生事件 —— 命中测试那一层仍然是真的。
   */
  clickSelector(selector: string, opts?: { nth?: number }): Promise<void>;
  /** 读 DOM（拿 rect / 计算样式等；a11y 树看不到的东西用这个） */
  query<T>(expression: string): Promise<T>;
  /** 按坐标拖拽（拖线用）；steps 让中间点也发出去，命中拖拽逻辑 */
  drag(from: { x: number; y: number }, to: { x: number; y: number }, steps?: number): Promise<void>;
  /** 在 renderer 里求值 */
  eval<T>(expr: string): Promise<T>;
  close(): void;
}

/** 匹配谓词：字符串 = 文本包含；函数 = 自定义（拿得到整个节点，可按 role/rect 过滤） */
export type TextMatch = string | ((text: string, node: A11yNode) => boolean);

export async function makeUiDriver(
  cdpUrl: string | null,
  inspect: () => Promise<A11yNode | undefined>,
): Promise<UiDriver> {
  if (!cdpUrl) throw new Error("[ui-drive] 该实例没有 CDP 端点（启动时拿不到 DevToolsActivePort）");
  const cdp = await Cdp.attach(cdpUrl);

  const mouse = (type: string, p: { x: number; y: number }, extra: Record<string, unknown> = {}) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x: Math.round(p.x),
      y: Math.round(p.y),
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
      ...extra,
    });

  /** 取树并按谓词定位（每次现取：上一步操作会让 rect 变） */
  const locate = async (target: TextMatch) => {
    const match =
      typeof target === "function" ? target : (t: string) => t.includes(target);
    const found = await waitUntil(
      async () => findClickable(await inspect(), match),
      (v) => !!v,
      { label: `找可点元素 ${typeof target === "string" ? target : "（谓词）"}` },
    );
    if (!found) {
      throw new Error(
        `[ui-drive] 找不到可点元素：${typeof target === "string" ? target : "（谓词）"}` +
          `（不存在、不可见（opacity:0 会被 a11y 树剔除），或尺寸为 0）`,
      );
    }
    return found;
  };

  return {
    async click(text) {
      const target = await locate(text);
      await mouse("mousePressed", target);
      await mouse("mouseReleased", target);
      // 让 Solid 的响应式更新走完（点击 → state 变 → DOM 重渲染）
      await new Promise((r) => setTimeout(r, 120));
    },

    async hover(text) {
      const target = await locate(text);
      await mouse("mouseMoved", target);
      await new Promise((r) => setTimeout(r, 150));
    },

    async clickSelector(selector, opts = {}) {
      const nth = opts.nth ?? 0;
      const sample = () =>
        cdp.eval<{ x: number; y: number } | string>(
          `(() => {
             const els = document.querySelectorAll(${JSON.stringify(selector)});
             const el = els[${nth}];
             if (!el) return "NOT_FOUND";
             const r = el.getBoundingClientRect();
             if (r.width === 0 || r.height === 0) return "ZERO_SIZE";
             return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
           })()`,
        );

      // 等坐标**连续两次一致**再点。
      // 实测教训：侧栏展开是 `transition-[width] duration-200`，pin 之后立刻取坐标
      // 拿到的是动画中间值，等事件派发到浏览器时按钮已经移走 —— 点击落到别处，
      // 表现为「点了没反应」（tab 没关掉，但也没有报错）。真人不会点中途的元素。
      let point = await sample();
      if (typeof point === "string") {
        throw new Error(`[ui-drive] 选择器定位失败（${point}）: ${selector}[${nth}]`);
      }
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 40));
        const next = await sample();
        if (typeof next === "string") {
          throw new Error(`[ui-drive] 选择器定位失败（${next}）: ${selector}[${nth}]`);
        }
        if (Math.abs(next.x - point.x) < 1 && Math.abs(next.y - point.y) < 1) {
          point = next;
          break;
        }
        point = next;
      }
      await mouse("mousePressed", point);
      await mouse("mouseReleased", point);
      await new Promise((r) => setTimeout(r, 120));
    },

    query: (expression) => cdp.eval(expression),

    async drag(from, to, steps = 8) {
      await mouse("mousePressed", from);
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await mouse("mouseMoved", { x, y });
      }
      await mouse("mouseReleased", to);
      await new Promise((r) => setTimeout(r, 120));
    },

    eval: (expr) => cdp.eval(expr),
    close: () => cdp.close(),
  };
}
