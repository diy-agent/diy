/**
 * FindBar — 页面内查找条（##234）。
 *
 * 形态对齐「提示词页的标注结果条」（DynamicBar）：i/n 计数 + ↑/↓ 跳转 + ✕ 关闭，
 * 且**动态出现**（关掉就完全消失），不是模态弹窗 —— 用户是在页面上找字，不该被
 * 一个挡住内容的对话框打断。
 *
 * 只负责 UI；搜索与高亮在 store/findStore（CSS Highlight API，不动 DOM）。
 */
import { Show, createEffect } from "solid-js";
import { findStore } from "../store/findStore";

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
            <div
                data-find-skip
                class="mx-2 my-1.5 flex shrink-0 items-center gap-2 rounded-lg border border-warning/70 bg-warning/20 px-2 py-1 text-body shadow-md"
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
        </Show>
    );
}
