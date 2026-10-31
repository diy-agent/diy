// bar.ts — 横条的 HTML（**本地**页面，`data:` URL 加载；不是远程页面的一部分）。
//
// 为什么横条必须由壳自己渲染（##481 硬规则一）：远程一坏，用户就不知道自己在哪台机器上。
// 这不是美观问题，是安全边界。横条与页面是 contentView 下的两个 WebContentsView，
// 各占各的矩形（横条 y=0..32，页面 y=32..），远程页面画什么都到不了横条那一行。
//
// 横条只做「当前位置 + 切换」（硬规则二）：没有确认弹窗、没有危险操作拦截 ——
// 本机怎么操作，远程就怎么操作（VSCode remote ssh 同理）。
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
  #bar {
    display: flex; align-items: center; gap: 8px; height: 100%; box-sizing: border-box;
    padding: 0 8px; border-bottom: 1px solid #30363d; background: #1f2430; color: #c9d1d9;
    font: 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    user-select: none; white-space: nowrap;
  }
  /* 状态色：连上=中性，连接中=琥珀，断线=整条变红（页面内容陈旧要一眼看出来） */
  #bar[data-status="connecting"] { background: #2b2413; }
  #bar[data-status="disconnected"] { background: #3d1d1f; color: #ffd7d5; border-bottom-color: #f85149; }
  #current { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  #dot { font-size: 12px; }
  #bar[data-status="connected"] #dot { color: #3fb950; }
  #bar[data-status="connecting"] #dot { color: #d29922; }
  #bar[data-status="disconnected"] #dot { color: #f85149; }
  #label { font-weight: 400; opacity: 0.75; }
  #detail { font-weight: 400; opacity: 0.8; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  #sep { opacity: 0.3; }
  #instances { display: flex; align-items: center; gap: 4px; overflow: hidden; }
  .inst {
    display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 6px;
    border: 1px solid transparent; background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  .inst:hover { background: #2d333b; }
  .inst[data-active="1"] { background: #30363d; border-color: #484f58; }
  .inst .mini { opacity: 0.8; }
  .hint { opacity: 0.6; }
  #spacer { flex: 1; }
  button.plain {
    border: 1px solid #30363d; border-radius: 6px; background: transparent; color: inherit;
    font: inherit; padding: 3px 8px; cursor: pointer;
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
  <span id="current" data-testid="current">
    <span id="dot" data-testid="current-dot">◌</span>
    <span id="name" data-testid="current-name">未连接</span>
    <span id="label" data-testid="current-label"></span>
  </span>
  <span id="detail" data-testid="current-detail"></span>
  <span id="sep">│</span>
  <span id="instances" data-testid="instances"></span>
  <span id="spacer"></span>
  <button id="add" class="plain" type="button" data-testid="add" title="连接一个 URL">＋ 连接…</button>
  <input id="endpoint" type="text" spellcheck="false" data-testid="endpoint" placeholder="host:9400 或 http://host:9400" />
  <button id="refresh" class="plain" type="button" data-testid="refresh" data-warn="0" title="重新发现">⟳</button>
</div>
<script>
  (function () {
    const api = window.diyBar;
    const bar = document.getElementById("bar");
    const dotEl = document.getElementById("dot");
    const nameEl = document.getElementById("name");
    const labelEl = document.getElementById("label");
    const detailEl = document.getElementById("detail");
    const listEl = document.getElementById("instances");
    const inputEl = document.getElementById("endpoint");
    const addBtn = document.getElementById("add");
    const refreshBtn = document.getElementById("refresh");

    if (!api) {
      nameEl.textContent = "preload 没注入横条桥";
      bar.dataset.status = "disconnected";
      return;
    }

    function paint(state) {
      const current = state.current;
      bar.dataset.status = current ? current.status : "idle";
      bar.dataset.endpoint = current ? current.endpoint : "";
      if (current) {
        dotEl.textContent = current.dot;
        nameEl.textContent = current.displayName;
        labelEl.textContent = current.label;
        detailEl.textContent = current.detail ? "· " + current.detail : "";
      } else {
        dotEl.textContent = "○";
        nameEl.textContent = "未连接";
        labelEl.textContent = "";
        detailEl.textContent = "";
      }

      listEl.textContent = "";
      const instances = state.instances || [];
      if (instances.length === 0) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = "没发现实例（点 ⟳ 重试，或 ＋ 连接…）";
        listEl.appendChild(hint);
      }
      for (const item of instances) {
        const active = current && current.endpoint === item.endpoint;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "inst";
        button.dataset.endpoint = item.endpoint;
        button.dataset.active = active ? "1" : "0";
        button.setAttribute("data-testid", "instance");
        const sources = item.sources && item.sources.length ? item.sources.join(" + ") : item.source;
        button.title = item.endpoint + "（" + sources + "）";
        const mini = document.createElement("span");
        mini.className = "mini";
        mini.textContent = active ? current.dot : "○";
        const label = document.createElement("span");
        label.textContent = item.displayName || item.endpoint;
        button.appendChild(mini);
        button.appendChild(label);
        button.addEventListener("click", function () {
          void api.connect(item.endpoint);
        });
        listEl.appendChild(button);
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
