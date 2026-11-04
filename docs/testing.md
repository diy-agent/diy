# 测试分级与命名规范

> 结论先行：**不测真模型**。凡是有 LLM 参与的功能，一律用**录制的真实事件流**回放
> （黄金测试）。真模型只在「模型本身可用性核对」时出现，见 `docs/model-testing.md`。

## 为什么不能用真模型

| 问题 | 后果 |
|---|---|
| 非确定性 | 同一用例今天绿明天红，CI 不可信 |
| 成本 | 每次 CI 都烧钱 |
| 速度 | 一次流式响应 5–30s，几百个用例跑不完 |
| 网络 | 断网 / 限流 / 模型下架 → 与代码无关的红 |

真模型唯一该出现的地方：**核对某个模型能不能用**（发一条、看流式和工具是否都通），
这是一次性人工动作，写成文档（`docs/model-testing.md`），不是自动化测试。

---

## 五层分工

```
        ▲ 少  慢  贵
        │
   ⑤ E2E（CDP 真点击）            ~10 条 / app
   ④ 意图（CLI 驱动真链路）        ~50 条 / app
   ③ 黄金（LLM 事件流回放）        ~10 条 / 每个有 LLM 的包
   ② DOM（happy-dom 渲染）         ~30 条 / UI 包
   ① 单元（纯逻辑）                 ~200 条 / 包
        │
        ▼ 多  快  便宜
```

### ① 单元 — `*.test.ts`，node 环境

**测什么**：纯函数、状态机、数据变换、错误分支。
**不测什么**：DOM、网络、文件系统副作用（要测就 tmpdir）。
**写在哪**：被测文件同包 `tests/` 下，文件名与被测模块同名。
**例子**：`pkgs.ts/model/catalog/tests/catalog.test.ts`、`tests/core/llm-cost.test.ts`

### ② DOM — `*.dom.test.ts`，happy-dom 环境

**测什么**：组件渲染出的结构、class 名、事件回调、状态切换。
**不测什么**：真实布局（happy-dom 的 `getBoundingClientRect` 恒为 0）、真实点击命中。
**写在哪**：UI 包的 `tests/`。
**首行必须有** `// @vitest-environment happy-dom`。
**例子**：`chat-page/tests/block-renderers.dom.test.ts`

### ③ 黄金 — `*.golden.test.ts`，node 环境

**测什么**：**有 LLM 参与的功能** —— 工具调用链路、思考流、错误恢复、中断、重试。
**怎么测**：回放录制的 `LanguageModelV3StreamPart[]`，断言**下游行为**
（UI 收到了什么 block、状态机走到哪个状态、journal 写了什么）。
**不测什么**：模型本身的质量（那是产品评估，不是测试）。
**写在哪**：被测能力所在包的 `tests/`，fixture 在 `tests/fixtures/llm/`。
**例子**：`pkgs.ts/agent/bot/tests/tool-turn.golden.test.ts`

### ④ 意图 — `*.intent.test.ts`，node + Electron

**测什么**：**一条需求从 CLI 到结果的真链路** —— 文件头写「需求定义 = 本文件即契约」，
逐条编号列出判据；用例按判据编号。
**不测什么**：内部实现细节（那是单元测试的事）。
**写在哪**：app 级 `tests/`，命名 `cli.intent.<主题>.test.ts`。
**例子**：`apps/diy-app/tests/cli.intent.llm-cost.test.ts`

**意图测试与单元测试的分工**（diy-app 已建立的约定，值得沿用）：

| | 单元 | 意图 |
|---|---|---|
| 文件头 | 说明测什么函数 | **需求定义，逐条判据** |
| 依赖 | 纯内存 | 一次性 HOME + 真 Electron |
| 断言 | 输入输出 | 用户可见的结果（文件变了 / CLI 退出码 / UI 出现某元素）|
| 失败含义 | 实现错了 | **需求没被满足** |

### ⑤ E2E — `*.e2e.test.ts`，CDP

**测什么**：「装起来能不能真用」—— 按钮点得动、面板打得开、填完能提交。
**怎么测**：`@diy-agent/ui-testing` 的 `Driver`（`Input.dispatchMouseEvent`，不是 `element.click()`）。
**不测什么**：样式细节、边界态（那是 DOM 层）。
**写在哪**：app 级 `tests/e2e/`，默认不跑（`npm run test:e2e`）。
**例子**：`apps/chat/tests/e2e/bot-create.e2e.test.ts`

---

## 命名规范

```
<主题>.test.ts           ① 单元
<主题>.dom.test.ts       ② DOM
<主题>.golden.test.ts    ③ 黄金（LLM 回放）
cli.intent.<主题>.test.ts ④ 意图
<主题>.e2e.test.ts       ⑤ E2E
```

**目录**：

```
pkgs.ts/<域>/<包>/tests/
├── *.test.ts              ①
├── *.dom.test.ts          ②
├── *.golden.test.ts       ③
└── fixtures/
    ├── models.ts          模型元数据（不是事件流）
    └── llm/               ③ 的录制事件流，一场景一个文件
        ├── text-only.jsonl
        ├── tool-call.jsonl
        └── ...

apps/<app>/tests/
├── *.test.ts              ① 装配 / 架构守卫
├── cli.intent.<主题>.test.ts  ④
└── e2e/
    └── *.e2e.test.ts      ⑤
```

