// bar.ts — 横条的 HTML（**本地**页面，`data:` URL 加载；不是远程页面的一部分）。
//
// 为什么横条必须由壳自己渲染（##481 硬规则一）：远程一坏，用户就不知道自己在哪台机器上。
// 这不是美观问题，是安全边界。横条与页面是 contentView 下的两个 WebContentsView，
// 各占各的矩形（横条 y=0..32，页面 y=32..），远程页面画什么都到不了横条那一行。
//
// 横条只做「当前位置 + 切换」（硬规则二）：没有确认弹窗、没有危险操作拦截 ——
// 本机怎么操作，远程就怎么操作（VSCode remote ssh 同理）。
//
// ##484：横条显示**人读地址** `alice@c-mac/diy-chat.lab`（user@host/app.variant[:端口]），
// 不再显示 `http://127.0.0.1:9411` —— 光看 URL 认不出「哪台机器的哪个 app」。
//
// ##493（用户裁决）：横条 = **纯 tab 条**。原先左侧「当前连接」+ 下方候选列表把同一个身份
// 画了两遍；现在只有一排 tab，当前那个靠**背景高亮**表达（不叠下划线），状态只占一个小圆点：
//   ● 绿 = 已连 / ⚠ 黄 = 连接中或断线 / ○ 灰 = 未连（只是列表项）
// 标签与人读地址的省略规则在主进程算（`index.ts` 的 `buildTabs`）—— 横条只画，不判断。
//
// 这个模块**不 import electron**：纯字符串，单测可以直接 import 做结构断言。

import { BAR_HEIGHT } from './index.js';

