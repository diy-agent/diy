// renderer-react.tsx —— 页面插件的 renderer 侧（**React 版**，##526）。
//
// 与另两版（renderer.ts 裸 DOM / renderer-diui.ts diyui）只差「怎么画」：线上形状
// （shared.ts 的 BotChatSnapshot / WireMessage）、client.ts 的方法名与调用时机一字不动，
// 装配层换一行 import 就能切。
//
// 分层（docs/ui-architecture.md §2.1 的三件套）：
//   store.ts   无框架快照仓库（本文件用 useSyncExternalStore 订阅它）
//   client.ts  领域式 rpc 客户端（组件里不出现 rpc 方法名字符串）
//   ui/*.tsx   shadcn 源码引入的组件（视觉 = react.css 里的 M3 令牌桥）
//
// 与 diui 版的关键差异：**不再手工做增量渲染**。React 自己按 key 复用行，重活交给
// memo + 稳定的 key；块内容（Block）走注册表产 DOM，用 layout effect 按指纹重画。
//
// ##498 界面形态不变（bot 中心）：左栏 bot 条 64px（hover 展开 200px）/ 消息流顶天 /
// 底部一行「bot 名 ⚙ | 输入 窗口 缓存 本轮 上下文」+ 输入框 / 配置面panel 悬浮或停靠。

import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { PageContext, PageView } from '@diy-agent/workbench-ui';
import type { BotView, BotChatSnapshot, CompactInfo, ModelChoice, WireMessage } from './shared.js';
import { textMessage } from './shared.js';
import { DEMO_TOOL_COMMAND, demoToolMessage } from './demo.js';
import { renderBlocks } from './block-renderers.js';
import { ensureChatStyle } from './style.js';
import { createChatStore, type ChatState, type ChatStore } from './store.js';
import { createChatClient, type ChatClient } from './client.js';
import type { ChatViewContribution } from './views.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Textarea } from './ui/textarea.js';
import { Label } from './ui/label.js';

// ##499：与另两版同一份注册表（插件自造 kind 从这里登记）
export { registerBlockRenderer, renderBlock, renderBlocks } from './block-renderers.js';

const { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, memo, useCallback } = React;

/**
 * 造一个聊天页（##539：tab 插槽）。
 *
 * 不传 `views` 时与从前完全一致（只有「标准」一个 tab）。`apps/chat/renderer.ts`
 * 用它在装配层追加别的视图 —— 核心文件不需要改。
 */
export function chatPageViewWith(views: readonly ChatViewContribution[]): PageView {
    return {
        id: 'chat',
        title: '聊天',
        render: (root: HTMLElement, ctx: PageContext): (() => void) => {
        ensureChatStyle(root.ownerDocument);
        const store = createChatStore();
        const client = createChatClient(ctx);
        const reactRoot = createRoot(root);
        // 首帧**同步**落地：workbench 的 PageView 契约是「render 返回时画好了」
        // （切页时紧接着就可能量位置 / 找元素；异步首帧会让这些读到空树，happy-dom 里的
        //  单测也拿不到 .chat-input）。
        flushSync(() => {
            reactRoot.render(<ChatApp store={store} client={client} views={views} />);
        });
        return (): void => {
            reactRoot.unmount();
        };
        },
    };
}

/** 缺省页（只有「标准」一个视图）—— 与 ##539 之前的行为一致 */
export const chatPageView: PageView = chatPageViewWith([]);

/** 「标准」视图的惰性加载入口（##539）—— 不传 views 时是唯一一个；传了也应当排第一 */
export const standardViewLoad = (): Promise<{ default: React.ComponentType<{ state: ChatState; client: ChatClient }> }> =>
    Promise.resolve({ default: ({ state }: { state: ChatState }) => <MessageList state={state} /> });

/** 「调试」视图的惰性加载入口（##539）—— `apps/chat/renderer.ts` 用它拼 views */
export const devtoolsViewLoad = (): Promise<{ default: React.ComponentType<{ state: ChatState; client: ChatClient }> }> =>
    import('./views/devtools.js') as unknown as Promise<{ default: React.ComponentType<{ state: ChatState; client: ChatClient }> }>;

export default chatPageView;

// ── 页面 ────────────────────────────────────────────────

interface Deps {
    readonly store: ChatStore;
    readonly client: ChatClient;
    /** tab 插槽（##539）：缺省只有一个「标准」视图 */
    readonly views: readonly ChatViewContribution[];
}

/** 右侧 panel（viewset）的状态：`null` = 收起 */
interface ViewsetState {
    readonly mode: 'config' | 'create';
    readonly bot: BotView | null;
    /** 强制模式：首启 / 存量缺模型时打开，关不掉 */
    readonly forced: boolean;
}

/** hover 卡片的定位（`fixed`，左栏 overflow:hidden 也裁不到它） */
interface CardState {
    readonly bot: BotView;
    readonly top: number;
    readonly left: number;
}

