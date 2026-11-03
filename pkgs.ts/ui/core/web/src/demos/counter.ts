import { DomApp } from "../../../src/providers/dom.js";

/** 最小验证：signal + cell rerun。对照 examples/counter.ts（TUI 版）。 */
export function counterDemo(el: HTMLElement): void {
  const app = new DomApp({ mount: el });
  const count = app.signal(0);

  app.column(() => {
    app.label("# 🧪 diy-ui web · Counter");

    app.row(() => {
      app.button({ name: "-1", onClick: () => { count.value--; } });
      app.button({ name: "+1", onClick: () => { count.value++; } });
    });

    // Cell：count 变化时自动 rerun（清空重建这一列）
    app.column().cell(() => {
      app.label(`Count: ${count.value}`);
    });
  });

  app.mount();
}
