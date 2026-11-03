// renderer-diui.ts — 页面插件的 renderer 侧（**diyui 版**，##468），与 renderer.ts（裸 DOM 版）并存。
//
// 两版只差「怎么画」：线上形状（shared.ts 的 BotChatSnapshot / WireMessage）、`ctx.invoke`
// 的方法名与调用时机**一字不动**，所以装配层换一行 import 就能切：
//
//   import { chatPageView } from "@diy-agent/chat-page/renderer";        // 裸 DOM 版
//   import { chatPageView } from "@diy-agent/chat-page/renderer-diui";   // 本文件
//
// ##498：页面从「会话中心」改成 **bot 中心**（界面形态见 ##498 body）：
//   · 左栏是 **bot 条**（64px，hover 展开 200px，平时只露头像）—— 一个 bot 一个长期对话
//   · **没有顶部横幅**：消息流从窗口最顶开始
//   · 底部一行合并「bot 名 ⚙ | 输入 … 窗口 … 缓存 … 本轮 … 上下文 …」+ 输入框
//   · bot hover 弹 2 级卡片（名字 / 模型 / 会话数 / 创建时间 / 本轮花费 + 配置 / 打开对话）
//   · 配置面板与首启引导是覆盖消息区的一层面板（不是新页面）
//
// 增量渲染的判据沿用 ##468：结构层（bot 条外壳 / 消息滚动容器 / 输入框）只建一次，
// 只有「动态块」（bot 行 / 指标 / 消息行）读 rev；列表给 key + rev，同 key 同 rev 直接复用 DOM。
// 面板与 hover 卡片是**命令式**的（打开时填一次内容）：它们里有输入框，走响应式重建会丢正在打的字。

import { GenApp, html, Signal, type Spec } from "@diy-agent/ui/browser";
import type { PageContext, PageView } from "@diy-agent/workbench-ui";
import type { BotView, ChatMetrics, BotChatSnapshot, ModelChoice, SendResult, WireMessage } from "./shared.js";
import { textMessage } from "./shared.js";
import { DEMO_TOOL_COMMAND, demoToolMessage } from "./demo.js";
import { renderBlocks } from "./block-renderers.js";
import { ensureChatStyle } from "./style.js";

// ##499：与裸 DOM 版同一份注册表（插件自造 kind 从这里登记）
export { registerBlockRenderer, renderBlock, renderBlocks } from "./block-renderers.js";

interface Store {
    /** `snapshot` 方法存在（多 bot 宿主注入）→ 左栏 + 底部指标可见 */
    multi: boolean;
    bots: readonly BotView[];
    bot: BotView | null;
    models: readonly ModelChoice[];
    messages: readonly WireMessage[];
    metrics: ChatMetrics | null;
    /** 新建 bot 的缺省模型 `providerId/modelId` */
    selectedModel: string;
    busy: boolean;
    /** 空消息线的提示语（首启 / 没消息时不同） */
    emptyText: string;
}

const store: Store = {
    multi: false,
    bots: [],
    bot: null,
    models: [],
    messages: [],
    metrics: null,
    selectedModel: "",
    busy: false,
    emptyText: "还没有消息，说一句话开始。",
};

/** 右侧 panel 的模式（固定 / 悬浮）：换 bot 也保持上次选择 */
let viewsetPinned = false;

/** 唯一的变更信号：状态改了 → bump() → 只有动态块重跑。 */
const rev = new Signal(0);

function bump(): void {
    rev.value++;
}

/**
 * 反应式布尔 prop。`Props` 把 hidden / disabled 这些字段写成了 `boolean`，
 * 而运行时（applyProps）接受 getter / Signal；这里只是把意图告诉类型系统。
 */
function B(fn: () => boolean): boolean {
    return (() => {
        void rev.value; // 建立依赖（不读 rev 的 getter 永远不会重求值）
        return fn();
    }) as unknown as boolean;
}

