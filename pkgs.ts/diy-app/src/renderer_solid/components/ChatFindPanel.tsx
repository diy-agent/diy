/**
 * ChatFindPanel — 会话数据层检索面版（##389）。⌘⇧F 开合；Esc 只关面板（**不抢 ⌘F**）。
 *
 * 形态取舍（与「⌘F 加范围开关」那版相比）：
 *   · 命中要**按轮分组**（同一轮多命中折叠成 ×n）+ 每条给上下文 + 能标「已压缩」——
 *     这些塞不进 i/n 计数的查找条，硬塞会把它做成半个体检报告；
 *   · ⌘F 的语义是「在**这一页**找位置」，若它也变成"找数据"，一次误用就会把页面滚到
 *     另一个世纪去；故页内仍归页内（##234 不动），本面板才是数据检索的正式入口。
 *   · 但报障入口天然是 ⌘F（手就按那儿）⇒ 页内 0/0 时 FindBar 出一行桥接（见 FindBar）。
 *
 * 定位（点击结果）由会话页负责：只有它拿得到滚动容器、块树与虚拟窗口 —— 面板不碰滚动。
 */
import { For, Show, createMemo } from "solid-js";
import { Portal } from "solid-js/web";
import { chatFindStore, type ChatFindHit } from "../store/chatFindStore";
import { fmtTurnFull, fmtTurnStamp } from "../../shared/date-format";
import { Z_CHAT_FIND } from "../lib/z-layers";

interface Group {
    turnId: string;
    hits: ChatFindHit[];
    compacted: boolean;
}

