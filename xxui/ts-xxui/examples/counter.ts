/**
 * counter.ts — 最小验证示例
 * 验证目标：signal + cell + rerun 基本流程
 *
 * 运行：npx tsx examples/counter.ts
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

const count = app.signal(0);

app.column(() => {
  app.label("# 🧪 ts-xxui Counter Demo");

  app.row(() => {
    app.button({ name: "-1" }).onClick = () => {
      count.value--;
    };
    app.button({ name: "+1" }).onClick = () => {
      count.value++;
    };
  });

  // Cell：count 变化时自动 rerun
  app.column().cell(() => {
    app.label(`Count: ${count.value}`);
  });
});

app.mount();
app.run();
