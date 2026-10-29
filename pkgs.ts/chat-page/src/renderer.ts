// renderer.ts — 页面插件的 renderer 侧：消息列表 + 输入框。
//
// 只做展示与转发：输入一句话 → `ctx.invoke('send', text)` → 用返回的消息线重画。
// 本文件不认识 Electron / IPC（那些在 preload 与主进程），也拿不到 LlmPort。

import type { PageContext, PageView } from "@diy/ui-workbench";
import type { SendResult, WireMessage } from "./shared.js";

const STYLE_ID = "chat-page-style";
const STYLE = `
.chat-page { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.chat-list { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 20px; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.chat-row { display: flex; gap: 8px; align-items: flex-start; }
.chat-row[data-role="user"] { flex-direction: row-reverse; }
.chat-role { flex: none; width: 52px; color: #6b7280; font-size: 12px; padding-top: 6px; text-align: center; }
.chat-text { max-width: 68ch; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; background: #f1f3f5; }
.chat-row[data-role="user"] .chat-text { background: #dfe6f2; }
.chat-row[data-role="assistant"] .chat-text { background: #eef6ee; }
.chat-empty { color: #9aa1a9; padding: 20px; }
.chat-composer { flex: none; display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #e4e7eb; }
.chat-input { flex: 1; padding: 9px 12px; border: 1px solid #d3d8de; border-radius: 8px; font: inherit; }
.chat-input:focus { outline: 2px solid #b9c9e4; outline-offset: 0; }
.chat-send { appearance: none; border: 0; border-radius: 8px; padding: 9px 18px; background: #2f6fdb; color: #fff; font: inherit; cursor: pointer; }
.chat-send:disabled { background: #a9b7cc; cursor: default; }
`;

export const chatPageView: PageView = {
    id: "chat",
    title: "聊天",
    render(root: HTMLElement, ctx: PageContext): () => void {
        const doc = root.ownerDocument;
        ensureStyle(doc);
        root.replaceChildren();

        const page = node(doc, "div", "chat-page");
        const list = node(doc, "ol", "chat-list");
        const empty = node(doc, "li", "chat-empty");
        empty.textContent = "还没有消息，说一句话开始。";
        list.append(empty);

        const form = node(doc, "form", "chat-composer");
        const input = node(doc, "input", "chat-input") as HTMLInputElement;
        input.type = "text";
        input.placeholder = "说点什么…";
        const send = node(doc, "button", "chat-send") as HTMLButtonElement;
        send.type = "submit";
        send.textContent = "发送";
        form.append(input, send);

        const paint = (messages: readonly WireMessage[]): void => {
            list.replaceChildren();
            if (messages.length === 0) {
                list.append(empty);
                return;
            }
            for (const message of messages) list.append(row(doc, message));
            list.scrollTop = list.scrollHeight;
        };

        let busy = false;
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const text = input.value.trim();
            if (busy || text.length === 0) return;
            busy = true;
            send.disabled = true;
            input.value = "";
            paint([...current, { role: "user", text }]);
            void ctx
                .invoke<SendResult>("send", text)
                .then((result) => {
                    current = result.messages;
                    paint(current);
                })
                .catch((cause: unknown) => {
                    paint([...current, { role: "assistant", text: `出错了：${messageOf(cause)}` }]);
                })
                .finally(() => {
                    busy = false;
                    send.disabled = false;
                    input.focus();
                });
        });

        let current: readonly WireMessage[] = [];
        page.append(list, form);
        root.append(page);
        input.focus();

        return () => {
            root.replaceChildren();
        };
    },
};

export default chatPageView;

function row(doc: Document, message: WireMessage): HTMLElement {
    const item = node(doc, "li", "chat-row");
    item.dataset["role"] = message.role;
    const role = node(doc, "span", "chat-role");
    role.textContent = message.role === "user" ? "我" : "助手";
    const text = node(doc, "div", "chat-text");
    text.textContent = message.text;
    item.append(role, text);
    return item;
}

function node(doc: Document, tag: string, className: string): HTMLElement {
    const element = doc.createElement(tag);
    element.className = className;
    return element;
}

function ensureStyle(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.append(style);
}

function messageOf(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}
