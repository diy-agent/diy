# 压缩装配管道 —— 实际范例（第二轮 / 形态乙）

> 状态：**草案**（##272 收口时预制；本轮**不动存储**）。目的：给「存储原文 / 筛选逻辑 / 沟通形式」的
> 具体样例，作下一任务规格。阅读顺序：① 四点修正 → ② 形式分层 → ③ 存储原文 → ④ 取法词汇 →
> ⑤ 执行逻辑与执行迹 → ⑥ 事件快照 → ⑦ 操作与沟通 → ⑧ 开放点。

---

## ① 四点修正（对上版范例）

1. **判别键用 `type`**（不用 `kind`）：本仓 `kind` 已专用于 op 流（`{op,kind}`）与事件账
   （`kind:"compact"`），新词汇一律 `type` 以免撞概念。既有事件账字段**不动**。
2. **同一取法只出现一次**：上版「最近 12 步」+「最近 2 步」是**子集冗余**（第二级什么都不加）。
   正确：同一取法出现两次**只在「不同粒度」时才有意义**（如"最近 3 轮全部"+"3~10 轮只留结论"），
   且更好的做法是**让粒度成为参数**，而非重复取法。
3. **Picker 产出的是「消息编号」**（= 该消息在全量历史里的第几条，0 起，升序编号），**按优先级排序**——
   不是内容、不是长度。`runPlan` 就照这个顺序逐条试着塞进预算。下文执行迹改用**消息本身**展示。
4. **形式不是三选一，是分层**（见 ②）。

---

## ② 形式分层（为什么不是 JS / 不是只有 CLI）

| 层 | 形式 | 职责 | 理由 |
|---|---|---|---|
| **真源（存储）** | **声明式数据**：YAML（人写）/ JSON（机写） | 唯一执行源，**同时是沟通与审计载体** | 可注释、可 diff、可 review、可静态校验、可回放 |
| **操作** | CLI · RPC · UI | 读 / 写 / **校验** / 预览 / diff | 入口，不是替身 |
| **生成** | agent 产**声明式数据**（自然语言→数据） | 组合/建议 plan，产出 diff 供人确认 | **绝不产码** |

**为什么坚决不用 JS**：正因为「这些数据**不光执行、还用来沟通**」——JS 不可 diff（逻辑藏在代码里）、
不可静态校验、非程序员看不懂、agent 生成后要执行还有安全风险。声明式数据三面通吃：机器执行、
人说/agent 说、审计回放。

---

## ③ 存储原文（`$DIY_HOME/auto-compact.yaml`）

### ③.1 缺省 = 等价现行（迁移态，**行为逐字节不变**）

```yaml
version: 2

auto:                                   # 什么时候自动压（可判定的确定事实，不含预测）
  mode: auto                            # off 不检测 / notify 只提示 / auto 检测到就压
  on: [system-context-changed, cache-expired, { window-over: 0.8 }]

history:                                # 发给模型的**历史消息**（压缩的作用对象）
  budget: 12 KB                         # 可占字节上限；0 = 清零。（`must` 项不受此限，见 ④）
  keep:                                 # 装配管道：**从上往下**生效，先声明的先挑
    - { type: ladder }                  # 缺省：纵向阶梯（用户>结论>过程>命令>结果，同层新先）

tool-result:                            # 工具结果「怎么显示」（与「选哪些」正交，独立演进）
  render: headtail                      # asis / headtail / callpath
  head: 3
  tail: 3
```

> `keep` 只有一级 `ladder` ⇒ 与现行「目标式预算单算法」**逐字节等价**（`defaultBudgetPlan`）。

### ③.2 实际场景：改 bug 的长会话

用户诉求（自然语言）：「别让 agent 忘了自己正在干什么；我说过的话都要在。」

```yaml
version: 2
auto:
  mode: auto
  on: [system-context-changed, cache-expired, { window-over: 0.8 }]
history:
  budget: 12 KB
  keep:
    - { type: steps, must: true, typeData: { n: 10 } }      # ① 最近 10 步 = 工作集（agent 正在做的事）—— 必保
    - { type: role,  must: true, typeData: { role: user } } # ② 所有用户发言 —— 必保
    - { type: ladder }                                     # ③ 剩余预算按重要度填（缺省兜底）
tool-result:
  render: headtail
  head: 3
  tail: 3
```

**为什么这样拆（正是你指出的冲突）**：
- 「最近几次操作重要」（agent 视角）→ ① `steps … must`：**必保、且不吃预算**。
- 「用户消息重要」（用户视角）→ ② `role user … must`：同样**必保**。
- 两股力量**不再争抢同一个预算**：必保层先各自钉死，`ladder` 只对**剩余预算**排序。
  —— 冲突从「一维算法里二选一」变成「两维各自声明，机器合并」。

---

## ④ 取法词汇（`type` 判别；可序列化、可校验）

