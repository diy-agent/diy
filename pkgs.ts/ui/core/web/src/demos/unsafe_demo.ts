import { DslApp } from "../../../src/providers/dom-dsl.js";
import { GenApp, html, type Spec } from "../../../src/providers/dom-gen.js";

/**
 * unsafe_demo —— 演示「节点方法 + `.unsafe`」这套通用逃生口（A/B 各一份，行为一致）。
 *
 * 三种用法：
 *   ① 容器模式：节点自己 `insert/remove(key)`（`.rows` 按 items 对齐）；
 *   ② 自身更新：`n.removeSelf()`（`.note` 随信号消失）；
 *   ③ 跨层搬运：`n.parent(".extra")?.insert(...)`（`.ghost` 往祖先容器插一行）。
 *
 * 纪律：**一张 key 表 = 一个管理者**（所以 `.rows` 与 `.extra` 分开，各管各的 key）。
 */

interface DemoState {
  items: number;
  rows: number;
  note: boolean;
  ghostRow: boolean;
}

function expose(name: string, get: () => DemoState): void {
  (window as unknown as Record<string, unknown>)[name] = { state: get };
}

// ── A 风格 ──────────────────────────────────────────────────

export function unsafeDemoA(mount: HTMLElement): void {
  const app = new DslApp({ mount });
  const items = app.signal<string[]>([]);
  const showNote = app.signal(true);
  const ghost = app.signal(false);

  // ① 容器模式：节点自己 insert/remove，按 items 对齐
  app.div({ class: "rows" }).unsafe((n) => {
    const want = new Set(items.value);
    for (const k of [...(n.keyedChildren?.keys() ?? [])]) {
      if (typeof k === "string" && k.startsWith("row:") && !want.has(k)) n.remove(k);
    }
    for (const it of items.value) {
      const key = `row:${it}`;
      if (!n.has(key)) n.insert((slot) => slot.div({ class: "row", text: it }), { key });
    }
  });

  // ③ 跨层搬运：`.ghost` 自己往祖先 `.extra` 插一行 / 移除
  app.div({ class: "extra" }).insert(
    (slot) =>
      slot.div({ class: "ghost" }).unsafe((n) => {
        const c = n.parent(".extra");
        if (!c) return;
        if (ghost.value) {
          if (!c.has("ghost")) c.insert((s) => s.div({ class: "row row-ghost", text: "来自 parent 插入" }), { key: "ghost" });
        } else {
          c.remove("ghost");
        }
      }),
    { key: "_ghost" },
  );

  // ② 自身更新：removeSelf
  app.div({ class: "note", text: "⚠️ 可移除的通知" }).unsafe((n) => {
    if (!showNote.value) n.removeSelf();
  });

  app.div({ class: "bar" }, (d) => {
    d.button({ class: "btn", text: "＋行", onClick: () => (items.value = [...items.value, `行#${items.value.length + 1}`]) });
    d.button({ class: "btn", text: "－行", onClick: () => (items.value = items.value.slice(0, -1)) });
    d.button({ class: "btn", text: "切换 ghost", onClick: () => (ghost.value = !ghost.value) });
    d.button({ class: "btn", text: "移除通知", onClick: () => (showNote.value = false) });
  });

  expose("__unsafeA", () => ({
    items: items.value.length,
    rows: mount.querySelectorAll(".rows > .row:not(.row-ghost)").length,
    note: !!mount.querySelector(".note"),
    ghostRow: !!mount.querySelector(".row-ghost"),
  }));
}

// ── B 风格 ──────────────────────────────────────────────────

export function unsafeDemoB(mount: HTMLElement): void {
  const app = new GenApp({ mount });
  const items = app.signal<string[]>([]);
  const showNote = app.signal(true);
  const ghost = app.signal(false);

  const rowsSpec: Spec = html.div({ class: "rows" }).unsafe((n) => {
    const want = new Set(items.value);
    for (const k of [...(n.keyedChildren?.keys() ?? [])]) {
      if (typeof k === "string" && k.startsWith("row:") && !want.has(k)) n.remove(k);
    }
    for (const it of items.value) {
      const key = `row:${it}`;
      if (!n.has(key)) n.insert(html.div({ class: "row", text: it }), { key });
    }
  });

  const extraSpec: Spec = html.div({ class: "extra" }).unsafe((n) => {
    if (n.has("_ghost")) return;
    n.insert(
      html.div({ class: "ghost" }).unsafe((g) => {
        const c = g.parent(".extra");
        if (!c) return;
        if (ghost.value) {
          if (!c.has("ghost")) c.insert(html.div({ class: "row row-ghost", text: "来自 parent 插入" }), { key: "ghost" });
        } else {
          c.remove("ghost");
        }
      }),
      { key: "_ghost" },
    );
  });

  app.render(
    rowsSpec,
    extraSpec,
    html.div({ class: "note", text: "⚠️ 可移除的通知" }).unsafe((n) => {
      if (!showNote.value) n.removeSelf();
    }),
    html.div({ class: "bar" }, function* () {
      yield html.button({ class: "btn", text: "＋行", onClick: () => (items.value = [...items.value, `行#${items.value.length + 1}`]) });
      yield html.button({ class: "btn", text: "－行", onClick: () => (items.value = items.value.slice(0, -1)) });
      yield html.button({ class: "btn", text: "切换 ghost", onClick: () => (ghost.value = !ghost.value) });
      yield html.button({ class: "btn", text: "移除通知", onClick: () => (showNote.value = false) });
    }),
  );

  expose("__unsafeB", () => ({
    items: items.value.length,
    rows: mount.querySelectorAll(".rows > .row:not(.row-ghost)").length,
    note: !!mount.querySelector(".note"),
    ghostRow: !!mount.querySelector(".row-ghost"),
  }));
}
