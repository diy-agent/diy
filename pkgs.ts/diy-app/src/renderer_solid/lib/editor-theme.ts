// lib/editor-theme.ts — 编辑器配色清单（试验场右上角 `…` 面板平铺直选）
//
// 与"应用主题"解耦：暗色 app 里配亮底编辑器是合理需求（像 VS Code 的主题选择器）。
// 主题实现来自 @uiw/codemirror-themes-*（各主题一个包，**动态 import**：不选就不进主包），
// 面板里的色块用静态 swatch 画，不必先把主题加载进来。
import { createSignal } from "solid-js";
import type { Extension } from "@codemirror/state";
import { Caches } from "./ui-state";

export interface EditorTheme {
    key: string;
    label: string;
    /** 暗底？（决定 DSL/标签装饰色的亮暗变体、以及预览侧判断） */
    dark: boolean;
    /** 面板色块预览：[底色, 正文色, 强调色] */
    swatch: [string, string, string];
    /** 返回 undefined = 内置方案（跟随应用主题：One Dark / CM 默认高亮 + daisyUI 纸面） */
    load?: () => Promise<Extension>;
}

export const EDITOR_THEMES: EditorTheme[] = [
    { key: "diy", label: "跟随应用主题", dark: true, swatch: ["#1d232a", "#a6adbb", "#6419e6"] },
    { key: "oneDark", label: "One Dark", dark: true, swatch: ["#282c34", "#abb2bf", "#c678dd"], load: async () => (await import("@codemirror/theme-one-dark")).oneDark },
    { key: "githubDark", label: "GitHub Dark", dark: true, swatch: ["#0d1117", "#c9d1d9", "#ff7b72"], load: async () => (await import("@uiw/codemirror-theme-github")).githubDark },
    { key: "githubLight", label: "GitHub Light", dark: false, swatch: ["#ffffff", "#24292f", "#cf222e"], load: async () => (await import("@uiw/codemirror-theme-github")).githubLight },
    { key: "vscodeDark", label: "VS Code Dark", dark: true, swatch: ["#1e1e1e", "#d4d4d4", "#569cd6"], load: async () => (await import("@uiw/codemirror-theme-vscode")).vscodeDark },
    { key: "vscodeLight", label: "VS Code Light", dark: false, swatch: ["#ffffff", "#000000", "#0000ff"], load: async () => (await import("@uiw/codemirror-theme-vscode")).vscodeLight },
    { key: "dracula", label: "Dracula", dark: true, swatch: ["#282a36", "#f8f8f2", "#ff79c6"], load: async () => (await import("@uiw/codemirror-theme-dracula")).dracula },
    { key: "nord", label: "Nord", dark: true, swatch: ["#2e3440", "#d8dee9", "#88c0d0"], load: async () => (await import("@uiw/codemirror-theme-nord")).nord },
    { key: "monokai", label: "Monokai", dark: true, swatch: ["#272822", "#f8f8f2", "#f92672"], load: async () => (await import("@uiw/codemirror-theme-monokai")).monokai },
    { key: "solarizedLight", label: "Solarized Light", dark: false, swatch: ["#fdf6e3", "#657b83", "#268bd2"], load: async () => (await import("@uiw/codemirror-theme-solarized")).solarizedLight },
    { key: "solarizedDark", label: "Solarized Dark", dark: true, swatch: ["#002b36", "#93a1a1", "#268bd2"], load: async () => (await import("@uiw/codemirror-theme-solarized")).solarizedDark },
    { key: "tokyoNight", label: "Tokyo Night", dark: true, swatch: ["#1a1b26", "#a9b1d6", "#bb9af7"], load: async () => (await import("@uiw/codemirror-theme-tokyo-night")).tokyoNight },
    { key: "materialDark", label: "Material Dark", dark: true, swatch: ["#212121", "#eeffff", "#82aaff"], load: async () => (await import("@uiw/codemirror-theme-material")).materialDark },
    { key: "sublime", label: "Sublime", dark: true, swatch: ["#2e2e2e", "#ffffff", "#ff9d00"], load: async () => (await import("@uiw/codemirror-theme-sublime")).sublime },
    { key: "gruvboxDark", label: "Gruvbox Dark", dark: true, swatch: ["#282828", "#ebdbb2", "#fb4934"], load: async () => (await import("@uiw/codemirror-theme-gruvbox-dark")).gruvboxDark },
    { key: "quietlight", label: "Quiet Light", dark: false, swatch: ["#f5f5f5", "#333333", "#7a3e9d"], load: async () => (await import("@uiw/codemirror-theme-quietlight")).quietlight },
    { key: "xcodeLight", label: "Xcode Light", dark: false, swatch: ["#ffffff", "#000000", "#0b4f79"], load: async () => (await import("@uiw/codemirror-theme-xcode")).xcodeLight },
    { key: "eclipse", label: "Eclipse", dark: false, swatch: ["#ffffff", "#000000", "#7f0055"], load: async () => (await import("@uiw/codemirror-theme-eclipse")).eclipse },
    { key: "abyss", label: "Abyss", dark: true, swatch: ["#000c18", "#6688cc", "#225588"], load: async () => (await import("@uiw/codemirror-theme-abyss")).abyss },
];

const KEYS = new Set(EDITOR_THEMES.map((t) => t.key));

/** 当前编辑器配色的 key（持久化在 Caches；坏值回落默认） */
export const [editorThemeKey, setEditorThemeKeySignal] = createSignal<string>(
    KEYS.has(Caches.diy_lab_editor_theme.get()) ? Caches.diy_lab_editor_theme.get() : "diy",
);

export function setEditorTheme(key: string): void {
    if (!KEYS.has(key)) return;
    Caches.diy_lab_editor_theme.set(key);
    setEditorThemeKeySignal(key);
}

export function currentEditorTheme(): EditorTheme {
    return EDITOR_THEMES.find((t) => t.key === editorThemeKey()) ?? EDITOR_THEMES[0]!;
}
