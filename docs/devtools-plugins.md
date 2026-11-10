# 白盒能力的插件化（diy-app devtools → 可插拔模块）

> 2026-11-10 · 任务 ##518 · 用户判断：diy-app 把大量 **devtools 级** 的 UI 与逻辑编进主应用
> （上下文树、大脑、raw request log、成本、模型配置、压缩可视化…），系统因此过复杂。
> 目标：把这些能力做成**分离的插件**，先插到 dev 里当先验与调试手段，稳定后可选择性让 diy2 也加载 ——
> 多 app 共用同一套插件体系，由启动器配置。本文回答：**先搬什么、怎么搬**。

## 1. 关键发现（它决定方案，不是选型）

diy-app 的所有域都绑在**同一个 `ServerBinding`** 上（`services/api-impl.ts`：context / traffic /
agent / llmConfig / job / facts / journal / …），并通过 `services/rpc-port.ts` 暴露成 **h2c HTTP**。

⇒ **插件不必 import 任何 core**：插件 = **rpc 客户端**。宿主只提供「一个 `invoke`」：

```ts
export interface DevtoolsHost {
    invoke<T>(method: string, args?: unknown): Promise<T>;
}
```

| 宿主 | `invoke` 的实现 | 能不能跑 |
|---|---|---|
| diy-app（进程内） | 现有 ipcTransport / rpc 端口 | 现在就能 |
| dev（`_diy`，独立进程） | h2c rpc 客户端（读目标实例的 `app.port`） | 一行 fetch，无需依赖 diy-app |
| diy2（apps/chat） | 同上 | 同上 |

现成契约也有：`@diy-agent/workbench-plugin`（manifest + views + panel）+ workbench 的 `PageContribution`。
**所以「插件化」不是重写，而是：把页面改成只吃 `DevtoolsHost` + 线上形状，然后挂到任一宿主。**

## 2. 清单：diy-app 现有白盒能力（含规模）

| 能力 | 位置（renderer_solid/components） | 后端域 | 对 **diy2** 的价值 | 插件化成本 |
|---|---|---|---|---|
| **上下文树** | `ContextLabPage.tsx` 1252 行 | `context` | ★★★ diy2 用**同一套** provider/树，最需要「当前到底发了什么」 | 中（只读 + 展开） |
| **raw request log** | `TrafficPage/TrafficView/TrafficDrawer` 62+… | `traffic` | ★★★ 「这次请求到底长什么样」是 diy2 反复踩的点 | **低**（只读 + 分页） |
| **大脑 / 回合消息** | `BrainPage.tsx` 669 + `BrainMessages` | `agent` | ★★★ 看 bot 一轮里的真实消息序列 | 中（要订阅） |
| **用量 / 成本** | `UsagePanel.tsx` 1906 + `UsageTable` | 使用量聚合 | ★★ diy2 也要算钱 | 中（图表多；先做表） |
| **模型配置** | `ModelConfigPage.tsx` 1252 | `llmConfig` | ★★ diy2 要配模型 | **高**（写侧 + 校验） |
| **压缩可视化** | `CompactSessionPanel.tsx` 1273 + `CompactCutBar` | compaction | ★ 看压缩边界 | 高（与实现强耦合） |
| **提示词实验** | `PromptLabV4Page.tsx` 1513 | `template` | ★ 做提示词时有用 | 高 |
| **任务知识三层** | `TaskFactsView` / `TaskJournalView` / `TaskTree` | `facts` / `journal` / `task` | ★★ 看任务上下文从哪来 | 中 |
| **运维面板** | `JobRunsPanel.tsx` 838 / `OpsDownBar` / `InstancesPage` | `job` / `app` | ★ 长活/实例 | 低（但 dev 已有类似） |
| **通用调试件** | `JsonTree` / `JsonViewer` / `LogPanel` | —（纯 UI） | ★★ 每个插件都要用 | **低**（直接抽成共享组件） |

## 3. 建议顺序（每步可独立验收，不必一次搬完）

**P0（先做这三件，覆盖 80% 的调试需求）**

1. **raw request log**（`traffic`）：只读、按任务/步骤筛、分页、看单条全文。
   成本最低、价值最高，也顺带验证「插件只吃 rpc」这条架构判断。
2. **上下文树**（`context`）：只读树 + 每节 token 数 + 「本轮新增/被裁」。diy2 的 bot 走同一套
   `assembleFromProviders`，这个视图对它直接可用。
3. **大脑 / 回合消息**（`agent`）：一轮里的完整消息序列（含 tool-call / tool-result）。

**P1**：用量与成本（先表格版）、任务知识三层（facts / journal 只读）。

**P2**：模型配置（写侧，成本最高）、压缩可视化、提示词实验、运维面板。

## 4. 落地形状（三步，不需要新框架）

1. **`@diy-agent/devtools-protocol`**（纯类型 + zod，零 UI）：把用到的线上形状与方法名从
   diy-app 的 `shared/*` 里抽出来（只抽插件要用的那几个）。这样插件不依赖 diy-app 的包。
2. **插件包** `@diy-agent/devtools-<name>`：`renderer-react.tsx`（吃 `DevtoolsHost`）+ `manifest`。
   目录形状照 `chat-page`：`src/{client,store,renderer-react,ui}`。
3. **宿主接入**：
   - dev：`workbench` 里注册一个页签，`invoke` = 读目标实例 `app.port` 的 h2c 客户端；
   - diy2：同一份插件，`invoke` = 自身 rpc；
   - diy-app：`invoke` = 现有 IPC（作为过渡期兜底）。

## 5. 判据与风险

- **只搬「看」，先不搬「改」**：写侧（模型配置、压缩边界调整）等只读面稳定后再做；
  这样大页面（1900 行）可以按「视图」增量搬，不必整包重写。
- **缺方法就补 rpc，不搬实现**：插件化过程中发现 「这个页面直接读了 fs / 订阅了内部事件」，
  正解是把它需要的**能力**补成 rpc 方法，而不是把那段实现搬进插件。
- **测试**：插件按新口径写（`docs/test-ownership.md`）—— 假快照验渲染分支 + 进程内全栈验链路；
  rpc 调用全记录在 `calls` 里，没给 handler 的方法一调就抛。
- **风险**：这些页面与 diy-app 的 inner state 深度耦合（尤其 Brain / Compact），
  搬的时候要接受「先做一个能力子集」，而不是追求与旧页面 1:1。

## 6. 一句话

**diy-app 已经把所有能力都开成了 rpc** —— 插件化剩下的只是「把页面从『同进程 + 内部类型』
改成『`DevtoolsHost` + 线上形状』」。先搬 raw request log（最低成本、最高价值），
再搬上下文树与大脑；三件到位后，dev 与 diy2 就共用一个调试面。
