// lib/theme.ts — 主题偏好（视图 cache：localStorage 归一定位，见 lib/ui-state）
//
// 不跟随系统 prefers-color-scheme：Playwright attach CDP 会注入 colorScheme 仿真，
// 跟随系统会导致测试时界面闪变（见 AGENTS.md 样式策略）。默认深色。
import { createSignal } from "solid-js";
import { Caches, type DiyTheme } from "./ui-state";
export type { DiyTheme };

/**
 * 当前主题的**响应式**信号（Caches 只是持久化，读它不会触发重渲染）。
 * 需要跟随主题变化的东西（如编辑器的语法着色风格）读这个。
 */
export const [themeSignal, setThemeSignal] = createSignal<DiyTheme>(Caches.diy_app_theme.get());

export function getTheme(): DiyTheme {
  return Caches.diy_app_theme.get();
}

export function applyTheme(t: DiyTheme): void {
  document.documentElement.dataset.theme = t;
}

export function setTheme(t: DiyTheme): void {
  Caches.diy_app_theme.set(t);
  applyTheme(t);
  setThemeSignal(t);
}
