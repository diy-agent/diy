import { DomApp, type DomInput } from "../../../src/providers/dom.js";

/** 消息列表 + 提交。对照 examples/chat_demo.ts（TUI 版）。 */
export function chatDemo(el: HTMLElement): void {
  const app = new DomApp({ mount: el });

  const inputValue = app.signal("");
  const messages = app.signal<string[]>(["hello", "world"]);

  let inputEl: DomInput | undefined;
  const send = (): void => {
    const text = inputValue.value.trim();
    if (!text) return;
    messages.value = [...messages.value, text];
    inputValue.value = "";
    if (inputEl) inputEl.value = "";
  };

  app.column(() => {
    app.label("# 🧪 diy-ui web · Chat");

    // 消息历史（响应式列表）
    app.column().cell(() => {
      if (messages.value.length === 0) {
        app.label("(empty)");
        return;
      }
      for (const msg of messages.value) app.label(`> ${msg}`);
    });

    app.row(() => {
      inputEl = app.input({
        placeholder: "message...",
        onInput: (v) => { inputValue.value = v; },
        onEnter: () => send(),
      });
      app.button({ name: "Send", onClick: () => send() });
    });
  });

  app.mount();
}
