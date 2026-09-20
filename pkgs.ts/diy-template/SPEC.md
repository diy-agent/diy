# @diy/template —— 提示词模版引擎（阶段 1）

> 状态：**原型已跑通**（`npx vitest run` 58 例全绿；diy-app 侧 10 例逐字节等价测试全绿；`./sha.sh check` exit 0）。
> 本文是设计规格 + 原型结论 + 未决问题，够开发 agent 接着做 M4（接入 diy-app）。

---

## 1. 为什么要换引擎（需求来源）

`pkgs.ts/diy-app/src/main/services/prompt-registry.ts` 现在用「正则白名单替换 + 代码拼装」渲染提示词。
对 8 份内置模版 + 装配逻辑做逐条清点后，结论是：

**需要**：插值（含属性内插值）、`if` / `unless`（取反）、`for`（含下标）、`include`（显式参数）、属性路径、**逐字节原样输出**。
**不需要**：表达式语言（`==`/`&&`/`>`/算术/函数调用/`?.`/`??`）、filter、helper、`with`/`../`/`@root` 等隐式上下文。

依据：现存 7 处条件需求**全部**是「非空 / 存在 / 取反」，0 处比较；枚举型判断（任务状态、cwd 情形）
用**谓词物化**（值即 key 查表）覆盖，不需要运算符。

现状里「藏在代码里、模版里看不到」的结构共 6 处，全部是这次要搬进模版的：

| 现状（代码） | 目标（模版） |
| --- | --- |
| `<${tag}>…</${tag}>` 包裹 | 标签内联在模版里 |
| `blocks.join("\n\n")` 节间分隔 | 布局里的空行 / 片段里的前置分隔符 |
| `if (!text.trim()) continue` 空节跳过 | `:if` / `:unless` |
| 循环渲染 `_chain.md` 拼链 | `<template :for>` + `<template :include>` |
| `cwd_note` 在 `cwd.ts` 里拼中文提示 | `:unless` + 模版里的文案 |
| `diy_cli` 未注入时的兜底文案 | `:if` / `:unless` |

---

## 2. 设计原则与语法

### 2.0 设计原则（**先读这条，它决定后面所有取舍**）

> **模版不是 XML 文档，是"带控制标记的纯文本"。借 XML 的视觉结构，不借它的合规约束。**

1. **输出标签永不解析**：`<diy>` / `<project_context>` / `<project_instructions path="…">` 都是普通文本
   （`{{}}` 照常替换）；不做配对校验、不做属性解析、不做引号/空白规范化。
   ⇒ `<pid>`、`a<b`、`vector<T>`、`{ }`、`&` **全部原样，零转义**（实测语料里 366 + 63 处 `<` 冲突）。
2. **只有控制标记是语法**：`<template …>` 与 `<raw>…</raw>` 两个名字，其余一切 `<…` 都是文本。
   ⇒ `<template>` 在 1708KB 语料里碰撞 **0 次**（纯 Markdown 里 0 次）。
3. **唯一必须严格的是控制标记**：识别失败不能静默 —— 未闭合的控制标签、非法 `:for`、未知路径、
   参数不匹配一律报错（带行列）；`<xxx :if>` 这类误用由 **lint** 明确提示（不阻断，但上屏）。
4. **逐字节保真**：不转义、不 trim、不删行；末尾换行与节间分隔由模版自己负责（§8 已拍板项）。
5. 生成的提示词本身是**伪 XML**，没有验证器 ⇒ 输出侧同样不需要为"良构"做任何妥协。

由此**删除**（相对早期 XML-native 方案）：输出元素解析、属性解析与重序列化、`/>` 前空白、
无值属性、`:omit-empty`、标签闭合校验，以及"正文里 `<` 必须转义"（parser 少 150 行量级）。

### 2.1 语法全集

```xml
{{path}} / {{.path}} / {{.index}} / {{.isFirst}} / {{.isLast}} / {{.}}

<template :if="p">…</template>
<template :unless="p">…</template>
<template :for="x of p">…</template>
<template :include="./a.md" k="p" />

<raw>…原样…</raw>

<diy>…</diy>                                       ← 纯文本，不解析
<project_instructions path="{{.p}}">…</project_instructions>

\{{     \<template                             ← 行内逃生（极少用：字面量 {{ 或 <template）
``` … ```                                          ← 代码围栏内一律不解析（讲格式/贴代码首选）
```

