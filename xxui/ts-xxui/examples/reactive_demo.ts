/**
 * reactive_demo.ts — 计数器 + 输入联动示例
 * 对应 xx-tui examples/reactive_example.ts
 *
 * 运行：npx tsx examples/reactive_demo.ts
 * 退出：按 q 或 Ctrl+C
 */

import { App, ImmediateScheduler } from "../src/index.js";
import { ScopeConfig } from "../src/scope.js";

const app = new App(
  new ScopeConfig({
    mode: "dev",
    scheduler: new ImmediateScheduler(),
  })
);

// 响应式状态
const count = app.signal(0);
const inputValue = app.signal("");
const messages = app.signal<string[]>([]);

// 模拟定时器：计数自增
setInterval(() => {
  count.value++;
}, 1000);

app.column(() => {
  app.label("# 🧪 ts-xxui Reactive Demo");

  // 消息历史面板
  app.column().cell(() => {
    if (messages.value.length > 0) {
      app.label("--- History ---");
      for (const msg of messages.value.slice(-10)) {
        app.label(`» ${msg}`);
      }
    }
  });

  // 状态显示
  app.column().cell(() => {
    app.label(`Counter: ${count.value}`);
    app.label(`Input:   ${inputValue.value || "(empty)"}`);
  });

  // 输入交互（简化版，使用 pi-tui Input）
  app.textInput({
    value: inputValue.value,
    placeholder: "Type message...",
    onSubmit: (v) => {
      if (v.trim()) {
        messages.value = [...messages.value, v.trim()];
        inputValue.value = "";
      }
    },
  });

  app.spacer();
  app.label("  Type something and press Enter to add to list");
});

app.mount();
app.run();
