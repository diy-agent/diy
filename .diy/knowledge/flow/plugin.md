---
desc: 插件槽与注册表：五个槽位、组合期校验、notify 旁路
updated: 2026-11-07
---

## compose-order

**先注册齐、再 `createRuntime`**（组合期扫描要求名字此刻已注册；`prompt:` 不查）。界线 = **内核只校验自己 `resolve` 的槽**（`guard`/`action`/`notify`）；`render`/`source` 的名字**不查**

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:55）

## notify-bypass

`notify` 是**旁路**：插件抛错 / 回执形状错只记进 `transition.notifyErrors`，**不作废**已落定的 `state` / `event`；插件异常统一包成 `plugin-threw`（带 `cause`）

（见 25da9072:pkgs.ts/diy-flow/AGENTS.md:57）