/** 横条页的 HTML（内联样式与脚本；无外部资源 ⇒ CSP 可以收紧到 'none'） */
export const BAR_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="dark" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>diy remote shell bar</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  /* 横条永远是 32px：tab 自己定高，不靠内容撑高（##493 判据 6） */
  #bar {
    display: flex; align-items: center; gap: 8px; height: 100%; box-sizing: border-box;
    padding: 0 8px; border-bottom: 1px solid #30363d; background: #1f2430; color: #c9d1d9;
    font: 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    user-select: none; white-space: nowrap; overflow: hidden;
  }
  /* 状态色：连接中=琥珀，断线=整条变红（页面内容陈旧要一眼看出来） */
  #bar[data-status="connecting"] { background: #2b2413; }
  #bar[data-status="disconnected"] { background: #3d1d1f; color: #ffd7d5; border-bottom-color: #f85149; }
  #tabs {
    display: flex; align-items: center; gap: 4px; min-width: 0; flex: 0 1 auto;
    height: 100%; overflow: hidden;
  }
  .tab {
    display: inline-flex; align-items: center; gap: 6px; flex: 0 1 auto;
    height: 24px; max-width: 220px; padding: 0 10px; border: 0; border-radius: 6px;
    background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  .tab:hover { background: #2d333b; }
  /* 高亮 = 当前（只用背景，不叠下划线） */
  .tab[data-active="1"] { background: #30363d; color: #e6edf3; }
  .tab .dot { flex: none; font-size: 10px; line-height: 1; }
  .tab[data-status="connected"] .dot { color: #3fb950; }
  .tab[data-status="connecting"] .dot { color: #d29922; }
  .tab[data-status="disconnected"] .dot { color: #d29922; }
  .tab[data-status="idle"] .dot { color: #8b949e; }
  .tab .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .hint { opacity: 0.6; }
  #detail { opacity: 0.8; max-width: 320px; overflow: hidden; text-overflow: ellipsis; flex: none; }
  #spacer { flex: 1; }
  button.plain {
    border: 1px solid #30363d; border-radius: 6px; background: transparent; color: inherit;
    font: inherit; padding: 3px 8px; cursor: pointer; flex: none;
  }
  button.plain:hover { background: #2d333b; }
  #refresh[data-warn="1"] { border-color: #d29922; color: #e3b341; }
  #endpoint {
    display: none; width: 240px; padding: 2px 6px; border-radius: 6px;
    border: 1px solid #484f58; background: #0d1117; color: inherit; font: inherit;
  }
  #bar[data-editing="1"] #endpoint { display: inline-block; }
</style>
</head>
<body>
<div id="bar" data-testid="bar" data-status="connecting" data-editing="0" data-endpoint="">
  <span id="tabs" data-testid="tabs" role="tablist"></span>
  <span id="spacer"></span>
  <span id="detail" data-testid="detail"></span>
  <button id="add" class="plain" type="button" data-testid="add" title="连接一个 URL">＋ 连接…</button>
  <input id="endpoint" type="text" spellcheck="false" data-testid="endpoint" placeholder="host:9400 或 http://host:9400" />
  <button id="refresh" class="plain" type="button" data-testid="refresh" data-warn="0" title="重新发现">⟳</button>
</div>
<script>
  (function () {
    const api = window.diyBar;
    const bar = document.getElementById("bar");
    const tabsEl = document.getElementById("tabs");
    const detailEl = document.getElementById("detail");
    const inputEl = document.getElementById("endpoint");
    const addBtn = document.getElementById("add");
    const refreshBtn = document.getElementById("refresh");

    if (!api) {
      bar.dataset.status = "disconnected";
      return;
    }

    function paint(state) {
      const current = state.current;
      const tabs = state.tabs || [];
      bar.dataset.status = current ? current.status : "idle";
      bar.dataset.endpoint = current ? current.endpoint : "";
      detailEl.textContent = current && current.detail ? "· " + current.detail : "";

      tabsEl.textContent = "";
      if (tabs.length === 0) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = "没发现实例（点 ⟳ 重试，或 ＋ 连接…）";
        tabsEl.appendChild(hint);
      }
      for (const tab of tabs) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tab";
        button.dataset.endpoint = tab.endpoint;
        button.dataset.active = tab.active ? "1" : "0";
        button.dataset.status = tab.status;
        button.setAttribute("data-testid", "tab");
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", tab.active ? "true" : "false");
        // 悬停永远给全名（tab 上只放省略后的短名）
        button.title = tab.title;
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.textContent = tab.dot;
        dot.title = tab.statusLabel;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = tab.label;
        button.appendChild(dot);
        button.appendChild(name);
        button.addEventListener("click", function () {
          void api.connect(tab.endpoint);
        });
        tabsEl.appendChild(button);
      }

      const errors = state.errors || [];
      refreshBtn.dataset.warn = errors.length ? "1" : "0";
      refreshBtn.title = errors.length
        ? "发现器失败：" + errors.map(function (e) { return e.source + "：" + e.message; }).join("；")
        : "重新发现";
    }

    addBtn.addEventListener("click", function () {
      const editing = bar.dataset.editing === "1";
      bar.dataset.editing = editing ? "0" : "1";
      if (!editing) { inputEl.focus(); inputEl.select(); }
    });
    inputEl.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        const value = inputEl.value.trim();
        if (value) {
          void api.connect(value);
          inputEl.value = "";
          bar.dataset.editing = "0";
        }
      } else if (event.key === "Escape") {
        bar.dataset.editing = "0";
      }
    });
    refreshBtn.addEventListener("click", function () {
      void api.refresh();
    });

    api.onState(paint);
    api.getState().then(paint);
  })();
</script>
</body>
</html>`;

/** 横条页的 data: URL（不落地文件：横条只有这一份，改它不会碰到远程页面） */
export function barDataUrl(): string {
    return `data:text/html;charset=utf-8,${encodeURIComponent(BAR_HTML)}`;
}

/** 横条在 CSS 里用的高度必须与壳的常量一致（单测盯着这一条） */
export const BAR_HTML_HEIGHT_HINT = BAR_HEIGHT;