**按 `rule.discriminated-union`**（判别键同级 = 公共字段；分支私有数据进 `<判别键>Data`）：

```ts
// 级 = 判别键 `type`（公共字段 must/limit 与 type 同级）+ 分支私有数据进 `typeData`
type Stage =
  | { type: "ladder"; must?: boolean; limit?: number }
  | { type: "role";   must?: boolean; limit?: number; typeData: { role: "user" | "assistant" | "tool" } }
  | { type: "recent"; must?: boolean; limit?: number; typeData: { n: number; role?: "user" | "assistant" | "tool" } }
  | { type: "steps";  must?: boolean; limit?: number; typeData: { n: number } };
```

- **与 `type` 同级** = 每个分支都有的公共字段：`must`（必保、不占 budget）、`limit`（最多几个单元）。
- **`typeData` 内** = 该 type **私有**的数据（`n` / `role`）——换 type 就换一整包 `typeData`。
- 判别键**用 `type`**（`kind` 已被 op 流 / 事件账占用，见 `rule.discriminated-union`）。

> 四个取法已够表达「工作集 / 用户话 / 按重要度」这三类诉求；**先不加更多**（简单优先，缺了再加）。

**映射到已落地的元件**（`compaction-plan.ts`）：`ladder→byLadder()` · `role→byRole()` ·
`recent→recentMessages()` · `steps→recentSteps()` · `must:true→exemptStage()` · 否则 `stage()`。

---

## ⑤ 执行逻辑与执行迹

### ⑤.0 坐标：两套「第几行」，**别混**（回答「编号是否可行」）

压缩选择的坐标**只有一套**，且它**与 role 无关**——就是「**消息历史里的第几行**」：

| 坐标 | 是什么 | 谁用 | 是否含投递期注入 |
|---|---|---|---|
| **`logLine`（日志坐标）** | **块树全量投影**的下标 + 1 = `llm.jsonl` **物理行号** | **压缩选择 / 注记 `kept` / byLine 回取** | **否**（runtime / 摘要**不在**此处） |
| `deliveryIndex`（投递坐标） | 最终发给模型的 `messages` 下标 | 只用于展示「这次到底发了什么」 | 是（含 `[..., {user:runtime}, {user:本轮输入}]` 及相邻 user 合并） |

**关键事实（查证 `local-agent.ts` 而来）**：
- runtime 容器（上下文树的易变部分）**不进块树、不进 `llm.jsonl`**；它在**投递期**作为尾部
  `user` 消息拼进去（`withRuntime`），与本轮输入组成**相邻两条 user**，再被 `normalizeUserRuns`
  **合并成一条**发给 provider。—— 这正是你说的「同一次请求可能发出 2 个 message」。
- 但**压缩选择不看投递坐标**：它在**块树投影**上做，编号 = 该投影下标 = `llm.jsonl` 行号
  （每行带 `turn` / `step` 索引位）。所以「runtime / 合并」**不干扰编号**，`kept: [[a,b]]` 稳定可回取。
- 因此**不需要** `step+messageId` 做选择坐标：选择只需要「在块树消息序列里的位置」，下标就够；
  且它是**唯一**那套坐标（注记 byLine 已按它取行）。role（user/assistant/tool）**只是该行的属性**，
  不是坐标维度 —— 「不关是 tool / user / 助理，只是第几行」的判断**正确**。

> ⚠️ 若将来要把「选择结果」映射到「最终发出那份」，才需要 `deliveryIndex`；那是**展示**用途，
> 必须与 `logLine` 显式区分命名（否则就是上版范例的混乱根源）。

### ⑤.1 逻辑（`runPlan` 语义；逐级 = 逐声明）

```
run(all, plan):
  ctx = 分类(all) + 配对(all) + 成本(all)         # 一次算清
  remaining = plan.budget                        # 仅「非 must」级消耗它

  for stage in plan.keep:                        # 级序 = 优先级序
    for i in stage取法.picks(ctx):               # 取法给**有序**候选（编号）
      if i 已入选 or 是 result: continue          # 去重 / result 只随其 call 入选
      add = [i]; c = cost[i]
      if 是 call: { ri = 该 call 的 result; if ri: add += ri; c += cost[ri] }   # 配对铁律
      if stage.must:  入选(add)                    # 必保：不碰 remaining
      else:
        if c > remaining: continue               # 放不下就跳（后面可能更小）
        入选(add); remaining -= c
  return 升序入选 + 连续区间 + Σ成本
```

### ⑤.2 执行迹（拿 ③.2 跑一个小会话，用**消息**展示）

会话（`#编号 · 轮/步 · 类型`）：

