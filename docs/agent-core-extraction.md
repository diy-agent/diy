# diy-app 核心逻辑分检清单

> 目的：diy-app 即将废弃，但它积累了 **160+ 处实测教训**（`local-agent.ts` 一个文件就 79 处）。
> 这些是**协议约束和边界情况**，跟着 app 一起消失 ⇒ 新架构必然重踩。
> 本文逐项判定：**留 / 迁 / 已在**，并给出迁的顺序。

## 判据（什么该迁）

| 类型 | 例子 | 去哪 |
|---|---|---|
| **协议约束**（上游铁律） | reasoning_content 必须回传 | ✅ 迁公共包 |
| **领域算法**（与 app 无关的计算） | 上下文压缩、值归一 | ✅ 迁公共包 |
| **边界情况处理**（实测出来的坑） | 未知模型上限是 null 不是 0 | ✅ 迁公共包（带测试） |
| **app 编排**（串起各能力的胶水） | local-agent 的 turn 循环 | 部分迁（内核），壳留 app |
| **平台依赖**（Electron / 窗口 / IPC） | window-ops、rpc-port | ❌ 留 app |

**一句话判据**：这段逻辑换个宿主（web / CLI / 另一个 app）还成立吗？成立就该迁。

---

## 一、已迁（对照组）

| 逻辑 | 原位置 | 现位置 | 证据 |
|---|---|---|---|
| reasoning_content 兜底 | `services/reasoning-replay.ts` | `pkgs.ts/model/provider` | `*.repro.test.ts`（15 次真实 400）|
| 工具循环 | 自己写的 `runToolLoop` | ai-sdk `streamText` | `session/types.ts:108-116`（##514）|
| 后台 run 账本 | `services/run-registry.ts` | `@diy-agent/jobs` | 该文件只剩装配 |
| 上下文压缩 | `local-agent.ts` 部分 | `@diy-agent/bot/compaction` | — |

---

## 二、该迁（按优先级）

### P0 · 协议约束（不迁必重踩）

| # | 逻辑 | 位置 | 坑 |
|---|---|---|---|
| 1 | **未知模型上限 = null，不是 0** | `local-agent.ts:349` | 0 会让 `streamText` 直接拒 |
| 2 | **模型不可用分类**（401/403 误判） | `model-unavailable.ts` | 任务 #87 已记此 bug |
| 3 | **工具输出截断**（头尾保留 + marker + 落盘） | `tool-output.ts`（##127） | 全文塞 context 会爆 |
| 4 | **推理只能裁短不能裁空** | `compaction.ts:213` | 裁空 = 没传 = 400 |

### P1 · 领域算法

| # | 逻辑 | 位置 | 规模 | 说明 |
|---|---|---|---|---|
| 5 | **块协议**（区间即树，id 即节点） | `local-blocks.ts` | 1354 行 | 16 处实测注释 |
| 6 | **事实库**（读写 + 变体解析） | `facts-store.ts` | 1281 行 | 13 处 |
| 7 | **事实投递**（按 env/paths 选变体） | `facts-context.ts` | 469 行 | — |
| 8 | **缓存提示**（cache-hint） | `cache-hint.ts` | 358 行 | 必须由 setLimits 显式失效 |
| 9 | **冷读勘验**（进程怎么死的） | `interrupted-cause.ts` | — | 读盘侧纯函数 |

### P2 · 编排内核（拆法还没定）

| # | 逻辑 | 位置 | 规模 | 问题 |
|---|---|---|---|---|
| 10 | **turn 循环 / steer / 中断** | `local-agent.ts` | **6364 行** | 79 处坑，但和 Electron/窗口耦合深浅不明 |
| 11 | **提示词注册表** | `prompt-registry.ts` | 695 行 | 模板引擎已在 `@diy-agent/template` |
| 12 | **API 定义/实现** | `api-def.ts` + `api-impl.ts` | 5848 行 | 可能大部分该拆成各包自己的 API |

### ⛔ 不迁：已停用的实验

| 逻辑 | 位置 | 为什么不迁 |
|---|---|---|
| **agent-guard**（bash 自杀护栏） | `services/agent-guard.ts`（246 行） | **2026-10-02 主动停用**：判据是命令文本，分不清「宿主进程」与「agent 自己起的实例」，实测会误拦（连 agent 自己起的 worktree 实例都收不掉）。迁过去等于把已知缺陷搬进新架构。 |

**但它记录的知识仍然值钱** —— 2026-09-12 的事故：agent 执行 `pkill -9 -f electron`
把宿主的 GPU / NetworkService / Renderer 子进程全杀了 → 窗口白屏，SIGKILL 无法捕获，
事后无法补救。结论「**只能在执行前拦截 + write-ahead 审计**」是对的，只是判据还没找到。

**重新启用的前提**（原注释里记着）：判据能区分宿主 vs agent 自建实例，或改走沙箱。
到那时再从 `apps/diy-app` 迁到 `@diy-agent/tools`（它只依赖 `os`，迁移成本很低）。

### 不迁（app 特有）

`window-ops` · `rpc-port` · `instances` · `process-scan` · `crash-reporting` ·
`remote.ts` · `hub.ts` · `room-service` · `local-layout-migrate` · `warm-wait`（Electron 睡眠）

---

## 三、local-agent.ts 特别说明（6364 行 / 79 处坑）

**不要整块迁**。它的内容明显分三层：

| 层 | 内容 | 处置 |
|---|---|---|
| **协议层** | 消息归一、reasoning 回放、上限计算、错误分类 | 已部分迁；剩余按 P0/P1 逐项迁 |
| **编排层** | turn 循环、steer 合并、并发队列、ops 订阅 | 先抽成 `@diy-agent/turn`（纯逻辑，注入时钟/存储/LLM） |
| **平台层** | 窗口、IPC、实例注册 | 留 app |

**做法**：不要一次拆完。**每抽一块，先把它那几条 `⚠️` 注释变成 `*.repro.test.ts`** ——
坑的判据先固定下来，代码怎么挪都不会丢。

---

## 四、执行方法（每个迁移项都照这个走）

```
1. 读源码 + 摘出该文件所有 ⚠️/实测 注释（那就是验收清单）
2. 把**能独立成纯函数的**部分抽出来，放到目标包
3. 每条 ⚠️ 写成一条 *.repro.test.ts 或 *.test.ts（先红后绿）
4. 原位置改成 re-export（保住调用点，如 reasoning-replay 的做法）
5. 跑两边全量测试
6. 留一条迁移记录在本文（「已迁」表）
```

**不做**：不为了「结构好看」而大重构。有测试守行为的迁移才是安全迁移。

---

## 五、建议顺序

```
第 1 波（协议约束，1~2 天）
  #1 模型上限 null ・ #2 模型不可用分类 ・ #3 工具输出截断
  → 都是小文件、纯逻辑、坑明确，风险最低

第 2 波（领域算法，3~5 天）
  #5 块协议 ・ #6 事实库 ・ #9 冷读勘验
  → 大一些但边界清楚，测试可覆盖

第 3 波（编排内核，需先设计）
  #10 turn 循环 —— 先只抽「纯状态机」部分，平台能力全注入

第 4 波（可选）
  #11 提示词 ・ #12 API 层
  → 这两个和新架构的设计强相关，最好等新 app 稳定后再定
```
