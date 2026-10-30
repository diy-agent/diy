# @diy-agent/flow — 工作流内核（定义 DSL + 泳道容器 + 插件槽 + 参数层 + guard 求值 + 转移执行器 + 领域态序列化 + 轨迹投影）

> 全仓契约见**仓库根 `AGENTS.md`**。本文件只写**包内定位**与**去哪查**。
>
> 本包是**纯内核**：不 import `node:fs` / `electron` / `@diy-agent/app`，不触外部世界（插件副作用全在宿主给的函数体里）、不取时间（`at` 由调用方传入）⇒ 现在即可拆成单独项目。唯一依赖是 `@diy-agent/talk`（复用 `Event` 原语，`anchor = node` 指目标节点）。
>
> 需求真源是意图测试（共 180 例）：`tests/intent.flow.test.ts`（定义 / 容器 / 投影 26）+ `tests/intent.plugin.test.ts`（槽位 / 求值 / 执行器 43）+ `tests/intent.params.test.ts`（参数层 41）+ `tests/intent.domain.test.ts`（领域态一等 / 落盘 / 关联 / 终态 / params 入态 / 正路自足 / 不许换配置 49）+ `tests/examples.dev.test.ts`（**范例①**：开发工作流端到端含打回 21）。
>
> **##333 依赖反转（本包当前模型）**：**领域状态一等、`Event` 降为审计** —— 领域态 `FlowState` 自成真源、由 `advance` 产出、可落盘可读回；`Event` 只是进程内的进度通知 / 落盘后的审计材料（`seed.id` 给了才落，可清可丢）；内核**不编人类文本**（给 `Move` 结构化语义，渲染归宿主）。

## 正文在知识库，本节只留目录

原先写在下面的 50 条正文已整体迁进**项目知识库**（真源 `knowledge/facts/flow.yaml`，逐条带 `evidence.at: 25da9072:pkgs.ts/diy-flow/AGENTS.md:<行>` —— rev 钉住版本，本文件瘦身后行号仍可核）。
本文件 16 KB → 2 KB，那 14 KB 原本每次进 `pkgs.ts/diy-flow` 目录都要整篇注入 system。

| 主题 | 是什么 | 条数 |
|---|---|---|
| `flow.find` | 包内定位：哪个文件管什么 | 12 |
| `flow.define` | 定义 DSL 的结构约束：节点/边/泳道/打回/边界 | 4 |
| `flow.domain` | 领域态一等（##333）：`advance` 正路 / 落盘读回 / 审计适配 | 10 |
| `flow.exec` | 转移执行器：guard 求值 / 选边 / 宣布 / 终态 / 次序铁律 / 报错不降级 | 14 |
| `flow.plugin` | 插件槽与注册表：五个槽位 / 组合期校验 / `notify` 旁路 | 2 |
| `flow.params` | 参数层（L2）：节点上声明 / 类型与取值 / 插值 / 快照导出 | 8 |

**取法**（`diy facts` 任意目录可跑）：

- `diy facts brief flow.exec` — 该主题**全部条目 + 每条首句（≤80 字）**，据此决定展开哪条
- `diy facts get 'flow.exec#seq'` — 单条完整值（要精确 claim：`<subject>#<aspect>`）
- `diy facts brief flow.*` — 全包一次拿（6 主题约 14 KB，紧贴原文件体量）

⚠️ **改 `src/` 前至少 brief 一次 `flow.exec`（次序铁律、`step` 非幂等）与 `flow.domain`（正路必须产出完整真源、不许静默换配置）** —— 这两条破了要返工，且测试不一定拦得住。
