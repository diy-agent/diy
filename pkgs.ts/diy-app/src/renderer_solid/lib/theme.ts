// lib/theme.ts — 主题偏好（localStorage 持久，data-theme 显式锁定）
//
// 不跟随系统 prefers-color-scheme：Playwright attach CDP 会注入 colorScheme 仿真，
// 跟随系统会导致测试时界面闪变（见 AGENTS.md 样式策略）。默认深色。
export type DiyTheme = "dark" | "light";

const KEY = "diy-theme";

export function getTheme(): DiyTheme {
  try {
    if (localStorage.getItem(KEY) === "light") return "light";
  } catch {
    /* 隐私模式/存储损坏，回退深色 */
  }
  return "dark";
}

export function applyTheme(t: DiyTheme): void {
  document.documentElement.dataset.theme = t;
}

export function setTheme(t: DiyTheme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* 存失败也应用本次选择 */
  }
  applyTheme(t);
}
