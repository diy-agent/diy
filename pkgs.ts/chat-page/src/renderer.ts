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
import { ensureChatStyle } from "./style.js";

export const chatPageView: PageView = {
    id: "chat",
    title: "聊天",
    render(root: HTMLElement, ctx: PageContext): () => void {
        const doc = root.ownerDocument;
        ensureChatStyle(doc);
        root.replaceChildren();

        const page = node(doc, "div", "chat-page");
        // 与 renderer-diui 对齐的版本标记（CDP 判据认版本用）
        page.dataset["renderer"] = "dom";
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

function messageOf(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}
