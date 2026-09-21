# 系统提示词的「落点」研究 —— 缓存、动态上下文与三通道设计（2026-09-21）

> **状态：研究完成，实现未开始（下一轮）**。本文是初始需求 + 设计草案，供后续实现时直接接手。
> 触发问题：`diy` 的系统提示词是否有缺陷、是否要补内容。结论是「结构上有一处真问题」，另外三方参考实现给出了一套有实测数字支撑的落点判据。

---

## 0. 一句话结论

`diy` 现在把**每轮都可能变**的内容（`<task>` 正文、`<project_context>` 链）放在 **system 前缀**里，任务正文一改就整个前缀失配。参考实现的实测差距是 **未命中输入 ~14.7k tokens → ~300 tokens（约 50×）**。这不是「缺动态上下文」的小优化，而是长会话的主要成本项。

---

## 1. 研究基线（可复现）

三方参考实现已浅克隆并逐文件核对（`/tmp` 会在重启后消失，需要时按下面命令重取；commit 已记录以保证结论可复现）：

| 项目 | 仓库 | commit | 日期 |
|---|---|---|---|
| `pi` | `github.com/earendil-works/pi` | `890f920884f6d21fc7617d236ef9e1cc5d7a0ef8` | 2026-09-21 |
| `opencode` | `github.com/anomalyco/opencode` | `0e3dfd17694471b55f1cc0db578bff8920341e2d` | 2026-09-21 |
| `dsh` | `github.com/deepseek-ai/deepseek-harness` | `ddefc45fbc7f8e46dd73185e68295696d1297887` | 2026-09-17 |

```bash
mkdir -p /tmp/prompt-research && cd /tmp/prompt-research
git clone --depth 1 https://github.com/earendil-works/pi pi
git clone --depth 1 https://github.com/anomalyco/opencode opencode
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness dsh
```

`dsh` 的 `.agents/notes/` 有完整的架构决策记录（`implemented/` / `archived/` / `rejected/`），是本轮结论的主要来源；引用时用 `<repo>/.agents/notes/...` 相对路径。

---

## 2. 核心判据：三个通道，不是两个

| 通道 | 放什么 | 判据 | `dsh` 的实现 |
|---|---|---|---|
| **leading `system`（node 0）** | harness 身份 / persona / 工具指引 / 源码路径 / Web surface | 整会话**几乎不变** | `systemPrompt.section({order})`，`SECTION_ORDERS` 稀疏位 |
| **in-history `system` append** | prompt 偶尔变（plan-mode、skill 注册、persona shadow） | 变化**少** + 模型声明 `systemPromptUpdate:'in-history'` | `SystemPromptProjection`，`llm-deepseek/src/common/models.ts:12` 给 DeepSeek 开 |
| **尾部 `user` 消息** | `snapshot` / `notice` / `instructions` / `relay` / `recall` 五种 form | **每步都可能变**，或需逐次重算 | `systemPrompt.context()` + 直接 `createUserMessage({source:{form}})` |

`dsh` 的决策规则原话（`dsh/.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md`）：

> A deployment whose prompt changes on **most steps** is better served by moving that fact into **runtime context**.

`dsh` 实际落到 user 通道的生产者（`grep "form: '"`）：`agent-instructions`(instructions) / `time-context`(snapshot) / `tmux-context`(snapshot) / `session-reference`(recall) / `model-selection`·`tool-goal`·`tool-jobs`·`repeat-tool-reminder`·`plan-mode`(notice)。
走 `systemPrompt.context()`（→ 快照 user 消息）的：`sandbox-policy` / `user-approval` / `subagent`。

---

## 3. 理论依据：provider prefix cache 按前缀字节匹配

`dsh/.agents/notes/archived/feature/2026-07-30-current-sandbox-policy-context.md`：

> Every system prompt change costs the whole provider prefix cache. … when the bytes differ — a plan-mode section entering or leaving, a skill or tool guidance section registering, a changed `{{model}}` variable — the request's **message 0 changes** and the DeepSeek context cache misses from the first token. Long agentic sessions pay this repeatedly, and the **runtime-context snapshot design exists precisely because moving a changing fact out of the prompt was the only way to keep the prefix stable**.

> DeepSeek matches **complete prefixes**; changing the first wire message prevents reuse of the longer system-plus-history prefix.

### 跨 harness 调研（dsh 自己做的，同一 note）

| harness | 做法 |
|---|---|
| **Codex** | 权限建模成 **developer 角色的 `WorldState` section + 持久化 fingerprint**，只在状态变或历史丢了片段时才发 |
| **Hermes** | system prompt **一个会话内固定**，把变化的 skill/model/voice 通知 **prepend 到下一条 user 消息** |
| **pi** | 无同类内置状态（不可比） |
| **Claude Code** | 不可公开检视 |
| **Anthropic 公开缓存指引** | 变化的 per-request context 应放在**稳定缓存前缀之后** |

