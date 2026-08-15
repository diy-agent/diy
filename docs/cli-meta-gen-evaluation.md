# 评估：CLI 从 RPC meta 生成信息的可能性

日期：2026-08-11　分支：`feat/cli-meta-gen`（worktree: `../diy-feat-cli-meta-gen`）

## 结论（先给答案）

**已成立，且已投入生产。** `@diy/rpc/cli` 的 `CliApp` + `core/_cli-meta.ts`（`cliArg`/`cliOption` zod 装饰）+ `cli/_parser.ts`（反射）就是「从 RPC meta 生成 CLI 信息」的实现，diy-app 的 `diy` 命令树、`--help`、参数解析全部由它驱动，无需单独维护 CLI 定义。

「可能性」不再是问题。真正的问题是一个**覆盖度 / 自动化程度**的评估：哪些信息能自动推导、哪些必须手写标注、还有哪些可以再自动一点。本文盘点现状并给出增量方向。

## 现状：三类信息来源

CLI 生成所需信息来自三个层次，自动度递减：

| 信息来源 | 内容 | 自动度 |
|---------|------|-------|
| router 树结构 | 命令树层级、分组、方法全名、streamMode | ✅ 全自动 |
| zod schema 类型 | 字段类型、默认值、可选性、布尔 flag、enum 值 | ✅ 全自动（`inferTypeName`/`inferDefault`/`isOptional`/unwrap） |
| cliArg/cliOption 标注 | 参数/选项的 desc、short、placeholder | ⚠️ 必须手写 |

diy-app 的 `api-def.ts`（334 行）里，命令定义走 router 树 + zod schema，只有「这个字段是 arg 还是 option」+「描述文案」是手写 `cliArg`/`cliOption` 标注的。

## 已全自动的部分（零标注）

- **命令树**：`_buildRouteTree` + `resolveCliTree`（`cliRootPath` 摊平/保留命名空间）→ 命令名、分组、层级全部来自 router 嵌套结构。
- **`--help` 命令列表**：`CliApp.showHelp()` 遍历树，命令名 + `cliDesc.description` + streamMode tag（非 unary 标注 `(server)/(client)/(bidi)`）。
- **单命令 `--help`**：`generateHelp()` 从 zod shape 反射——位置参数/命名选项、`<ph>`/`[ph]` 必选/可选括号、类型名占位符（`inferTypeName`）、默认值（`inferDefault`）、`[required]`、布尔 flag 无参数形态。**全部从 schema 推导**。
- **参数解析**：`parseArgv()` 同源——`--name`/`-s` 短名、`--name=value`/分离值、boolean 翻转、位置参数按序映射、数字预转。规则集中在 parser，不散落。
- **类型安全**：`createTypedClient` 从同一 router 推导客户端调用签名，CLI 与类型客户端共享单一事实源。

**单一事实源已达成**：改 api-def.ts 一处，CLI 帮助 + 解析 + TS 客户端类型同步更新，无第二处可漂移。

## 必须手写标注的部分（当前不可自动）

1. **arg vs option 划分**：同是 zod 字段，`cliArg()` 变位置参数、`cliOption()` 变命名选项。schema 类型本身不表达这个意图，**语义性标注，无法自动**。合理。
2. **`desc` 描述文案**：每个字段的中文说明。zod 没有对应字段，`cliArg({ desc })` 承载。合理（文案是人为编写）。
3. **`short` 短选项名**：`-p`/`-s`/`-a` 等。约定俗成的缩写，无法自动。合理。
4. **命令级描述**：`ProcedureMeta.cliDesc.description`。

## 发现的冗余 / 可再自动化的点

### ① zod `.describe()` 与 `cliArg.desc` 并存，描述信息双源

api-def.ts 里已经出现两种写法：
```ts
name: z.string().describe('组件名称'),          // zod 原生描述
title: z.string().cliArg({ desc: "任务标题" }), // CLI 标注
```
`generateHelp`/`showHelp` **只读 `cliArg.desc`，不读 zod `.description`**（已 grep 验证：`_parser.ts` 仅读 `_getCliArgMeta` 的 desc，`cli/index.ts` 只读 `cliDesc.description`）。

→ 机会：`generateHelp` 做回退链 `cliArg.desc ?? schema.description ?? ''`。这样 `z.string().describe('...')` 描述的字段，CLI help 自动带上，不必重复写 `cliArg({ desc })`。zod 的 describe 语义更通用（也用于 IDE/文档），复用即可避免双源。

### ② ProcedureMeta 的 `summary`/`description` 顶层字段未接入 CLI

meta.ts 里 `ProcedureMeta` 已有 `summary?`/`description?`，但 CliApp 只读 `cliDesc.description`。若有人用 `RpcSchema.unary({ summary, description })` 定义命令说明，CLI 不显示。

→ 机会：`showHelp`/`generateHelp` 回退链 `cliDesc?.description ?? def.description ?? def.summary ?? ''`，统一三个字段。

### ③ `inferTypeName` 覆盖不完整

`_parser.ts:19-27` 只处理 string/number/boolean/enum/array。object 回退 `'value'`，union 没处理。api-def 的 `output` 用 `.or()`（union）但那是输出；input 里目前无复杂嵌套，但 `agent chat` 的 `messages` 是 array。占位符只影响 help 观感，不影响解析——低优先。

### ④ 命令级 help 的「Usage」硬编码全名

`cli/index.ts:171` `usageParts = proc.path.split(".")`，未用 `cliRootPath` 裁剪后的短名。`cliRootPath` 下 `diy app task create` 的命令显示成 `Usage: diy diy.app.task.create ...`。**功能正确，展示不美观**——可用已计算的 `depth`/树路径生成用户实际输入的命令名。

## 结论与建议

**评估结论：CLI 从 RPC meta 生成信息不仅可行，已是现状。** 架构上它是「单一事实源」的正面范例，改 api-def 一处三端（help/解析/类型）同步，无重复定义。

增量方向按价值排序：
1. **（中价值，小改动）** zod `.description` 回退到 CLI help —— 消除双描述源，让 `describe()` 描述的字段自动进 help。
2. **（小价值，小改动）** ProcedureMeta `summary`/`description` 接入 showHelp 回退链 —— 统一命令描述字段。
3. **（观感）** 命令级 Usage 用 cliRootPath 裁剪后的短命令名。
4. **（低优先）** `inferTypeName` 补 object/union。

1、2 是「信息已有但没被消费」，属可立即落地的净增；3、4 是打磨。若认可方向，我可以在本 worktree 落地 1+2（+3），跑 diy-app 意图测试验证无回归。