// 结构层的 DOM 句柄：只建一次，焦点与输入内容都住在真实 DOM 里。
let inputEl: HTMLInputElement | null = null;
/** 挂载代次：页面切走后旧代的动态块一律不再产节点（避免两份半边树打架）。 */
let generation = 0;

export const chatPageView: PageView = {
    id: "chat",
    title: "聊天",
    render(root: HTMLElement, ctx: PageContext): () => void {
        ensureChatStyle(root.ownerDocument);
        const doc = root.ownerDocument;
        const my = ++generation;

        // 面板 / 卡片句柄（命令式填充；类型上都是普通元素）
        let editorEl: HTMLElement | null = null;
        let firstEl: HTMLElement | null = null;
        let cardEl: HTMLElement | null = null;
        /** `/demo-tool` 的收尾定时器（running → ok 用） */
        let demoTimer: ReturnType<typeof setTimeout> | null = null;
        /** 快照请求的单调序号：只有最新一次的结果才允许落地 */
        let snapshotSeq = 0;
        let hideTimer: ReturnType<typeof setTimeout> | null = null;

        // ── 面板：配置 / 新建 bot / 首启引导 ──────────────────

        const closeEditor = (): void => {
            if (editorEl !== null) editorEl.dataset["show"] = "false";
        };

        const closeFirst = (): void => {
            if (firstEl !== null) firstEl.dataset["show"] = "false";
        };

        const hideCard = (): void => {
            if (hideTimer !== null) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            if (cardEl !== null) cardEl.dataset["show"] = "false";
        };

        const scheduleHide = (): void => {
            if (hideTimer !== null) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                hideTimer = null;
                if (cardEl !== null && cardEl.matches(":hover")) return;
                if (cardEl !== null) cardEl.dataset["show"] = "false";
            }, 120);
        };

        const selectBot = (id: string): void => {
            if (store.busy) return;
            hideCard();
            void ctx
                .invoke<BotChatSnapshot>("selectBot", { id })
                .then(() => refresh())
                .catch((cause: unknown) => appendError(`切换失败：${messageOf(cause)}`));
        };

        // 悬停**不再**拉出配置 panel（用户 2026-11-02 裁）：hover 只是看（浮层卡片里带
        // 「配置」按钮），panel 只由显式点击打开 —— 点 bot 行只切对话，点「配置」/⚙ 才弹。

        /**
         * 右侧 panel（viewset）：列表项的「明细编辑」统一走这里，不再整页切换。
         *
         * 两种模式（同一份内容，只换摆法）：
         *   · `floating`（缺省）：浮在消息区右侧，不挤压正文
         *   · `pinned`：停靠成右侧一栏，消息区让出宽度
         * 模式记在模块级（`viewsetPinned`）：换 bot / 重开都保持上次的选择。
         */
        const openViewset = (mode: "config" | "create", bot: BotView | null, forced = false): void => {
            if (editorEl === null) return;
            hideCard();
            closeFirst();
            const isNew = mode === "create";
            editorEl.replaceChildren();
            editorEl.dataset["show"] = "true";
            editorEl.dataset["mode"] = viewsetPinned ? "pinned" : "floating";

            const head = el(doc, "div", "chat-viewset-head");
            head.append(el(doc, "span", "chat-viewset-title", isNew ? "新建 bot" : (bot?.name ?? "")));
            const pin = el(doc, "button", "chat-viewset-pin", viewsetPinned ? "📌 固定" : "📌 悬浮") as HTMLButtonElement;
            pin.type = "button";
            pin.title = "在「固定」（占一栏）和「悬浮」（浮在消息上）之间切换";
            pin.addEventListener("click", () => {
                viewsetPinned = !viewsetPinned;
                if (editorEl === null) return;
                editorEl.dataset["mode"] = viewsetPinned ? "pinned" : "floating";
                pin.textContent = viewsetPinned ? "📌 固定" : "📌 悬浮";
            });
            const close = el(doc, "button", "chat-viewset-close", "✕") as HTMLButtonElement;
            close.type = "button";
            close.title = "关闭";
            close.hidden = forced;
            close.addEventListener("click", closeEditor);
            head.append(pin, close);

            const body = el(doc, "div", "chat-viewset-body");
            const form = el(doc, "div", "chat-form");

            const nameInput = inputOf(doc, "text", bot?.name ?? "");
            const modelSelect = selectOf(
                doc,
                store.models.map((choice) => ({
                    value: `${choice.providerId}/${choice.modelId}`,
                    label: `${choice.providerId} · ${choice.name}`,
                })),
                bot?.model !== undefined && bot.model !== "" ? bot.model : store.selectedModel,
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
            const instructions = el(doc, "textarea", "") as HTMLTextAreaElement;
            instructions.value = bot?.instructions ?? "";

            form.append(
                el(doc, "label", "", "名字"),
                nameInput,
                el(doc, "label", "", "模型"),
                modelSelect,
                el(doc, "label", "", "推理强度"),
                effortSelect,
                el(doc, "label", "", "行为指令"),
                instructions,
            );
            body.append(form);

            if (!isNew && bot !== null) {
                body.append(
                    el(
                        doc,
                        "p",
                        "chat-viewset-note",
                        `会话 ${String(bot.sessionCount)} · 创建于 ${dateOf(bot.createdAt)} · 模型 ${
                            bot.needsModel ? "未选" : bot.model
                        }`,
                    ),
                );
            }

            const error = el(doc, "p", "chat-panel-error");
            error.hidden = true;

            const actions = el(doc, "div", "chat-viewset-actions");
            const submit = el(doc, "button", "chat-primary", isNew ? "创建" : "保存") as HTMLButtonElement;
            submit.type = "button";
            actions.append(submit);
            if (!isNew && bot !== null) {
                const remove = el(doc, "button", "chat-danger", "删除") as HTMLButtonElement;
                remove.type = "button";
                remove.addEventListener("click", () => {
                    const ok =
                        typeof doc.defaultView?.confirm !== "function" ||
                        doc.defaultView.confirm(`删除 bot「${bot.name}」？它的会话会一并删除（不可撤销）。`);
                    if (!ok) return;
                    void ctx
                        .invoke<BotChatSnapshot>("removeBot", { id: bot.id })
                        .then(() => {
                            closeEditor();
                            return refresh();
                        })
                        .catch((cause: unknown) => fail(`删除失败：${messageOf(cause)}`));
                });
                actions.append(remove);
            }
            body.append(error, actions);
            editorEl.append(head, body);

            const fail = (text: string): void => {
                error.textContent = text;
                error.hidden = false;
            };

            submit.addEventListener("click", () => {
                const name = nameInput.value.trim();
                const model = modelSelect.value;
                if (name === "") {
                    fail("名字不能为空");
                    return;
                }
                if (model === "") {
                    fail("必须先选一个模型（bot 的 model 必填）");
                    return;
                }
                const payload = {
                    name,
                    model,
                    instructions: instructions.value,
                    reasoningEffort: effortSelect.value,
                };
                const request = isNew
                    ? ctx.invoke<BotChatSnapshot>("createBot", payload)
                    : ctx.invoke<BotChatSnapshot>("updateBot", { id: bot?.id, ...payload });
                submit.disabled = true;
                void request
                    .then(() => {
                        closeEditor();
                        return refresh();
                    })
                    .catch((cause: unknown) => fail(`保存失败：${messageOf(cause)}`))
                    .finally(() => {
                        submit.disabled = false;
                    });
            });

            nameInput.focus();
        };

        /** 首启引导：bots 为空 ⇒ 必须先建一个 bot（选模型），不进聊天（##498 判据 8） */
        const openFirstBoot = (): void => {
            if (firstEl === null) return;
            closeEditor();
            hideCard();
            firstEl.replaceChildren();
            firstEl.dataset["show"] = "true";

            const head = el(doc, "div", "chat-panel-head");
            head.append(el(doc, "h2", "chat-panel-title", "建第一个 bot"));
            const body = el(doc, "div", "chat-panel-body");
            body.append(el(doc, "p", "", "一个 bot 一条长期对话。先起个名字、选一个模型 —— 之后点它就是进这个对话。"));

            const form = el(doc, "div", "chat-form");
            const nameInput = inputOf(doc, "text", "大王助手");
            const modelSelect = selectOf(
                doc,
                store.models.map((choice) => ({
                    value: `${choice.providerId}/${choice.modelId}`,
                    label: `${choice.providerId} · ${choice.name}`,
                })),
                store.selectedModel,
            );
            const instructions = el(doc, "textarea", "") as HTMLTextAreaElement;
            instructions.value = "你是「大王助手」，在 diy 的聊天窗口里陪大王干活。回答要短、要具体，能查证的不靠猜。";
            form.append(
                el(doc, "label", "", "名字"),
                nameInput,
                el(doc, "label", "", "模型"),
                modelSelect,
                el(doc, "label", "", "行为指令"),
                instructions,
            );
            body.append(form);

            const error = el(doc, "p", "chat-panel-error");
            error.hidden = true;
            const actions = el(doc, "div", "chat-panel-actions");
            const submit = el(doc, "button", "chat-primary", "创建并开始") as HTMLButtonElement;
            submit.type = "button";
            actions.append(submit);
            body.append(error, actions);
            firstEl.append(head, body);

            submit.addEventListener("click", () => {
                const model = modelSelect.value;
                if (model === "") {
                    error.textContent = "模型目录里没有可用模型 —— 先到「模型配置」添加一个";
                    error.hidden = false;
                    return;
                }
                submit.disabled = true;
                void ctx
                    .invoke<BotChatSnapshot>("createFirstBot", {
                        model,
                        name: nameInput.value.trim() || undefined,
                        instructions: instructions.value,
                    })
                    .then(() => {
                        closeFirst();
                        return refresh();
                    })
                    .catch((cause: unknown) => {
                        error.textContent = `创建失败：${messageOf(cause)}`;
                        error.hidden = false;
                    })
                    .finally(() => {
                        submit.disabled = false;
                    });
            });

            if (store.models.length === 0) {
                error.textContent = "模型目录里没有可用模型 —— 先到「模型配置」添加一个";
                error.hidden = false;
            }
            nameInput.focus();
        };

        /** hover 卡片：2 级信息（名字 / 模型 / 会话数 / 创建时间 / 本轮花费 + 两个按钮） */
        const showCard = (bot: BotView, anchor: HTMLElement): void => {
            if (cardEl === null) return;
            if (hideTimer !== null) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            const doc2 = cardEl.ownerDocument;
            cardEl.replaceChildren();
            cardEl.append(el(doc2, "div", "chat-card-title", bot.name));
            cardEl.append(el(doc2, "div", "chat-card-model", bot.needsModel ? "未选模型" : bot.model));
            cardEl.append(cardRow(doc2, "会话", String(bot.sessionCount)));
            cardEl.append(cardRow(doc2, "创建", dateOf(bot.createdAt)));
            const cost = bot.id === store.bot?.id ? store.metrics?.cost : undefined;
            cardEl.append(cardRow(doc2, "本轮花费", cost === undefined ? "—" : money(cost)));

            const acts = el(doc2, "div", "chat-card-acts");
            const cfg = el(doc2, "button", "chat-primary", "配置") as HTMLButtonElement;
            cfg.type = "button";
            cfg.addEventListener("click", () => {
                openViewset("config", bot);
            });
            const open = el(doc2, "button", "", "打开对话") as HTMLButtonElement;
            open.type = "button";
            open.addEventListener("click", () => selectBot(bot.id));
            acts.append(cfg, open);
            cardEl.append(acts);

            const rect = anchor.getBoundingClientRect();
            cardEl.style.top = `${String(Math.round(rect.top))}px`;
            cardEl.style.left = `${String(Math.round(rect.right + 8))}px`;
            cardEl.dataset["show"] = "true";
        };

        /** 卡片自己也要挡住「离开 bot 就收」：移进卡片算仍在看 */
        const wireCard = (): void => {
            const node = cardEl;
            if (node === null) return;
            node.addEventListener("mouseenter", () => {
                if (hideTimer !== null) {
                    clearTimeout(hideTimer);
                    hideTimer = null;
                }
            });
            node.addEventListener("mouseleave", scheduleHide);
        };

        // ── 结构层 ─────────────────────────────────────────

        const app = new GenApp({ mount: root });
        app.render(
            // data-renderer 是给 CDP 判据认版本用的（两版视觉等价，DOM 标记是唯一区别）
            html.div({ class: "chat-page", "data-renderer": "diui" }, function* () {
                yield html.div({ class: "chat-app" }, function* () {
                    yield botsPane(my);
                    yield html.section({ class: "chat-main" }, function* () {
                        // 首启引导是**硬闸门**：覆盖整块消息区，没得关（##498 判据 8）
                        yield html.div({
                            class: "chat-panel",
                            "data-show": "false",
                            ref: (node: HTMLElement) => {
                                firstEl = node;
                            },
                        });
                        // 消息流 + 右侧 panel（viewset）：pinned 时并排，floating 时浮在消息上
                        yield html.div({ class: "chat-body" }, function* () {
                            yield html.div({ class: "chat-stream" }, function* () {
                                yield messageList(my);
                                yield footBar(my, ctx);
                            });
                            yield html.tag(
                                "aside",
                                {
                                    class: "chat-viewset",
                                    "data-show": "false",
                                    "data-mode": "floating",
                                    ref: (node: HTMLElement) => {
                                        editorEl = node;
                                    },
                                },
                                function* () {},
                            );
                        });
                    });
                });
                // hover 卡片：fixed 定位，左栏 overflow:hidden 也裁不到它
                yield html.div({
                    class: "chat-card",
                    "data-show": "false",
                    ref: (node: HTMLElement) => {
                        cardEl = node;
                    },
                });
            }),
        );
        wireCard();
        inputEl?.focus();
        // `data-ready`：首份快照落地后置 1（CDP 判据等「页面就绪」用；不影响渲染）
        void load().finally(() => {
            root.dataset['ready'] = '1';
        });
        return () => {
            generation++;
            inputEl = null;
            editorEl = null;
            firstEl = null;
            cardEl = null;
            if (hideTimer !== null) clearTimeout(hideTimer);
            root.replaceChildren();
        };

        // ── 左栏：bot 条 ───────────────────────────────────

        function botsPane(gen: number): Spec {
            return html.tag(
                "aside",
                {
                    class: "chat-bots",
                    hidden: B(() => !store.multi),
                },
                function* () {
                    yield html.ul({ class: "chat-bot-list" }, function* () {
                        if (gen !== generation) return;
                        void rev.value;
                        // ##后端：新 bot 按钮放**列表最上面**（用户 2026-11-02 要求）
                        yield html.li({ key: "new-bot", class: "chat-bot chat-bot-new" }, function* () {
                            yield html.button(
                                {
                                    class: "chat-bot-btn chat-bot-new-btn",
                                    type: "button",
                                    onClick: () => openViewset("create", null),
                                },
                                function* () {
                                    yield html.span({ class: "chat-bot-avatar", text: "+" });
                                    yield html.span({ class: "chat-bot-text" }, function* () {
                                        yield html.span({ class: "chat-bot-name", text: "新 bot" });
                                        yield html.span({ class: "chat-bot-model", text: "创建一个" });
                                    });
                                },
                            );
                        });
                        for (const bot of store.bots) {
                            const active = bot.id === store.bot?.id;
                            yield html.li(
                                {
                                    key: `bot:${bot.id}`,
                                    rev: `${bot.name}|${bot.model}|${String(bot.sessionCount)}|${bot.needsModel ? "1" : "0"}|${String(active)}`,
                                    class: "chat-bot",
                                    "data-active": String(active),
                                },
                                function* () {
                                    yield html.button(
                                        {
                                            class: "chat-bot-btn",
                                            type: "button",
                                            // CDP 判据用：一个 bot 一行
                                            "data-bot-id": bot.id,
                                            onMouseEnter: (event: MouseEvent) => {
                                                const anchor = event.currentTarget as HTMLElement;
                                                // 悬停只出「概览卡片」（会话数 / 花费 + 配置 / 打开对话两个按钮），
                                                // **不**自动拉出右侧配置 panel（用户 2026-11-02 裁）
                                                showCard(bot, anchor);
                                            },
                                            onMouseLeave: () => {
                                                scheduleHide();
                                            },
                                            // 点 bot **只打开对话**（配置入口是 ⚙ / hover 卡片里的「配置」）
                                            onClick: () => {
                                                hideCard();
                                                selectBot(bot.id);
                                            },
                                        },
                                        function* () {
                                            yield html.span({
                                                class: "chat-bot-avatar",
                                                style: { background: colorOf(bot.id) },
                                                text: initialOf(bot.name),
                                            });
                                            yield html.span({ class: "chat-bot-text" }, function* () {
                                                yield html.span({ class: "chat-bot-name", text: bot.name });
                                                yield html.span({
                                                    class: "chat-bot-model",
                                                    text: bot.needsModel ? "未选模型" : bot.model,
                                                });
                                            });
                                        },
                                    );
                                },
                            );
                        }
                    });
                },
            );
        }

        // ── 主区：消息列表（滚动容器 = 结构层，行 = 动态块） ──

        function messageList(gen: number): Spec {
            return html.ol({ class: "chat-list" }, function* (self) {
                if (gen !== generation) return;
                void rev.value;
                const list = self.el;
                // 重跑前记下滚动：贴底就跟到底，否则原地不动（判据 3：新消息不把用户拽走）
                const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
                const top = list.scrollTop;
                if (store.messages.length === 0) {
                    yield html.li({ key: "empty", class: "chat-empty", text: store.emptyText });
                } else {
                    let index = 0;
                    for (const message of store.messages) {
                        // 指纹 = 块内容本身：tool 块从 running → ok 时 rev 变，只重建那一行
                        const fingerprint = message.blocks
                            .map((block) => `${block.kind}:${block.id}:${JSON.stringify(block.data)}`)
                            .join("\n");
                        const key = `${String(index)}:${message.role}:${String(hash(fingerprint))}`;
                        yield html.li(
                            { key, rev: fingerprint, class: "chat-row", "data-role": message.role },
                            function* () {
                                yield html.span({ class: "chat-role", text: message.role === "user" ? "我" : "助手" });
                                // ##499：一行 = 若干 Block（渲染器注册表在 block-renderers.ts，这里不认 kind）
                                yield html.div({
                                    class: "chat-blocks",
                                    ref: (node: HTMLElement) => {
                                        node.replaceChildren(...renderBlocks(message.blocks));
                                    },
                                });
                            },
                        );
                        index++;
                    }
                }
                if (atBottom) list.scrollTop = list.scrollHeight;
                else list.scrollTop = top;
            });
        }

        // ── 底部：bot 名 + 指标（一行）+ 输入框 ─────────────

        function footBar(gen: number, context: PageContext): Spec {
            return html.div({ class: "chat-foot", hidden: B(() => store.multi && store.bot === null) }, function* () {
                yield html.div({ class: "chat-metrics", hidden: B(() => !store.multi) }, function* () {
                    if (gen !== generation) return;
                    void rev.value;
                    const bot = store.bot;
                    if (bot === null) return;
                    yield html.button(
                        {
                            class: "chat-bot-label",
                            type: "button",
                            onClick: () => openViewset("config", bot, bot.needsModel),
                        },
                        function* () {
                            yield html.span({ text: bot.name });
                            yield html.span({ text: "⚙" });
                        },
                    );
                    yield html.span({ class: "chat-sep", text: "|" });
                    const metrics = store.metrics;
                    yield metric("输入", tokenText(metrics?.inputTokens));
                    const ratio =
                        metrics?.inputTokens !== undefined &&
                        metrics.contextWindow !== undefined &&
                        metrics.contextWindow > 0
                            ? (metrics.inputTokens / metrics.contextWindow) * 100
                            : undefined;
                    yield metric(
                        "窗口",
                        ratio === undefined ? "—" : `${ratio.toFixed(1)}%`,
                        ratio !== undefined && ratio > 60,
                    );
                    const cache =
                        metrics?.cacheReadTokens !== undefined &&
                        metrics.inputTokens !== undefined &&
                        metrics.inputTokens > 0
                            ? (metrics.cacheReadTokens / metrics.inputTokens) * 100
                            : undefined;
                    yield metric("缓存", cache === undefined ? "—" : `${cache.toFixed(1)}%`);
                    yield metric("本轮", metrics?.cost === undefined ? "—" : money(metrics.cost));
                    yield metric("上下文", `${String(metrics?.turns ?? 0)} step`);
                });
                yield composer(context);
            });
        }

        // ── 输入框（结构层：整个运行期只建一次 ⇒ 焦点与草稿不丢） ──

        function composer(context: PageContext): Spec {
            return html.tag(
                "form",
                {
                    class: "chat-composer",
                    onSubmit: (event: Event) => {
                        event.preventDefault();
                        void sendMessage(context);
                    },
                },
                function* () {
                    yield html.input({
                        class: "chat-input",
                        type: "text",
                        placeholder: "说点什么…",
                        disabled: B(() => store.multi && store.bot === null),
                        ref: (node: HTMLElement) => {
                            inputEl = node as HTMLInputElement;
                        },
                    });
                    yield html.button({
                        class: "chat-send",
                        type: "submit",
                        text: "发送",
                        disabled: B(() => store.busy || (store.multi && store.bot === null)),
                    });
                },
            );
        }

        // ── 行为 ───────────────────────────────────────────

        /**
         * 唯一的状态入口：从核心层**重新取整份快照**（docs/plans/2026-11-02-concurrency-actor.md 判据 5）。
         * UI 不增量改 `store.bots` / `store.messages` —— 那是显示状态，不是真源。
         */
        async function refresh(): Promise<void> {
            // 单调化：只认「最后发起的那个」快照。
            // 并发刷新时先发出的可能后到（旧状态盖新状态），丢弃它 —— 否则切 bot / 建 bot
            // 之后 UI 会显回上一个 bot 的消息线（真状态在核心层，UI 只是显示）。
            const seq = ++snapshotSeq;
            const next = await ctx.invoke<BotChatSnapshot>("snapshot");
            if (seq !== snapshotSeq) return;
            applySnapshot(next);
        }

        async function load(): Promise<void> {
            try {
                await refresh();
            } catch {
                // 没有多 bot 能力（apps/minimal 的单会话）：消息线从空开始
                store.multi = false;
                store.messages = [];
                bump();
            }
        }

        /**
         * `/demo-tool` 演示（##514 前置）：本地插一条假工具块，**不发主进程**。
         * 先 running（展开、黄点），约 900ms 后原地变 ok（收起、绿点、摘要 + 输出）。
         * 下一次快照（发消息 / 切 bot）就把它抹掉 —— 真状态只认核心层。
         */
        // 用 function 声明（提升）：本文件的结构层在 `return () => {...}` 之前收尾，
        // 后面的这些「行为」全是提升的函数声明（const 落在 return 之后就成不可达了）。
        function runDemoTool(): void {
            store.messages = [...store.messages, textMessage("user", DEMO_TOOL_COMMAND), demoToolMessage("running")];
            const index = store.messages.length - 1;
            bump();
            if (demoTimer !== null) clearTimeout(demoTimer);
            demoTimer = setTimeout(() => {
                demoTimer = null;
                const next = store.messages.slice();
                next[index] = demoToolMessage("ok");
                store.messages = next;
                bump();
            }, 900);
        }

        async function sendMessage(context: PageContext): Promise<void> {
            if (store.busy || inputEl === null) return;
            const text = inputEl.value.trim();
            if (text.length === 0) return;
            inputEl.value = "";
            if (text === DEMO_TOOL_COMMAND) {
                runDemoTool();
                return;
            }
            store.busy = true;
            store.messages = [...store.messages, textMessage("user", text)];
            bump();
            const multi = store.multi && store.bot !== null;
            try {
                if (multi) {
                    // send 的返回值只是这一条会话的消息线；整份状态**重新取**
                    await context.invoke<BotChatSnapshot>("send", { text });
                    await refresh();
                } else {
                    const result = await context.invoke<SendResult>("send", text);
                    store.messages = result.messages;
                    bump();
                }
            } catch (cause) {
                appendError(`出错了：${messageOf(cause)}`);
            } finally {
                store.busy = false;
                bump();
                inputEl?.focus();
            }
        }

        function applySnapshot(next: BotChatSnapshot): void {
            store.multi = true;
            store.bots = next.bots;
            store.bot = next.bot;
            store.models = next.models;
            store.messages = next.messages;
            store.metrics = next.metrics;
            store.selectedModel = next.selectedModel ?? firstKey(next.models);
            store.emptyText = next.bot === null ? "先建一个 bot（引导页）" : "还没有消息，说一句话开始。";
            bump();
            // 面板：首启 / 存量缺模型 ⇒ 强制拦在配置页（关不掉），不许静默用「宿主缺省」
            if (next.bot === null) openFirstBoot();
            else if (next.bot.needsModel) openViewset("config", next.bot, true);
        }

        function appendError(text: string): void {
            store.messages = [...store.messages, textMessage("assistant", text)];
            bump();
        }
    },
};

