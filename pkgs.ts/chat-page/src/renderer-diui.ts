// renderer-diui.ts — 页面插件的 renderer 侧（**diyui 版**，##468），与 renderer.ts（裸 DOM 版）并存。
//
// 两版只差「怎么画」：线上形状（shared.ts 的 ChatSnapshot / WireMessage）、`ctx.invoke`
// 的方法名与调用时机**一字不动**，所以装配层换一行 import 就能切：
//
//   import { chatPageView } from "@diy-agent/chat-page/renderer";        // 裸 DOM 版
//   import { chatPageView } from "@diy-agent/chat-page/renderer-diui";   // 本文件
//
// 为什么换（旧版 `apply(snapshot)` 时 `list.replaceChildren()` 整体重绘）：
//   消息一多就闪、滚动位置跳、输入框丢焦点。这里的做法照 video/workbench/src/pages/*：
//
//   1. 状态全部住在模块级 store（不在 render 闭包里建 signal —— 切页再回来不丢值）
//   2. 结构层（左栏外壳 / 顶栏 / 输入框 / 消息滚动容器）的生成器**不读 rev**
//      ⇒ 发消息时它们一个节点都不重建（不闪、焦点留在输入框）
//   3. 只有「动态块」（会话列表 / 模型选项 / 消息列表）在生成器里 `void rev.value`
//   4. 列表项给 `key`：同 key 同 rev 直接复用 DOM（消息只追加新节点）
//   5. 消息列表重跑前记下滚动：贴底就跟到新底，否则原地不动

import { GenApp, html, Signal, type Spec } from '@diy-agent/ui/browser';
import type { PageContext, PageView } from '@diy-agent/workbench-ui';
import type { ChatSnapshot, SendResult, WireMessage } from './shared.js';
import type { ModelChoice, SessionSummary } from './shared.js';
import { ensureChatStyle } from './style.js';

interface Store {
    /** `snapshot` 方法存在（多会话宿主注入）→ 左栏 + 顶栏可见 */
    multi: boolean;
    sessions: readonly SessionSummary[];
    models: readonly ModelChoice[];
    activeId: string | null;
    messages: readonly WireMessage[];
    /** 新建会话将使用的模型限定名 `providerId/modelId` */
    selectedModel: string;
    busy: boolean;
    /** 空消息线的提示语（多会话且没有任何会话时不同） */
    emptyText: string;
}

const store: Store = {
    multi: false,
    sessions: [],
    models: [],
    activeId: null,
    messages: [],
    selectedModel: '',
    busy: false,
    emptyText: '还没有消息，说一句话开始。',
};

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
    id: 'chat',
    title: '聊天',
    render(root: HTMLElement, ctx: PageContext): () => void {
        ensureChatStyle(root.ownerDocument);
        const my = ++generation;
        const app = new GenApp({ mount: root });
        app.render(
            // data-renderer 是给 CDP 判据认版本用的（两版视觉等价，DOM 标记是唯一区别）
            html.div({ class: 'chat-page', 'data-renderer': 'diui' }, function* () {
                yield html.div({ class: 'chat-app' }, function* () {
                    yield sessionsPane(my, ctx);
                    yield html.section({ class: 'chat-main' }, function* () {
                        yield headerBar(my);
                        yield messageList(my);
                        yield composer(ctx);
                    });
                });
            }),
        );
        inputEl?.focus();
        void load(ctx);
        return () => {
            generation++;
            inputEl = null;
            root.replaceChildren();
        };
    },
};

export default chatPageView;

// ── 左栏：会话列表 ─────────────────────────────────────────

function sessionsPane(my: number, ctx: PageContext): Spec {
    return html.tag('aside', { class: 'chat-sessions', hidden: B(() => !store.multi) }, function* () {
        yield html.div({ class: 'chat-sessions-head' }, function* () {
            yield html.span({ class: 'chat-sessions-title', text: '会话' });
            yield html.button({
                class: 'chat-new',
                type: 'button',
                text: '新建',
                disabled: B(() => !store.multi || store.busy),
                onClick: () => void createSession(ctx),
            });
        });
        // 动态块：会话项按 id 给 key，同一会话（标题 / 条数 / 选中态都没变）直接复用 DOM
        yield html.ul({ class: 'chat-session-list' }, function* () {
            if (my !== generation) return;
            void rev.value;
            for (const session of store.sessions) {
                const active = session.id === store.activeId;
                yield html.li(
                    {
                        key: `session:${session.id}`,
                        rev: `${session.title}|${session.model}|${session.messageCount}|${String(active)}`,
                        class: 'chat-session-item',
                    },
                    function* () {
                        yield html.button(
                            {
                                class: 'chat-session',
                                type: 'button',
                                'data-active': String(active),
                                onClick: () => {
                                    if (store.busy || session.id === store.activeId) return;
                                    void selectSession(ctx, session.id);
                                },
                            },
                            function* () {
                                yield html.span({ class: 'chat-session-name', text: session.title });
                                yield html.span({
                                    class: 'chat-session-meta',
                                    text: `${session.model} · ${session.messageCount} 条`,
                                });
                            },
                        );
                    },
                );
            }
        });
    });
}

// ── 顶栏：模型选择器 ───────────────────────────────────────

