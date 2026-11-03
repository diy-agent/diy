import { GenApp, html, Signal } from "../../../src/browser.js";

/**
 * reactive —— **B 风格**（dom-gen / pull）对照 `reactive_demo.ts`（A 风格）。
 *
 * A：两个 cell（历史 / 状态）各自清空重建。
 * B：一个重跑块读两个信号；历史走 keyed 对账（只追加新行），状态走 getter（只改文本）。
 */
export function reactiveGenDemo(el: HTMLElement): void {
  const app = new GenApp({ mount: el });

  const count = new Signal(0);
  const inputValue = new Signal("");
  const messages = new Signal<string[]>([]);

  // 模拟定时器：计数自增
  setInterval(() => {
    count.value++;
  }, 1000);

  app.render(
    html.div({ class: "panel-body" }, function* () {
      yield html.div({ class: "panel-tag", text: "B · yield html.div()" });

      // 历史：keyed 子节点 → 追加一条只新建 1 个节点
      yield html.div({ class: "panel-history" }, function* () {
        const list = messages.value.slice(-10);
        if (list.length === 0) return;
        yield html.div({ class: "panel-muted", text: "--- History ---" });
        for (const msg of list) {
          yield html.div({ key: msg, class: "panel-line", text: `» ${msg}` });
        }
      });

      // 状态：text getter → 只 patch 文本
      yield html.div({
        class: "panel-out",
        text: () => `Counter: ${count.value}\nInput:   ${inputValue.value || "(empty)"}`,
      });

      yield html.input({
        class: "panel-input",
        placeholder: "输入后回车加入列表",
        onInput: (e) => {
          inputValue.value = (e.target as HTMLInputElement).value;
        },
        onEnter: (e) => {
          const v = (e.target as HTMLInputElement).value;
          if (v.trim()) {
            messages.value = [...messages.value, v.trim()];
            inputValue.value = "";
            (e.target as HTMLInputElement).value = "";
          }
        },
      });

      yield html.div({ class: "panel-muted", text: "Type text, Enter to add." });
    }),
  );
}
