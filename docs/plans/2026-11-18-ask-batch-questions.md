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
AskQuestion { id; question; kind; options?; fields?; multiple?; allowFreeform?; note? }
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
- 呈现选**平铺**而不是翻页：卡在消息流里本来就会滚，翻页多一层状态、还会让"能一起看到"
  这个好处消失。
- 单题时 UI 与以前一致（不显示序号、不显示跳过）。

**HTTP 层**：`answerAsk` 带上服务端 `error` 文案（400 与 404 对用户要做的事不同）。

## 验证

隔离实例（`DIY2_DATA_DIR=build/lab/diy2-askbatch`、端口 5391）真跑：

1. 发一条"一次问我三个问题" → 模型**一次** `ask` 调用带 3 题，`pendingAsks` 一返回就是一个 askId / 3 题。
2. 少答一题 → `400 {"error":"还有 2 题没作答：q2、q3"}`；整批提交 → `200`；再答 → `404`。
3. 投递消息是一条：`回答提问（3 题）：\n- Q → A\n- Q → A\n- Q → A`。
4. 浏览器（playwright）：一张卡三题、`1/3 2/3 3/3`、每题勾一个 → `提交（3 题）` 可点 →
   提交后卡片转只读「已回答」，时间线上出现整批回答。

测试：`ask.test.ts` 补批量 / 少答 / 题 id 对不上 / 旧快照归一；`askDraft.test.ts` 重写
（分桶、跳过、整批装配）。`entity-runtime` + `entity-chat` + `chat-core` 244 例全绿，
`./sha.sh check` 全绿。

## 没做（留着的口子）

- 翻页 / 进度条（dsh、shadcn 的呈现）：平铺够用；真到十题再谈。
- 题目级 `required` 与"提交后才校验"：现在仍是"没答完按钮就是灰的"。
- `MAX_PENDING` 现在按**请求**计（一批算一个），不再按题计 —— 这是新语义，注释里说明了。