**硬规则**

1. **不转义、不 trim、不删行**：控制标记不产出任何字符，其余逐字节进提示词。
2. **只有 `<template`（后跟空白 / `:` / `>` / `/`）与 `<raw>` 是控制标记**，其它一切 `<…` 原样透传。
3. **控制属性只能写在 `<template>` 上**：`:if` / `:unless` / `:for` / `:include`。
   写在普通标签或正文里 → 不解析（会原样漏进提示词），由 `analyze().lint` 明确提示改用 `<template>` 包裹。
4. **控制属性的值是路径**，不写 `{{}}`：`test="cwd.isProject"`、`of="chain"`、`path="f.path"`。
5. **独占一行的控制标记整行不输出**（standalone 规则；解决"空节残留空行"，§8 已拍板）。
6. 实现是**自研词法扫描器**，不引入 XML parser 库（它们会规范化实体/引号/空白，破坏逐字节保真）。

**逃生舱只有两种场景**：① 讲格式/贴代码 → 代码围栏；② 正文里要写字面量 `<template`/`{{` → `\<template`、`\{{`、`<raw>` 或围栏。
**不支持** `<xxx :if>` / `<xxx :for>`（那要求解析所有标签，与原则 1 冲突）；包裹一层 `<template>` 是免费的（不产出字符）。

**与最初设计稿的差异**：

| 设计稿 | 本实现 | 理由 |
| --- | --- | --- |
| `:args="{ task: .task }"` | 非控制属性即参数：`task=".task"` | 属性内嵌 JS 对象字面量本身就是表达式解析器 |
| `:for="task, index of xs"` | `:for="task of xs"` + 内建 `{{.index}}` | 少一个语法面，静态检查更容易 |
| 无取反 / 无首末判断 | `:unless`、`{{.isFirst}}` / `{{.isLast}}` | 否则 `join("\n\n")` 这类分隔需求没表达法 |
| 所有标签都是语法（XML） | 输出标签是文本，只解析 `<template>` / `<raw>` | 消除 `<pid>` / `a<b` 等 429 处转义需求 |
| `:if` 可挂任意输出元素 | 不支持（用 `<template>` 包裹 + lint 提示误用） | 与"输出标签是文本"互斥，二选一 |

## 3. Context 模型

```ts
interface RenderContext {
  globals: Record<string, unknown>;   // 宿主提供：diy.* / task.* / …
  dynamic: DynamicFrame[];            // 由外到内的作用域链
}
```

- 路径分流：`.` 开头 → dynamic；否则 → globals。**不允许跨 scope 同名遮蔽**（前缀天然区分）。
- 作用域链：同模版内嵌套 `:for` → 内层可见外层，同名内层遮蔽。
- **`:include` 硬隔离**：不继承调用者的动态链，被调模版只有 `args` 一层；globals 全程可见
  （= `renderInclude(path, { globals, dynamic: args })`）。
- 严格性：**首段必须存在**（否则 `unresolved-path`，detail 列出可用名）；深层字段缺失返回 `undefined`；
  **插值取到 `undefined`/`null` → `missing-value` 报错**（可选值必须用 `:if` 守住，禁止静默空串）。
- 真假值表（固定）：`false | null | undefined | "" | [] | 0` 为假；`"false" | "0" | " " | {}` 为真。
  **约定：模版内不出现任何运算符**，比较一律由宿主物化成布尔/枚举路径。

---

## 4. include 与宿主注册表

```ts
interface IncludeResolver {
  resolve(relpath: string): { source: string; fragment?: boolean; locked?: boolean } | null;
}
```

引擎强制（与 resolver 双保险）：

1. 必须以 `./` 开头；禁止 `..`、绝对路径。
2. 必须由 resolver 命中（= 宿主白名单 / 项目覆盖 > 内置）；未命中 → `include` 报错，不静默。
3. **循环检测**（报错给完整链）+ 深度上限（默认 8）。
4. 锁定模版（`_guard.md`）不可被可覆盖模版 include；锁定入口可以 include 它。
5. **参数双向静态校验**（阶段 1 用它替代 Zod）：
   - 被调模版引用了但没传 → `missing-arg`
   - 传了但被调模版从未引用（含 `:iff` 这类拼错）→ `unknown-arg`
   - 被调模版的 `:for` 绑定名与 `index`/`isFirst`/`isLast` 自动排除，不算参数。

