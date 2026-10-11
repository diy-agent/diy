/**
 * NavSearch — nav 里的「⌘K 快速打开会话」弹层。
 *
 * 需求（##254）：打开会话的路径过长（任务管理 → 搜索 → 点标题 → 点会话）。
 * 这里给一条一步到位的路：⌘K → 敲词 → ↑↓ → Enter，**直接落到会话 tab**，
 * 不经过任务管理详情。
 *
 * 三条刻意的选择：
 *  1. **结果单位是任务（= 会话）**：diy 里任务与会话 1:1（打开会话 = 开该任务的
 *     task-run tab），故不造「任务条目 + 会话条目」两份数据，去重靠 tabStore.open
 *     自身的语义（已开则只聚焦，不新开）。
 *  2. **搜索口径与任务管理页同源**（shared/task-list 的 matchTask/buildSnippet，
 *     排序见 shared/nav-search）：同一个词在两个入口命中同一批，不会各写一套。
 *  3. **每次打开都是干净的一次**：输入清空、聚焦、选中归零 —— 上次的词还留着会
 *     让"直接打字"变成"先删干净"。
 *
 * 非目标（弹层范围，父任务 ##254 已定）：不搜项目 / 设置项 / CLI 命令，不做
 * `-` 排除等查询语法 —— 本功能是"快速定位"，不是查询语言。
 *
 * 键盘语义（review1 RV-1）：**IME 组合态一律不处理**（拼音"回车选词"不能被当成
 * "确认打开第一条"）。这是中文用户的高频路径，仓内同款先例见 lib/on-enter.ts。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { NAV_SEARCH_LIMIT, flattenTasks, searchTasksOf } from "../../shared/nav-search";
import { taskStateColor } from "../../main/core/task-state";
import { taskStore } from "../store/taskStore";
import { tabStore } from "../store/tabStore";

/**
 * 弹层遮罩的 z-index。
 *
 * 为什么取 500：它是**阻塞式模态**，必须高于所有"偶然浮起"的层 —— peek 信息卡 150 /
 * 全局 tooltip 200 / 各类 popover 70（见各组件），否则会出现"卡压在弹层上、看着像 ⌘K 没反应"。
 * 仍低于 toast 9999（系统级通知，不该被模态吞）。
 * 注：仓内尚无统一层级表（z 值散落各组件），这里是显式取值 + 依据，不假装有表。
 */
const OVERLAY_Z = 500;

/**
 * 该任务此刻是否已开着会话 tab（用于「已打开」徽标）。
 *
 * 用 `tabStore.find` 而非自己遍历 `opened`（review4 R4-2）：仓内既有惯用法就是
 * `!!tabStore.find(\`task-run:${uri}\`)`（见 TaskDetailContent 的 chatOpen），
 * 键格式由 `keyOf` 保证与 `opened` 同源 —— 不必在这里重述一遍匹配规则。
 * 注：**不是** `isTaskDisplayed`，那个只判"此刻在屏上"，语义不同、不可替代。
 */
const hasOpenSession = (uri: string): boolean => !!tabStore.find(`task-run:${uri}`);

/**
 * IME 组合态守卫：组合中（拼音/日文未选词）的按键一律放行给 IME，
 * 不触发我们的 Enter/↑/↓/Esc 语义。`keyCode === 229` 是部分浏览器的兜底信号。
 */
const composing = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === 229;

