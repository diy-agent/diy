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
  }),
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

  // 输入区域
  app.column().cell(() => {
    app.label(`> ${inputValue.value}${inputValue.value ? "" : "_"}`);
  });

  app.spacer();
  app.label("  Type text, Enter to add to list • q to quit");
});

// 全局输入处理 —— 参考 original reactive_example
app.addInputListener((data: string) => {
  // Enter 提交
  if (data === "\r" || data === "\n") {
    if (inputValue.value.trim()) {
      messages.value = [...messages.value, inputValue.value.trim()];
      inputValue.value = "";
    }
    return { consume: true };
  }

  // Backspace
  if (data === "\x7f" || data === "\b") {
    inputValue.value = inputValue.value.slice(0, -1);
    return { consume: true };
  }

  // 普通可打印字符（排除控制字符）
  const code = data.charCodeAt(0);
  if (data.length === 1 && code >= 32 && code !== 127) {
    inputValue.value += data;
    return { consume: true };
  }

  return undefined;
});

app.mount();
app.run();
