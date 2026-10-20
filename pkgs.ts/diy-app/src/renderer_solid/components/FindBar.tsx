/**
 * FindBar — 页面内查找条（##234）。
 *
 * 形态对齐「提示词页的标注结果条」（DynamicBar）：i/n 计数 + ↑/↓ 跳转 + ✕ 关闭，
 * 且**动态出现**（关掉就完全消失），不是模态弹窗 —— 用户是在页面上找字，不该被
 * 一个挡住内容的对话框打断。
 *
 * 只负责 UI；搜索与高亮在 store/findStore（CSS Highlight API，不动 DOM）。
 *
 * **顶层贴片（##309 修）**：它是 `Portal` 到 body 的 `fixed` 浮条（`Z_FIND`），不是流内
 * 元素。原先是 `main` 里包屑与内容区之间的流内元素，会被流量抽屉（z-50）/ 人物配置
 * （z-70）这类全屏浮层盖住 —— 输入框还在、⌘F 还能打字，**就是看不见**（点它中心命中的
 * 竟是抽屉里的按钮）。流内元素压不过 fixed 浮层，故上提到最顶层。
 * 搜索范围随"最前浮层"切换见 findStore.setRootResolver。
 */
import { Show, createEffect, createMemo } from "solid-js";
import { Portal } from "solid-js/web";
import { findStore } from "../store/findStore";
import { chatFindStore } from "../store/chatFindStore";
import { Z_FIND } from "../lib/z-layers";

export function FindBar() {
    let inputEl: HTMLInputElement | undefined;
    /**
     * 桥接行（##389 口径 1）：页内查找 **0/0** 且**数据层确有命中**时才出现。
     *
     * 三条硬约束（都是"别让用户误以为已经找过了"）：
     *   · 数据层也 0 ⇒ **不出**这一行（不拿"可能有更多"敷衍）；
     *   · 页内有命中 ⇒ 不出（用户的诉求已经满足了，再提一句只是噪音）；
     *   · 探针结论必须对应**当前查询**（打新字后旧结论作废，否则会显示上一句话的数字）。
     */
    const bridge = createMemo(() => {
        const p = chatFindStore.probe;
        if (!p || p.hits === 0) return null;
        if (findStore.count > 0) return null;
        if (p.query !== findStore.query) return null;
        if (!findStore.query.trim()) return null;
        return p;
    });
    /** ⌘⇧F 的提示（只此一处解释为什么 ⌘F 找不到） */
    const BRIDGE_HINT = "页内查找只覆盖**已渲染**的那几轮（虚拟滚动）。";
    // 打开即聚焦输入框（⌘F 后直接打字；点按钮打开同理）
    createEffect(() => {
        if (findStore.open && inputEl) {
            inputEl.focus();
            inputEl.select();
        }
    });

    return (
        <Show when={findStore.open}>
            <Portal>
            {/* 外层只管定位与纵向排布：查找条与它下方的桥接行是一列（桥接不能盖住条本身） */}
            {/* 探针结论**暴露成属性**（`data-probe-*`）：桥接行是"有条件出现"的，
                测试与人工排查都需要一个不看视觉就能判定的口径 —— 否则"没出那一行"
                到底是"数据层没命中"还是"压根没探"，只能靠猜。 */}
            <div
                data-find-skip
                style={{ "z-index": String(Z_FIND) }}
                data-probe-query={chatFindStore.probe?.query ?? ""}
                data-probe-hits={String(chatFindStore.probe?.hits ?? -1)}
                data-probe-unrendered={String(chatFindStore.probe?.unrendered ?? -1)}
                class="fixed left-1/2 top-2 flex max-w-[min(680px,92vw)] -translate-x-1/2 flex-col items-stretch gap-1"
            >
            <div class="flex items-center gap-2 rounded-lg border border-warning/70 bg-base-100 px-2 py-1 text-body shadow-2xl ring-1 ring-black/20">
                {/* 明确标注这是「查找」条：原先只有一条与面包屑同款的淡黄细线，在流量页这类
                    内容密集的页面里几乎看不出输入框（实测与背景对比度仅 1.37） */}
                <span class="whitespace-nowrap font-medium text-warning">🔍 查找</span>
                <input
                    ref={(el) => {
                        inputEl = el;
                        // ⚠️ **必须**在挂载后补一次聚焦（微任务级，紧贴 DOM 插入之后）：
                        // 上面那个 effect 在"组件刚挂载"这一拍里，`inputEl` 指向的节点**还没进 DOM**
                        // （ref 回调先于插入），对游离节点调 `focus()` 是静默无效的。
                        // 症状：⌘F 开了查找条却**一个字都打不进去**（焦点还在 body 上）—— 实测踩过：
                        // 先关过别的浮层（焦点掉回 body）再按 ⌘F 就复现。
                        queueMicrotask(() => {
                            if (findStore.open) {
                                el.focus();
                                el.select();
                            }
                        });
                    }}
                    type="search"
                    class="input input-bordered input-sm min-w-40 max-w-96 flex-1 border-warning/50 bg-base-100 placeholder:opacity-50"
                    placeholder="页面内查找…"
                    value={findStore.query}
                    onInput={(e) => findStore.setQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            if (e.shiftKey) findStore.prev();
                            else findStore.next();
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            findStore.close();
                        }
                    }}
                />
                <span class="join join-horizontal">
                    <button
                        class="btn btn-xs join-item"
                        title="上一个（Shift+回车）"
                        disabled={findStore.count === 0}
                        onClick={() => findStore.prev()}
                    >
                        ↑
                    </button>
                    <button
                        class="btn btn-xs join-item"
                        title="下一个（回车）"
                        disabled={findStore.count === 0}
                        onClick={() => findStore.next()}
                    >
                        ↓
                    </button>
                </span>
                <span class="badge badge-xs badge-ghost font-mono" title="第几个 / 共几个">
                    {findStore.count === 0 ? "0/0" : `${findStore.index + 1}/${findStore.count}`}
                </span>
                <button class="btn btn-xs btn-ghost ml-auto" title="关闭（Esc）" onClick={() => findStore.close()}>
                    ✕
                </button>
            </div>
            {/* ── 桥接行（##389）──
                页面里搜不到、但**会话数据里有**时，用户最需要的不是"再搜一次"，而是知道
                「你找的东西存在，只是不在这一屏」。点它带着**当前查询**进面板，不让人重打一遍。 */}
            <Show when={bridge()}>
                {(p) => (
                    <button
                        type="button"
                        data-find-bridge="1"
                        class="flex items-center gap-2 self-center rounded-lg border border-primary/50 bg-base-100/95 px-3 py-1 text-xs shadow-lg hover:bg-base-200"
                        title={`${BRIDGE_HINT}点这里到会话数据里找（⌘⇧F）`}
                        onClick={() => {
                            // ⚠️ 先取查询再关条：`findStore.close()` **会清空 query**
                            // （关条 = 一次查找结束），关完再读就只剩空串 —— 面板会打开成空白，
                            // 用户以为"点了没反应"还得重打一遍（实测踩过）。
                            const q = findStore.query;
                            findStore.close();
                            chatFindStore.openWith(q);
                        }}
                    >
                        <span class="font-medium text-primary">
                            本会话另有 {p().hits} 处命中
                        </span>
                        <Show when={p().unrendered > 0}>
                            <span class="opacity-70">（其中 {p().unrendered} 处未渲染）</span>
                        </Show>
                        <span class="opacity-50">·</span>
                        <span class="underline decoration-dotted">搜本会话</span>
                    </button>
                )}
            </Show>
            </div>
            </Portal>
        </Show>
    );
}
