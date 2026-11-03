import { GenApp, html, mountStream, Signal, type GenNode } from "../../../src/browser.js";

/**
 * generator cell —— **B 风格**对照 `generator_cell_demo.ts`（A 风格，用 `n.label()` 逐步挂）。
 *
 * 这里能直接看出 A/B 的关键差异：
 *   ① A 的 generator cell 可以 `await`，所以三步是**真的分三次**上屏（Python 同理）。
 *   ② B 的 children 生成器是**同步 drain**：三步在同一轮里 yield 完 → **同时出现**。
 *   ③ 想在 B 里做到「逐条出现」，必须换成 `mountStream`（异步源 → 每条 insert）。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一个带节奏的异步源：每 400ms 吐一条 */
async function* steps(): AsyncGenerator<string> {
  yield "🔄 步骤 1/3：开始初始化...";
  await sleep(400);
  yield "🔄 步骤 2/3：处理数据...";
  await sleep(400);
  yield "✅ 步骤 3/3：完成！";
}

export function generatorCellGenDemo(el: HTMLElement): void {
  const app = new GenApp({ mount: el });
  const count = new Signal(1);
  let streamNode: GenNode | null = null;
  let stop: (() => void) | null = null;

  app.render(
    html.div({ class: "panel-body" }, function* () {
      yield html.div({ class: "panel-tag", text: "B · yield html.div()" });

      // ① 同步生成器：三个 yield 在同一轮 drain 完 → 同时出现
      yield html.div({ class: "panel-block" }, function* () {
        yield html.div({ class: "panel-muted", text: "① children 生成器（同步 drain → 同时出现）" });
        yield html.div({ class: "panel-line", text: "🔄 步骤 1/3" });
        yield html.div({ class: "panel-line", text: "🔄 步骤 2/3" });
        yield html.div({ class: "panel-line", text: "✅ 步骤 3/3" });
      });

      // ② 响应式：count 控制子节点数量（keyed，追加/移除只动差量）
      yield html.div({ class: "panel-block" }, function* () {
        yield html.div({ class: "panel-muted", text: "② 响应式列表（keyed 对账）" });
        for (let i = 0; i < count.value; i++) {
          yield html.div({ key: `item-${i}`, class: "panel-line", text: `  📄 item ${i + 1}` });
        }
      });

      yield html.div({ class: "panel-row" }, function* () {
        yield html.button({
          class: "panel-btn",
          text: "-1",
          onClick: () => {
            count.value = Math.max(0, count.value - 1);
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

      // ③ 逐条出现：必须换 mountStream（异步源 → 每条 insert，不重跑）
      yield html.div({ class: "panel-block" }, function* () {
        yield html.div({ class: "panel-muted", text: "③ mountStream（异步源 → 逐条 insert）" });
        yield html.div({ class: "panel-row" }, function* () {
          yield html.button({
            class: "panel-btn",
            text: "▶ 逐步播放",
            onClick: () => {
              stop?.();
              if (!streamNode) return;
              for (const k of [...(streamNode.keyedChildren?.keys() ?? [])]) streamNode.remove(k);
              stop = mountStream(streamNode, steps(), (line) =>
                html.div({ class: "panel-line", text: line }),
              );
            },
          });
        });
        yield html
          .div({ class: "panel-lines" })
          .unsafe((n: GenNode) => {
            streamNode = n;
          });
      });
    }),
  );
}
