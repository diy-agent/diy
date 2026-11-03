import { GenApp, html, mountStream, Signal, type GenNode } from "../../../src/browser.js";

/**
 * async cell —— **B 风格**对照 `async_cell_demo.ts`（A 风格：`cell(async function* (n))`）。
 *
 * A 里靠 async generator + 显式句柄 `n` 逐步 `n.label()`；B 里没有 async 生成器（同步 drain），
 * 等价物就是 `mountStream`：异步源 → 每条 insert。
 *
 * 关键差异：**A 重跑会整块清空重建；B 的 mountStream 根本不重跑**（历史行保留）。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): string => new Date().toLocaleTimeString("zh-CN", { hour12: false });

interface Task {
  name: string;
  color: string;
  delay: number;
}

const TASKS: Task[] = [
  { name: "A", color: "🔴", delay: 400 },
  { name: "B", color: "🔵", delay: 700 },
  { name: "C", color: "🟡", delay: 1200 },
];

async function* taskFlow(t: Task): AsyncGenerator<string> {
  yield `${t.color} **任务启动**`;
  for (let i = 1; i <= 5; i++) {
    await sleep(t.delay);
    yield `${t.color} ${t.name}: ${i}/5 @ ${now()}`;
  }
  yield `✅ ${t.name} 完成`;
}

function clearNode(node: GenNode): void {
  for (const k of [...(node.keyedChildren?.keys() ?? [])]) node.remove(k);
}

export function asyncCellGenDemo(el: HTMLElement): void {
  const app = new GenApp({ mount: el });
  const nodes: Array<GenNode | null> = TASKS.map(() => null);
  const stops: Array<(() => void) | null> = TASKS.map(() => null);
  let runId = 0;

  const runOne = (i: number): void => {
    const node = nodes[i];
    const t = TASKS[i];
    if (!node || !t) return;
    stops[i]?.();
    clearNode(node);
    const id = ++runId;
    stops[i] = mountStream(node, taskFlow(t), (line) => html.div({ class: "panel-line", text: line }), {
      key: (_line, k) => `${i}:${id}:${k}`,
    });
  };

  app.render(
    html.div({ class: "panel-body" }, function* () {
      yield html.div({ class: "panel-tag", text: "B · yield html.div() + mountStream" });
      yield html.button({
        class: "panel-btn",
        text: "🚀 Launch All",
        onClick: () => TASKS.forEach((_, i) => runOne(i)),
      });

      yield html.div({ class: "panel-row panel-cards" }, function* () {
        for (let i = 0; i < TASKS.length; i++) {
          const idx = i;
          const t = TASKS[idx] as Task;
          yield html.div({ class: "panel-card" }, function* () {
            yield html.div({ class: "panel-card-title", text: `Task ${t.name} (${t.delay}ms)` });
            yield html.button({
              class: "panel-btn",
              text: `Run ${t.name}`,
              onClick: () => runOne(idx),
            });
            yield html
              .div({ class: "panel-lines" })
              .unsafe((n: GenNode) => {
                nodes[idx] = n;
              });
          });
        }
      });
    }),
  );
}
