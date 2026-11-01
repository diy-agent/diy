// renderer.ts — 页面插件的 renderer 侧（**裸 DOM 版**）：消息列表 + bot 条 + 输入框。
//
// 只做展示与转发：输入一句话 → `ctx.invoke('send', …)` → 用返回的快照重画。
// 本文件不认识 Electron / IPC（那些在 preload 与主进程），也拿不到 LlmPort。
//
// 两种形态由主进程能力决定：
//   · `snapshot` 方法存在（多 bot 宿主注入，##465/##498）→ 左侧 bot 条 + 底部指标 + 主区消息流
//   · 不存在（apps/minimal 的单会话）→ 原来的单列聊天，行为一字不变
//
// ##498：界面形态与 renderer-diui.ts 一致（bot 条 64/200px、无顶部横幅、底部一行指标、
// hover 2 级卡片）。**差别只在画法**：本文件每次快照整体重画（对照组：会闪 / 丢焦点），
// diui 版走增量。判据 1 要求两版长得一样，所以结构、class 名、文案都对着写。

import type { PageContext, PageView } from "@diy-agent/workbench-ui";
import type { BotView, ChatMetrics, ChatSnapshot, ModelChoice, SendResult, WireMessage } from "./shared.js";
import { textMessage } from "./shared.js";
import { renderBlocks } from "./block-renderers.js";
import { ensureChatStyle } from "./style.js";

// ##499：renderer 对外提供块渲染器注册口（插件自造 kind 从这里登记）
export { registerBlockRenderer, renderBlock, renderBlocks } from "./block-renderers.js";

