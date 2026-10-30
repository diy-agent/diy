// renderer.ts — 页面插件的 renderer 侧：消息列表 + 输入框（+ 多会话模式的左侧列表与模型选择器）。
//
// 只做展示与转发：输入一句话 → `ctx.invoke('send', …)` → 用返回的消息线重画。
// 本文件不认识 Electron / IPC（那些在 preload 与主进程），也拿不到 LlmPort。
//
// 两种形态由主进程能力决定：
//   · `snapshot` 方法存在（多会话宿主注入，##465）→ 左侧会话列表 + 顶部模型选择器 + 主区消息流
//   · 不存在（apps/minimal 的单会话）→ 原来的单列聊天，行为一字不变

import type { PageContext, PageView } from "@diy-agent/workbench-ui";
import type { ChatSnapshot, ModelChoice, SendResult, SessionSummary, WireMessage } from "./shared.js";

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

export const chatPageView: PageView = {
    id: "chat",
    title: "聊天",
    render(root: HTMLElement, ctx: PageContext): () => void {
        const doc = root.ownerDocument;
        ensureStyle(doc);
        root.replaceChildren();

        const page = node(doc, "div", "chat-page");
        const app = node(doc, "div", "chat-app");
        const aside = node(doc, "aside", "chat-sessions") as HTMLElement;
        aside.hidden = true;
        const head = node(doc, "div", "chat-sessions-head");
        const headTitle = node(doc, "span", "chat-sessions-title");
        headTitle.textContent = "会话";
        const newButton = node(doc, "button", "chat-new") as HTMLButtonElement;
        newButton.type = "button";
        newButton.textContent = "新建";
        head.append(headTitle, newButton);
        const sessionList = node(doc, "ul", "chat-session-list");
        aside.append(head, sessionList);

        const main = node(doc, "section", "chat-main");
        const header = node(doc, "div", "chat-header") as HTMLElement;
        header.hidden = true;
        const modelLabel = node(doc, "span", "chat-model-label");
        modelLabel.textContent = "新会话模型";
        const modelSelect = node(doc, "select", "chat-model") as HTMLSelectElement;
        header.append(modelLabel, modelSelect);

        const list = node(doc, "ol", "chat-list");
        const empty = node(doc, "li", "chat-empty");
        empty.textContent = "还没有消息，说一句话开始。";

        const form = node(doc, "form", "chat-composer");
        const input = node(doc, "input", "chat-input") as HTMLInputElement;
        input.type = "text";
        input.placeholder = "说点什么…";
        const send = node(doc, "button", "chat-send") as HTMLButtonElement;
        send.type = "submit";
        send.textContent = "发送";
        form.append(input, send);

        let current: readonly WireMessage[] = [];
        let snapshot: ChatSnapshot | null = null;
        let selectedModel = "";
        let busy = false;

        const paint = (messages: readonly WireMessage[]): void => {
            current = messages;
            list.replaceChildren();
            if (messages.length === 0) {
                list.append(empty);
                return;
            }
            for (const message of messages) list.append(row(doc, message));
            list.scrollTop = list.scrollHeight;
        };

        const paintSessions = (sessions: readonly SessionSummary[], activeId: string | null): void => {
            sessionList.replaceChildren();
            for (const session of sessions) {
                const item = node(doc, "li", "chat-session-item");
                const button = node(doc, "button", "chat-session") as HTMLButtonElement;
                button.type = "button";
                button.dataset["active"] = String(session.id === activeId);
                const name = node(doc, "span", "chat-session-name");
                name.textContent = session.title;
                const meta = node(doc, "span", "chat-session-meta");
                meta.textContent = `${session.model} · ${session.messageCount} 条`;
                button.append(name, meta);
                button.addEventListener("click", () => {
                    if (busy || session.id === snapshot?.activeId) return;
                    void ctx
                        .invoke<ChatSnapshot>("selectSession", { id: session.id })
                        .then(apply)
                        .catch((cause: unknown) => paint([...current, { role: "assistant", text: `切换失败：${messageOf(cause)}` }]));
                });
                item.append(button);
                sessionList.append(item);
            }
        };

        const paintModels = (models: readonly ModelChoice[], selected: string | null): void => {
            modelSelect.replaceChildren();
            for (const choice of models) {
                const value = `${choice.providerId}/${choice.modelId}`;
                const option = doc.createElement("option");
                option.value = value;
                option.textContent = `${choice.providerId} · ${choice.name}`;
                modelSelect.append(option);
            }
            const keys = models.map((choice) => `${choice.providerId}/${choice.modelId}`);
            if (selected !== null) selectedModel = selected;
            else if (!keys.includes(selectedModel)) selectedModel = keys[0] ?? "";
            modelSelect.value = selectedModel;
            modelSelect.disabled = models.length === 0;
            if (models.length === 0) {
                const option = doc.createElement("option");
                option.value = "";
                option.textContent = "（model.yaml 里没有可用模型）";
                modelSelect.append(option);
            }
        };

        const apply = (next: ChatSnapshot): void => {
            snapshot = next;
            aside.hidden = false;
            header.hidden = false;
            paintSessions(next.sessions, next.activeId);
            paintModels(next.models, next.selectedModel);
            paint(next.messages);
            // 多会话模式但还没有打开的会话：输入框先禁用（先建会话再说话）
            input.disabled = next.activeId === null;
            send.disabled = next.activeId === null;
            empty.textContent = "还没有消息，说一句话开始。";
        };

        modelSelect.addEventListener("change", () => {
            selectedModel = modelSelect.value;
        });

        newButton.addEventListener("click", () => {
            if (busy || !snapshot) return;
            busy = true;
            newButton.disabled = true;
            const model = selectedModel === "" ? {} : { model: selectedModel };
            void ctx
                .invoke<ChatSnapshot>("createSession", model)
                .then(apply)
                .catch((cause: unknown) => paint([...current, { role: "assistant", text: `新建失败：${messageOf(cause)}` }]))
                .finally(() => {
                    busy = false;
                    newButton.disabled = false;
                    input.focus();
                });
        });

        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const text = input.value.trim();
            if (busy || text.length === 0) return;
            busy = true;
            send.disabled = true;
            modelSelect.disabled = true;
            input.value = "";
            paint([...current, { role: "user", text }]);
            const multi = snapshot !== null && snapshot.activeId !== null;
            const request: Promise<unknown> = multi
                ? ctx.invoke<ChatSnapshot>("send", { sessionId: snapshot!.activeId, text })
                : ctx.invoke<SendResult>("send", text);
            void request
                .then((result) => {
                    if (isSnapshot(result)) apply(result);
                    else paint((result as SendResult).messages);
                })
                .catch((cause: unknown) => {
                    paint([...current, { role: "assistant", text: `出错了：${messageOf(cause)}` }]);
                })
                .finally(() => {
                    busy = false;
                    // 多会话模式且没打开会话时保持禁用（单会话模式 snapshot = null）
                    const blocked = snapshot !== null && snapshot.activeId === null;
                    send.disabled = blocked;
                    input.disabled = blocked;
                    modelSelect.disabled = (snapshot?.models.length ?? 0) === 0;
                    input.focus();
                });
        });

        main.append(header, list, form);
        app.append(aside, main);
        page.append(app);
        root.append(page);
        input.focus();

        // 先问主进程有没有多会话能力；没有就按单会话画（消息线从空开始）
        void ctx
            .invoke<ChatSnapshot>("snapshot")
            .then((next) => {
                apply(next);
                if (next.activeId === null && next.sessions.length === 0) {
                    empty.textContent = "点左上角「新建」开始一个会话。";
                    paint([]);
                }
            })
            .catch(() => {
                snapshot = null;
                paint([]);
            });

        return () => {
            root.replaceChildren();
        };
    },
};

export default chatPageView;

function isSnapshot(value: unknown): value is ChatSnapshot {
    return value !== null && typeof value === "object" && Array.isArray((value as ChatSnapshot).sessions);
}

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
