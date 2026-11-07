---
desc: 参考实现：三方 agent 框架源码位置（只读设计取舍，不抄代码）
updated: 2026-11-02
---

## dir

三方源码在 `~/git-ref/`：`deepseek-harness/`（= dsh）· `opencode/` · `pi/`。**带着问题去查**（「我要的是哪种取舍」），不通读。

## dsh

DeepSeek 自家 harness；**编辑器式工具 + UI 呈现**：`packages/fs/tool-str-replace-editor/`（`str_replace_editor`：view / create / str_replace / insert）+ `packages/fs/tool-fs/{edit,write,read}.ts`。

## opencode

TS + Effect 的完整 agent；**工具契约最全**：`packages/core/src/tool/plugin/*.ts`（edit / write / read / patch / glob / grep / shell），带权限审批、formatter 钩子、返回文件 diff。

## outcome

结论写回**任务 body 或 AGENTS.md**，别只留在会话里（同一轮调研会被压缩掉）。

## pi

极简 durable agent；**参数容错与盘面细节最讲究**：`packages/durable/src/tools/edit.ts`（批量 `edits[]`、行尾 / BOM 归一、字符归一匹配、同文件变更队列、生成 unified patch）。