function headerBar(my: number): Spec {
    return html.div({ class: 'chat-header', hidden: B(() => !store.multi) }, function* () {
        yield html.span({ class: 'chat-model-label', text: '新会话模型' });
        yield html.tag(
            'select',
            {
                class: 'chat-model',
                disabled: B(() => store.busy || store.models.length === 0),
                onChange: (event: Event) => {
                    // 选中值直接落在 select 自己身上；这里只同步 store（不 bump，免得重建自己）
                    store.selectedModel = (event.target as HTMLSelectElement).value;
                },
            },
            function* (self) {
                if (my !== generation) return;
                void rev.value;
                const keys: string[] = [];
                for (const choice of store.models) {
                    const value = `${choice.providerId}/${choice.modelId}`;
                    keys.push(value);
                    yield html.tag('option', {
                        key: value,
                        rev: choice.name,
                        value,
                        text: `${choice.providerId} · ${choice.name}`,
                    });
                }
                if (store.models.length === 0) {
                    yield html.tag('option', { key: 'none', value: '', text: '（model.yaml 里没有可用模型）' });
                }
                // 子节点已装好（driver 取下一个值时跑到这里）：最后同步选中项
                if (!keys.includes(store.selectedModel)) store.selectedModel = keys[0] ?? '';
                (self.el as HTMLSelectElement).value = store.selectedModel;
            },
        );
    });
}

// ── 主区：消息列表（滚动容器 = 结构层，行 = 动态块） ────────

function messageList(my: number): Spec {
    return html.ol({ class: 'chat-list' }, function* (self) {
        if (my !== generation) return;
        void rev.value;
        const list = self.el;
        // 重跑前记下滚动：贴底就跟到底，否则原地不动（判据 3：新消息不把用户拽走）
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
        const top = list.scrollTop;
        if (store.messages.length === 0) {
            yield html.li({ key: 'empty', class: 'chat-empty', text: store.emptyText });
        } else {
            let index = 0;
            for (const message of store.messages) {
                const key = `${index}:${message.role}:${message.text.length}:${hash(message.text)}`;
                yield html.li({ key, class: 'chat-row', 'data-role': message.role }, function* () {
                    yield html.span({ class: 'chat-role', text: message.role === 'user' ? '我' : '助手' });
                    yield html.div({ class: 'chat-text', text: message.text });
                });
                index++;
            }
        }
        if (atBottom) list.scrollTop = list.scrollHeight;
        else list.scrollTop = top;
    });
}

// ── 底部：输入框（结构层：整个运行期只建一次 ⇒ 焦点与草稿不丢） ──

function composer(ctx: PageContext): Spec {
    return html.tag(
        'form',
        {
            class: 'chat-composer',
            onSubmit: (event: Event) => {
                event.preventDefault();
                void send(ctx);
            },
        },
        function* () {
            yield html.input({
                class: 'chat-input',
                type: 'text',
                placeholder: '说点什么…',
                disabled: B(() => store.multi && store.activeId === null),
                ref: (el: HTMLElement) => {
                    inputEl = el as HTMLInputElement;
                },
            });
            yield html.button({
                class: 'chat-send',
                type: 'submit',
                text: '发送',
                disabled: B(() => store.busy || (store.multi && store.activeId === null)),
            });
        },
    );
}

// ── 行为：与裸 DOM 版逐条对应（调的方法名、失败文案都一样） ──

async function load(ctx: PageContext): Promise<void> {
    try {
        applySnapshot(await ctx.invoke<ChatSnapshot>('snapshot'));
    } catch {
        // 没有多会话能力（apps/minimal 的单会话）：消息线从空开始
        store.multi = false;
        store.messages = [];
        bump();
    }
}

async function selectSession(ctx: PageContext, id: string): Promise<void> {
    try {
        applySnapshot(await ctx.invoke<ChatSnapshot>('selectSession', { id }));
    } catch (cause) {
        appendError(`切换失败：${messageOf(cause)}`);
    }
}

async function createSession(ctx: PageContext): Promise<void> {
    if (store.busy || !store.multi) return;
    store.busy = true;
    bump();
    try {
        const args = store.selectedModel === '' ? {} : { model: store.selectedModel };
        applySnapshot(await ctx.invoke<ChatSnapshot>('createSession', args));
    } catch (cause) {
        appendError(`新建失败：${messageOf(cause)}`);
    } finally {
        store.busy = false;
        bump();
        inputEl?.focus();
    }
}

async function send(ctx: PageContext): Promise<void> {
    if (store.busy || !inputEl) return;
    const text = inputEl.value.trim();
    if (text.length === 0) return;
    inputEl.value = '';
    store.busy = true;
    store.messages = [...store.messages, { role: 'user', text }];
    bump();
    const activeId = store.activeId;
    const multi = store.multi && activeId !== null;
    try {
        const result = multi
            ? await ctx.invoke<ChatSnapshot>('send', { sessionId: activeId, text })
            : await ctx.invoke<SendResult>('send', text);
        if (isSnapshot(result)) applySnapshot(result);
        else {
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

function applySnapshot(next: ChatSnapshot): void {
    store.multi = true;
    store.sessions = next.sessions;
    store.models = next.models;
    store.activeId = next.activeId;
    store.messages = next.messages;
    store.selectedModel = next.selectedModel ?? firstKey(next.models);
    store.emptyText =
        next.activeId === null && next.sessions.length === 0
            ? '点左上角「新建」开始一个会话。'
            : '还没有消息，说一句话开始。';
    bump();
}

function appendError(text: string): void {
    store.messages = [...store.messages, { role: 'assistant', text }];
    bump();
}

function firstKey(models: readonly ModelChoice[]): string {
    const first = models[0];
    return first ? `${first.providerId}/${first.modelId}` : '';
}

function isSnapshot(value: unknown): value is ChatSnapshot {
    return value !== null && typeof value === 'object' && Array.isArray((value as ChatSnapshot).sessions);
}

function messageOf(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

/** 消息行的内容指纹（wire 里没有 seq；同一位置同角色同正文 = 同一行）。 */
function hash(text: string): number {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return h;
}