---

## 黄金测试：录制与回放

### 场景清单（每个都要有一份录制）

| 场景 | 文件 | 覆盖什么 |
|---|---|---|
| 纯文本 | `text-only.jsonl` | 最基础链路 |
| 思考流 | `think.jsonl` | reasoning 块收/展、折叠 |
| 工具调用成功 | `tool-ok.jsonl` | tool-call → tool-result 配对、状态点变色 |
| 工具调用失败 | `tool-error.jsonl` | 错误块渲染、不崩 |
| 多步工具 | `tool-multi-step.jsonl` | 连续 tool-call、step 边界 |
| 用户中断 | `abort.jsonl` | AbortError 分支、写 `aborted{source}` |
| 模型不可用 | `model-unavailable.jsonl` | `model_coming_soon` / 404 / 401 |
| 限流 | `rate-limit.jsonl` | 429 + 重试/退避 |
| 上下文溢出 | `context-overflow.jsonl` | 压缩触发、摘要回填 |
| 空响应 | `empty.jsonl` | done 但零内容 |

### 录制方式

**来源一（推荐）：生产流量日志**

`$DIY_HOME/local/<taskUri>/<session>/llm.jsonl` 已经在记每条消息（含 tool-call 块）。
它比事件流粗一档（消息级），但**保留了真实的 tool-call id / 时序 / 错误文本**。

**来源二：一次性真跑 + 抓流**

需要精确的 `LanguageModelV3StreamPart[]` 时，用包装过的 model 账号跑一次：

```ts
// tools/record-llm.mts（待建）
const parts: LanguageModelV3StreamPart[] = [];
const recording = new RecordingModel(realModel, (p) => parts.push(p));
await runScenario(recording, scenario);
writeFileSync(`fixtures/llm/${scenario}.jsonl`, parts.map((p) => JSON.stringify(p)).join("\n"));
```

### 回放方式

```ts
// tests/helpers/replay-model.ts（待建）
import { readFileSync } from "node:fs";
import { MockLanguageModelV3 } from "ai/test";

/** 回放一份录制的流；支持按 index 重放（同一 fixture 多次调用得到相同序列） */
export function replayModel(scenario: string): LanguageModel {
    const parts = readFileSync(`tests/fixtures/llm/${scenario}.jsonl`, "utf-8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return new MockLanguageModelV3({
        doStream: async () => ({ stream: new ReadableStream({ start: (c) => { for (const p of parts) c.enqueue(p); c.close(); } }) }),
    });
}
```

### 三条纪律

1. **fixture 里有真实 API key / 用户内容的部分必须脱敏** —— 录制后过一遍，把 key 换成 `$REDACTED`。
2. **fixture 要跟着协议走** —— `LanguageModelV3StreamPart` 的类型变了就重录，别手改。
3. **一个 fixture 只演一件事** —— 要测「工具成功后再失败」，录第三份 `tool-ok-then-error.jsonl`，不要在回放器里拼。

---

## 什么时候写哪一层（决策树）

```
这块代码有 LLM 参与吗？
├─ 有 ──► ③ 黄金测试（录事件流回放）
│          └─ 想验「真发出去长什么样」？→ 不写测试，写 docs/model-testing.md
└─ 没有
    ├─ 是纯函数 / 状态机 ────────────► ① 单元
    ├─ 产出 DOM 结构 ────────────────► ② DOM
    ├─ 是「一条需求」的完整链路 ──────► ④ 意图
    └─ 是「用户能不能点到」 ──────────► ⑤ E2E
```

**别写重复的**：同一件事只在**最能暴露问题的那一层**写一次。
例：`createBot` 的参数校验 → ①（纯逻辑）；`createBot` 写文件 → ④（真链路）；
`+新 bot` 按钮点得动 → ⑤（CDP）。**不要三层都写一遍。**

---

## 现状与差距（2026-11-04）

| 层 | 现有 | 差距 |
|---|---|---|
| ① 单元 | **438 个** `.test.ts` | 够 |
| ② DOM | **3 个** `.dom.test.ts` | **偏少**，UI 包应各有一份 |
| ③ 黄金 | **0 个** | **完全缺失** ← 最大空洞 |
| ④ 意图 | **58 个** `cli.intent.*`（全在 diy-app） | 新 app（chat/web/minimal）**一条没有** |
| ⑤ E2E | **1 个**（chat，刚加） | web / minimal 没有 |

**最近的教训**：「+新 bot 模型列表恒为空」在 48 个绿测试下长期存活 ——
它是 ③（有 LLM 参与）和 ⑤（真点击）的缺口，① 层再多也抓不到。

---

## 跑法

```bash
./sha.sh test                    # ① ② ③（快，默认）
npm run test:e2e                 # ⑤（要起 Electron，app 目录下）
cd apps/chat && ./sha.sh build && npm run test:e2e   # ⑤ 前置构建
```

④ 意图测试跟着各自的 app 跑（`apps/diy-app` 的 vitest.config 已含）。