---

## 4. 实测数据（真实 provider，同 note 的 Web fixture）

| 方案 | 权限切换那一轮 | 后续稳定轮 |
|---|---|---|
| 变化事实放在 **dynamic system section** | cache-read **256** / uncached **14,691–14,782** | cache-read ≈14.7k–15.5k |
| 变化事实放在 **尾部 user 快照** | cache-read **14,848–15,872** / uncached **59–306** | — |

> The earlier real-provider Web fixture quantified the defect in the system-section version. The first `danger-full-access` and `workspace-write` requests each reported only **256 cache-read tokens against 14,691 and 14,782 uncached input tokens**. … Across the permission switches and four mutation steps, **cache reads were 14,848–15,872 tokens while uncached input was 59–306 tokens per request**.

**切换点未命中输入 ~14.7k → ~300，约 50×。**

in-history 支路的验证方式（观察口是 `cacheReadTokens`）：

> `packages/llm/llm-deepseek/tests/adapter.e2e.ts` … asserts that the appended request **reads more cached tokens** than the same conversation with a rewritten leading prompt; it skips when the variable is unset.

**边界（诚实标注）**：

- 缓存数字是**测量**；措辞/模型行为层面的收益**未被统计验证** —— 同 note 的 12-session 预注册实验两个阳性对照都失败（0 抢先拒绝），正式对照臂未跑，note 明确写 *"these experiments do not select or validate the current wording"*。所以：**缓存收益可信，行为收益未建立**。
- *"A proxy that rewrites or reorders system messages breaks the replacement semantics silently; the real-API e2e's cache-hit assertion is the detector."*

---

## 5. 四条语义约束（不只为缓存，同样决定落点）

**① in-history system 必须是完整 prompt，不能是 delta**

> Send only the changed sections as a delta. The model treats the latest system message as **the complete prompt**, so a delta would **silently drop every unchanged section**. Rejected on the model contract.

→ 两种自洽实现：`pi` 用 `sections` 命名补丁 + `getCurrentSystemMessage()` 回放成完整 prompt（`pi/packages/ai/src/utils/transcript.ts`）；`dsh` 直接 append 完整文本。

**② 顺序必须 system 在 user 之前**

> Place the system message after the step's user messages. Both positions sit after the cached prefix, but the model then reads the instructions **after** the input it must apply them to. Rejected.

**③ 清空要清「所有活跃 system 节点」**

> Clear only the latest system node. Empty nodes project to no message, so **an older prompt would become effective again**.

**④ node 0 受保护，后面的 system 不受保护**

`dsh/packages/core/session/src/surface.ts` 的 `assertSystemHeadRewrite`：替换范围覆盖 node 0 时，替换事件必须本身是 `system/message` 且精确覆盖该节点；`compaction-basic` 的 `selectCompactableRange` 锚在第一个非 system 节点 → **node 0 永不被压缩**，后续 system 节点可被遮蔽。

### user 通道的固有代价

`source: {kind:'plugin', plugin, form}` **不发给模型**（只用于日志/UI）。模型只能靠正文 frame 文案识别「这不是用户说的」：

- `opencode`：`<system-reminder>` + 提示词显式声明 *"They are NOT part of the user's provided input or the tool result."*（`opencode/packages/opencode/src/session/prompt/default.txt:78`）
- `dsh`：`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` / 清空时 `Current runtime context: none. Earlier runtime-context snapshots no longer apply.`

### in-history 的成本

> the appended node **costs its own tokens on every request in the series** until compaction shadows it.

→ 变化少 → append 划算（省 cache miss）；几乎每步都变 → 下沉 user（避免 token 堆积）。

---

## 6. 三方消息形态对照（供实现参考，不照抄）

| | 注入内容的 role | 标记（模型不可见） | 去重 | supersede 语义 |
|---|---|---|---|---|
| `pi` | `system`（`sections` 补丁）或自定义角色 → `convertToLlm` 映射成 `user` | 自定义 role（`custom`/`compactionSummary`/`branchSummary`） | 无 | 靠 frame 文案（`<summary>…</summary>`） |
| `opencode` | `system` 数组 join（最多 2 条）/ user 消息的 `synthetic:true` text part / tool result | `synthetic`、`ignored`（自家 schema，`packages/schema/src/v1/session.ts:106,401`） | 无（每步重算） | 靠 `<system-reminder>` + 提示词声明 |
| `dsh` | `system` 消息（head + in-history）/ 独立 durable `user/message` | `source:{kind,plugin,form,sections}` | `retained.text === snapshot` | 显式 supersede + 显式清空 + compaction 对账重建 |