export const chatPageView: PageView = {
    id: "chat",
    title: "聊天",
    render(root: HTMLElement, ctx: PageContext): () => void {
        const doc = root.ownerDocument;
        ensureChatStyle(doc);
        root.replaceChildren();

        const page = node(doc, "div", "chat-page");
        page.dataset["renderer"] = "dom";
        const app = node(doc, "div", "chat-app");
        const aside = node(doc, "aside", "chat-bots");
        aside.hidden = true;
        const botList = node(doc, "ul", "chat-bot-list");
        aside.append(botList);

        const main = node(doc, "section", "chat-main");
        const editor = node(doc, "div", "chat-panel");
        editor.dataset["show"] = "false";
        const first = node(doc, "div", "chat-panel");
        first.dataset["show"] = "false";
        const list = node(doc, "ol", "chat-list");
        const empty = node(doc, "li", "chat-empty");
        empty.textContent = "还没有消息，说一句话开始。";

        const foot = node(doc, "div", "chat-foot");
        const metrics = node(doc, "div", "chat-metrics");
        const form = node(doc, "form", "chat-composer");
        const input = node(doc, "input", "chat-input") as HTMLInputElement;
        input.type = "text";
        input.placeholder = "说点什么…";
        const send = node(doc, "button", "chat-send") as HTMLButtonElement;
        send.type = "submit";
        send.textContent = "发送";
        form.append(input, send);
        foot.append(metrics, form);
        main.append(editor, first, list, foot);
        app.append(aside, main);
        page.append(app);

        const card = node(doc, "div", "chat-card");
        card.dataset["show"] = "false";
        page.append(card);
        root.append(page);

        let snapshot: ChatSnapshot | null = null;
        let current: readonly WireMessage[] = [];
        let selectedModel = "";
        let busy = false;
        let hideTimer: ReturnType<typeof setTimeout> | null = null;

        // ── 消息线 ───────────────────────────────────────

        const paint = (messages: readonly WireMessage[]): void => {
            current = messages;
            list.replaceChildren();
            if (messages.length === 0) {
                empty.textContent = snapshot?.bot == null ? "先建一个 bot（引导页）" : "还没有消息，说一句话开始。";
                list.append(empty);
                return;
            }
            for (const message of messages) list.append(row(doc, message));
            list.scrollTop = list.scrollHeight;
        };

        // ── bot 条 ───────────────────────────────────────

        const paintBots = (next: ChatSnapshot): void => {
            botList.replaceChildren();
            for (const bot of next.bots) {
                const item = node(doc, "li", "chat-bot");
                item.dataset["active"] = String(bot.id === next.bot?.id);
                const button = node(doc, "button", "chat-bot-btn") as HTMLButtonElement;
                button.type = "button";
                button.dataset["botId"] = bot.id;
                const avatar = node(doc, "span", "chat-bot-avatar", initialOf(bot.name));
                avatar.style.background = colorOf(bot.id);
                const text = node(doc, "span", "chat-bot-text");
                text.append(
                    node(doc, "span", "chat-bot-name", bot.name),
                    node(doc, "span", "chat-bot-model", bot.needsModel ? "未选模型" : bot.model),
                );
                button.append(avatar, text);
                button.addEventListener("mouseenter", () => showCard(next, bot, button));
                button.addEventListener("mouseleave", scheduleHide);
                button.addEventListener("click", () => {
                    hideCard();
                    if (bot.id === next.bot?.id) openEditor("config", bot, bot.needsModel);
                    else void ctx.invoke<ChatSnapshot>("selectBot", { id: bot.id }).then(apply).catch(fail("切换失败"));
                });
                item.append(button);
                botList.append(item);
            }
            const item = node(doc, "li", "chat-bot chat-bot-new");
            const button = node(doc, "button", "chat-bot-btn chat-bot-new-btn") as HTMLButtonElement;
            button.type = "button";
            const avatar = node(doc, "span", "chat-bot-avatar", "+");
            const text = node(doc, "span", "chat-bot-text");
            text.append(node(doc, "span", "chat-bot-name", "新 bot"), node(doc, "span", "chat-bot-model", "创建一个"));
            button.append(avatar, text);
            button.addEventListener("click", () => openEditor("create", null));
            item.append(button);
            botList.append(item);
        };

        // ── 底部指标 ─────────────────────────────────────

        const paintMetrics = (next: ChatSnapshot): void => {
            metrics.replaceChildren();
            const bot = next.bot;
            if (bot === null) return;
            const label = node(doc, "button", "chat-bot-label") as HTMLButtonElement;
            label.type = "button";
            label.append(node(doc, "span", "", bot.name), node(doc, "span", "", "⚙"));
            label.addEventListener("click", () => openEditor("config", bot, bot.needsModel));
            metrics.append(label, node(doc, "span", "chat-sep", "|"));
            const m: ChatMetrics | null = next.metrics;
            const ratio =
                m?.inputTokens !== undefined && m.contextWindow !== undefined && m.contextWindow > 0
                    ? (m.inputTokens / m.contextWindow) * 100
                    : undefined;
            const cache =
                m?.cacheReadTokens !== undefined && m.inputTokens !== undefined && m.inputTokens > 0
                    ? (m.cacheReadTokens / m.inputTokens) * 100
                    : undefined;
            metrics.append(
                metric(doc, "输入", tokenText(m?.inputTokens)),
                metric(
                    doc,
                    "窗口",
                    ratio === undefined ? "—" : `${ratio.toFixed(1)}%`,
                    ratio !== undefined && ratio > 60,
                ),
                metric(doc, "缓存", cache === undefined ? "—" : `${cache.toFixed(1)}%`),
                metric(doc, "本轮", m?.cost === undefined ? "—" : money(m.cost)),
                metric(doc, "上下文", `${String(m?.turns ?? 0)} step`),
            );
        };

        // ── hover 卡片 ───────────────────────────────────

        const scheduleHide = (): void => {
            if (hideTimer !== null) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                hideTimer = null;
                if (card.matches(":hover")) return;
                hideCard();
            }, 120);
        };
        const hideCard = (): void => {
            if (hideTimer !== null) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            card.dataset["show"] = "false";
        };
        card.addEventListener("mouseenter", () => {
            if (hideTimer !== null) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
        });
        card.addEventListener("mouseleave", scheduleHide);

        const showCard = (next: ChatSnapshot, bot: BotView, anchor: HTMLElement): void => {
            if (hideTimer !== null) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            card.replaceChildren();
            card.append(
                node(doc, "div", "chat-card-title", bot.name),
                node(doc, "div", "chat-card-model", bot.needsModel ? "未选模型" : bot.model),
                cardRow(doc, "会话", String(bot.sessionCount)),
                cardRow(doc, "创建", bot.createdAt.slice(0, 10)),
                cardRow(
                    doc,
                    "本轮花费",
                    bot.id === next.bot?.id && next.metrics?.cost !== undefined ? money(next.metrics.cost) : "—",
                ),
            );
            const acts = node(doc, "div", "chat-card-acts");
            const cfg = node(doc, "button", "chat-primary", "配置") as HTMLButtonElement;
            cfg.type = "button";
            cfg.addEventListener("click", () => openEditor("config", bot));
            const open = node(doc, "button", "", "打开对话") as HTMLButtonElement;
            open.type = "button";
            open.addEventListener("click", () => {
                hideCard();
                if (bot.id !== next.bot?.id) void ctx.invoke<ChatSnapshot>("selectBot", { id: bot.id }).then(apply);
            });
            acts.append(cfg, open);
            card.append(acts);
            const rect = anchor.getBoundingClientRect();
            card.style.top = `${String(Math.round(rect.top))}px`;
            card.style.left = `${String(Math.round(rect.right + 8))}px`;
            card.dataset["show"] = "true";
        };

        // ── 面板：配置 / 新建 / 首启 ──────────────────────

        const closeEditor = (): void => {
            editor.dataset["show"] = "false";
        };

        const openEditor = (mode: "config" | "create", bot: BotView | null, forced = false): void => {
            hideCard();
            first.dataset["show"] = "false";
            const isNew = mode === "create";
            editor.replaceChildren();
            editor.dataset["show"] = "true";

            const head = node(doc, "div", "chat-panel-head");
            head.append(node(doc, "h2", "chat-panel-title", isNew ? "新建 bot" : `${bot?.name ?? ""} · 配置`));
            const close = node(doc, "button", "", "关闭") as HTMLButtonElement;
            close.type = "button";
            close.hidden = forced;
            close.addEventListener("click", closeEditor);
            head.append(close);

            const body = node(doc, "div", "chat-panel-body");
            const formEl = node(doc, "div", "chat-form");
            const nameInput = inputOf(doc, "text", bot?.name ?? "");
            const modelSelect = selectOf(
                doc,
                (snapshot?.models ?? []).map((choice) => ({
                    value: `${choice.providerId}/${choice.modelId}`,
                    label: `${choice.providerId} · ${choice.name}`,
                })),
                bot?.model !== undefined && bot.model !== "" ? bot.model : selectedModel,
            );
            const effortSelect = selectOf(
                doc,
                [
                    { value: "", label: "缺省" },
                    { value: "low", label: "low" },
                    { value: "medium", label: "medium" },
                    { value: "high", label: "high" },
                ],
                bot?.reasoningEffort ?? "",
            );
            const instructions = node(doc, "textarea", "") as HTMLTextAreaElement;
            instructions.value = bot?.instructions ?? "";
            formEl.append(
                node(doc, "label", "", "名字"),
                nameInput,
                node(doc, "label", "", "模型"),
                modelSelect,
                node(doc, "label", "", "推理强度"),
                effortSelect,
                node(doc, "label", "", "行为指令"),
                instructions,
            );
            body.append(formEl);
            if (!isNew && bot !== null) {
                body.append(
                    node(
                        doc,
                        "p",
                        "chat-panel-note",
                        `会话 ${String(bot.sessionCount)} · 创建于 ${bot.createdAt.slice(0, 10)} · 模型 ${
                            bot.needsModel ? "未选" : bot.model
                        }`,
                    ),
                );
            }

            const error = node(doc, "p", "chat-panel-error");
            error.hidden = true;
            const fail = (text: string): void => {
                error.textContent = text;
                error.hidden = false;
            };

            const actions = node(doc, "div", "chat-panel-actions");
            const submit = node(doc, "button", "chat-primary", isNew ? "创建" : "保存") as HTMLButtonElement;
            submit.type = "button";
            actions.append(submit);
            if (!isNew && bot !== null) {
                const remove = node(doc, "button", "chat-danger", "删除 bot") as HTMLButtonElement;
                remove.type = "button";
                remove.addEventListener("click", () => {
                    const ok =
                        typeof doc.defaultView?.confirm !== "function" ||
                        doc.defaultView.confirm(`删除 bot「${bot.name}」？它的会话会一并删除（不可撤销）。`);
                    if (!ok) return;
                    void ctx
                        .invoke<ChatSnapshot>("removeBot", { id: bot.id })
                        .then((next) => {
                            closeEditor();
                            apply(next);
                        })
                        .catch((cause: unknown) => fail(`删除失败：${messageOf(cause)}`));
                });
                actions.append(remove);
            }
            body.append(error, actions);
            editor.append(head, body);

            submit.addEventListener("click", () => {
                const name = nameInput.value.trim();
                const model = modelSelect.value;
                if (name === "") return fail("名字不能为空");
                if (model === "") return fail("必须先选一个模型（bot 的 model 必填）");
                const payload = {
                    name,
                    model,
                    instructions: instructions.value,
                    reasoningEffort: effortSelect.value,
                };
                const request = isNew
                    ? ctx.invoke<ChatSnapshot>("createBot", payload)
                    : ctx.invoke<ChatSnapshot>("updateBot", { id: bot?.id, ...payload });
                submit.disabled = true;
                void request
                    .then((next) => {
                        closeEditor();
                        apply(next);
                    })
                    .catch((cause: unknown) => fail(`保存失败：${messageOf(cause)}`))
                    .finally(() => {
                        submit.disabled = false;
                    });
            });
            nameInput.focus();
        };

        const openFirstBoot = (): void => {
            closeEditor();
            hideCard();
            first.replaceChildren();
            first.dataset["show"] = "true";
            const head = node(doc, "div", "chat-panel-head");
            head.append(node(doc, "h2", "chat-panel-title", "建第一个 bot"));
            const body = node(doc, "div", "chat-panel-body");
            body.append(
                node(doc, "p", "", "一个 bot 一条长期对话。先起个名字、选一个模型 —— 之后点它就是进这个对话。"),
            );
            const formEl = node(doc, "div", "chat-form");
            const nameInput = inputOf(doc, "text", "大王助手");
            const modelSelect = selectOf(
                doc,
                (snapshot?.models ?? []).map((choice) => ({
                    value: `${choice.providerId}/${choice.modelId}`,
                    label: `${choice.providerId} · ${choice.name}`,
                })),
                selectedModel,
            );
            const instructions = node(doc, "textarea", "") as HTMLTextAreaElement;
            instructions.value = "你是「大王助手」，在 diy 的聊天窗口里陪大王干活。回答要短、要具体，能查证的不靠猜。";
            formEl.append(
                node(doc, "label", "", "名字"),
                nameInput,
                node(doc, "label", "", "模型"),
                modelSelect,
                node(doc, "label", "", "行为指令"),
                instructions,
            );
            body.append(formEl);
            const error = node(doc, "p", "chat-panel-error");
            error.hidden = true;
            const actions = node(doc, "div", "chat-panel-actions");
            const submit = node(doc, "button", "chat-primary", "创建并开始") as HTMLButtonElement;
            submit.type = "button";
            actions.append(submit);
            body.append(error, actions);
            first.append(head, body);
            if ((snapshot?.models.length ?? 0) === 0) {
                error.textContent = "模型目录里没有可用模型 —— 先到「模型配置」添加一个";
                error.hidden = false;
            }
            submit.addEventListener("click", () => {
                const model = modelSelect.value;
                if (model === "") {
                    error.textContent = "模型目录里没有可用模型 —— 先到「模型配置」添加一个";
                    error.hidden = false;
                    return;
                }
                submit.disabled = true;
                void ctx
                    .invoke<ChatSnapshot>("createFirstBot", {
                        model,
                        name: nameInput.value.trim() || undefined,
                        instructions: instructions.value,
                    })
                    .then((next) => {
                        first.dataset["show"] = "false";
                        apply(next);
                    })
                    .catch((cause: unknown) => {
                        error.textContent = `创建失败：${messageOf(cause)}`;
                        error.hidden = false;
                    })
                    .finally(() => {
                        submit.disabled = false;
                    });
            });
            nameInput.focus();
        };

        // ── 快照落地 ─────────────────────────────────────

        const fail =
            (prefix: string) =>
            (cause: unknown): void => {
                paint([...current, textMessage("assistant", `${prefix}：${messageOf(cause)}`)]);
            };

        const apply = (next: ChatSnapshot): void => {
            snapshot = next;
            aside.hidden = false;
            metrics.hidden = false;
            foot.hidden = next.bot === null;
            paintBots(next);
            paintMetrics(next);
            selectedModel = next.selectedModel ?? firstKey(next.models);
            paint(next.messages);
            const blocked = next.bot === null;
            input.disabled = blocked;
            send.disabled = blocked;
            if (next.bot === null) openFirstBoot();
            else if (next.bot.needsModel) openEditor("config", next.bot, true);
        };

        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const text = input.value.trim();
            if (busy || text.length === 0) return;
            busy = true;
            send.disabled = true;
            input.value = "";
            paint([...current, textMessage("user", text)]);
            const multi = snapshot !== null && snapshot.bot !== null;
            const request: Promise<unknown> = multi
                ? ctx.invoke<ChatSnapshot>("send", { text })
                : ctx.invoke<SendResult>("send", text);
            void request
                .then((result) => {
                    if (isSnapshot(result)) apply(result);
                    else paint((result as SendResult).messages);
                })
                .catch((cause: unknown) => paint([...current, textMessage("assistant", `出错了：${messageOf(cause)}`)]))
                .finally(() => {
                    busy = false;
                    send.disabled = (snapshot !== null && snapshot.bot === null) || false;
                    input.disabled = snapshot !== null && snapshot.bot === null;
                    input.focus();
                });
        });

        // 先问主进程有没有多 bot 能力；没有就按单会话画（消息线从空开始）
        void ctx
            .invoke<ChatSnapshot>("snapshot")
            .then((next) => {
                apply(next);
                if (next.bot === null) {
                    empty.textContent = "先建一个 bot（引导页）";
                    paint([]);
                }
            })
            .catch(() => {
                snapshot = null;
                paint([]);
            })
            // `data-ready`：首份快照落地后置 1（CDP 判据等「页面就绪」用；不影响渲染）
            .finally(() => {
                root.dataset['ready'] = '1';
            });

        return () => {
            if (hideTimer !== null) clearTimeout(hideTimer);
            root.replaceChildren();
        };
    },
};

