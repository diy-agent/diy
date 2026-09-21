# @diy/template

diy 提示词模版引擎：XML 控制节点 + 属性路径，**无表达式、不转义、逐字节保真**。
零依赖、纯 TypeScript、Node / 浏览器 / Electron 通用（不认识文件系统，include 由宿主注入 resolver）。

设计与需求见 [`SPEC.md`](./SPEC.md)；意图测试见 [`tests/intent.template.test.ts`](./tests/intent.template.test.ts)。

## 快速开始

```ts
import { render } from '@diy/template';

render('<diy>{{diy.cli}}</diy>', { globals: { diy: { cli: '/repo/diy.sh' } } });
// => '<diy>/repo/diy.sh</diy>'
```

## 语法

```xml
{{diy.cli}}                                   globals 取值（点路径）
{{.task.title}}                               动态作用域取值（. 前缀：循环信封 / include 参数）
{{.x.value}} {{.x.index}} {{.x.isFirst}}     循环信封（:for={{集合}} :as="x"）
\{{   \<   <raw>…</raw>                       逃生舱：输出字面量 {{ / < / 整段原文

<template :if={{p}}>…</template>              条件
<template :if-not={{p}}>…</template>          取反（cwd 回退提示这类场景）
<template :for={{p}} :as="x">…</template>     循环（:for = 集合，:as = 名字）
<template :include="./layer.md" path={{.p}}/>    片段调用（非控制属性即参数，动态作用域硬隔离）
<enabled :if={{p}}>true</enabled>             控制属性也可挂在输出元素上
<diy>…</diy>                                   任意标签原样进提示词
```

**属性值只有两种形态**（引号只是边界，不改变语义 —— 与正文同一条规则）：

| 写法 | 含义 |
| --- | --- |
| `attr={{x}}` | 整值单个插值 → **表达式**，取值保留原类型（数组仍是数组） |
| `attr="text"` | 字符串字面量 |
| `attr="共 {{n}} 项"` | 含插值的文本 → 字符串 |
| `attr={{x}}b` | ❌ 裸值里插值后不能跟内容（用引号：`attr="{{x}}b"`） |

## 硬规则

- **不转义、不 trim、不删行** —— 控制标记不占空间（独占一行时该行连换行都不产出），其余逐字节进提示词。
- 只有 `<template` 是控制节点，其它标签原样透传 ⇒ 提示词里的 `<project_instructions>` 零转义。
- 未知路径 / 未知参数 / 少传参数 / 取到 `undefined` / 写表达式 / 集合被插值 → **一律报错**（带行列），绝不静默。
- 宿主可声明**变量契约**（`analyze(src, { vars })`）：静态校验未知路径、`:for` 拿标量、`{{}}` 插集合。
- include 必须走宿主 resolver（覆盖 > 内置 + 白名单），带循环检测、深度上限、锁定模版保护。

## API

```ts
parse(source, { file }): Node[]                          // 语法错抛 TemplateError（带 line/col）
render(source, { globals, dynamic }, { resolver, file, locked, maxDepth }): string
renderWithTrace(...): { text, trace }                    // 模版结构树：节点字节数 + :if 真假与原因
analyze(source, { file }): { paths, globals, dynamics, includes, conditions, loops }
```

## 开发

```bash
cd pkgs.ts/diy-template
npx vitest run          # 58 例（意图 36 + 边界 22）
npx tsc -p tsconfig.json --noEmit
# 全仓检查（含产物护栏）：在仓库根跑 ./sha.sh check
```
