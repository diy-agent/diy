import { GenApp, html, Signal } from "../../../src/browser.js";

/**
 * counter —— **B 风格**（dom-gen / pull）对照 `counter.ts`（A 风格 / eager）。
 *
 * 同功能，差别在更新粒度：
 *   A：`app.column().cell(...)` → 信号一变**清空重建**这一列。
 *   B：重跑块只 yield 结构；`text: () => …` 是 getter → 只 patch 那个文本节点。
 */
export function counterGenDemo(el: HTMLElement): void {
  const app = new GenApp({ mount: el });
  const count = new Signal(0);

  app.render(
    html.div({ class: "panel-body" }, function* () {
      yield html.div({ class: "panel-tag", text: "B · yield html.div()" });
      yield html.div({ class: "panel-row" }, function* () {
        yield html.button({
          class: "panel-btn",
          text: "-1",
          onClick: () => {
            count.value--;
          },
        });
        yield html.button({
          class: "panel-btn",
          text: "+1",
          onClick: () => {
            count.value++;
          },
        });
      });
      yield html.div({ class: "panel-out", text: () => `Count: ${count.value}` });
    }),
  );
}