function ChatApp({ store, client, views }: Deps): React.ReactElement {
    const state = useSyncExternalStore(store.subscribe, store.get, store.get);
    const [viewset, setViewset] = useState<ViewsetState | null>(null);
    const [firstBoot, setFirstBoot] = useState(false);
    const [card, setCard] = useState<CardState | null>(null);
    const [busySince, setBusySince] = useState(0);
    /** 悬浮 / 停靠：换 bot、重开都保持上次选择（命令式那版放在模块级，这里放页面级） */
    const [pinned, setPinned] = useState(false);

    /** 快照请求的单调序号：只有最新一次的结果才允许落地 */
    const snapshotSeq = useRef(0);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * 模型目录：**按需拉**（##526）。只有「配模型 / 新建 bot / 首启」需要它 ——
     * 之前它跟着每条快照走，于是切一次 bot 就重算一遍模型目录（4.6 MB 的 spec 快照），
     * 实测 400+ms。已经有缓存就不重复拉（模型改过的场景由 `refreshModels` 强刷）。
     */
    const loadModels = useCallback(
        async (force = false): Promise<void> => {
            if (!force && store.get().models.length > 0) return;
            const next = await client.models();
            store.patch({
                models: next.choices,
                selectedModel: next.defaultModel ?? firstKey(next.choices),
            });
        },
        [client, store],
    );

    /**
     * 唯一的状态入口：从核心层**重新取整份快照**（concurrency-actor 判据 5）。
     * 单调化：并发刷新时先发出的可能后到，旧状态不许盖新状态。
     */
    const refresh = useCallback(async (): Promise<void> => {
        const seq = ++snapshotSeq.current;
        const next = await client.snapshot();
        if (seq !== snapshotSeq.current) return;
        apply(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- apply 只依赖 setState（稳定）
    }, [client]);

    const apply = useCallback(
        (next: BotChatSnapshot): void => {
            store.patch({
                multi: true,
                bots: next.bots,
                bot: next.bot,
                messages: next.messages,
                metrics: next.metrics,
                emptyText: next.bot === null ? '先建一个 bot（引导页）' : '还没有消息，说一句话开始。',
            });
            // 首启 / 存量缺模型 ⇒ 强制拦在配置页（关不掉），不许静默用「宿主缺省」。
            // ##526：面板里要用模型目录，**等目录到手再开** —— 否则下拉是空的，
            // 用户直接点「创建」就提交空 model（实测报「必须先选一个模型」）。
            if (next.bot === null) {
                setFirstBoot(false);
                setViewset(null);
                void loadModels()
                    .catch(() => undefined)
                    .then(() => {
                        setFirstBoot(true);
                    });
            } else if (next.bot.needsModel) {
                setFirstBoot(false);
                const bot = next.bot;
                void loadModels()
                    .catch(() => undefined)
                    .then(() => {
                        setViewset({ mode: 'config', bot, forced: true });
                    });
            }
        },
        [loadModels, store],
    );

    const appendError = useCallback(
        (text: string): void => {
            store.patch({ messages: [...store.get().messages, textMessage('assistant', text)] });
        },
        [store],
    );

    // 首份快照：没有多 bot 能力（apps/minimal 的单会话）时消息线从空开始
    useEffect(() => {
        let alive = true;
        void refresh()
            .catch(() => {
                if (!alive) return;
                store.patch({ multi: false, messages: [] });
            })
            .finally(() => {
                // `data-ready`：首份快照落地后置 1（CDP 判据等「页面就绪」用）
                document.querySelector('.chat-page')?.setAttribute('data-ready', '1');
            });
        return () => {
            alive = false;
            if (hideTimer.current !== null) clearTimeout(hideTimer.current);
            if (demoTimer.current !== null) clearTimeout(demoTimer.current);
        };
    }, [refresh, store]);

    const selectBot = useCallback(
        (id: string): void => {
            if (store.get().busy) return;
            setCard(null);
            void client
                .selectBot(id)
                .then(() => refresh())
                .catch((cause: unknown) => appendError(`切换失败：${messageOf(cause)}`));
        },
        [appendError, client, refresh, store],
    );

    /** 发一条消息：先本地乐观显示，再以主进程回的整份快照为准 */
    const send = useCallback(
        async (text: string): Promise<void> => {
            const current = store.get();
            if (current.busy) return;
            const trimmed = text.trim();
            if (trimmed.length === 0) return;
            if (trimmed === DEMO_TOOL_COMMAND) {
                runDemoTool();
                return;
            }
            store.patch({
                busy: true,
                messages: [...current.messages, textMessage('user', trimmed)],
            });
            setBusySince(Date.now());
            try {
                if (current.multi && current.bot !== null) {
                    // send 的返回值只是这一条会话的消息线；整份状态**重新取**
                    await client.send(trimmed);
                    await refresh();
                } else {
                    const result = await client.send(trimmed);
                    store.patch({ messages: result.messages });
                }
            } catch (cause) {
                appendError(`出错了：${messageOf(cause)}`);
            } finally {
                store.patch({ busy: false });
                setBusySince(0);
            }
        },
        [appendError, client, refresh, store],
    );

    /**
     * `/demo-tool` 演示（##514 前置）：本地插一条假工具块，**不发主进程**。
     * 先 running（展开、黄点），约 900ms 后原地变 ok；下一次快照就把它抹掉。
     */
    const runDemoTool = useCallback((): void => {
        const current = store.get();
        const next = [...current.messages, textMessage('user', DEMO_TOOL_COMMAND), demoToolMessage('running')];
        store.patch({ messages: next });
        const index = next.length - 1;
        if (demoTimer.current !== null) clearTimeout(demoTimer.current);
        demoTimer.current = setTimeout(() => {
            demoTimer.current = null;
            const list = store.get().messages.slice();
            list[index] = demoToolMessage('ok');
            store.patch({ messages: list });
        }, 900);
    }, [store]);

    // hover 卡片：移进卡片算仍在看（否则鼠标一挪开就消失）
    const scheduleHideCard = useCallback((): void => {
        if (hideTimer.current !== null) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => {
            hideTimer.current = null;
            setCard(null);
        }, 120);
    }, []);
    const cancelHideCard = useCallback((): void => {
        if (hideTimer.current !== null) {
            clearTimeout(hideTimer.current);
            hideTimer.current = null;
        }
    }, []);

    const showCard = useCallback(
        (bot: BotView, anchor: HTMLElement): void => {
            cancelHideCard();
            const rect = anchor.getBoundingClientRect();
            setCard({ bot, top: Math.round(rect.top), left: Math.round(rect.right + 8) });
        },
        [cancelHideCard],
    );

    /**
     * 打开配置 / 新建面板：**先拉目录再开**（每次强刷 —— 用户可能刚在「模型配置」里改过）。
     * 面板晚几百毫秒出现，好过让用户对着空下拉点「创建」。
     */
    const openViewset = useCallback(
        (next: ViewsetState): void => {
            setCard(null);
            setFirstBoot(false);
            void loadModels(true)
                .catch((cause: unknown) => {
                    appendError(`读模型目录失败：${messageOf(cause)}`);
                })
                .then(() => {
                    setViewset(next);
                });
        },
        [appendError, loadModels],
    );
    const openConfig = useCallback(
        (bot: BotView, forced = false): void => {
            openViewset({ mode: 'config', bot, forced });
        },
        [openViewset],
    );
    const openCreate = useCallback((): void => {
        openViewset({ mode: 'create', bot: null, forced: false });
    }, [openViewset]);
    const closeViewset = useCallback((): void => {
        setViewset((current) => (current !== null && current.forced ? current : null));
    }, []);

    return (
        <div className="chat-page" data-renderer="react">
            <div className="chat-app">
                <BotsPane
                    state={state}
                    onSelect={selectBot}
                    onCreate={openCreate}
                    onShowCard={showCard}
                    onHideCard={scheduleHideCard}
                />
                <section className="chat-main">
                    {/* 首启引导是**硬闸门**：覆盖整块消息区，没得关（##498 判据 8） */}
                    <div className="chat-panel" data-show={firstBoot ? 'true' : 'false'}>
                        {firstBoot ? (
                            <FirstBoot
                                models={state.models}
                                selectedModel={state.selectedModel}
                                onDone={(next) => {
                                    setFirstBoot(false);
                                    apply(next);
                                }}
                                client={client}
                            />
                        ) : null}
                    </div>
                    <div className="chat-body">
                        <div className="chat-stream">
                            <ViewTabs views={views} state={state} client={client} fallback={<MessageList state={state} />} />
                            <FootBar
                                state={state}
                                busySince={busySince}
                                onSend={send}
                                onOpenConfig={openConfig}
                                client={client}
                                onSnapshot={apply}
                            />
                        </div>
                        <aside
                            className="chat-viewset"
                            data-show={viewset === null ? 'false' : 'true'}
                            data-mode={pinned ? 'pinned' : 'floating'}
                        >
                            {viewset === null ? null : (
                                <Viewset
                                    key={viewset.bot?.id ?? 'new'}
                                    state={viewset}
                                    models={state.models}
                                    selectedModel={state.selectedModel}
                                    pinned={pinned}
                                    onTogglePin={() => setPinned((value) => !value)}
                                    onClose={closeViewset}
                                    client={client}
                                    onDone={(next) => {
                                        setViewset(null);
                                        apply(next);
                                    }}
                                    onError={appendError}
                                />
                            )}
                        </aside>
                    </div>
                </section>
            </div>
            {card === null ? null : (
                <BotCard
                    card={card}
                    activeBot={state.bot}
                    metrics={state.metrics}
                    onEnter={cancelHideCard}
                    onLeave={scheduleHideCard}
                    onConfig={(bot) => openConfig(bot)}
                    onOpen={(bot) => selectBot(bot.id)}
                />
            )}
        </div>
    );
}

