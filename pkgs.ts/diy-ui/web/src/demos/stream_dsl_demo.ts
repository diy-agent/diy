import { DomApp } from "../../../src/providers/dom.js";

/**
 * stream —— **A 风格**对照 `stream_demo.ts`（B 风格 / mountStream）。
 *
 * A 没有「增量投递」入口：最小更新单位是 cell 重跑 → 每来一条消息都要
 * **清空整列 + 重建全部行**。消息越多越贵，但实现最直白、语义最简单。
 */

const hhmmss = (): string => new Date().toLocaleTimeString("zh-CN", { hour12: false });

export function streamDslDemo(el: HTMLElement): void {
  const app = new DomApp({ mount: el });
  const msgs = app.signal<string[]>([]);
  let seq = 0;

  const send = (): void => {
    seq++;
    msgs.value = [...msgs.value, `消息 #${seq}（${hhmmss()}）`];
  };

  app.column(() => {
    app.label("A · app.column().cell()（每条都整块重建）");

    app.row(() => {
      app.button({ name: "① 发送一条", onClick: send });
      app.button({
        name: "② 模拟 SSE ×10",
        onClick: () => {
          let n = 0;
          const t = setInterval(() => {
            send();
            if (++n >= 10) clearInterval(t);
          }, 300);
        },
      });
    });

    // 列表：每次 msgs 变化都清空重建
    app.column().cell(() => {
      app.label(`已发送 ${msgs.value.length} 条（每来一条整列重建）`);
      for (const m of msgs.value) app.label(`💬 ${m}`);
    });
  });

  app.mount();
}
