# @diy/template — 提示词模版引擎

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**零依赖纯内核**（不认识文件系统，`include` 由宿主注入 resolver），Node / 浏览器 / Electron 通用。

## find — 包内定位

- `find.spec` — `SPEC.md` **决策记录**（为什么换引擎、明确不做哪些语法）；需求真源是 `tests/intent.template.test.ts`（R1–R15）与 `tests/parser.test.ts`
- `find.parser` — `src/parser.ts` + `src/ast.ts`：模版文本 → AST（两种正交概念：`parse` 与 `encode`，本包只做 parse）
- `find.render` — `src/render.ts`：`render` / `renderWithTrace`（trace 供提示词试验场的高亮联动）
- `find.scope` — `src/scope.ts`：作用域求值（`globals` 点路径 vs `.` 前缀的动态作用域）
- `find.analyze` — `src/analyze.ts`：静态分析（变量契约、lint 视图、循环引用推导的数据源）
- `find.entry` — `src/index.ts` barrel 导出
- `find.host` — 宿主侧接入：`pkgs.ts/diy-app/src/main/services/prompt-registry.ts`（唯一装配入口）

## rule — 硬约束

- `rule.no-expr` — **刻意不做表达式语言**（无 `==` / `&&` / 算术 / `?.` / `??` / filter / `with` / `../` / `@root`）：现存条件全部是「非空 / 存在 / 取反」，枚举判断用**谓词物化**覆盖。加语法前先读 `SPEC.md` 的取舍依据
- `rule.byte-faithful` — **逐字节保真、不转义**：控制标记单独占行时不产出任何字符（故可自由缩进表达嵌套），但**输出文本必须顶格**（行首缩进会原样进提示词）；空行是内容不是排版
- `rule.intent-first` — 需求真源是意图测试：新增需求**先写意图测试再补实现**，`SPEC.md` 只作索引与背景
- `rule.host-owns-io` — 本包不碰文件系统 / Node API；`include` 的路径解析与读取一律由宿主的 `IncludeResolver` 提供
