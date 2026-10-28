// lib/skin.ts — 界面样式（皮肤）偏好：**系统整体样式**，不是聊天页私有开关
//
// 两套皮肤（2026-10-12 用户定稿，草图 /tmp/t253-sketch/rail-v4.html 的两列就是它们）：
//   · `rail` 竖栏折叠 —— 一条 rail 贯穿，层级 = 线 + 缩进，行不带卡片底
//   · `card` 卡片折叠 —— 每块一张卡，左 4px 色条表类型（**错误/警告才吃色**）
// 落地路径：`document.documentElement.dataset.skin` 一处挂载，样式规则写在 index.css
// 的 `[data-skin=…]` 段里 —— 组件只输出中立结构，皮肤不改 DOM（改 DOM 就是两套代码）。
//
// 本期只作用于 **agent 输出区**（聊天），其他页面暂无差异；后续扩面时**不改本文件**，
// 只给对应区块加 `diy-skin-scope` 语义类。
import { Caches, type DiySkin } from "./ui-state";
export type { DiySkin };

export function getSkin(): DiySkin {
  return Caches.diy_app_skin.get();
}

export function applySkin(s: DiySkin): void {
  document.documentElement.dataset.skin = s;
}

export function setSkin(s: DiySkin): void {
  Caches.diy_app_skin.set(s);
  applySkin(s);
}

/** 皮肤清单（设置页与其它入口共用的唯一真源：加皮肤只改这里） */
export const SKINS: { key: DiySkin; label: string; hint: string }[] = [
  { key: "rail", label: "竖栏", hint: "一条竖线贯穿；层级靠线与缩进，行不带卡片底" },
  { key: "card", label: "卡片", hint: "每块一张卡；左侧色条标类型，只有错误/警告吃色" },
];