---

## 5. 诊断能力（两个"自说明"视图的数据源）

```ts
analyze(source, { file }): { paths, globals, dynamics, includes, conditions, loops }
renderWithTrace(source, ctx, { resolver, file, locked }): { text, trace }
// trace 节点：{ kind, name, bytes, result?, reason?, children? }
```

- `analyze` → 试验场「变量 view」：点变量反向索引到模版与行号；体检死变量/孤儿引用。
- `renderWithTrace` → 试验场「结构树」：每个节点字节数 + **每个 `:if` 的真假与原因**
  （"空数组 / 空字符串 / false / 字段缺失"），这是静默失败唯一的解药。

---

## 6. 原型实测结论（本次交付）

**代码量**（`pkgs.ts/diy-template/`）：

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `src/parser.ts` | 370 | 词法 + 语法（控制标记 + 纯文本、围栏、位置换算） |
| `src/render.ts` | 282 | 渲染 + trace + include 规则 |
| `src/analyze.ts` | 181 | 静态分析 + 循环绑定扣除 + 误用 lint |
| `src/scope.ts` | 142 | 作用域链、路径解析、真假值 |
| `src/ast.ts` | 60 | 5 类节点 |
| `src/errors.ts` | 70 | 9 类错误（全部带行列） |
| `src/index.ts` | 35 | 公共 API |
| **合计** | **≈1,140** | 零依赖、纯 TS、Node/浏览器通用 |
| `tests/intent.template.test.ts` | 566 | **意图测试**：R1–R12 需求级（人类语言场景） |
| `tests/parser.test.ts` | 154 | 边界单测：文本透传/围栏/控制标记报错/lint |

**验证**：

- 新包 58 例全绿（意图 36 + 边界 22）。
- `pkgs.ts/diy-app/tests/core/template-engine-equivalence.test.ts` **10 例全绿**：
  - 8 份真实内置模版：新引擎 vs 现有 `renderTemplate` **逐字节相同**；
  - **整份 system 装配等价**：把「包裹标签 + 空节跳过 + `join("\n\n")`」全部搬进模版
    （标签内联 + `:for` + `:unless=".isFirst"` + `:include`）后，输出与今天的 system **逐字节相同**。
- `./sha.sh check` exit 0（含产物护栏）；diy-app core 测试 166 例全绿（无回归）。

**代价与结论**：引擎本身**可行且不大**（≈1,260 行 / 2 天量级）；真正的成本在
**迁移期的逐字节对齐**（下面第 8 节第 4、5 条），不在引擎实现。

---

## 7. 明确不做（阶段 1）

| # | 不做 | 说明 |
| --- | --- | --- |
| N1 | 表达式语言 | `== != > < && \|\| !` 算术 `?:` `??` `?.` 函数调用 数组下标 对象字面量 |
| N2 | filter / pipe / helper / blockHelper / macro / 模板继承 | 一律不做 |
| N3 | `#with` / `../` / `@root` 等隐式上下文 | 与显式 scope 隔离冲突 |
| N4 | HTML 转义 / 自动转义 | 输出是纯文本提示词；转义=破坏逐字节 |
| N5 | standalone 行剥离 / 自动 trim | 见未决问题 5 |
| N6 | Zod schema 校验（Context / Args） | 阶段 1 用静态参数校验替代 |
| N7 | 编辑器诊断 / 高亮 / 自动补全 / LSP | — |
| N8 | i18n、异步、流式、增量、SSR、沙箱权限 | — |
| N9 | 动态 include / 动态 partial 名 | 静态 include 足够（system.md 逐节 include） |
| N10 | 引入 XML parser / 表达式 parser 库 | 自研词法级扫描器即可，且保证逐字节 |
| N11 | 跨调用 AST 缓存（含失效策略） | 只做单次渲染内缓存 |

---

## 8. 未决问题（需拍板，按影响排序）

