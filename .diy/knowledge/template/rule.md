---
desc: diy-template 硬约束：不做表达式语言 / 逐字节保真 / 意图测试优先 / IO 归宿主
updated: 2026-10-23
---

## byte-faithful

**逐字节保真、不转义**：控制标记单独占行时不产出任何字符（故可自由缩进表达嵌套），但**输出文本必须顶格**（行首缩进会原样进提示词）；空行是内容不是排版

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:18）

## host-owns-io

本包**不碰文件系统 / Node API**（零依赖纯内核，Node / 浏览器 / Electron 通用）；`include` 的路径解析与读取一律由宿主注入的 `IncludeResolver` 提供

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:20）

## intent-first

需求真源是意图测试：新增需求**先写意图测试再补实现**，`SPEC.md` 只作索引与背景

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:19）

## no-expr

**刻意不做表达式语言**（无 `==` / `&&` / 算术 / `?.` / `??` / filter / `with` / `../` / `@root`）：现存条件全部是「非空 / 存在 / 取反」，枚举判断用**谓词物化**覆盖。**加语法前先读 `SPEC.md` 的取舍依据** —— 这不是遗漏，是设计选择

（见 818d342a:pkgs.ts/diy-template/AGENTS.md:17）
