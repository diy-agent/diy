// style.ts — 聊天页的样式表（两个 renderer 共用：裸 DOM 版与 diyui 版必须长得一样）。
//
// 只注入一次（按 STYLE_ID 去重）；页面切走不清除，回来接着用。
//
// ##498（bot 中心）的形状：
//   ┌────┬──────────────────────────────┐
//   │bot │ 消息流（顶天，无横幅）          │
//   │ 条  │                              │
//   │64px│                              │
//   │hover│                              │
//   │→200│                              │
//   ├────┴──────────────────────────────┤
//   │ bot 名 ⚙ | 输入 … 窗口 … 缓存 … 本轮 … 上下文 … │
//   │ [说点什么…]                  [发送] │
//   └───────────────────────────────────┘

export const STYLE_ID = "chat-page-style";

export const CHAT_STYLE = `
/* ═══ M3 语义角色（seed #3b6fd4 生成，palette 已展开）═══
 * light-dark() 的两个值都留着，但 color-scheme **固定为 light** ——
 * 定成 light dark 会让整个 app 跟随系统深色模式，而 workbench-ui / bot-config
 * 还没做深色适配，两边一混搭就错乱。等全站都接上 M3 再改成 light dark。
 * 改主题：重跑生成脚本换这一块，下面 53 处硬编码全部跟着变。 */
:root {
  color-scheme: light;
  --md-sys-color-primary: light-dark(#1f5abe, #b0c6ff);
  --md-sys-color-on-primary: light-dark(#ffffff, #002d6e);
  --md-sys-color-primary-container: light-dark(#d9e2ff, #00429b);
  --md-sys-color-on-primary-container: light-dark(#00429b, #d9e2ff);
  --md-sys-color-secondary: light-dark(#575e71, #c0c6dc);
  --md-sys-color-on-secondary: light-dark(#ffffff, #293042);
  --md-sys-color-secondary-container: light-dark(#dce2f9, #404659);
  --md-sys-color-on-secondary-container: light-dark(#404659, #dce2f9);
  --md-sys-color-tertiary: light-dark(#725572, #e0bbde);
  --md-sys-color-on-tertiary: light-dark(#ffffff, #412742);
  --md-sys-color-tertiary-container: light-dark(#fdd7fa, #593d5a);
  --md-sys-color-on-tertiary-container: light-dark(#593d5a, #fdd7fa);
  --md-sys-color-error: light-dark(#ba1a1a, #ffb4ab);
  --md-sys-color-on-error: light-dark(#ffffff, #690005);
  --md-sys-color-error-container: light-dark(#ffdad6, #93000a);
  --md-sys-color-on-error-container: light-dark(#93000a, #ffdad6);
  --md-sys-color-surface: light-dark(#fbf8fd, #121316);
  --md-sys-color-surface-dim: light-dark(#dbd9dd, #121316);
  --md-sys-color-surface-bright: light-dark(#fbf8fd, #38393c);
  --md-sys-color-surface-container-lowest: light-dark(#ffffff, #0d0e11);
  --md-sys-color-surface-container-low: light-dark(#f5f3f7, #1b1b1f);
  --md-sys-color-surface-container: light-dark(#efedf1, #1f1f23);
  --md-sys-color-surface-container-high: light-dark(#e9e7ec, #292a2d);
  --md-sys-color-surface-container-highest: light-dark(#e3e2e6, #343438);
  --md-sys-color-on-surface: light-dark(#1b1b1f, #e3e2e6);
  --md-sys-color-on-surface-variant: light-dark(#44464f, #c5c6d0);
  --md-sys-color-outline: light-dark(#757780, #8f9099);
  --md-sys-color-outline-variant: light-dark(#c5c6d0, #44464f);
  --md-sys-color-inverse-surface: light-dark(#303034, #e3e2e6);
  --md-sys-color-inverse-on-surface: light-dark(#f2f0f4, #303034);
  --md-sys-color-inverse-primary: light-dark(#b0c6ff, #1f5abe);

  /* chat 自己的语义别名 —— 只指向 M3 角色，不存颜色值 */
  --chat-bg: var(--md-sys-color-surface);
  --chat-fg: var(--md-sys-color-on-surface);
  --chat-dim: var(--md-sys-color-on-surface-variant);
  --chat-line: var(--md-sys-color-outline-variant);
  --chat-hi: var(--md-sys-color-secondary-container);
  --chat-accent: var(--md-sys-color-primary);
}
.chat-page { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; color: var(--chat-fg); }
.chat-app { display: flex; height: 100%; min-height: 0; }

/* ── 左栏：bot 条（平时 64px 只露头像，hover 展开 200px） ── */
.chat-bots { flex: none; width: 64px; border-right: 1px solid var(--chat-line); background: var(--md-sys-color-surface-container-low); display: flex; flex-direction: column; min-height: 0; overflow: hidden; transition: width .18s ease; position: relative; z-index: 10; }
.chat-bots[hidden] { display: none; }
.chat-bots:hover, .chat-bots[data-open="true"] { width: 200px; }
.chat-bot-list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; margin: 0; padding: 6px 0; list-style: none; }
.chat-bot { position: relative; }
.chat-bot-btn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 13px; border: 0; border-left: 3px solid transparent; background: transparent; font: inherit; text-align: left; cursor: pointer; white-space: nowrap; }
.chat-bot-btn:hover { background: var(--md-sys-color-surface-container-high); }
.chat-bot[data-active="true"] .chat-bot-btn { background: var(--chat-hi); border-left-color: var(--chat-accent); }
.chat-bot-avatar { flex: none; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; color: var(--md-sys-color-on-primary); font-weight: 600; font-size: 15px; }
.chat-bot-text { min-width: 0; opacity: 0; transition: opacity .12s; }
.chat-bots:hover .chat-bot-text, .chat-bots[data-open="true"] .chat-bot-text { opacity: 1; }
.chat-bot-name { display: block; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.chat-bot-model { display: block; font-size: 11px; color: var(--chat-dim); overflow: hidden; text-overflow: ellipsis; }
.chat-bot-new { margin-bottom: 4px; border-bottom: 1px solid var(--chat-line); padding-bottom: 4px; }
.chat-bot-new .chat-bot-avatar { background: var(--md-sys-color-surface-container-highest); font-size: 20px; font-weight: 400; }

/* ── hover 卡片（fixed 定位：左栏 overflow hidden 也挡不住它） ── */
.chat-card { position: fixed; width: 260px; padding: 14px; background: var(--md-sys-color-surface); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, .12); z-index: 100; display: none; }
.chat-card[data-show="true"] { display: block; }
.chat-card-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.chat-card-model { font-size: 11px; color: var(--chat-dim); margin-bottom: 10px; word-break: break-all; }
.chat-card-row { display: flex; justify-content: space-between; font-size: 12px; color: #555; padding: 3px 0; }
.chat-card-row b { font-weight: 500; color: var(--chat-fg); }
.chat-card-acts { display: flex; gap: 8px; margin-top: 12px; }
.chat-card-acts button { flex: 1; padding: 6px 0; border: 1px solid var(--md-sys-color-outline); border-radius: 8px; background: var(--md-sys-color-surface); font: inherit; font-size: 12px; cursor: pointer; }
.chat-card-acts button.chat-primary { background: var(--chat-accent); border-color: var(--chat-accent); color: var(--md-sys-color-on-primary); }

/* ── 主区：消息流（顶天，没有顶部横幅） ── */
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
/* 消息流 + 右侧 panel：pinned 时并排（消息让宽），floating 时 panel 浮在消息上 */
.chat-body { flex: 1; min-height: 0; display: flex; flex-direction: row; position: relative; }
.chat-stream { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.chat-list { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 20px 24px; list-style: none; display: flex; flex-direction: column; gap: 10px; }
/* ── 右侧 panel（viewset）：列表明细编辑的统一形态（##viewset） ── */
.chat-viewset { display: none; flex-direction: column; min-height: 0; background: var(--md-sys-color-surface); }
.chat-viewset[data-show="true"] { display: flex; }
.chat-viewset[data-mode="pinned"] { flex: none; width: 340px; border-left: 1px solid var(--chat-line); }
.chat-viewset[data-mode="floating"] { position: absolute; top: 12px; right: 12px; bottom: 12px; width: 340px; border: 1px solid var(--md-sys-color-outline-variant); border-radius: 12px; box-shadow: 0 8px 28px rgba(0, 0, 0, .14); z-index: 15; overflow: hidden; }
.chat-viewset-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--chat-line); }
.chat-viewset-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-viewset-pin, .chat-viewset-close { flex: none; border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; background: var(--md-sys-color-surface); font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer; }
.chat-viewset-pin:hover, .chat-viewset-close:hover { background: var(--md-sys-color-surface-container-high); }
.chat-viewset-body { flex: 1; min-height: 0; overflow: auto; padding: 14px; font-size: 13px; }
.chat-viewset-actions { display: flex; gap: 8px; margin-top: 16px; }
.chat-viewset-actions button { padding: 6px 14px; border: 1px solid var(--md-sys-color-outline); border-radius: 8px; background: var(--md-sys-color-surface); font: inherit; font-size: 13px; cursor: pointer; }
.chat-viewset-actions button.chat-primary { background: var(--chat-accent); border-color: var(--chat-accent); color: var(--md-sys-color-on-primary); }
.chat-viewset-actions button.chat-danger { color: var(--md-sys-color-error); border-color: var(--md-sys-color-error-container); }
.chat-viewset-note { margin-top: 12px; font-size: 12px; color: var(--chat-dim); }
/* panel 里的表单：一列（比覆盖式面板窄） */
.chat-viewset .chat-form { display: flex; flex-direction: column; gap: 4px; max-width: none; }
.chat-viewset .chat-form label { padding-top: 6px; }
.chat-viewset .chat-form input, .chat-viewset .chat-form select, .chat-viewset .chat-form textarea { width: 100%; box-sizing: border-box; }
/* ##499：一行 = 若干 Block */
.chat-blocks { display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 68ch; }
.chat-block { min-width: 0; }
.chat-row { display: flex; gap: 8px; align-items: flex-start; }
.chat-row[data-role="user"] { flex-direction: row-reverse; }
.chat-role { flex: none; width: 52px; color: var(--md-sys-color-on-surface-variant); font-size: 12px; padding-top: 6px; text-align: center; }
.chat-text { padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; background: var(--md-sys-color-surface-container-high); }
/* think / tool：折叠块（运行中展开，结束收起） */
.chat-block-think, .chat-block-tool, .chat-block-unknown { border: 1px solid var(--chat-line); border-radius: 10px; background: var(--md-sys-color-surface-container-low); padding: 6px 10px; font-size: 13px; }
.chat-block-think > summary, .chat-block-tool > summary, .chat-block-unknown > summary { cursor: pointer; color: var(--md-sys-color-on-surface-variant); }
.chat-think-text { white-space: pre-wrap; word-break: break-word; margin-top: 6px; color: var(--md-sys-color-on-surface-variant); }
.chat-tool-head { display: flex; align-items: baseline; gap: 6px; }
.chat-tool-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
.chat-tool-dot[data-state="running"] { background: #eab308; }
.chat-tool-dot[data-state="ok"] { background: #22c55e; }
.chat-tool-dot[data-state="error"] { background: #ef4444; }
.chat-tool-name { font-weight: 600; color: #1f2937; }
.chat-tool-args { color: var(--chat-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-tool-summary { margin-left: auto; color: var(--md-sys-color-on-surface-variant); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-tool-output { max-height: 260px; overflow: auto; margin: 6px 0 0; padding: 8px; border-radius: 6px; background: var(--md-sys-color-surface-container-high); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.chat-unknown-head { color: #b45309; }
.chat-unknown-json { max-height: 260px; overflow: auto; margin: 6px 0 0; font-size: 12px; }
.chat-row[data-role="user"] .chat-text { background: #dfe6f2; }
.chat-row[data-role="assistant"] .chat-text { background: #eef6ee; }
.chat-empty { color: #9aa1a9; padding: 20px; }

/* ── 底部：bot 名 + 指标 + 输入（一行合并） ── */
.chat-foot { flex: none; border-top: 1px solid var(--chat-line); padding: 10px 24px 12px; }
.chat-metrics { display: flex; align-items: center; gap: 14px; font-size: 11px; color: var(--chat-dim); margin-bottom: 8px; flex-wrap: wrap; }
.chat-metrics b { color: var(--chat-fg); font-weight: 500; }
.chat-metrics .chat-bot-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--chat-fg); background: transparent; border: 0; padding: 0; font-family: inherit; cursor: pointer; }
.chat-metrics .chat-bot-label:hover { color: var(--chat-accent); }
.chat-metrics .chat-sep { color: #ddd; }
.chat-metrics .chat-warn { color: #d97706; }
.chat-composer { display: flex; gap: 8px; }
.chat-input { flex: 1; padding: 9px 12px; border: 1px solid var(--md-sys-color-outline); border-radius: 8px; font: inherit; }
.chat-input:focus { outline: 2px solid var(--md-sys-color-primary); outline-offset: 0; }
.chat-send { appearance: none; border: 0; border-radius: 8px; padding: 9px 18px; background: var(--chat-accent); color: var(--md-sys-color-on-primary); font: inherit; cursor: pointer; }
.chat-send:disabled { background: #a9b7cc; cursor: default; }

/* ── 覆盖消息区的面板：配置 / 首启引导 ── */
.chat-panel { position: absolute; inset: 0; background: var(--md-sys-color-surface); display: none; flex-direction: column; z-index: 20; }
.chat-panel[data-show="true"] { display: flex; }
.chat-panel-head { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--chat-line); }
.chat-panel-title { flex: 1; font-size: 15px; font-weight: 600; margin: 0; }
.chat-panel-head button { border: 1px solid var(--md-sys-color-outline); border-radius: 6px; background: var(--md-sys-color-surface); padding: 4px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.chat-panel-body { padding: 20px; overflow: auto; font-size: 13px; }
.chat-panel-note { margin-top: 16px; font-size: 12px; color: var(--chat-dim); }
.chat-panel-actions { display: flex; gap: 10px; margin-top: 18px; }
.chat-panel-actions button { padding: 7px 16px; border: 1px solid var(--md-sys-color-outline); border-radius: 8px; background: var(--md-sys-color-surface); font: inherit; font-size: 13px; cursor: pointer; }
.chat-panel-actions button.chat-primary { background: var(--chat-accent); border-color: var(--chat-accent); color: var(--md-sys-color-on-primary); }
.chat-panel-actions button.chat-danger { color: var(--md-sys-color-error); border-color: var(--md-sys-color-error-container); }
.chat-form { display: grid; grid-template-columns: 88px 1fr; gap: 10px 14px; max-width: 640px; align-items: start; }
.chat-form label { color: var(--md-sys-color-on-surface-variant); padding-top: 6px; font-size: 13px; }
.chat-form input, .chat-form select, .chat-form textarea { padding: 5px 9px; border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; font: inherit; font-size: 13px; width: 100%; box-sizing: border-box; background: var(--md-sys-color-surface); }
.chat-form textarea { min-height: 84px; resize: vertical; }
.chat-panel-error { margin-top: 12px; font-size: 12px; color: var(--md-sys-color-error); }
/* ── ##519 压缩点（二级悬停面板） ────────────────────────── */
.chat-cut-wrap { position: relative; display: inline-block; }
.chat-cut-chip { font: inherit; font-size: 11px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,.18); background: transparent; color: inherit; cursor: pointer; opacity: .75; }
.chat-cut-chip:hover { opacity: 1; }
.chat-cut-panel { position: absolute; bottom: calc(100% + 8px); right: 0; width: 300px; z-index: 40;
  background: #161a22; border: 1px solid #2a3140; border-radius: 8px; padding: 8px 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.45); display: flex; flex-direction: column; gap: 4px; }
.chat-cut-head { display: flex; gap: 6px; align-items: baseline; font-size: 12px; }
.chat-cut-dim { opacity: .6; font-size: 11px; }
.chat-cut-row { display: flex; gap: 8px; align-items: baseline; font-size: 12px; padding: 1px 0; }
.chat-cut-lab { font-family: ui-monospace, monospace; font-size: 11px; opacity: .7; flex: none; }
.chat-cut-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-cut-row-drop .chat-cut-title,
.chat-cut-row-drop .chat-cut-lab { text-decoration: line-through; opacity: .5; }
.chat-cut-line { border-top: 2px dashed #f87171; font-size: 10px; color: #f87171; margin: 2px 0; }
.chat-cut-range { width: 100%; accent-color: #60a5fa; }
.chat-cut-actions { display: flex; gap: 8px; align-items: center; }
.chat-cut-apply { font: inherit; font-size: 12px; padding: 3px 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid #4f93e8; background: #3b82f6; color: #fff; }
.chat-cut-err { font-size: 11px; color: #f09b9b; }

`;

/** 注入样式表（幂等）。 */
export function ensureChatStyle(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CHAT_STYLE;
    doc.head.append(style);
}