export default chatPageView;

// ── 小工具 ───────────────────────────────────────────────

function isSnapshot(value: unknown): value is ChatSnapshot {
    return value !== null && typeof value === "object" && Array.isArray((value as ChatSnapshot).bots);
}

function row(doc: Document, message: WireMessage): HTMLElement {
    const item = node(doc, "li", "chat-row");
    item.dataset["role"] = message.role;
    const role = node(doc, "span", "chat-role");
    role.textContent = message.role === "user" ? "我" : "助手";
    // ##499：一行 = 若干 Block；renderer 只认 Block，不认识任何单个 kind 的数据语义
    const blocks = node(doc, "div", "chat-blocks");
    blocks.append(...renderBlocks(message.blocks));
    item.append(role, blocks);
    return item;
}

function node(doc: Document, tag: string, className: string, text?: string): HTMLElement {
    const element = doc.createElement(tag);
    if (className !== "") element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function cardRow(doc: Document, label: string, value: string): HTMLElement {
    const row = node(doc, "div", "chat-card-row");
    row.append(node(doc, "span", "", label), node(doc, "b", "", value));
    return row;
}

function metric(doc: Document, label: string, value: string, warn = false): HTMLElement {
    const span = node(doc, "span", "chat-metric");
    span.append(node(doc, "span", "", `${label} `), node(doc, "b", warn ? "chat-warn" : "", value));
    return span;
}

function inputOf(doc: Document, type: string, value: string): HTMLInputElement {
    const input = doc.createElement("input");
    input.type = type;
    input.value = value;
    return input;
}

function selectOf(
    doc: Document,
    options: readonly { value: string; label: string }[],
    selected: string,
): HTMLSelectElement {
    const select = doc.createElement("select");
    for (const option of options) {
        const item = doc.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        select.append(item);
    }
    if (options.length === 0) {
        const item = doc.createElement("option");
        item.value = "";
        item.textContent = "（model.yaml 里没有可用模型）";
        select.append(item);
    } else if (options.some((option) => option.value === selected)) {
        select.value = selected;
    }
    return select;
}

function messageOf(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

function firstKey(models: readonly ModelChoice[]): string {
    const first = models[0];
    return first ? `${first.providerId}/${first.modelId}` : "";
}

function tokenText(value: number | undefined): string {
    if (value === undefined) return "—";
    return value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;
}

function money(value: number): string {
    return `$${value.toFixed(4)}`;
}

function colorOf(id: string): string {
    const palette = ["#5b8def", "#e08b4a", "#4aa87a", "#9b7bd4", "#d4698b", "#4aa3b8"];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length] ?? palette[0]!;
}

function initialOf(name: string): string {
    return name.trim().slice(0, 1) || "?";
}
