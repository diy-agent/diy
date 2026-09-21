// components/EditorThemePicker.tsx — 编辑器视图上的 `…` 按钮：平铺面板直选编辑器配色
//
// 形态参考 VS Code 的"隐藏扩展按钮菜单" + daisyUI megamenu（dropdown + 网格平铺）：
// **一层到位**，不做「主题 → 子类 → 具体」的层级菜单。面板是"功能选项区"，
// 以后加别的编辑器选项（字号/折行/行号…）也往这里加一组即可。
import { For, Show } from "solid-js";
import { EDITOR_THEMES, editorThemeKey, setEditorTheme } from "../lib/editor-theme";

export function EditorThemePicker() {
    return (
        <div class="dropdown dropdown-end">
            <div
                tabindex={0}
                role="button"
                class="btn btn-xs btn-ghost px-1.5 font-mono"
                title="编辑器显示选项（配色等）"
            >
                …
            </div>
            <div
                tabindex={0}
                class="dropdown-content z-50 mt-1 w-[23rem] rounded-box border border-base-300 bg-base-200 p-2 shadow-xl"
            >
                <div class="px-1 pb-1.5 text-[10px] font-bold tracking-widest opacity-60">编辑器配色</div>
                <div class="grid grid-cols-4 gap-1">
                    <For each={EDITOR_THEMES}>
                        {(t) => (
                            <button
                                class={`flex flex-col gap-1 rounded border px-1 py-1 text-[10px] leading-tight ${
                                    editorThemeKey() === t.key
                                        ? "border-primary bg-primary/15 font-semibold"
                                        : "border-transparent hover:bg-base-300/60"
                                }`}
                                title={t.label}
                                onClick={() => setEditorTheme(t.key)}
                            >
                                {/* 色块预览：不加载主题也能画（底色 | 正文 | 强调） */}
                                <span class="flex h-3.5 w-full overflow-hidden rounded-sm">
                                    <span class="w-1/2" style={{ background: t.swatch[0] }} />
                                    <span class="w-1/4" style={{ background: t.swatch[1] }} />
                                    <span class="w-1/4" style={{ background: t.swatch[2] }} />
                                </span>
                                <span class="w-full truncate text-left">{t.label}</span>
                            </button>
                        )}
                    </For>
                </div>
                <div class="mt-2 border-t border-base-300 px-1 pt-1.5 text-[10px] opacity-50">
                    两个编辑器同步；选择会记住（<Show when={editorThemeKey() === "diy"} fallback="非默认">跟随应用主题</Show>
                    ）
                </div>
            </div>
        </div>
    );
}