function Panel(props: { onClose: () => void; onPick: (uri: string) => void }) {
    const [query, setQuery] = createSignal("");
    /**
     * 选中项记 **uri**，不记下标（review4 R4-1）。
     *
     * 为什么：`hits` 会在弹层开着时被**后台数据变更**重算 —— agent 持续写任务文件 →
     * `task-change` → `taskStore.loadTree()` → `nodes` 换引用 → 排序重排。若记下标，
     * 重排后高亮会落到"换到那个位置"的**别的**任务上，用户按 Enter 打开的不是眼睛
     * 看到的那条。记 uri 则选中跟着"同一条任务"走；它若从结果里消失，退回首项。
     */
    const [activeUri, setActiveUri] = createSignal<string | null>(null);
    let inputEl: HTMLInputElement | undefined;
    let listEl: HTMLUListElement | undefined;
    /** 打开弹层前的焦点元素 —— 关闭时归还焦点（RV-7：模态不该把焦点吞掉） */
    const restoreFocus = document.activeElement as HTMLElement | null;

    /** 平铺的任务（RV-8：与查询词无关，按 nodes 引用 memo —— 逐键只重做匹配，不重走全树） */
    const flat = createMemo(() => flattenTasks(taskStore.nodes));
    /** 全部命中（不截断；用于计数与展示两处，见 RV-4） */
    const allHits = createMemo(() => searchTasksOf(flat(), query()));
    /** 展示的命中（截断到上限） */
    const hits = createMemo(() => allHits().slice(0, NAV_SEARCH_LIMIT));
    /** 被截断掉多少条（>0 时底部提示还有更多） */
    const hiddenCount = () => allHits().length - hits().length;

    /**
     * 选中项下标（渲染与 aria 用）：按 uri 在当前结果里定位；uri 不在结果里则归零。
     *
     * ⚠️ 是**普通函数**而不是 `createMemo` —— Solid 的 memo 创建时**立即求值**，
     * 放在这里没问题，但若上移到 `activeUri` 旁边就会在 `hits` 初始化前读它（TDZ，
     * 整个 Panel 直接抛错、弹层再也开不出来）。惰性求值也顺带省掉一层订阅。
     */
    const activeIndex = () => {
        const list = hits();
        const u = activeUri();
        if (u) {
            const i = list.findIndex((h) => h.uri === u);
            if (i >= 0) return i;
        }
        return 0;
    };

    /** 换词 → 选中归零（新列表的首项才是用户此刻想看的那条） */
    createEffect(() => {
        query();
        setActiveUri(null);
    });

    const move = (delta: number) => {
        const list = hits();
        const n = list.length;
        if (n === 0) return;
        const next = ((activeIndex() + delta) % n + n) % n;
        setActiveUri(list[next]!.uri);
    };

    const pick = (i: number) => {
        const hit = hits()[i];
        if (!hit) return;
        props.onPick(hit.uri);
        props.onClose();
    };

    onMount(() => {
        inputEl?.focus();
        // 不开弹层时焦点可能在别处（列表点过之后），故 Esc 在 document 统一兜住。
        // **捕获阶段 + stopPropagation**（不是 window 冒泡）：`TaskDetailPanel` 也在 window
        // 上听 Esc（冒泡）关整个任务详情面板，两条互不相识、都不查 defaultPrevented ——
        // 一次 Esc 会跑两个语义（关弹层 + 清面板，review3 R3-1a）。捕获阶段先手拦下，
        // 事件不再传播到 window，面板就不受牵连。同款先例见 ConfirmDialog。
        // Esc 一律先 **拦下不再外传**（review5 R5-1a）：组合态与普通态都要 stopPropagation。
        // 此前只在非组合态才 stopPropagation —— 组合态放行会让事件继续冒泡到 window，
        // 被 TaskDetailPanel 的 window 监听接走、顺手清掉背后的任务详情面板（R3-1a 的对称面）。
        // 组合中的 Esc 是"取消选词"，对任何外层 UI 都该是空操作：拦下但不关弹层。
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            if (composing(e)) return;
            e.preventDefault();
            props.onClose();
        };
        document.addEventListener("keydown", onKey, true);
        onCleanup(() => {
            document.removeEventListener("keydown", onKey, true);
            restoreFocus?.focus?.(); // 焦点归还触发元素（若它还在文档里）
        });
    });

    /** 选中项滚进可视区（键盘导航时列表可能比容器长） */
    createEffect(() => {
        const i = activeIndex();
        const el = listEl?.querySelector<HTMLElement>(`[data-index="${i}"]`);
        el?.scrollIntoView({ block: "nearest" });
    });

    /** 当前选中项 id（aria-activedescendant 用；无结果时 undefined） */
    const activeId = () => (hits().length > 0 ? `nav-search-item-${activeIndex()}` : undefined);

    return (
        <div
            class="fixed inset-0 flex items-start justify-center bg-neutral/40 pt-[12vh]"
            style={{ "z-index": String(OVERLAY_Z) }}
            data-testid="nav-search-overlay"
            onClick={props.onClose}
        >
            <div
                class="flex flex-col rounded-xl border border-base-300 bg-base-100 shadow-2xl overflow-hidden"
                style={{ width: "min(560px, 90vw)" }}
                data-testid="nav-search-panel"
                role="dialog"
                aria-modal="true"
                aria-label="搜索任务与会话"
                onClick={(e) => e.stopPropagation()}
            >
                <input
                    ref={(el) => (inputEl = el)}
                    data-testid="nav-search-input"
                    class="w-full border-b border-base-300 bg-transparent px-3 py-2 text-prose outline-none placeholder:opacity-50"
                    placeholder="搜索任务 / 会话（↑↓ 选择，Enter 打开）"
                    value={query()}
                    role="combobox"
                    aria-label="搜索任务 / 会话"
                    aria-autocomplete="list"
                    // R2-2：aria-expanded 语义 =「弹出列表是否展示」，与有无命中无关。
                    // 弹层只在 open 时渲染 → 列表恒展示（0 命中也有"没有匹配的任务"），故恒 true。
                    aria-expanded={true}
                    aria-controls="nav-search-list"
                    aria-activedescendant={activeId()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        // RV-1：IME 组合态一律不处理（拼音回车选词 ≠ 确认打开）
                        if (composing(e)) return;
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            move(1);
                        } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            move(-1);
                        } else if (e.key === "Enter") {
                            e.preventDefault();
                            pick(activeIndex());
                        }
                        // 注意：Esc **不在这里**处理 —— 由 onMount 的 document 捕获阶段统一接管
                        // （只有那样才挡得住 TaskDetailPanel 的 window 监听，见 R3-1a）。
                    }}
                />
                <ul
                    id="nav-search-list"
                    ref={(el) => (listEl = el)}
                    class="max-h-[50vh] overflow-auto py-1"
                    data-testid="nav-search-list"
                    role="listbox"
                    aria-label="搜索结果"
                >
                    <Show
                        when={hits().length > 0}
                        fallback={
                            <li class="px-3 py-3 text-body opacity-50" role="presentation">
                                {query().trim() ? "没有匹配的任务" : "输入关键词搜索任务（标题 / 编号 / 正文…）"}
                            </li>
                        }
                    >
                        <For each={hits()}>
                            {(hit, i) => (
                                <li role="presentation">
                                    <button
                                        id={`nav-search-item-${i()}`}
                                        data-testid="nav-search-item"
                                        data-index={i()}
                                        data-uri={hit.uri}
                                        role="option"
                                        aria-selected={i() === activeIndex()}
                                        class={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors ${
                                            i() === activeIndex() ? "bg-primary/25" : "hover:bg-base-200"
                                        }`}
                                        onMouseEnter={() => setActiveUri(hit.uri)}
                                        onClick={() => pick(i())}
                                    >
                                        <span class="flex w-full items-center gap-2">
                                            <span
                                                class={`h-1.5 w-1.5 shrink-0 rounded-full ${taskStateColor(hit.node.state)}`}
                                            />
                                            <span class="shrink-0 font-mono text-caption opacity-60">
                                                {/* hit.node 就是 taskStore.nodes 树里的**同一批对象引用**
                                                    （flattenTasks 只平铺、不拷贝），再 findNode 一次既多余
                                                    又与同行的 hit.node.title 写法不一致（review3 R3-3）。 */}
                                                #{hit.node.num}
                                            </span>
                                            <span class="min-w-0 flex-1 truncate text-body">
                                                {hit.node.title ?? hit.uri}
                                            </span>
                                            <Show when={hit.node.project_label || hit.node.project}>
                                                <span class="shrink-0 text-caption opacity-50">
                                                    {hit.node.project_label ?? hit.node.project}
                                                </span>
                                            </Show>
                                            <Show when={hasOpenSession(hit.uri)}>
                                                <span class="shrink-0 text-caption opacity-60">已打开</span>
                                            </Show>
                                        </span>
                                        {/* 正文命中：就地展示片段（与任务管理页同一 snippet 形状） */}
                                        <Show when={hit.snippet}>
                                            {(s) => (
                                                <span class="w-full truncate text-caption opacity-60">
                                                    {s().before}
                                                    <mark class="bg-transparent text-base-content font-semibold">
                                                        {s().match}
                                                    </mark>
                                                    {s().after}
                                                    <Show when={s().count > 1}>
                                                        <span class="opacity-60"> +{s().count - 1} 处</span>
                                                    </Show>
                                                </span>
                                            )}
                                        </Show>
                                    </button>
                                </li>
                            )}
                        </For>
                    </Show>
                </ul>
                <div
                    data-testid="nav-search-footer"
                    class="border-t border-base-300 px-3 py-1 text-caption opacity-50"
                >
                    {/* R2-4：计数段与快捷键段用同一模板串拼接（无计数时不留下前导 `·`）。
                        RV-4：被截断时说清"还有更多"，不让用户以为总共就这些。 */}
                    {[
                        hits().length > 0
                            ? hiddenCount() > 0
                                ? `显示 ${hits().length} / 共 ${allHits().length} 条 · 继续输入缩小范围`
                                : `${hits().length} 条`
                            : "",
                        "Enter 打开会话 · Esc 关闭 · ⌘K / Ctrl+K 开关",
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </div>
            </div>
        </div>
    );
}

export function NavSearch(props: { open: boolean; onClose: () => void; onPick: (uri: string) => void }) {
    return (
        <Show when={props.open}>
            <Panel onClose={props.onClose} onPick={props.onPick} />
        </Show>
    );
}
