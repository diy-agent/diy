import { DomApp } from "../../../src/providers/dom.js";

/** 计数器 + 输入联动。对照 examples/reactive_demo.ts（TUI 版）。 */
export function reactiveDemo(el: HTMLElement): void {
  const app = new DomApp({ mount: el });

  const count = app.signal(0);
  const inputValue = app.signal("");
  const messages = app.signal<string[]>([]);

  // 模拟定时器：计数自增
  setInterval(() => { count.value++; }, 1000);

  app.column(() => {
    app.label("# 🧪 diy-ui web · Reactive");

    // 消息历史（依赖 messages）
    app.column().cell(() => {
      if (messages.value.length === 0) return;
      app.label("--- History ---");
      for (const msg of messages.value.slice(-10)) app.label(`» ${msg}`);
    });

    // 状态显示（依赖 count + inputValue）
    app.column().cell(() => {
      app.label(`Counter: ${count.value}`);
      app.label(`Input:   ${inputValue.value || "(empty)"}`);
    });

    app.input({
      placeholder: "输入后回车加入列表",
      onInput: (v) => { inputValue.value = v; },
      onEnter: (v) => {
        if (v.trim()) {
          messages.value = [...messages.value, v.trim()];
          inputValue.value = "";
        }
      },
    });

    app.label("Type text, Enter to add.");
  });

  app.mount();
}