export function ChatFindPanel(props: {
    /** 当前会话 URI（null = 没选任务；面板照开但检索无从谈起） */
    taskUri: () => string | null;
    onLocate: (hit: ChatFindHit) => void;
    onClose: () => void;
}) {
    const groups = createMemo<Group[]>(() => {
        const out: Group[] = [];
        const at = new Map<string, Group>();
        for (const h of chatFindStore.hits) {
            let g = at.get(h.turnId);
            if (!g) {
                g = { turnId: h.turnId, hits: [], compacted: h.compacted };
                at.set(h.turnId, g);
                out.push(g);
            }
            g.hits.push(h);
        }
        return out;
    });

    const totalHits = createMemo(() => chatFindStore.hits.length);

    return (
        <Portal>
            {/* data-find-skip：面板自己的文字**不该**被页内查找（⌘F）搜到 ——
                否则一开面板，⌘F 的计数里就混进"结果列表里那条命中"（自指噪音） */}
            <div
                data-find-skip
                data-chat-find="1"
                style={{ "z-index": String(Z_CHAT_FIND) }}
                class="fixed right-2 top-14 bottom-2 flex w-[min(420px,92vw)] flex-col overflow-hidden rounded-lg border border-base-300 bg-base-100 text-body shadow-2xl ring-1 ring-black/20"
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation(); // 别让 ⌘F 的 Esc 逻辑跟着关一次（那是另一层）
                        props.onClose();
                    }
                }}
            >
                <div class="flex items-center gap-2 border-b border-base-300 px-2 py-1.5">
                    <span class="whitespace-nowrap font-medium text-primary">🔍 搜本会话</span>
                    <span class="truncate text-xs opacity-50" title="检索的是会话数据（含未渲染的轮与被压缩的历史）">
                        数据层 · 含未渲染 / 已压缩
                    </span>
                    <button class="btn btn-xs btn-ghost ml-auto" title="关闭（Esc）" onClick={props.onClose}>
                        ✕
                    </button>
                </div>

                <div class="flex flex-col gap-1.5 px-2 py-2">
                    <input
                        ref={(el) => {
                            // 打开即聚焦：⌘⇧F 之后直接打字（与 ⌘F 查找条同一手感）。
                            // 用 microtask 而非 onMount：面板每次打开都是**新挂载**，此刻节点已就位。
                            queueMicrotask(() => el.focus());
                        }}
                        type="search"
                        class="input input-bordered input-sm w-full"
                        placeholder="在本会话数据里找…"
                        value={chatFindStore.query}
                        onInput={(e) => chatFindStore.setQuery(props.taskUri(), e.currentTarget.value)}
                    />
                    <div class="flex flex-wrap items-center gap-3 text-xs">
                        {/* 正文恒开（关掉它 = 面板没有意义）；勾选框禁用而不是隐藏 ——
                            "为什么没有这个勾"比"永远是勾"更让人困惑 */}
                        <label class="flex items-center gap-1 opacity-70" title="用户与助理的消息正文（恒开）">
                            <input type="checkbox" class="checkbox checkbox-xs" checked disabled />
                            正文
                        </label>
                        <label class="flex items-center gap-1" title="工具的输入与输出（默认开）">
                            <input
                                type="checkbox"
                                class="checkbox checkbox-xs"
                                checked={chatFindStore.scopes.tool}
                                onChange={(e) =>
                                    chatFindStore.setScope(props.taskUri(), "tool", e.currentTarget.checked)
                                }
                            />
                            工具
                        </label>
                        <label
                            class="flex items-center gap-1"
                            title="模型推理（默认关：量最大、与结论重复度最高，开着找会淹掉正文）"
                        >
                            <input
                                type="checkbox"
                                class="checkbox checkbox-xs"
                                checked={chatFindStore.scopes.think}
                                onChange={(e) =>
                                    chatFindStore.setScope(props.taskUri(), "think", e.currentTarget.checked)
                                }
                            />
                            推理
                        </label>
                        <span class="ml-auto font-mono opacity-60">
                            <Show when={chatFindStore.busy} fallback={`${chatFindStore.turns} 轮 · ${totalHits()} 处`}>
                                检索中…
                            </Show>
                        </span>
                    </div>
                    <Show when={chatFindStore.error}>
                        {(msg) => <div class="text-xs text-error">检索失败：{msg()}</div>}
                    </Show>
                </div>

                <div class="min-h-0 flex-1 overflow-y-auto border-t border-base-300">
                    <Show
                        when={groups().length > 0}
                        fallback={
                            <div class="px-3 py-6 text-center text-xs opacity-50">
                                <Show
                                    when={chatFindStore.query.trim()}
                                    fallback={<>敲几个字，在<span class="font-medium">整个会话的数据</span>里找（不只是屏幕上这几轮）</>}
                                >
                                    <Show when={!chatFindStore.busy} fallback={<>…</>}>
                                        会话数据里没有「{chatFindStore.query.trim()}」
                                    </Show>
                                </Show>
                            </div>
                        }
                    >
                        <For each={groups()}>
                            {(g) => (
                                <div class="border-b border-base-300/60 last:border-b-0">
                                    {/* 组头 = 一轮：时刻 + 命中数折叠 + 「已压缩」标注 */}
                                    <div class="sticky top-0 z-10 flex items-center gap-2 bg-base-200/80 px-2 py-1 text-xs backdrop-blur">
                                        <span class="font-mono" title={fmtTurnFull(g.turnId) ?? g.turnId}>
                                            {fmtTurnStamp(g.turnId) ?? g.turnId}
                                        </span>
                                        <span class="opacity-60">×{g.hits.length}</span>
                                        <Show when={g.compacted}>
                                            <span
                                                class="badge badge-xs badge-warning"
                                                title="这一轮早于最近一次压缩的保留边界：不再投递给模型，但原文仍在盘上（可搜到）"
                                            >
                                                已压缩
                                            </span>
                                        </Show>
                                        <span class="ml-auto text-[0.65rem] opacity-40">
                                            第 {groups().indexOf(g) + 1} / {groups().length}
                                        </span>
                                    </div>
                                    <For each={g.hits}>
                                        {(h) => (
                                            <button
                                                type="button"
                                                class="block w-full px-2 py-1 text-left hover:bg-base-200"
                                                title="点击定位到这一轮"
                                                onClick={() => {
                                                    chatFindStore.locate(h);
                                                    // 定位后收起面板：用户要看的是**那一轮**，不是命中列表
                                                    //（列表里留着反而挡住刚跳过去的内容）
                                                    props.onClose();
                                                }}
                                            >
                                                <div class="flex items-baseline gap-2">
                                                    <span class="shrink-0 rounded bg-base-300/70 px-1 text-[0.65rem] opacity-70">
                                                        {h.label}
                                                    </span>
                                                    <span class="min-w-0 flex-1 break-words text-xs leading-5">
                                                        <span class="opacity-70">{h.pre}</span>
                                                        <mark class="rounded bg-warning/40 px-0.5 text-inherit">
                                                            {h.hit}
                                                        </mark>
                                                        <span class="opacity-70">{h.post}</span>
                                                    </span>
                                                </div>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            )}
                        </For>
                    </Show>
                </div>

                <Show when={chatFindStore.more}>
                    <div class="border-t border-base-300 p-2">
                        <button class="btn btn-xs btn-block" onClick={() => chatFindStore.loadMore(props.taskUri())}>
                            还有更多（只显示了前 {chatFindStore.turns} 轮）· 显示更多
                        </button>
                    </div>
                </Show>
                <Show when={!chatFindStore.busy && chatFindStore.spentMs > 0 && totalHits() > 0}>
                    <div class="border-t border-base-300 px-2 py-1 text-right text-[0.65rem] opacity-40">
                        扫了 {chatFindStore.spentMs}ms
                    </div>
                </Show>
            </div>
        </Portal>
    );
}