// ── 左栏：bot 条 ────────────────────────────────────────

function BotsPane({
    state,
    onSelect,
    onCreate,
    onShowCard,
    onHideCard,
}: {
    state: ChatState;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onShowCard: (bot: BotView, anchor: HTMLElement) => void;
    onHideCard: () => void;
}): React.ReactElement {
    return (
        <aside className="chat-bots" hidden={!state.multi}>
            <ul className="chat-bot-list">
                {/* ##后端：新 bot 按钮放**列表最上面**（用户 2026-11-02 要求） */}
                <li className="chat-bot chat-bot-new">
                    <button className="chat-bot-btn chat-bot-new-btn" type="button" onClick={onCreate}>
                        <span className="chat-bot-avatar">+</span>
                        <span className="chat-bot-text">
                            <span className="chat-bot-name">新 bot</span>
                            <span className="chat-bot-model">创建一个</span>
                        </span>
                    </button>
                </li>
                {state.bots.map((bot) => {
                    const active = bot.id === state.bot?.id;
                    return (
                        <li key={bot.id} className="chat-bot" data-active={String(active)}>
                            <button
                                className="chat-bot-btn"
                                type="button"
                                data-bot-id={bot.id}
                                // 悬停只出「概览卡片」，**不**自动拉出右侧配置 panel（用户 2026-11-02 裁）
                                onMouseEnter={(event) => {
                                    onShowCard(bot, event.currentTarget);
                                }}
                                onMouseLeave={onHideCard}
                                // 点 bot **只打开对话**（配置入口是 ⚙ / hover 卡片里的「配置」）
                                onClick={() => {
                                    onSelect(bot.id);
                                }}
                            >
                                <span className="chat-bot-avatar" style={{ background: colorOf(bot.id) }}>
                                    {initialOf(bot.name)}
                                </span>
                                <span className="chat-bot-text">
                                    <span className="chat-bot-name">{bot.name}</span>
                                    <span className="chat-bot-model">{bot.needsModel ? '未选模型' : bot.model}</span>
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </aside>
    );
}

// ── 消息列表 ────────────────────────────────────────────

/**
 * tab 插槽（##539）：切到哪个 tab 才 `load()` 它。
 *
 * `views` 为空 ⇒ 直接渲染 `fallback`（与从前完全一致）。
 * 懒加载结果缓存在 `loaded` 里 —— 切回来不重新加载，也不丢各自的滚动位置（内容不卸载，
 * 只是用 `display:none` 藏起来）。
 */
function ViewTabs({
    views,
    state,
    client,
    fallback,
}: {
    views: readonly ChatViewContribution[];
    state: ChatState;
    client: ChatClient;
    fallback: React.ReactElement;
}): React.ReactElement {
    const sorted = useMemo(() => [...views].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)), [views]);
    const [active, setActive] = useState<string>(sorted[0]?.id ?? '');
    const [loaded, setLoaded] = useState<Record<string, React.ComponentType<{ state: ChatState; client: ChatClient }>>>({});
    useEffect(() => {
        const hit = sorted.find((v) => v.id === active);
        if (hit === undefined || loaded[active] !== undefined) return;
        let cancelled = false;
        void hit.load().then((mod) => {
            if (!cancelled) setLoaded((prev) => ({ ...prev, [active]: mod.default }));
        });
        return () => {
            cancelled = true;
        };
    }, [active, sorted, loaded]);

    if (sorted.length === 0) return fallback;
    return (
        <div className="chat-views">
            <div className="chat-view-tabs" role="tablist">
                {sorted.map((v) => (
                    <button
                        key={v.id}
                        type="button"
                        role="tab"
                        aria-selected={v.id === active}
                        className={v.id === active ? 'chat-view-tab active' : 'chat-view-tab'}
                        onClick={() => setActive(v.id)}
                    >
                        {v.label}
                    </button>
                ))}
            </div>
            <div className="chat-view-body">
                {sorted.map((v) => {
                    const Comp = loaded[v.id];
                    if (v.id !== active || Comp === undefined) return null;
                    return (
                        <div key={v.id} className="chat-view-pane">
                            <Comp state={state} client={client} />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function MessageList({ state }: { state: ChatState }): React.ReactElement {
    const listRef = useRef<HTMLOListElement>(null);
    /** 贴底就跟到底，否则原地不动（判据 3：新消息不把用户拽走） */
    const stickRef = useRef(true);

    useLayoutEffect(() => {
        const list = listRef.current;
        if (list === null) return;
        if (stickRef.current) list.scrollTop = list.scrollHeight;
    }, [state.messages]);

    return (
        <ol
            className="chat-list"
            ref={listRef}
            onScroll={(event) => {
                const list = event.currentTarget;
                stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
            }}
        >
            {state.messages.length === 0 ? (
                <li className="chat-empty">{state.emptyText}</li>
            ) : (
                state.messages.map((message, index) => {
                    // 指纹 = 块内容本身：tool 块从 running → ok 时只有那一行重画
                    const fingerprint = message.blocks
                        .map((block) => `${block.kind}:${block.id}:${JSON.stringify(block.data)}`)
                        .join('\n');
                    return (
                        <MessageRow
                            key={`${String(index)}:${message.role}:${String(hash(fingerprint))}`}
                            message={message}
                            fingerprint={fingerprint}
                        />
                    );
                })
            )}
        </ol>
    );
}

/**
 * 一行消息。memo 的判据是**内容指纹**（不是对象身份）：快照每次都是新对象，
 * 按身份比会把整表重画（那就退化成裸 DOM 版的毛病了）。
 */
const MessageRow = memo(
    function MessageRow({ message, fingerprint }: { message: WireMessage; fingerprint: string }): React.ReactElement {
        return (
            <li className="chat-row" data-role={message.role}>
                <span className="chat-role">{message.role === 'user' ? '我' : '助手'}</span>
                <BlockList blocks={message.blocks} fingerprint={fingerprint} />
            </li>
        );
    },
    (prev, next) => prev.fingerprint === next.fingerprint,
);

/**
 * 一条消息的全部 Block。渲染走注册表（`block-renderers.ts`，产真实 DOM），
 * 所以这里只用 layout effect 按指纹换 children —— 不把 Block 形状塞进 React 的 diff。
 */
function BlockList({
    blocks,
    fingerprint,
}: {
    blocks: readonly WireMessage['blocks'][number][];
    fingerprint: string;
}): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const latest = useRef(blocks);
    latest.current = blocks;
    useLayoutEffect(() => {
        const node = ref.current;
        if (node === null) return;
        node.replaceChildren(...renderBlocks(latest.current));
    }, [fingerprint]);
    return <div className="chat-blocks" ref={ref} />;
}

// ── 底部：bot 名 + 指标（一行）+ 输入框 ───────────────────

function FootBar({
    state,
    busySince,
    onSend,
    onOpenConfig,
    client,
    onSnapshot,
}: {
    state: ChatState;
    busySince: number;
    onSend: (text: string) => Promise<void>;
    onOpenConfig: (bot: BotView, forced?: boolean) => void;
    client: ChatClient;
    onSnapshot: (next: BotChatSnapshot) => void;
}): React.ReactElement {
    const bot = state.bot;
    const metrics = state.metrics;
    const ratio =
        metrics?.inputTokens !== undefined && metrics.contextWindow !== undefined && metrics.contextWindow > 0
            ? (metrics.inputTokens / metrics.contextWindow) * 100
            : undefined;
    const cache =
        metrics?.cacheReadTokens !== undefined && metrics.inputTokens !== undefined && metrics.inputTokens > 0
            ? (metrics.cacheReadTokens / metrics.inputTokens) * 100
            : undefined;

    return (
        <div className="chat-foot" hidden={state.multi && bot === null}>
            <div className="chat-metrics" hidden={!state.multi}>
                {bot === null ? null : (
                    <>
                        <Button
                            variant="ghost"
                            size="xs"
                            className="chat-bot-label"
                            onClick={() => {
                                onOpenConfig(bot, bot.needsModel);
                            }}
                        >
                            <span>{bot.name}</span>
                            <span>⚙</span>
                        </Button>
                        <span className="chat-sep">|</span>
                        <Metric label="输入" value={tokenText(metrics?.inputTokens)} />
                        {/* ##519：**悬停「窗口」**就展开压缩点（不是另外挂一个按钮） */}
                        <CutPanel
                            client={client}
                            onSnapshot={onSnapshot}
                            trigger={
                                <Metric
                                    label="窗口"
                                    value={ratio === undefined ? '—' : `${ratio.toFixed(1)}%`}
                                    warn={ratio !== undefined && ratio > 60}
                                />
                            }
                        />
                        <Metric label="缓存" value={cache === undefined ? '—' : `${cache.toFixed(1)}%`} />
                        <Metric label="本轮" value={metrics?.cost === undefined ? '—' : money(metrics.cost)} />
                        <Metric label="上下文" value={`${String(metrics?.turns ?? 0)} step`} />
                    </>
                )}
            </div>
            <Composer state={state} busySince={busySince} onSend={onSend} />
        </div>
    );
}

/** 指标一格：`标签 <b>值</b>`；值缺省显示「—」（不编 0） */
function Metric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }): React.ReactElement {
    return (
        <span className="chat-metric">
            <span>{`${label} `}</span>
            <b className={warn ? 'chat-warn' : ''}>{value}</b>
        </span>
    );
}

function Composer({
    state,
    busySince,
    onSend,
}: {
    state: ChatState;
    busySince: number;
    onSend: (text: string) => Promise<void>;
}): React.ReactElement {
    const [text, setText] = useState('');
    const [tick, setTick] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    // 「等待回复」秒表：发出去之后如果上游慢/挂住，界面必须自己说（用户 2026-11-07）
    useEffect(() => {
        if (busySince === 0) return;
        const timer = setInterval(() => {
            setTick((value) => value + 1);
        }, 500);
        return () => {
            clearInterval(timer);
        };
    }, [busySince]);

    // 焦点：只在挂载与「一轮结束」时抢回（打字时不动它）
    useEffect(() => {
        if (!state.busy) inputRef.current?.focus();
    }, [state.busy]);

    const disabled = state.multi && state.bot === null;
    const busyText = busyTextOf(busySince, tick);

    return (
        <form
            className="chat-composer"
            onSubmit={(event) => {
                event.preventDefault();
                const value = text;
                setText('');
                void onSend(value);
            }}
        >
            <Input
                ref={inputRef}
                className="chat-input"
                type="text"
                placeholder="说点什么…"
                disabled={disabled}
                value={text}
                onChange={(event) => {
                    setText(event.target.value);
                }}
            />
            <Button className="chat-send" type="submit" disabled={state.busy || disabled}>
                发送
            </Button>
            <span
                className="chat-busy"
                data-slow={busySince !== 0 && Date.now() - busySince >= 20_000 ? '1' : undefined}
            >
                {busyText}
            </span>
        </form>
    );
}

/** 等待提示文案（0.5s 一跳；>20s 标黄，>60s 提示可以去压上下文/换模型） */
function busyTextOf(busySince: number, tick: number): string {
    void tick; // tick 只是为了让本函数在计时器里重新求值
    if (busySince === 0) return '';
    const ms = Date.now() - busySince;
    if (ms < 1200) return '已发送…';
    const sec = Math.round(ms / 1000);
    return sec < 60 ? `等待回复… ${String(sec)}s` : `等待回复… ${String(sec)}s（超过 1 分钟，可能上游慢或网络不通）`;
}

// ── ##519 压缩点（二级悬停面板） ─────────────────────────

function CutPanel({
    client,
    onSnapshot,
    trigger,
}: {
    client: ChatClient;
    onSnapshot: (next: BotChatSnapshot) => void;
    trigger: React.ReactNode;
}): React.ReactElement {
    const [open, setOpen] = useState(false);
    const [info, setInfo] = useState<CompactInfo | null>(null);
    const [keep, setKeep] = useState(0);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const closing = useRef<ReturnType<typeof setTimeout> | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            const next = await client.compactInfo();
            setInfo(next);
            setKeep(next.rounds.length);
            setError('');
        } catch (cause) {
            setInfo(null);
            setError(messageOf(cause));
        } finally {
            setLoading(false);
        }
    }, [client]);

    const openPanel = useCallback((): void => {
        if (closing.current !== null) clearTimeout(closing.current);
        closing.current = null;
        setOpen(true);
        if (info === null && !loading) void load();
    }, [info, load, loading]);

    const closePanel = useCallback((): void => {
        closing.current = setTimeout(() => {
            closing.current = null;
            setOpen(false);
            setInfo(null);
        }, 220);
    }, []);

    const applyCut = useCallback(async (): Promise<void> => {
        try {
            const next = await client.compact(keep);
            onSnapshot(next);
            setError('');
            await load();
        } catch (cause) {
            setError(messageOf(cause));
        }
    }, [client, keep, load, onSnapshot]);

    return (
        <div className="chat-cut-wrap" onPointerEnter={openPanel} onPointerLeave={closePanel}>
            {trigger}
            <div className="chat-cut-panel" hidden={!open}>
                {info === null ? (
                    <span className="chat-cut-row">{error === '' ? '读取中…' : error}</span>
                ) : (
                    <>
                        <div className="chat-cut-head">
                            <span>{`保留最近 ${String(keep)} / ${String(info.rounds.length)} 轮${keep === 0 ? '（全部丢弃）' : ''}`}</span>
                            {info.droppedCount > 0 ? (
                                <span className="chat-cut-dim">{`（已压掉 ${String(info.droppedCount)} 轮）`}</span>
                            ) : null}
                        </div>
                        {info.rounds.map((round, index) => {
                            const cut = index === info.rounds.length - keep;
                            return (
                                <React.Fragment key={`${String(index)}:${round.label}`}>
                                    {cut ? (
                                        <div className="chat-cut-line">
                                            <span>✂ 压缩点</span>
                                        </div>
                                    ) : null}
                                    <div className={round.kept ? 'chat-cut-row' : 'chat-cut-row chat-cut-row-drop'}>
                                        <span className="chat-cut-lab">{round.label}</span>
                                        <span className="chat-cut-title">{round.title}</span>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                        <input
                            className="chat-cut-range"
                            type="range"
                            min={0}
                            max={Math.max(0, info.rounds.length)}
                            value={keep}
                            onChange={(event) => {
                                setKeep(Number(event.target.value));
                            }}
                        />
                        <div className="chat-cut-actions">
                            <button
                                className="chat-cut-apply"
                                type="button"
                                onClick={() => {
                                    void applyCut();
                                }}
                            >
                                压缩
                            </button>
                            {error === '' ? null : <span className="chat-cut-err">{error}</span>}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

// ── 右侧 panel：配置 / 新建 bot ──────────────────────────

function Viewset({
    state,
    models,
    selectedModel,
    pinned,
    onTogglePin,
    onClose,
    client,
    onDone,
    onError,
}: {
    state: ViewsetState;
    models: readonly ModelChoice[];
    selectedModel: string;
    pinned: boolean;
    onTogglePin: () => void;
    onClose: () => void;
    client: ChatClient;
    onDone: (next: BotChatSnapshot) => void;
    onError: (text: string) => void;
}): React.ReactElement {
    const bot = state.bot;
    const isNew = state.mode === 'create';
    const [name, setName] = useState(bot?.name ?? '');
    const [search, setSearch] = useState('');
    const [model, setModel] = useState(bot?.model !== undefined && bot.model !== '' ? bot.model : selectedModel);
    const [effort, setEffort] = useState(bot?.reasoningEffort ?? '');
    const [instructions, setInstructions] = useState(bot?.instructions ?? '');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        nameRef.current?.focus();
    }, []);

    // ##526：模型目录是按需异步拉的 —— 面板先挂上、目录后到，这里把缺省模型补进去
    // （否则用户没动下拉就直接「创建」，提交的是空 model ⇒ "必须先选一个模型"）
    useEffect(() => {
        if (model === '' && selectedModel !== '') setModel(selectedModel);
    }, [selectedModel, model]);

    const groups = useMemo(() => groupModels(models, search), [models, search]);

    const submit = async (): Promise<void> => {
        const trimmed = name.trim();
        if (trimmed === '') {
            setError('名字不能为空');
            return;
        }
        if (model === '') {
            setError('必须先选一个模型（bot 的 model 必填）');
            return;
        }
        const payload = { name: trimmed, model, instructions, reasoningEffort: effort };
        setSaving(true);
        try {
            const next = isNew
                ? await client.createBot(payload)
                : await client.updateBot({ id: bot?.id ?? '', ...payload });
            onDone(next);
        } catch (cause) {
            setError(`保存失败：${messageOf(cause)}`);
        } finally {
            setSaving(false);
        }
    };

    const remove = async (): Promise<void> => {
        if (bot === null) return;
        const ok =
            typeof window.confirm !== 'function' ||
            window.confirm(`删除 bot「${bot.name}」？它的会话会一并删除（不可撤销）。`);
        if (!ok) return;
        try {
            const next = await client.removeBot(bot.id);
            onDone(next);
        } catch (cause) {
            onError(`删除失败：${messageOf(cause)}`);
            setError(`删除失败：${messageOf(cause)}`);
        }
    };

    return (
        <>
            <div className="chat-viewset-head">
                <span className="chat-viewset-title">{isNew ? '新建 bot' : (bot?.name ?? '')}</span>
                <Button
                    variant="ghost"
                    size="xs"
                    className="chat-viewset-pin"
                    title="在「固定」（占一栏）和「悬浮」（浮在消息上）之间切换"
                    onClick={onTogglePin}
                >
                    {pinned ? '📌 固定' : '📌 悬浮'}
                </Button>
                <Button
                    variant="ghost"
                    size="xs"
                    className="chat-viewset-close"
                    title="关闭"
                    hidden={state.forced}
                    onClick={onClose}
                >
                    ✕
                </Button>
            </div>
            <div className="chat-viewset-body">
                <div className="chat-form">
                    <Label htmlFor="chat-bot-name">名字</Label>
                    <Input
                        id="chat-bot-name"
                        ref={nameRef}
                        type="text"
                        value={name}
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                    />
                    <Label htmlFor="chat-bot-model-search">模型</Label>
                    {/* 搜索框 + 按 provider 分组（用户 2026-11-04：「列表太长了 flat 了」） */}
                    <Input
                        id="chat-bot-model-search"
                        className="chat-model-search"
                        type="text"
                        placeholder="搜索模型（provider / 账号 / 名称）"
                        value={search}
                        onChange={(event) => {
                            setSearch(event.target.value);
                        }}
                    />
                    <select
                        value={model}
                        onChange={(event) => {
                            setModel(event.target.value);
                        }}
                    >
                        {groups.length === 0 ? <option value="">（model.yaml 里没有可用模型）</option> : null}
                        {groups.map((group) => (
                            <optgroup key={group.provider} label={group.provider}>
                                {group.options.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                    <Label htmlFor="chat-bot-effort">推理强度</Label>
                    <select
                        id="chat-bot-effort"
                        value={effort}
                        onChange={(event) => {
                            setEffort(event.target.value);
                        }}
                    >
                        <option value="">缺省</option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                    </select>
                    <Label htmlFor="chat-bot-instructions">行为指令</Label>
                    <Textarea
                        id="chat-bot-instructions"
                        value={instructions}
                        onChange={(event) => {
                            setInstructions(event.target.value);
                        }}
                    />
                </div>
                {!isNew && bot !== null ? (
                    <p className="chat-viewset-note">
                        {`会话 ${String(bot.sessionCount)} · 创建于 ${dateOf(bot.createdAt)} · 模型 ${bot.needsModel ? '未选' : bot.model}`}
                    </p>
                ) : null}
                <p className="chat-panel-error" hidden={error === ''}>
                    {error}
                </p>
                <div className="chat-viewset-actions">
                    <Button
                        className="chat-primary"
                        disabled={saving}
                        onClick={() => {
                            void submit();
                        }}
                    >
                        {isNew ? '创建' : '保存'}
                    </Button>
                    {!isNew && bot !== null ? (
                        <Button
                            variant="destructive"
                            className="chat-danger"
                            onClick={() => {
                                void remove();
                            }}
                        >
                            删除
                        </Button>
                    ) : null}
                </div>
            </div>
        </>
    );
}

// ── 首启引导 ────────────────────────────────────────────

function FirstBoot({
    models,
    selectedModel,
    client,
    onDone,
}: {
    models: readonly ModelChoice[];
    selectedModel: string;
    client: ChatClient;
    onDone: (next: BotChatSnapshot) => void;
}): React.ReactElement {
    const [name, setName] = useState('大王助手');
    const [model, setModel] = useState(selectedModel);
    const [instructions, setInstructions] = useState(
        '你是「大王助手」，在 diy 的聊天窗口里陪大王干活。回答要短、要具体，能查证的不靠猜。',
    );
    const [error, setError] = useState(models.length === 0 ? '模型目录里没有可用模型 —— 先到「模型配置」添加一个' : '');
    const [saving, setSaving] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        nameRef.current?.focus();
    }, []);

    // ##526：目录异步到达后补缺省模型（同 Viewset）
    useEffect(() => {
        if (model === '' && selectedModel !== '') setModel(selectedModel);
    }, [selectedModel, model]);

    const submit = async (): Promise<void> => {
        if (model === '') {
            setError('模型目录里没有可用模型 —— 先到「模型配置」添加一个');
            return;
        }
        setSaving(true);
        try {
            const next = await client.createFirstBot({
                model,
                ...(name.trim() === '' ? {} : { name: name.trim() }),
                instructions,
            });
            onDone(next);
        } catch (cause) {
            setError(`创建失败：${messageOf(cause)}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <div className="chat-panel-head">
                <h2 className="chat-panel-title">建第一个 bot</h2>
            </div>
            <div className="chat-panel-body">
                <p>一个 bot 一条长期对话。先起个名字、选一个模型 —— 之后点它就是进这个对话。</p>
                <div className="chat-form">
                    <Label htmlFor="chat-first-name">名字</Label>
                    <Input
                        id="chat-first-name"
                        ref={nameRef}
                        type="text"
                        value={name}
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                    />
                    <Label htmlFor="chat-first-model">模型</Label>
                    <select
                        id="chat-first-model"
                        value={model}
                        onChange={(event) => {
                            setModel(event.target.value);
                        }}
                    >
                        {models.length === 0 ? <option value="">（model.yaml 里没有可用模型）</option> : null}
                        {models.map((choice) => (
                            <option key={modelValue(choice)} value={modelValue(choice)}>
                                {modelLabel(choice)}
                            </option>
                        ))}
                    </select>
                    <Label htmlFor="chat-first-instructions">行为指令</Label>
                    <Textarea
                        id="chat-first-instructions"
                        value={instructions}
                        onChange={(event) => {
                            setInstructions(event.target.value);
                        }}
                    />
                </div>
                <p className="chat-panel-error" hidden={error === ''}>
                    {error}
                </p>
                <div className="chat-panel-actions">
                    <Button
                        className="chat-primary"
                        disabled={saving}
                        onClick={() => {
                            void submit();
                        }}
                    >
                        创建并开始
                    </Button>
                </div>
            </div>
        </>
    );
}

// ── hover 卡片（2 级信息） ───────────────────────────────

function BotCard({
    card,
    activeBot,
    metrics,
    onEnter,
    onLeave,
    onConfig,
    onOpen,
}: {
    card: CardState;
    activeBot: BotView | null;
    metrics: ChatState['metrics'];
    onEnter: () => void;
    onLeave: () => void;
    onConfig: (bot: BotView) => void;
    onOpen: (bot: BotView) => void;
}): React.ReactElement {
    const cost = card.bot.id === activeBot?.id ? metrics?.cost : undefined;
    return (
        <div
            className="chat-card"
            data-show="true"
            style={{ top: card.top, left: card.left }}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
        >
            <div className="chat-card-title">{card.bot.name}</div>
            <div className="chat-card-model">{card.bot.needsModel ? '未选模型' : card.bot.model}</div>
            <CardRow label="会话" value={String(card.bot.sessionCount)} />
            <CardRow label="创建" value={dateOf(card.bot.createdAt)} />
            <CardRow label="本轮花费" value={cost === undefined ? '—' : money(cost)} />
            <div className="chat-card-acts">
                <Button className="chat-primary" onClick={() => onConfig(card.bot)}>
                    配置
                </Button>
                <Button variant="outline" onClick={() => onOpen(card.bot)}>
                    打开对话
                </Button>
            </div>
        </div>
    );
}

function CardRow({ label, value }: { label: string; value: string }): React.ReactElement {
    return (
        <div className="chat-card-row">
            <span>{label}</span>
            <b>{value}</b>
        </div>
    );
}

// ── 小工具（纯函数） ────────────────────────────────────

/** 模型选择的一项 → 限定名（`account@provider/model`） */
function modelValue(choice: ModelChoice): string {
    return `${choice.account === undefined ? '' : `${choice.account}@`}${choice.providerId}/${choice.modelId}`;
}

function modelLabel(choice: ModelChoice): string {
    return `${choice.account === undefined ? '' : `${choice.account}@`}${choice.providerId} · ${choice.name}`;
}

/** 按 provider 分组 + 关键字过滤（搜窄了不该把已选模型悄悄改掉，所以返回完整分组） */
function groupModels(
    models: readonly ModelChoice[],
    keyword: string,
): { provider: string; options: { value: string; label: string }[] }[] {
    const q = keyword.trim().toLowerCase();
    const groups = new Map<string, { value: string; label: string }[]>();
    for (const choice of models) {
        const value = modelValue(choice);
        const label = modelLabel(choice);
        if (q !== '' && !label.toLowerCase().includes(q) && !value.toLowerCase().includes(q)) continue;
        const key = choice.providerId === '' ? '(其他)' : choice.providerId;
        const list = groups.get(key);
        if (list === undefined) groups.set(key, [{ value, label }]);
        else list.push({ value, label });
    }
    return [...groups].map(([provider, options]) => ({ provider, options }));
}

function firstKey(models: readonly ModelChoice[]): string {
    const first = models[0];
    return first === undefined ? '' : modelValue(first);
}

function messageOf(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/** 消息行的内容指纹（wire 里没有 seq；同一位置同角色同正文 = 同一行） */
function hash(text: string): number {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return h;
}

/** token 数：≥1000 走 k（223.0k），否则原样 */
function tokenText(value: number | undefined): string {
    if (value === undefined) return '—';
    if (value < 1000) return String(value);
    return `${(value / 1000).toFixed(1)}k`;
}

/** 金额：$0.0271（四位够看清单步量级） */
function money(value: number): string {
    return `$${value.toFixed(4)}`;
}

/** 头像底色：按 id 稳定取色（同一个 bot 永远同一个颜色） */
function colorOf(id: string): string {
    const palette = ['#5b8def', '#e08b4a', '#4aa87a', '#9b7bd4', '#d4698b', '#4aa3b8'];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length] ?? palette[0]!;
}

function initialOf(name: string): string {
    return name.trim().slice(0, 1) || '?';
}

/** ISO 时间只取日期段（`2026-11-01T…` → `2026-11-01`） */
function dateOf(iso: string): string {
    return iso.slice(0, 10);
}
