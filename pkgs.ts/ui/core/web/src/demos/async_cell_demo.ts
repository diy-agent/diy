import { DomApp, type DomColumn } from "../../../src/providers/dom.js";

/** 异步刷新块 + 并发隔离。对照 examples/features/async_cell_demo.pn.py。 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): string => new Date().toLocaleTimeString("zh-CN", { hour12: false });

export function asyncCellDemo(el: HTMLElement): void {
  const app = new DomApp({ mount: el });

  const startAll = app.signal(0);

  app.label("# 🚀 异步刷新块 · 并发隔离");
  app.button({ name: "🚀 Launch All", onClick: () => { startAll.value++; } });

  app.row(() => {
    taskCard("A", "🔴", 400);
    taskCard("B", "🔵", 700);
    taskCard("C", "🟡", 1200);
  });

  function taskCard(name: string, color: string, delay: number): void {
    app.column((card) => {
      // 每个任务独立的局部信号
      const localRun = card.signal(0);
      card.button({ name: `Run ${name}`, onClick: () => { localRun.value++; } });

      // 独立 cell：读全局 + 局部信号（首段同步读 → 自动成为依赖）
      card.column().cell(async function* (n: DomColumn) {
        const trigger = startAll.value + localRun.value;
        if (trigger === 0) {
          n.label("  等待启动...");
          return;
        }
        n.label(`  ${color} **任务 #${trigger} 启动**`);
        for (let i = 0; i < 5; i++) {
          await sleep(delay);
          n.label(`  ${color} ${name}: ${i + 1}/5 @ ${now()}`);
        }
        n.label(`  ✅ ${name} 完成`);
      });
    });
  }
}
