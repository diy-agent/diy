# @diy/template —— 提示词模版引擎（阶段 1）

> **本文档状态：意图测试为唯一真源** — `tests/intent.template.test.ts`（R1–R15）与 `tests/parser.test.ts` 已覆盖本 SPEC 全部可验证行为；本文保留作**决策记录与索引**，新增需求先写意图测试，再补实现。今后以意图测试为准，本文仅作索引与背景。
>
> 接入状态：已接入 `diy-app`（`./sha.sh check` ✅ / `./sha.sh test` 4 包全绿：`diy-template 83` + `diy-app 247+` + `diy-rpc 31` + `diy-dev 41`）。

## 目录

- [1. 为什么要换引擎](#1-为什么要换引擎需求来源)
- [2. 设计原则与语法](#2-设计原则与语法)
  - [2.0 原则](#20-设计原则先读这条它决定后面所有取舍)
  - [2.1 parse/encode 正交](#21-两个正交概念parse-与-encode词汇表已定实现只做-parse)
  - [2.2 属性值两种形态](#22-属性值只有两种形态引号不是语法)
  - [2.3 控制属性与循环](#23-控制属性与循环语法)
  - [2.4 源码区间与迭代信封](#24-源码区间loc--end--trace-的-src--out)
  - [2.5 判据 C：带控制属性即容器](#25-判据-c带控制属性的标签才算节点)
- [3. Context 模型](#3-context-模型)
- [4. include 与宿主注册表](#4-include-与宿主注册表)
- [5. 诊断能力](#5-诊断能力两个自说明视图的数据源)
- [6. 实测结论](#6-实测结论)
- [7. 明确不做](#7-明确不做阶段-1)
- [8. 未决问题（已收口）](#8-未决问题已收口全部有结论)
- [9. 下一步](#9-下一步)

---

## 1. 为什么要换引擎（需求来源）

`pkgs.ts/diy-app/src/main/services/prompt-registry.ts` 原用「正则白名单替换 + 代码拼装」渲染提示词。对 8 份内置模版 + 装配逻辑清点后：

**需要**（已由 R1–R15 覆盖）：插值（含属性内插值）、`if` / `if-not`、`:for`（含下标/首末）、`include`（显式参数+硬隔离）、属性路径、判据 C 的标签容器、**逐字节原样**、standalone 不占空间、变量契约校验、trace 区间。  
**不需要**：表达式语言（`==`/`&&`/`>`/算术/`?.`/`??`）、filter/helper/`with`/`../`/`@root` 等隐式上下文。

依据：现存条件**全部**是「非空/存在/取反」，0 处比较；枚举判断用**谓词物化**覆盖。

现状里「藏在代码里」的 6 处结构已搬进模版：

| 现状（代码） | 目标（模版） |
| --- | --- |
| `<${tag}>…</${tag}>` 包裹 | 标签内联在模版里 |
| `blocks.join("\n\n")` 节间分隔 | 节模版末尾空行；布局每行一个 `include` |
| `if (!text.trim()) continue` 空节跳过 | `:if` / `:if-not` |
| 循环渲染链（一层一个 `<project_instructions>`） | `<template :for={{chain}} :as="f">` |
| `cwd_note` 在 `cwd.ts` 里拼中文提示 | `:if-not` + 文案 |
| `diy_cli` 未注入兜底文案 | `:if` / `:if-not` |

---

## 2. 设计原则与语法

### 2.0 设计原则（**先读这条，它决定后面所有取舍**）

> **模版不是 XML 文档，是"带控制标记的纯文本"。借 XML 的视觉结构，不借它的合规约束。**

1. **输出标签永不解析**：`<diy>` / `<project_context>` 等都是文本（`{{}}` 照常替换）；不配对、不校验、不规范化。⇒ `<pid>`、`a<b`、`vector<T>`、`&` 全原样（语料 366+63 处 `<` 冲突）。
2. **只有控制标记是语法**：`<template>` / `<raw>` / **带控制属性的标签容器**（判据 C，见 §2.5）。⇒ `<template>` 碰撞 0 次。
3. **唯一必须严格的是控制标记**：未闭合、非法 `:for`、未知路径、参数不匹配一律报错（带行列）；`<xxx :if>` 误用由 `lint` 提示。
4. **逐字节保真**：不转义、不 trim、不删行；末尾换行与节间分隔由模版自己负责。
5. **伪 XML 无验证器** ⇒ 输出侧无需为"良构"妥协。
6. **代码围栏 ` ``` ` 内一律不解析**（讲格式、贴样例零转义，与 `<raw>` 互补）。

由此**删除**（相对 XML-native）：输出元素解析/重序列化、`/>` 前空白、无值属性、标签闭合校验、"正文 `<` 必须转义"。

### 2.1 两个正交概念：`parse` 与 `encode`（**词汇表已定，实现只做 parse**）

```
parse  = 我怎么理解源文本     ← 模版语义，属于引擎
encode = 我怎么输出字符串     ← 输出管线，属于调用方
```

| 维度 | 取值 | 阶段 1 | 现状对应 |
| --- | --- | --- | --- |
| `parse` | `normal`（默认） | ✅ | 识别控制标记 |
| `parse` | `none` | ✅ | `<raw>…</raw>`；围栏 ` ``` ` 为 parser 级透明区 |
| `encode` | `none`（默认） | ✅ | — |
| `encode` | `xml` / `html` / `json` … | ❌ 不实现 | — |

**为什么 `encode` 不做**：下游是 LLM 无解码器；与逐字节基线冲突；交互面大（块 vs 节点、`{{}}` 是否编码、trace 字节口径）。触发条件：出现会 decode 的真实消费者时，放在 `RenderOptions { encode }` 而非模版属性。

### 2.2 属性值：**只有两种形态，引号不是语法**

| 写法 | 形态 | 取值 |
| --- | --- | --- |
| `attr={{x}}` / `attr="{{x}}"` | 整值恰好一个插值 → **表达式** | 原类型（数组/布尔保真） |
| `attr="text"` / `attr=text` | 其余 → **文本**（含 `{{}}` 插值点） | 字符串 |

引号只定界，`attr={{x}}` 与 `attr="{{x}}"` 等价（推荐前者：`list={{skills}}` 比 `list="{{skills}}"` 更不绕）。约束：裸值不能含空格；`attr={{x}}b` 报错（需引号）。集合只能迭代、标量才能插值（引号不把集合字符串化）。

### 2.3 控制属性与循环语法

| 控制标记 | 含义 |
| --- | --- |
| `<template :if={{p}}>` | 真值渲染 |
| `<template :if-not={{p}}>` | 取反（`if-not` 与 `if` 同根对称，不叫 `:unless`） |
| `<template :for={{集合}} :as="item">` | 循环：`:for` = 集合表达式，`:as` = 变量名 |
| `<template :include="./a.md" p={{x}} />` | 片段调用；路径字面量，参数硬隔离 |

### 2.4 源码区间（`loc` / `end` / trace 的 `src` / `out`）

| 概念 | 含义 |
|------|------|
| `loc` | 起点（line/col/offset） |
| `end` | 源码终点（不含）；`:if`/`:for` 的 `loc` 指控制属性，`from` 为整段起点 |
| `src` | 所属模版 body 区间（由 include 祖先决定） |
| `out` | 渲染结果字符区间（`bytes` 仍为预算口径） |

**迭代信封**：`:as="item"` 绑定命名空间：

| 写法 | 含义 |
| --- | --- |
| `{{.item.value}}` / `{{.item.value.path}}` | 当前项 / 字段（无碰撞） |
| `{{.item.index}}` | 下标 |
| `{{.item.isFirst}}` / `{{.item.isLast}}` | 首/末（分隔符无需表达式） |

嵌套各自独立：`.g.index` 与 `.it.index` 同时可访。已取消：`{{.}}`、游离 `{{.index}}` 等（报错并提示 `.x.value`）。

### 2.5 判据 C：带控制属性的标签才算节点

| 判据 | 碰撞（1703KB 语料） | 维护成本 | 支持 `<description :if>` |
| --- | ---: | --- | --- |
| A 只解析 `<template>` / `<raw>` | 0 | 无 | ❌ |
| B 标签名白名单 | 17/10… | 有 | ✅ 限白名单 |
| **C 带控制属性即容器** | **0**（62 次全是测试/文档） | **无** | ✅ 任意标签 |

**3 条规则**

1. 任何 `<name …>` 默认文本：不配对、不校验、不转义。
2. **当且仅当带控制属性**（`:if`/`:if-not`/`:for`）时成为容器：须配对 `</name>`（否则报错），并原样输出自身标签（只剥控制属性字符区间）。⇒ `<skill :for={{skills}} :as="s">{{.s.value}}</skill>` → `<skill>a</skill><skill>b</skill>`。
3. 逐字节重发：只按区间剥属性，其余保留（`<pi path='x'  flag :if={{on}}>` → `<pi path='x'  flag>`）。

`<template>` 是同判据特例（不输出标签）；`:include` 只能在 `<template>` 上；`<raw>` = `parse="none"`。误报（`:if=` / `:iff=`）由 `analyze().lint` 提示。

---

## 3. Context 模型

```ts
interface RenderContext {
  globals: Record<string, unknown>;   // diy.* / task.* / …
  dynamic: DynamicFrame[];            // 由外到内的作用域链
}
```

- 路径分流：`.` 开头 → dynamic，否则 → globals；**前缀隔离，禁同名遮蔽**。
- 嵌套 `:for`：内层可见外层（同名则遮蔽）；信封为普通对象（路径机直走，无内建名特例）。
- **`:include` 硬隔离**：`{ globals, dynamic: args }`，不继承调用者链。
- 严格性：首段必须存在（`unresolved-path`）；深层缺失→`undefined`；插值 `undefined`/`null`→`missing-value`（需 `:if` 守住）。
- 真假值表：`false|null|undefined|""|[]|0|NaN` 为假；`"false"|"0"|" "|{}` 为真。**模版内无运算符**，比较由宿主物化。

---

## 4. include 与宿主注册表

```ts
interface IncludeResolver { resolve(relpath: string): { source: string; locked?: boolean } | null; }
```

1. 必须 `./` 开头，禁 `..` / 绝对路径。
2. 须命中 resolver（白名单/项目覆盖>内置），否则 `include` 报错。
3. 循环检测（完整链）+ 深度上限 8。
4. 锁定模版（`_guard.md`）仅锁定入口可 include。
5. **参数双向校验**：少传→`missing-arg`，多传→`unknown-arg`，`:as` 绑定名自动排除。

---

## 5. 诊断能力（两个"自说明"视图的数据源）

```ts
analyze(source, { file, vars }): { paths, globals, dynamics, includes, conditions, loops, lint }
renderWithTrace(source, ctx, { resolver, file, locked }): { text, trace }
// trace: { kind, name, arg, value, bytes, src, out, result, reason, children }
```

- `analyze` → 变量 view：反向索引、lint、变量契约校验（未知路径/:for 非数组/插值非标量）。
- `renderWithTrace` → 结构树：字节数、`:if` 真假与原因、迭代次数、双向区间。

---

## 6. 实测结论

**代码量**（`pkgs.ts/diy-template/`，零依赖、Node/浏览器通用）：

| 文件 | 说明 |
| --- | --- |
| `src/parser.ts` | 词法+语法（控制标记/纯文本/围栏/位置） |
| `src/render.ts` | 渲染+trace+include |
| `src/analyze.ts` | 静态分析+lint |
| `src/scope.ts` | 作用域链、路径、真假值 |
| `src/ast.ts` | 6 类节点 |
| `src/errors.ts` | 10 类错误（带行列） |
| `tests/intent.template.test.ts` | 意图测试 R1–R15（需求级） |
| `tests/parser.test.ts` | 边界单测（透传/围栏/报错/lint） |

**验证**：

- `diy-template` 全绿（`intent` R1–R15 + `parser` 边界）。
- `template-dsl-golden` 6 例：8 份内置模版与整份 `system` 装配与换引擎前逐字节一致（差异仅末尾换行，见测试注释）。
- `./sha.sh check` ✅；全仓 `vitest` 4 包全绿。

---

## 7. 明确不做（阶段 1）

| # | 不做 | 说明 |
| --- | --- | --- |
| N1 | 表达式语言 | `== != > < && \|\| !` 算术 `?:` `??` `?.` 函数调用 下标 字面量 |
| N2 | filter/pipe/helper/macro/继承 | 一律不做 |
| N3 | `#with` / `../` / `@root` | 与显式 scope 隔离冲突 |
| N4 | HTML 转义/自动转义 | 转义破坏逐字节 |
| N5 | standalone 行剥离/自动 trim | 已由 standalone 默认开覆盖（见 §8.5） |
| N6 | Zod schema 校验（Context/Args） | 用静态参数校验替代 |
| N7 | 编辑器高亮/LSP | 阶段 2 候选 |
| N8 | i18n/异步/流式/增量 | — |
| N9 | 动态 include | 静态 include 足够 |
| N10 | XML/表达式 parser 库 | 自研扫描器保逐字节 |
| N11 | 跨调用 AST 缓存 | 仅单次渲染内缓存 |

---

## 8. 未决问题（已收口）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 旧 Handlebars 分支 | ❌ 不用（已删） |
| 2 | 迁移基线时机 | ✅ 20+ 语义提交，M4 切默认 |
| 3 | 命名空间 `{{diy_cli}}` → `{{diy.cli}}` | ✅ 已改 |
| 4 | 模版末尾换行/trim | ✅ 逐字节进引擎，末尾换行由模版负责 |
| 5 | 节间分隔与空节 | ✅ 节自带末尾空行；`_guard` 恒存在 |
| 6 | `:else` | ❌ 不做（`:if` + `:if-not` 已够） |
| 7 | 注释 | ✅ `{{/* … */}}` |
| 8 | 谓词物化边界 | ✅ 仅原子布尔 |
| 9 | trace/analyze UI | ✅ 试验场两 view 已落地（M5） |
| 10 | 打包形态 | ✅ `vite.*.config.ts` 内联 |
| 11 | 属性值引号 | ✅ 引号仅定界，推荐裸值 |
| 12 | 内建名冲突 | ✅ 迭代信封解决 |
| 13 | 集合插值 | ✅ `not-scalar` 硬错 |
| 14 | 变量契约 | ✅ `SYSTEM_VARS` + `analyze({vars})` 校验，试验场展示类型/说明 |

---

## 9. 下一步

- [x] **M5 已完成**：试验场两 view（变量定义/变量值/结构树 + 高亮联动/区间/列宽）与变量契约落地。
- [ ] **可做**：数组元素类型 `chain[].path` → 细化 `include` 参数与循环内字段校验。
- **阶段 2 候选**（非当下需求）：表达式语言、`:else`、动态 include、`encode`、编辑器 LSP。

> M4 已完成：注册表切 DSL ✅、8 份模版改写 ✅、`_system.md` 装配 ✅、真发等价（golden）✅、回退改为 `git revert + golden` ✅。
