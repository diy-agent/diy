/**
 * InboxBell — 上边栏靠右的**通知信箱入口**（##436 块 1/2/3）。
 *
 * 用户原话：「inbox 的状态图标入口放在上边栏，靠右区域，全局都可以看到新信息」。
 * 要治的真问题：「把我拉到几个任务页面好几次，但都没啥要回复的啊……我找半天也看不出来
 * 为啥叫我去」。所以这个入口要回答三件事 —— **有什么**（列表 + 原文）、**谁叫的**
 * （来源 / 原因 / 机制三件套）、**去哪看**（去来源会话）。
 *
 * 形态选择（硬要求「别自造样式」）：
 *   · 外层 = daisyUI `dropdown dropdown-end` 的**焦点版**（`div[tabindex=0]` + `dropdown-content`，
 *     与 EditorThemePicker / FlowPage 同形）：`focus-within` 负责显隐 ⇒ 点外面（焦点移走）
 *     自己收，不必自己写全局 click 监听，也不用和别的浮层抢 Esc；
 *   · 每条 = `menu` 里的一行（时刻 · kind · 任务 · 一句话结论），展开给三件套 + `data` + 原文；
 *   · 徽标 = `badge badge-error badge-sm`，0 时不显示数字但**图标恒在**（「全局可见」）。
 *
 * 已读口径（块 3）：面板**关闭时**把水位推到最新 —— 打开期间仍显示每条的新旧标记，
 * 否则点开瞬间所有条目一起"变旧"，用户反而看不出哪几条是这次叫他的。
 */
import { For, Show, createSignal } from "solid-js";
import { INBOX_KIND_LABEL, inboxBadgeOf, type InboxEntry } from "../../shared/inbox";
import { inboxStore } from "../store/inboxStore";
import { formatClock } from "../lib/notice";

/** `projects/4/tasks/436` → `#436`（列表一行里只够放这个；全 URI 放 title） */
function taskLabelOf(uri: string): string {
    const m = /\/tasks\/(\d+)$/.exec(uri);
    return m ? `#${m[1]}` : uri;
}

/** `data` 里的结构化事实 → 两列文本（数字不撒谎；空 = 不显示这一块） */
function dataRowsOf(e: InboxEntry): Array<[string, string]> {
    const d = e.data ?? {};
    const rows: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(d)) {
        if (k === "raw" || k === "dedupeKey") continue; // 原文单独成块 / 幂等键是内部实现
        if (v === null || v === undefined || v === "") continue;
        rows.push([k, String(v)]);
    }
    return rows;
}

