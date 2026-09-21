// components/EditorThemePicker.tsx — 编辑器视图的 `…` 扩展菜单（所有编辑器 view 的标题栏最右）
//
// 形态参考 VS Code 的"隐藏扩展按钮菜单" + daisyUI megamenu（dropdown + 网格平铺）：
// **一层到位**，不做「主题 → 子类 → 具体」的层级菜单。面板是"功能选项区"，
// 以后加别的编辑器选项（字号/折行/行号…）也往这里加一组即可。
//
// 分区回答"自动 vs 暗/亮"：自动 = 跟随应用主题（app 切主题时编辑器跟着变）；
// 一旦选了具体配色就是显式选择，**不再跟随**（VS Code 同款行为），下面一行状态会说明。
import { For } from "solid-js";
import { EDITOR_THEMES, currentEditorTheme, editorThemeKey, setEditorTheme, type EditorTheme } from "../lib/editor-theme";
import { themeSignal } from "../lib/theme";

/** 分区：自动 / 暗色 / 亮色（三块同时平铺可见，不是三级菜单） */
const GROUPS: { title: string; key: EditorTheme["group"] }[] = [
    { title: "自动", key: "auto" },
    { title: "暗色", key: "dark" },
    { title: "亮色", key: "light" },
];

export function EditorThemePicker() {
    const isAuto = () => editorThemeKey() === "diy";
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
                <For each={GROUPS}>
                    {(g) => (
                        <div class="mb-1.5">
                            <div class="flex items-center gap-1 px-1 pb-1 text-[10px] font-bold tracking-widest opacity-60">
                                <span>{g.title}</span>
                                <span class="font-normal normal-case tracking-normal opacity-80">
                                    {g.key === "auto"
                                        ? `跟随应用主题（当前：${themeSignal() === "dark" ? "暗色" : "亮色"}）`
                                        : ""}
                                </span>
                            </div>
                            <div class="grid grid-cols-4 gap-1">
                                <For each={EDITOR_THEMES.filter((t) => t.group === g.key)}>
                                    {(t) => (
                                        <button
                                            class={`flex flex-col gap-1 rounded border px-1 py-1 text-[10px] leading-tight ${
                                                editorThemeKey() === t.key
                                                    ? "border-primary bg-primary/15 font-semibold"
                                                    : "border-transparent hover:bg-base-300/60"
                                            }`}
                                            title={`${t.label}（${t.group === "auto" ? "自动" : t.dark ? "暗色" : "亮色"}）`}
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
                        </div>
                    )}
                </For>
                <div class="border-t border-base-300 px-1 pt-1.5 text-[10px] leading-relaxed opacity-50">
                    两个编辑器同步；选择会记住。
                    <br />
                    当前：
                    <span class="opacity-100">
                        {isAuto()
                            ? `自动（跟随应用主题 · ${themeSignal() === "dark" ? "暗色" : "亮色"}）`
                            : `${currentEditorTheme().label}（${currentEditorTheme().dark ? "暗色" : "亮色"}，不再跟随应用主题）`}
                    </span>
                </div>
            </div>
        </div>
    );
}
