---
desc: diy-template 包内定位：parser / render / scope / analyze / 宿主装配入口（@diy-agent/template 提示词模版引擎）
updated: 2026-10-23
---

## analyze

`src/analyze.ts`：静态分析（变量契约、lint 视图、循环引用推导的数据源）

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:11）

## entry

`src/index.ts` barrel 导出（消费者只看这一份）

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:12）

## host

宿主侧接入：`apps/diy-app/src/main/services/prompt-registry.ts`（唯一装配入口）

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:13）

## parser

`src/parser.ts` + `src/ast.ts`：模版文本 → AST（两种正交概念：`parse` 与 `encode`，本包只做 parse）

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:8）

## render

`src/render.ts`：`render` / `renderWithTrace`（trace 供提示词试验场的高亮联动）

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:9）

## scope

`src/scope.ts`：作用域求值（`globals` 点路径 vs `.` 前缀的动态作用域）

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:10）

## spec

`SPEC.md` **决策记录**（为什么换引擎、明确不做哪些语法）；需求真源是 `tests/intent.template.test.ts`（R1–R15）与 `tests/parser.test.ts`

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:7）