| # | 轮/步 | 角色·类型 | 内容 |
|---|---|---|---|
| 0 | t1/– | user | 开场问 |
| 1 | t1/s1 | call | bash#1 | 
| 2 | t1/s1 | result | #1 输出 |
| 3 | t1/s2 | conclusion | 结论 1 |
| 4 | t2/– | user | 第二问 |
| 5 | t2/s1 | call | bash#2 |
| 6 | t2/s1 | result | #2 输出 |
| 7 | t2/s2 | call | bash#3 |
| 8 | t2/s2 | result | #3 输出 |
| 9 | t3/– | user | 第三问 |
| 10 | t3/s1 | call | bash#4 |
| 11 | t3/s1 | result | #4 输出 |
| 12 | t3/s2 | conclusion | 结论 3（最新）|

跑 ③.2（`budget=12KB` 足够全是小消息，故最终全留；此处**只看各级挑了谁**）：

| 级 | 取法 | 有序候选（编号） | 挑了谁 |
|---|---|---|---|
| ① `steps 10 must` | 最近 10 步的消息 | `12,10,11,7,8,5,6,3,1,2` | 12、10+11、7+8、5+6、3、1+2 —— **不占预算** |
| ② `role user must` | 所有用户消息 | `9,4,0` | 9、4、0 —— **不占预算** |
| ③ `ladder`（非 must） | 阶梯序 | user(已留) → conclusion(已留) → call(已留) → result(已留) | 无新增（都被前面挑走了） |

**最终 `kept = [0,1,2,3,4,5,6,7,8,9,10,11,12]`（全留）。**

**把 `budget` 调小到 6KB** 才见差异：①②（必保，不占预算）仍全留；
③ `ladder` 的 `remaining` 变小，**只影响「①②没覆盖的**旧工具往返**」** ——这正是设计意图：
**必保层（工作集 + 用户话）绝不因预算被挤掉**，被牺牲的只是「剩余的、可回取的细节」。

> 对照**缺省单级 ladder**同预算：它会先全 user、再全 conclusion，**工具往返后到、最旧的被丢**——
> 差别就体现在「工作集（最近 step）先于一切被钉死」这一步。

---

## ⑥ 事件快照（`.compact.jsonl`；执行 + 审计）

事件记**当时生效的整条 plan 原文**（不是只记 `budget`），这样「这次为什么留这些」可回放。

```json
{
  "kind": "compact",
  "v": 3,
  "id": "2026-10-08T12:30:00.000Z",
  "ts": "2026-10-08T12:30:00.000Z",
  "by": "auto",
  "trigger": "windowOver",
  "plan": {
    "budgetBytes": 12288,
    "keep": [
      { "type": "steps", "must": true, "typeData": { "n": 10 } },
      { "type": "role", "must": true, "typeData": { "role": "user" } },
      { "type": "ladder" }
    ]
  },
  "size": { "before": { "bytes": 61230 }, "after": { "bytes": 11890 } },
  "kept": [[1, 8], [20, 26], [41, 42]],
  "dropped": [ /* 摘要 */ ]
}
```

> 读侧宽松：旧账无 `plan` ⇒ 用 `defaultBudgetPlan`（= 现行算法），无需迁移。

---

## ⑦ 操作与沟通

### ⑦.1 CLI（入口；读写/校验/预览）

```bash
diy compact plan get  <uri>            # 打印当前 plan（真源原文，可读可 diff）
diy compact plan set  <uri> --file p.yaml   # 写入（校验后归一）
diy compact plan check <uri>           # 校验：未知取法 / must 项体积 / 预算非负 …
diy compact preview   <uri>            # 按当前 plan 现算：保留/丢弃、省多少（不写账）
```

### ⑦.2 agent 沟通（自然语言 → 数据 → 人确认）

```
用户：记得把我说的都留着，还有你最近干的别忘。
agent：（产出 plan 修改建议，不直接生效）
   + - { type: steps, must: true, typeData: { n: 10 } }
   + - { type: role,  must: true, typeData: { role: user } }
     - { type: ladder }
   「新增两级必保（不吃预算）；ladder 继续兜底。」
用户：行。
→ 写入 auto-compact.yaml（一次可 diff、可回退的编辑）
```

数据**既是**机器执行的东西，**又是**人和 agent 对话的媒介——同一份文本，三种用法。

---

## ⑧ 开放点（下轮开工前敲定）

- **必保层撑爆硬上限**？`must` 全留可能超窗口 ⇒ 需**兜底闸**（超窗口某比例强制截断，按 `must` 内序倒着丢）。
- **`limit` 的单位**：单元（call+result=1）还是「轮」？`recent`/`role` 级是否也按轮计？
- **`must` 项之间**要不要有序（现在 = 声明序）；截断时从**最后一条** `must` 开始丢？
- **粒度参数**：将来若要「最近 3 轮全部 + 3~10 轮只留结论」，怎么把「粒度」做成参数而非重复取法？
- **agent 产出 plan 的可靠性与测试**：自然语言→plan 的生成器如何测、如何防幻觉？
- **一致性悖论**：从「算法黑箱」转为「可协商」——需要「装配结果预览 + 理由说明」的交互，而非只给结果。