export function InboxBell(props: {
    /** 点「去来源会话」：由 App 负责切页 + 请求定位（这里不直接依赖 tabStore） */
    onOpenEntry: (e: InboxEntry) => void;
}) {
    const [open, setOpen] = createSignal(false);
    /** 打开那一刻的水位快照：用来给条目画「新/旧」，关闭才真正推进水位 */
    const [watermarkAtOpen, setWatermarkAtOpen] = createSignal<string | null>(null);

    const unread = () => inboxStore.unread;
    const badge = () => inboxBadgeOf(unread());
    /** 倒序（新的在上）：信箱的用途是"最近发生了什么" */
    const rows = () => [...inboxStore.entries].reverse();
    const isNew = (e: InboxEntry): boolean => {
        const wm = watermarkAtOpen();
        const all = inboxStore.entries;
        if (!wm) return all.some((x) => x.id === e.id);
        const at = all.findIndex((x) => x.id === wm);
        if (at < 0) return true;
        return all.findIndex((x) => x.id === e.id) > at;
    };

    /** 打开 = 记下当前水位（条目据此画「新」标记）；关闭 = 把水位推到最新（这一波都看过了） */
    let wrapEl: HTMLDivElement | undefined;
    const markOpened = () => {
        if (open()) return;
        setOpen(true);
        setWatermarkAtOpen(inboxStore.lastReadId);
    };
    const maybeClosed = (e: FocusEvent) => {
        const next = e.relatedTarget as Node | null;
        if (next && wrapEl?.contains(next)) return; // 焦点还在面板/按钮里 = 没关
        if (!open()) return;
        setOpen(false);
        inboxStore.markAllRead();
    };

    return (
        <div
            class="dropdown dropdown-end"
            data-testid="inbox-bell"
            ref={(el) => (wrapEl = el)}
            onFocusIn={markOpened}
            onFocusOut={maybeClosed}
        >
            <div
                tabindex="0"
                role="button"
                class="btn btn-ghost btn-sm h-7 min-h-0 gap-1 px-2"
                title={unread() > 0 ? `通知信箱：${unread()} 条未读` : "通知信箱"}
                aria-label={unread() > 0 ? `通知信箱：${unread()} 条未读` : "通知信箱"}
            >
                <span aria-hidden="true">🔔</span>
                <Show when={badge()}>
                    <span class="badge badge-error badge-sm font-normal" data-testid="inbox-badge">
                        {badge()}
                    </span>
                </Show>
            </div>

            <div
                tabindex="0"
                class="dropdown-content z-50 mt-1 w-[min(92vw,30rem)] rounded-box border border-base-300 bg-base-100 shadow-xl"
                data-testid="inbox-panel"
            >
                <div class="flex items-center justify-between border-b border-base-300 px-3 py-2 text-body">
                    <span class="font-semibold">通知信箱</span>
                    <span class="opacity-70">
                        {unread() > 0 ? `${unread()} 条未读` : "都看过了"} · 共 {inboxStore.entries.length} 条
                    </span>
                </div>

                <Show
                    when={rows().length > 0}
                    fallback={<div class="px-3 py-6 text-center text-body opacity-60">还没有通知。跑完 / 超支 / 有人留言都会落在这里。</div>}
                >
                    <ul class="menu max-h-[70vh] w-full flex-nowrap overflow-y-auto px-1 py-1">
                        <For each={rows()}>
                            {(e) => (
                                <li class="block">
                                    <div class="flex flex-col gap-1 rounded-lg px-2 py-1.5 hover:bg-base-200">
                                        {/* 一行 = 时刻 · kind · 任务 · 一句话结论（块 2 的硬要求） */}
                                        <div class="flex items-baseline gap-2 text-body">
                                            <Show when={isNew(e)}>
                                                <span class="badge badge-primary badge-xs" title="未读">新</span>
                                            </Show>
                                            <span class="opacity-60 tabular-nums">{formatClock(Date.parse(e.ts))}</span>
                                            <span class="badge badge-ghost badge-sm">{INBOX_KIND_LABEL[e.kind]}</span>
                                            {/* 人 / 机器（##435 的判据在 main 侧算好，这里只读）：人署名的
                                                那条才是"真的有人在等你回复"，机器写的只落条目不催人 */}
                                            <Show when={e.data?.["senderKind"] === "human"}>
                                                <span class="badge badge-warning badge-xs" title="人署名（真的有人在等你）">
                                                    人
                                                </span>
                                            </Show>
                                            <Show when={e.data?.["senderKind"] === "machine"}>
                                                <span class="badge badge-ghost badge-xs" title="job / agent / 无署名：机器写的，无需你回复">
                                                    自动
                                                </span>
                                            </Show>
                                            <span class="opacity-70" title={e.taskUri}>
                                                {taskLabelOf(e.taskUri)}
                                            </span>
                                            <span class="min-w-0 flex-1 truncate" title={e.text}>
                                                {e.text}
                                            </span>
                                        </div>

                                        {/* 展开 = 三件套 + 结构化数字 + 原文（块 2 的直接解药） */}
                                        <details class="text-caption">
                                            <summary class="cursor-pointer opacity-60 hover:opacity-100">详情 / 原文</summary>
                                            <div class="mt-1 space-y-1 whitespace-pre-wrap break-words pl-2">
                                                <div>
                                                    <span class="opacity-60">来源：</span>
                                                    {e.source}
                                                </div>
                                                <div>
                                                    <span class="opacity-60">原因：</span>
                                                    {e.reason}
                                                </div>
                                                <div>
                                                    <span class="opacity-60">机制：</span>
                                                    {e.detail}
                                                </div>
                                                <Show when={dataRowsOf(e).length > 0}>
                                                    <div class="mt-1 border-t border-base-300 pt-1">
                                                        <For each={dataRowsOf(e)}>
                                                            {([k, v]) => (
                                                                <div>
                                                                    <span class="opacity-60">{k}：</span>
                                                                    {v}
                                                                </div>
                                                            )}
                                                        </For>
                                                    </div>
                                                </Show>
                                                <Show when={typeof e.data?.["raw"] === "string" && (e.data["raw"] as string).length > 0}>
                                                    <div class="mt-1 border-t border-base-300 pt-1">
                                                        <div class="opacity-60">原文（未截断）：</div>
                                                        <pre class="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words bg-base-200/60 p-2 text-caption">
                                                            {e.data!["raw"] as string}
                                                        </pre>
                                                    </div>
                                                </Show>
                                            </div>
                                        </details>

                                        <div class="flex items-center gap-2">
                                            <button
                                                class="btn btn-ghost btn-xs min-h-0"
                                                data-testid="inbox-goto"
                                                onClick={() => {
                                                    props.onOpenEntry(e);
                                                    // 跳走就收面板：留着会盖在刚打开的会话上（焦点交给主区，
                                                    // 走的是 focusout ⇒ 水位照常推进）
                                                    setOpen(false);
                                                    inboxStore.markAllRead();
                                                    (document.activeElement as HTMLElement | null)?.blur();
                                                }}
                                            >
                                                去来源会话
                                            </button>
                                            <span class="truncate text-caption opacity-50" title={e.taskUri}>
                                                {e.taskUri}
                                            </span>
                                        </div>
                                    </div>
                                </li>
                            )}
                        </For>
                    </ul>
                </Show>
            </div>
        </div>
    );
}
