# ask 一次问一批问题（多问题交互对齐）

日期：2026-11-18　分支：`feat/ask-batch-questions`（worktree: `diy.worktrees/ask-batch`）

## 为什么要改

`dev app 构建对齐` 那次，模型连着调了三次 `ask`：

```
11:28:00  回答提问「环境变量口径怎么定？」： B. 全套 DIY2_* 前缀（keep）
11:28:01  回答提问「dev 的进程拓扑怎么改？」： A. 单端口
11:28:03  回答提问「本轮落地到哪一步？」： C. 全量（full）
```

时间线上三张卡、用户点三次提交、模型收到**三条独立的用户消息**。

根因不在卡片 UI，在协议：`AskRequest` 只能表达一个问题，`ask` 工具一次调用只能带一个
`question`。模型想问三件相关的事，除了连调三次没有别的选择。我们的 `fields` 也不是
"多问题"——它是同一个问题的参数表（`text | textarea | number`），每题自己的 `options`
塞不进去。

## 四家的做法（都是 batch）

| | 协议 | 呈现 | 提交 |
|---|---|---|---|
| dsh `ask_user_question` | `questions: AskUserQuestionItem[]` | 卡片占用输入框位置，pager 翻页；单选点一下自动前进 | 一次 Submit 整批；缺答案跳回第一个未答；`Skip` 写 `{selected:[]}` 保批完整；`BAD_ANSWER` 要求每题恰好一条 |
| opencode `question` | `questions: Prompt[]` → 通用 `Form` 的 `q0/q1…` fields | 单 field 直接提交；多 field 用 tabs + 末尾 Review 页 | 一次提交整表 `Record<key, Value>` |
| assistant-ui | `ToolApproval.display:'questions'` + `questions[]` | 整卡平铺 | 一次 Send；`complete` 要求每题都有答案（无 Skip） |
| shadcn `Questionnaire`（2026-08 新增） | `items[]` | 一步一题 + 进度 + Previous/Skip/Next | 原生 form 一次 `onSubmit`；required 校验 focus 第一个未答；`Skip` 记 `status:'skipped'` |
| Astryx | 无 ask/approval 组件（`Chat*` 全是展示层） | 只能用 `FormLayout`/`Field`/`Stepper` 自己拼 | 自带 |

**一致点**：一个请求带一批问题、一次提交、答案按题 id 回传。
**分歧点只在呈现**（翻页 / tab / 平铺 / 一步一题）。
两家独立收敛到「未答 ≠ 跳过」：dsh 用 `{selected:[]}` 占位，shadcn 用 `status:'skipped'`。

## 改了什么

**协议**（`@diy-agent/protocol`）

```ts
AskRequest { askId; questions: AskQuestion[]; note?; toolCallId?; owner?; at }
AskQuestion { id; question; kind; options?; fields?; multiple?; allowFreeform?; note?; required? }
AskAnswer { answers: AskQuestionAnswer[] }
AskQuestionAnswer { id; values?; fields?; text?; skipped? }
```

- 只有一种形状：一批至少一题。旧的单问题形状不再产出，只**读**（`normalizeAskRequest`
  把旧快照包成 `questions:[{id:'q1',…}]`，否则刷新后旧卡片渲不出来，而它们是用户回头
  核对"当时选了哪个"的唯一线索）。
- 答案表述搬到 `protocol/src/ask.ts`（`describeAnswer` / `askAnswerHeading` / `answerFor`），
  后端拼投递消息、前端渲染、工具回执共用同一份，不会出现三种表述。

**工具**（`tools/ask.ts`）

- schema 新增 `questions` 数组；`question` 保留为单题简写（模型少写一层数组，也免得
  一圈测试全改）。
- description 明确写「有好几件相关的事要定就一次问完，分开问会变成多张卡 + 多条问候」。

**闸门**（`entity-runtime/src/ask.ts`）

- `answer()` 从 boolean 改成三态 `AnswerOutcome`：`ok` / `no-such-ask`(404) /
  `bad-answer`(400，附"还有 N 题没作答：q2、q3")。混成一个 404 会让用户对着旧卡片重试。
