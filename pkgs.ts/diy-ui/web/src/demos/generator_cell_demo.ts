import { DomApp, type DomColumn } from "../../../src/providers/dom.js";

/** generator cell（yield 步进挂载）+ 响应式重建。对照 examples/features/generator_cell_demo.pn.py。 */

export function generatorCellDemo(el: HTMLElement): void {
  const app = new DomApp({ mount: el });

  app.label("# 🧬 Generator Cell");

  // 基础：yield 步进
  app.column().cell(function* (n: DomColumn) {
    yield n.label("🔄 步骤 1/3：开始初始化...");
    yield n.label("🔄 步骤 2/3：处理数据...");
    yield n.label("✅ 步骤 3/3：完成！");
  });

  // 响应式：count 控制子节点数量
  const count = app.signal(1);
  app.column().cell(function* (n: DomColumn) {
    for (let i = 0; i < count.value; i++) {
      yield n.label(`  📄 item ${i + 1}`);
    }
  });

  app.row(() => {
    app.button({ name: "-1", onClick: () => { count.value = Math.max(0, count.value - 1); } });
    app.button({ name: "+1", onClick: () => { count.value++; } });
  });
}
