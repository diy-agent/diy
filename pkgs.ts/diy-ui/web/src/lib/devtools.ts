import { allNodes, nodeOf, setCaptureLoc, type TrackedNode } from "../../../src/providers/dom-dsl.js";

/**
 * rerun 诊断 devtools（A/B 两风格共用）。
 *
 * 交互（按用户口径）：
 *   1. 页面顶部一个「诊断」按钮；点开后，**所有 rerun cell 直接亮出自己的数字**（不加框）；
 *   2. 诊断状态下 hover 某个 cell，才额外加**高亮框 + 详情面板**（名称 / 类型 / 行 / 次数）。
 *
 * 数据来自 dom-dsl：`TrackedNode.rerunCell`（是否重跑块）、`reruns`、`loc`、`nodeOf`。
 * 数字只对**视口内**的 cell 渲染（离屏看不见，避免几千个浮层拖慢页面）。
 * 颜色：×1 绿 / ×2–3 黄 / ×>3 红。仅开发用。
 */
export function installDevtools(root: HTMLElement): void {
  // 打开调用点采集（此后创建的节点才有 `行`；关掉则零成本）
  setCaptureLoc(true);

  // 数字浮层（pointer-events:none，不挡交互）
  const layer = document.createElement("div");
  layer.id = "__devtools-layer";
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483645;";

  // hover 高亮框 + 详情面板
  const box = document.createElement("div");
  box.id = "__devtools-box";
  box.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;border:1px solid #f59e0b;" +
    "background:rgba(245,158,11,.10);border-radius:4px;display:none;";
  const detail = document.createElement("div");
  detail.id = "__devtools-detail";
  detail.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.6 ui-monospace,monospace;" +
    "padding:6px 9px;border-radius:6px;background:#0b1220;color:#e5e7eb;border:1px solid #334155;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;white-space:pre;max-width:420px;";

  const toggle = document.createElement("button");
  toggle.id = "__devtools-toggle";
  toggle.textContent = "诊断";
  toggle.style.cssText =
    "position:fixed;right:10px;top:10px;z-index:2147483647;font:12px ui-monospace,monospace;" +
    "padding:4px 12px;border-radius:6px;border:1px solid #555;background:#1f2937;color:#e5e7eb;cursor:pointer;";

  document.body.append(layer, box, detail, toggle);

  const color = (n: number): string => (n <= 1 ? "#16a34a" : n <= 3 ? "#d97706" : "#dc2626");
  const nameOf = (el: HTMLElement): string =>
    el.tagName.toLowerCase() + (el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : "");

  let enabled = false;
  const badges = new Map<HTMLElement, HTMLElement>();
  let raf = 0;
  let last = 0;

  const clearBadges = (): void => {
    for (const b of badges.values()) b.remove();
    badges.clear();
  };
  const hideHover = (): void => {
    box.style.display = "none";
    detail.style.display = "none";
  };

  const update = (): void => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const wanted = new Set<HTMLElement>();
    for (const n of allNodes) {
      if (!n.rerunCell || !root.contains(n.el)) continue;
      const r = n.el.getBoundingClientRect();
      if (r.bottom < -20 || r.top > vh + 20 || r.right < 0 || r.left > vw) continue;
      wanted.add(n.el);
      let b = badges.get(n.el);
      if (!b) {
        b = document.createElement("span");
        b.style.cssText =
          "position:absolute;pointer-events:none;font:10px/1.4 ui-monospace,monospace;padding:0 4px;" +
          "border-radius:3px;color:#fff;transform:translate(0,-100%);white-space:nowrap;";
        layer.append(b);
        badges.set(n.el, b);
      }
      b.style.left = `${Math.max(0, r.left)}px`;
      b.style.top = `${Math.max(10, r.top)}px`;
      b.style.background = color(n.reruns);
      b.textContent = `×${n.reruns}`;
    }
    for (const [el, b] of badges) {
      if (!wanted.has(el)) {
        b.remove();
        badges.delete(el);
      }
    }
  };

  const tick = (ts: number): void => {
    if (!enabled) return;
    if (ts - last > 120) {
      last = ts;
      update();
    }
    raf = requestAnimationFrame(tick);
  };

  root.addEventListener("mousemove", (e) => {
    if (!enabled) return;
    let el = e.target as HTMLElement | null;
    let hit: TrackedNode | null = null;
    while (el && el !== document.body) {
      const n = nodeOf(el);
      if (n && n.rerunCell) {
        hit = n;
        break;
      }
      el = el.parentElement;
    }
    if (!hit) {
      hideHover();
      return;
    }
    const r = hit.el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    detail.style.display = "block";
    detail.style.left = `${Math.max(4, Math.min(window.innerWidth - 300, r.left))}px`;
    detail.style.top = `${Math.max(4, Math.min(window.innerHeight - 90, r.bottom + 4))}px`;
    detail.style.borderColor = color(hit.reruns);
    detail.textContent =
      `名称  ${nameOf(hit.el)}\n` +
      `类型  ${hit.rerunCell ? "cell（重跑块）" : "静态"}\n` +
      `行    ${hit.loc ?? "—"}\n` +
      `rerun ×${hit.reruns}   ${Math.round(r.width)}×${Math.round(r.height)}`;
  });
  root.addEventListener("mouseleave", hideHover);

  const setEnabled = (on: boolean): void => {
    enabled = on;
    toggle.textContent = on ? "诊断：开" : "诊断";
    toggle.style.background = on ? "#b45309" : "#1f2937";
    toggle.style.borderColor = on ? "#f59e0b" : "#555";
    if (on) {
      last = 0;
      raf = requestAnimationFrame(tick);
      update();
    } else {
      cancelAnimationFrame(raf);
      clearBadges();
      hideHover();
    }
  };
  toggle.onclick = (): void => setEnabled(!enabled);
}