export default chatPageView;

// ── 小工具（纯函数） ──────────────────────────────────────

function el(doc: Document, tag: string, className: string, text?: string): HTMLElement {
    const node = doc.createElement(tag);
    if (className !== "") node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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

function cardRow(doc: Document, label: string, value: string): HTMLElement {
    const row = el(doc, "div", "chat-card-row");
    row.append(el(doc, "span", "", label), el(doc, "b", "", value));
    return row;
}

/** 指标一格：`标签 <b>值</b>`；值缺省显示「—」（不编 0） */
function metric(label: string, value: string, warn = false): Spec {
    return html.span({ class: "chat-metric" }, function* () {
        yield html.span({ text: `${label} ` });
        yield html.tag("b", { class: warn ? "chat-warn" : "", text: value });
    });
}

function messageOf(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

function firstKey(models: readonly ModelChoice[]): string {
    const first = models[0];
    return first ? `${first.providerId}/${first.modelId}` : "";
}

/** 消息行的内容指纹（wire 里没有 seq；同一位置同角色同正文 = 同一行）。 */
function hash(text: string): number {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return h;
}

/** token 数：≥1000 走 k（223.0k），否则原样 */
function tokenText(value: number | undefined): string {
    if (value === undefined) return "—";
    if (value < 1000) return String(value);
    return `${(value / 1000).toFixed(1)}k`;
}

/** 金额：$0.0271（四位够看清单步量级） */
function money(value: number): string {
    return `$${value.toFixed(4)}`;
}

/** 头像底色：按 id 稳定取色（同一个 bot 永远同一个颜色） */
function colorOf(id: string): string {
    const palette = ["#5b8def", "#e08b4a", "#4aa87a", "#9b7bd4", "#d4698b", "#4aa3b8"];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length] ?? palette[0]!;
}

function initialOf(name: string): string {
    return name.trim().slice(0, 1) || "?";
}

/** ISO 时间只取日期段（`2026-11-01T…` → `2026-11-01`） */
function dateOf(iso: string): string {
    return iso.slice(0, 10);
}