- 校验只抓「漏题 / 多题 / 题 id 对不上」，**不深究内容**（选题和必填在界面上拦）。跳过
  必须显式 `skipped: true`，否则和"漏了"区分不开。
- 一题都凑不出来时不推卡片（不造空卡片）。

**UI**（`entity-chat`）

- 草稿从"一张卡三个字段"改成按题分桶：`AskDraft { answers: Record<qid, QuestionDraft> }`。
  不分桶的话，改第 2 题会把第 1 题打的字冲掉。旧草稿读成 `q1`。
- `AskCard` = 批次容器 + `QuestionBlock`（序号 `1/3`、输入、`跳过`/撤销）；第一次提交
  整批，提交按钮显示 `提交（3 题）`，提示"还有 N 题没答"。
- 呈现：**多题默认翻页**（顶部 `1/3` + 一条进度段，点某段直接跳；底部 上一题 / 跳过 /
  下一题，最后一页是 `提交（3 题）`），另有「全部展开」切回平铺。单选点一下自动前进
  （dsh 的手感）。已答的卡片永远平铺 —— 那时用户是回来核对"当时每题选了啥"。
  两种形态共用同一个 `QuestionBlock`，不维护两套渲染。
- **提交才校验**：按钮不再灰着（灰按钮不告诉你差哪题），点了没答完就跳到第一个缺口、
  把那几题标红，提示"还有 N 题没答（题目标了「必答」）"。计数是**派生**的，用户补一题
  提示就跟着减，不会停在旧数字上。
- 题目级 `required`（缺省 true）：`false` 的题标「（可选）」、可以直接翻过去、不拦提交；
  服务端也只要求必答题出现在答案里。
- 单题时 UI 与以前一致（不显示序号、不显示跳过、不翻页）。

**HTTP 层**：`answerAsk` 带上服务端 `error` 文案（400 与 404 对用户要做的事不同）。

## 一个只有真机才撞得到的问题：自动翻页 + 双击

单选点一下就翻页，换掉的是整块选项 —— 而手是跟着上一屏走的。双击、或触控板的惯性
第二下，会落在**新一屏的选项**上：用户根本没看那题，却替他把答案选了（playwright 的
`check()` 重试也是这个模式，一次点击写出了三题的答案）。

修法是在自动翻页后加 250ms 冷却（`advancedAt` ref），冷却期内的点击直接丢弃；
同时前进的条件从 `page + 1` 改成「这题**从没答过** → 现在答了」—— 用户回头改同一题的
答案时不该再被弹走。两处都在 `AskCard.tsx`，注释写清了为什么。

## 验证

隔离实例（`DIY2_DATA_DIR=build/lab/diy2-askbatch`、端口 5391）真跑：

1. 发一条"一次问我三个问题" → 模型**一次** `ask` 调用带 3 题，`pendingAsks` 一返回就是一个 askId / 3 题。
2. 少答一题 → `400 {"error":"还有 2 题没作答：q2、q3"}`；整批提交 → `200`；再答 → `404`。
3. 投递消息是一条：`回答提问（3 题）：\n- Q → A\n- Q → A\n- Q → A`。
4. 浏览器（playwright）：一张卡三题、只显示当前一题、进度 `1/3 → 2/3 → 3/3`；
   不答任何题直接提交 → 跳回第 1 题并标「必答」、提示"还有 2 题没答"；
   答第 1 题 → 自动前进；第 3 题（可选）留空 → 提交成功，卡片转只读、时间线出现整批回答。
5. 双击验证：点第 1 题选项后立刻再点一下 → 停在第 2 题且第 2 题**没有**被误答；
   等 300ms 后再点 → 正常前进。

测试：`ask.test.ts` 补批量 / 少答 / 题 id 对不上 / 可选题可缺 / 旧快照归一；
`askDraft.test.ts` 补可选题不拦提交、可选题未填不亮「已答」。265 例全绿，
`./sha.sh check` 全绿。

## 没做（留着的口子）

- 键盘导航（方向键翻题 / Enter 提交整批）：dsh 有，我们等真有键盘用户反馈。
- 题内的"其他"输入不参与 required 判定（选了选项就算答了），与四家一致。
- `MAX_PENDING` 现在按**请求**计（一批算一个），不再按题计 —— 这是新语义，注释里说明了。