> `synthetic` **不是** wire 字段（OpenAI/Anthropic/Gemini/AI SDK/pi 都没有），跨进程即消失（`opencode/packages/core/src/session/runner/to-llm-message.ts:132` 转换时丢弃）。

**provider 侧的 system 承载形状**（`dsh` 用 pi-ai 作为多 provider adapter，可直接参考）：

| provider | 形状 | 证据 |
|---|---|---|
| OpenAI Chat | `messages[0] = {role:"system"}` | `@ai-sdk/openai-compatible/dist/index.js:123` |
| OpenAI 推理模型 | `{role:"developer"}` | `pi/packages/ai/src/api/openai-completions.ts`（`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`） |
| Anthropic | **顶层 `system` 数组** | `pi/packages/ai/src/api/anthropic-messages.ts`（OAuth 时两块：Claude Code 身份 + 真 prompt） |
| Gemini | 顶层 `systemInstruction` | `pi/packages/ai/src/api/google-generative-ai.ts`（`collapseSystemMessages`） |
| Bedrock | 顶层 `system` + collapse | `pi/packages/ai/src/api/bedrock-converse-stream.ts:131` |
| legacy Completions | 折成裸文本前缀；第二条 system **抛错** | `@ai-sdk/openai-compatible/dist/index.js:1098-1111` |

---

## 7. `diy` 现状与差距

### 现状（`pkgs.ts/diy-app/src/main/prompts/defaults.ts`）

```
_system.md 顺序：identity → diy → project → task → rules → skills → guard
```

全部落在**一条 leading system**，每轮 `renderSystemDslTraced({globals})` 全量重算（`prompt-registry.ts` 的 `assembleSystem`）。

### 差距

| 段 | 变化频率 | 现在 | 应然 |
|---|---|---|---|
| `identity` / `diy` / `rules` / `_guard` | 几乎不变 | system ✅ | system（node 0）✅ |
| `project.md` 的 `<project_context>`（`chain` 内容随 AGENTS.md 变） | 偶尔变 | **system ❌** | in-history append 或尾部 user |
| `task.md`（`task.body` 用户随时编辑；`cwd.*` 随目录回退变） | **每轮可能变** | **system ❌** | **尾部 user 快照** |
| `skills.md` | 会话内基本不变（空则跳过） | system 可接受 | system |

**这不是「缺动态上下文」，而是「把易变内容放在了最贵的位置」。**

### `diy` 不需要的部分（本轮明确不做）

- `dsh` 的 projection / compaction 对账 / `startsSeries` / node 0 保护 —— 这些是为「多 system 节点 + 原位 append」服务的复杂度，`diy` 单条 system 不涉及。
- 审批模型、`plan_mode`/`ask` 协作 —— 用户已明确「单独设计，不放进本次提示词」。
- `suppressRuntimeContext` —— `diy` 无「每轮刷新的运行时事实」通道。

---

## 8. 初始需求（下一轮实现的验收依据）

> 写法遵循本仓惯例：需求级、人类语言，实现前先落成意图测试。当前可先作为 `prompt-registry` / `defaults` 的改造目标。

**R1 易变内容不得进入 leading system**
`task.body`、`cwd.note`、`chain[].content` 中任一发生变化时，渲染结果里 leading system 段必须**逐字节不变**。

**R2 易变内容用尾部 user 消息承载**
变化事实渲染成一条尾部 `user` 消息，正文自带 supersede 语义（`dsh` 式 `This snapshot supersedes earlier…`），使模型能撤销旧事实的效力。

**R3 内容未变则不发**
同一事实重复渲染出相同文本时，不再追加消息（避免 token 堆积）。

**R4 清空要显式**
易变事实全部消失时，必须发出显式的「清空」文案，而不是简单不发（否则旧快照继续在历史里生效）。

**R5 顺序：system 在前、snapshot 在 user 输入之前**
（若将来做 in-history system append，则必须落在该步 user 消息**之前**。）

**R6 预算口径不变**
`clamp(窗口 × 4B × 5%, 16KB, 64KB)` 的判定对象仍应是「本条请求实际发送的完整 system 部分」；新增 user 快照是否计入预算需在实现时明确并写进测试。

**R7 失败必须响亮**
快照渲染失败 / 变量缺失沿用现有严格策略（`missing-value` 等硬错），不得静默降级为空快照。

---

## 9. 设计草案（待验证，非最终）

### 9.1 模板层（`defaults.ts`）

把 `task.md` 拆成两半：

