/**
 * chat_demo.ts — chat 面板 + 按钮互动示例
 * 对应 xx-tui examples/example.ts
 *
 * 运行：npx tsx examples/chat_demo.ts
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

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const messages = app.signal<ChatMessage[]>([
  {
    role: "assistant",
    content: "Welcome! Type a message and press Enter.",
  },
]);
const inputValue = app.signal("");

function addMessage(content: string): void {
  if (!content.trim()) return;
  messages.value = [
    ...messages.value,
    { role: "user", content },
    {
      role: "assistant",
      content: `Echo: ${content}`,
    },
  ];
  inputValue.value = "";
}

app.column(() => {
  app.label("# 💬 ts-xxui Chat Demo");

  // Chat history（响应式列表）
  app.column().cell(() => {
    for (const msg of messages.value) {
      const prefix = msg.role === "user" ? "You:  " : "Bot:  ";
      app.label(`${prefix}${msg.content}`);
    }
  });

  app.spacer();

  // 输入区域
  app.row(() => {
    app.textInput({
      value: inputValue.value,
      placeholder: "Type a message...",
      onSubmit: (v) => addMessage(v),
    });

    app.button({ name: "Send" }).onClick = () => {
      addMessage(inputValue.value);
    };
  });

  app.spacer();
  app.label("  Type a message + Enter, or click Send");
});

app.mount();
app.run();
