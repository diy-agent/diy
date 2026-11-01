// style.ts — 聊天页的样式表（两个 renderer 共用：裸 DOM 版与 diyui 版必须长得一样）。
//
// 只注入一次（按 STYLE_ID 去重）；页面切走不清除，回来接着用。

export const STYLE_ID = 'chat-page-style';

export const CHAT_STYLE = `
.chat-page { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.chat-list { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 20px; list-style: none; display: flex; flex-direction: column; gap: 10px; }
/* ##499：一行 = 若干 Block */
.chat-blocks { display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 68ch; }
.chat-block { min-width: 0; }
.chat-row { display: flex; gap: 8px; align-items: flex-start; }
.chat-row[data-role="user"] { flex-direction: row-reverse; }
.chat-role { flex: none; width: 52px; color: #6b7280; font-size: 12px; padding-top: 6px; text-align: center; }
.chat-text { padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; background: #f1f3f5; }
/* think / tool：折叠块（运行中展开，结束收起） */
.chat-block-think, .chat-block-tool, .chat-block-unknown { border: 1px solid #e4e7eb; border-radius: 10px; background: #fafbfc; padding: 6px 10px; font-size: 13px; }
.chat-block-think > summary, .chat-block-tool > summary, .chat-block-unknown > summary { cursor: pointer; color: #4b5563; }
.chat-think-text { white-space: pre-wrap; word-break: break-word; margin-top: 6px; color: #6b7280; }
.chat-tool-head { display: flex; align-items: baseline; gap: 6px; }
.chat-tool-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
.chat-tool-dot[data-state="running"] { background: #eab308; }
.chat-tool-dot[data-state="ok"] { background: #22c55e; }
.chat-tool-dot[data-state="error"] { background: #ef4444; }
.chat-tool-name { font-weight: 600; color: #1f2937; }
.chat-tool-args { color: #8b95a1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-tool-summary { margin-left: auto; color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-tool-output { max-height: 260px; overflow: auto; margin: 6px 0 0; padding: 8px; border-radius: 6px; background: #f1f3f5; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.chat-unknown-head { color: #b45309; }
.chat-unknown-json { max-height: 260px; overflow: auto; margin: 6px 0 0; font-size: 12px; }
.chat-row[data-role="user"] .chat-text { background: #dfe6f2; }
.chat-row[data-role="assistant"] .chat-text { background: #eef6ee; }
.chat-empty { color: #9aa1a9; padding: 20px; }
.chat-composer { flex: none; display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #e4e7eb; }
.chat-input { flex: 1; padding: 9px 12px; border: 1px solid #d3d8de; border-radius: 8px; font: inherit; }
.chat-input:focus { outline: 2px solid #b9c9e4; outline-offset: 0; }
.chat-send { appearance: none; border: 0; border-radius: 8px; padding: 9px 18px; background: #2f6fdb; color: #fff; font: inherit; cursor: pointer; }
.chat-send:disabled { background: #a9b7cc; cursor: default; }
/* 多会话布局 */
.chat-app { display: flex; height: 100%; min-height: 0; }
.chat-sessions { flex: none; width: 220px; border-right: 1px solid #e4e7eb; display: flex; flex-direction: column; min-height: 0; background: #fafbfc; }
.chat-sessions[hidden] { display: none; }
.chat-sessions-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e4e7eb; }
.chat-sessions-title { flex: 1; font-size: 13px; color: #4b5563; }
.chat-new { appearance: none; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.chat-session-list { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 6px; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.chat-session { display: block; width: 100%; text-align: left; appearance: none; border: 0; border-radius: 8px; background: transparent; padding: 8px 10px; font: inherit; cursor: pointer; }
.chat-session:hover { background: #eef1f5; }
.chat-session[data-active="true"] { background: #e3ebf8; }
.chat-session-name { display: block; font-size: 13px; color: #1f2937; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-session-meta { display: block; font-size: 11px; color: #8b95a1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.chat-header { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid #e4e7eb; }
.chat-header[hidden] { display: none; }
.chat-model-label { font-size: 12px; color: #6b7280; }
.chat-model { max-width: 340px; padding: 5px 8px; border: 1px solid #d3d8de; border-radius: 6px; font: inherit; font-size: 13px; background: #fff; }
`;

/** 注入样式表（幂等）。 */
export function ensureChatStyle(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CHAT_STYLE;
    doc.head.append(style);
}