```
_system.md（node 0，仅稳定内容）
  identity.md
  diy.md
  project.md       ← 只留说明文字（「以下是按目录 scope 生效的项目规范」）
  rules.md
  skills.md
  _guard.md

snapshot（尾部 user，每轮可变）
  <task>…</task>              ← task.md 的正文部分
  <project_context>…</project_context>  ← project.md 的 chain 循环部分
  cwd 回退注意
```

新增模板如 `_snapshot.md`（锁定）负责拼装快照体，走独立渲染入口（不复用 `assembleSystem` 的 system 路径）。

### 9.2 代码层（`prompt-registry.ts`）

- 新增 `assembleSnapshot(home, projectId, opts)` → `{ text, sections }`，与 `assembleSystem` 并列，共用 `assembleGlobals`。
- `assembleSystem` 的 `globals` 收窄为稳定子集（`diy.*` + `skills`），`task.*` / `cwd.*` / `chain` 移出。
- `local-agent.ts` 的 `runTurn`：在 messages 前置 system 之后，按「未变不发 / 变了追加 / 消失发清空」三条规则维护快照。
- 快照状态机建议**先做最简版**：内存里记 `lastSnapshotText`，按内容比较决定 append；`diy` 的会话是单进程长驻，暂不需要 `dsh` 那套从 session log 重建的 projection（但要把这个取舍写进注释与测试）。

### 9.3 不做

- 不引入 `source` 持久化字段（`diy` 的 ops 流已有自己的 op 记录；模型可见性不依赖它）。
- 不做 in-history system append（需 provider 能力位；`diy` 现在的模型池是否支持未验证，留阶段 2）。

---

## 10. 验证方案

**行为层（意图测试，优先）**

- 新增 `tests/core/snapshot-stability.test.ts`：同一输入两次调用，leading system 逐字节相同 → 只有快照段参与 diff。
- 新增 `tests/core/snapshot-lifecycle.test.ts`：R3（内容未变不追加）、R4（清空发显式文案）、R5（顺序）。
- 扩展 `tests/fixtures/system.golden.txt`：leading system 的 golden 应**去掉** `<task>` / `<project_context>`，另出一份 snapshot golden。
- `tests/cli.intent.template.test.ts`：新增「改了任务正文后 leading system 不变」的用例。

**缓存层（可做则做，择机）**

- 若能拿到带 `cacheReadTokens` 的 provider 响应（`diy` 的 `llm.jsonl` 是否记录 usage 需先确认），做一次真实两轮对比：改任务正文前后，断言第二轮 cache-read 明显高于改造前。参考 `dsh` 的 e2e 断言形式（同一对话改 message 0 vs 追加尾部，比 cache-read）。
- 拿不到就只做行为层，并在文档里标注缓存收益**未在本机复现**。

---

## 11. 未决 / 留待下一轮

| # | 问题 | 说明 |
|---|---|---|
| 1 | 快照用「尾部 user 追加」还是「in-history system append」 | 取决于 `diy` 的模型是否支持 mid-convo system；需先查 provider 能力位（`diy` 用 AI SDK + `@ai-sdk/openai-compatible`，目前无能力位抽象） |
| 2 | `<project_context>` 放快照还是留 system | `chain` 只在 AGENTS.md 变化时变，频率远低于 `task.body`；可先只挪 `task.*`，观察收益 |
| 3 | 快照是否计入 64KB 预算 | 若计入，预算语义从「system 预算」变成「上下文预算」，需重命名与更新告警文案 |
| 4 | 快照与 `task.body` 编辑的时序 | `task.body` 可能在同一次会话中被用户改多次；快照的「变更」粒度按渲染文本比较即可，无需事件 |
| 5 | 是否要为快照补「分段归属」 | `dsh` 有 `sections`（UI 逐段归因）。`diy` 的试验场若要显示「这段来自快照」需要；可延后 |
| 6 | `skills` 非空后归哪边 | 若 skills 是会话内固定 → 留 system；若随会话加载变化 → 进快照 |

---

## 12. 与本轮已交付工作的关系

本轮（`prompt-lab` 分支）已完成的、与本文相关的基础：

- `@diy/template` 引擎（`pkgs.ts/diy-template/`）：**逐字节保真** + `<raw>` / 代码围栏逃生 + 严格报错（未知路径/参数不静默）—— 是本文「逐字节不变」类断言（R1）能成立的前提。
- `assembleSystem` 已是**真发与预览的唯一入口**（`prompt-registry.ts`），快照入口按同构方式并列即可，试验场可同时预览两者。
- 试验场的 trace / `analyze` 区间能力可直接复用给「快照来源」的高亮。

**本轮不动实现**，等下一轮按 §8 的需求落成意图测试后再改代码。
