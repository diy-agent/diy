import { GenApp, html, mountStream, Signal, type GenNode } from "../../../src/browser.js";

/**
 * stream —— **只属于 B 风格**的能力：异步流 → 每条 insert（真·增量投递）。
 *
 * A 风格（`app.column().cell(...)`）没有对应写法：它的最小更新单位是「重跑整块」。
 * `mountStream` 把「一条一条来」做成零重跑：列表重跑块一次都不 drain，
 * 没有 key 查表、没有 reorder，只有 append。
 *
 * 三个按钮：
 *   ① 手动发送（等价于用户在 chat 里发消息）
 *   ② 模拟 SSE（后台持续推送 10 条）
 *   ③ 停止消费（取消循环，验证不泄漏）
 */

interface Chunk {
  id: number;
  text: string;
}

/** 可增长的异步源：push 多少就能消费多少（等价于 SSE / RPC 推送队列） */
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
        const v = buf.shift();
        if (v !== undefined) {
          yield v;
          continue;
        }
        yield await new Promise<T>((r) => waiters.push(r));
      }
    },
  };
}

const hhmmss = (): string => new Date().toLocaleTimeString("zh-CN", { hour12: false });

export function streamDemo(el: HTMLElement): void {
  const app = new GenApp({ mount: el });
  const inbox = createInbox<Chunk>();
  const sent = new Signal(0);
  const shown = new Signal(0);
  const rerunCount = new Signal(0);

  let seq = 0;
  let listNode: GenNode | null = null;
  let stop: (() => void) | null = null;
  let sse: number | null = null;

  const send = (): void => {
    seq++;
    inbox.push({ id: seq, text: `消息 #${seq}（${hhmmss()}）` });
    sent.value++;
  };

  const startStream = (): void => {
    if (!listNode) return;
    stop?.();
    stop = mountStream(listNode, inbox.consume(), (c) => html.div({ class: "chat-msg", text: `💬 ${c.text}` }), {
      key: (c) => c.id,
      onError: (e) => console.error("[streamDemo]", e),
    });
  };

  app.render(
    html.div({ class: "panel-body" }, function* () {
      yield html.div({ class: "panel-tag", text: "B · mountStream（异步流 → 每条 insert，0 重跑）" });

      yield html.div({ class: "panel-row" }, function* () {
        yield html.button({ class: "panel-btn", text: "① 发送一条", onClick: send });
        yield html.button({
          class: "panel-btn",
          text: "② 模拟 SSE ×10",
          onClick: () => {
            if (sse !== null) return;
            let n = 0;
            sse = window.setInterval(() => {
              send();
              if (++n >= 10) {
                window.clearInterval(sse as number);
                sse = null;
              }
            }, 300);
          },
        });
        yield html.button({
          class: "panel-btn",
          text: "③ 停止消费",
          onClick: () => {
            stop?.();
            stop = null;
          },
        });
      });

      yield html.div({
        class: "panel-out",
        text: () => `已发送 ${sent.value} 条 · 已上屏 ${shown.value} 条 · 列表重跑 ${rerunCount.value} 次`,
      });

      yield html
        .div({ class: "chat-list" })
        .unsafe((n: GenNode) => {
          listNode = n;
          startStream();
        });
    }),
  );

  // 「已上屏」直接数 DOM（不掺框架内部计数），顺便读取列表块的重跑次数
  window.setInterval(() => {
    if (!listNode) return;
    const n = listNode.el.childElementCount;
    if (n !== shown.value) shown.value = n;
    const reruns = listNode.reruns;
    if (reruns !== rerunCount.value) rerunCount.value = reruns;
  }, 200);
}
