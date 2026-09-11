// lib/theme.ts — 主题偏好（视图 cache：localStorage 归一定位，见 lib/ui-state）
//
// 不跟随系统 prefers-color-scheme：Playwright attach CDP 会注入 colorScheme 仿真，
// 跟随系统会导致测试时界面闪变（见 AGENTS.md 样式策略）。默认深色。
import { Caches, type DiyTheme } from "./ui-state";
export type { DiyTheme };

export function getTheme(): DiyTheme {
  return Caches.diy_app_theme.get();
}

export function applyTheme(t: DiyTheme): void {
  document.documentElement.dataset.theme = t;
}

export function setTheme(t: DiyTheme): void {
  Caches.diy_app_theme.set(t);
  applyTheme(t);
}