1. **旧实现处置**：`feat/template-engine` 分支上那份 Handlebars 风格实现（1,367 行、19 组测试）
   与本规格默认行为相反（默认 HTML 转义、`stripStandalone`、filter/helper/`with`/`../`）。
   → 抛弃该分支 / 打 tag 保留 / 直接删？（推荐：**不再使用**，仅保留分支历史）
2. **迁移基线的提交时机**：本次要迁移的对象（`tag`/`fragment`、`_chain.md`、`assembleSystem`、试验场）
   都还在 prompt-lab 工作区的未提交改动里。→ 先提交再动 M4？
3. **变量命名空间**：现在是扁平 `{{diy_cli}}`；新设计倾向 `{{diy.cli}}` / `{{task.title}}`。
   本期是否顺带改名？（改名与"输出等价"正交，但会让 UI 的变量清单更整齐）
4. ~~**模版 body 的末尾换行 / trim**~~ **【已拍板】**：注册表**不再** `trim() + '\n'`，
   模版源**逐字节**进引擎；末尾换行与节间分隔**全部由模版自己完成**。
   ⇒ 迁移时每份模版要显式写出自己的末尾换行；用户覆盖文件也照原样参与渲染。
5. ~~**节间分隔与空节**~~ **【已拍板：方案 (b) 节模版自带分隔符】**（实测见下）。
   被 `:if` 跳过的节不会自己产出字符，但**它是被布局里的空行包围的**，所以：

   | 情形 | (a) 布局空行 | (b) 节模版自带分隔 | (c) 只含控制标签的行不输出 |
   | --- | --- | --- | --- |
   | 有节被跳过（skills 空） | ❌ **+2 字节**（多一个空行） | ✅ 逐字节相同 | ❌ +2 字节 |
   | 无节被跳过 | ✅ | ✅ | ✅ |

   ⇒ 约定：**每份节模版以空行结尾、末节不带**；布局只负责顺序（全部 include 写一行或逐行皆可）。
   **约束：末节必须永不跳过**（我们的 `_guard` 恒存在，满足）。方案 (c) 只有在"无跳过"时与 (b) 等价，
   且引入隐式删行规则，不采纳。
6. **`:else` 是否需要**：现在只有 `:if` / `:unless`，正反两个分支要写两段（或用 `<raw>` 拼）。
   8 份模版目前不需要，但 layout/技能节可能会。
7. **注释语法要不要**：`{{! … }}`（不产出字符）。写"为什么这么排"的说明很需要，但属新语法面。
8. **谓词物化的边界**：`when.<枚举>.<值>` 查表是否本期就用（还是只提供 `diy.cwd.is_fallback` 这类原子布尔）？
9. **trace / analyze 的 UI 形态**：左侧两个 view 的具体呈现（树粒度、是否显示字节数、是否可点跳转）未定。
10. **打包形态**：`@diy/template` 需要在 `vite.main/preload/serve.config.ts` 的 `pkgDeps` 里内联（M4 时处理）。
11. **属性值里的 `"` 不转义**：可能产出不良构 XML（值来自变量时）。是否限制/告警？
12. **内建名冲突**：`.index` / `.isFirst` / `.isLast` 与 include 参数同名时的优先级
    （当前规则：参数优先，未被参数覆盖时才退化到循环内建量）。确认即可。

---

## 9. M4 剩余工作（原型之后）

1. 注册表改造：`prompt-registry.ts` 用新引擎替换 `renderTemplate`，提供 `IncludeResolver`
   （relpath → 覆盖 > 内置 + 白名单 + `locked`/`fragment` 标记），保留预算与告警逻辑。
2. 8 份模版改写：标签内联、正文里的 `<` 转义（实测 2 处：`<pid>`/`<tid>`）、片段局部变量加 `.` 前缀、
   按第 8 节第 4/5 条决定末尾换行与分隔符形态。
3. `system.md` 顶层装配模版（锁定、不可覆盖），替代代码里的节顺序与拼接。
4. `PROMPT_ENGINE=legacy|dsl` 开关（一键回退）+ 真发一轮对齐 + 试验场两个 view 接 `analyze`/`renderWithTrace`。
5. 验收：`./sha.sh check` exit 0；等价值与真发 system byte-diff 为 0（或差异仅限已拍板的空白项）。
