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
import { Show, createEffect } from "solid-js";
import { Portal } from "solid-js/web";
import { findStore } from "../store/findStore";
import { Z_FIND } from "../lib/z-layers";

export function FindBar() {
    let inputEl: HTMLInputElement | undefined;
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
            <div
                data-find-skip
                style={{ "z-index": String(Z_FIND) }}
                class="fixed left-1/2 top-2 -translate-x-1/2 flex max-w-[min(680px,92vw)] items-center gap-2 rounded-lg border border-warning/70 bg-base-100 px-2 py-1 text-body shadow-2xl ring-1 ring-black/20"
            >
                {/* 明确标注这是「查找」条：原先只有一条与面包屑同款的淡黄细线，在流量页这类
                    内容密集的页面里几乎看不出输入框（实测与背景对比度仅 1.37） */}
                <span class="whitespace-nowrap font-medium text-warning">🔍 查找</span>
                <input
                    ref={inputEl}
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
            </Portal>
        </Show>
    );
}
