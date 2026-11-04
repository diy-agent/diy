# 测试分级与命名规范

> 两条结论先行：
> 1. **测试是二维的** —— 「层级」（测多大范围）× 「手法」（用什么冻结不确定性）。
>    DOM 测试 = 单元层 + happy-dom 环境，不是独立层级；黄金测试 = 手法，不是层级。
> 2. **不测真模型**。有 LLM 参与的功能一律**回放录制的事件流**（黄金 fixture）。
>    真模型只在「模型可用性核对」时出现，见 `docs/model-testing.md`。

---

## 维度一：层级（测多大范围）

| 层 | 后缀 | 环境 | 测什么 |
|---|---|---|---|
| **单元** | `*.test.ts` / `*.dom.test.ts` | node / happy-dom | 一个模块。**DOM 测试只是换了环境的单元测试** |
| **集成 / 意图** | `cli.intent.<主题>.test.ts` | 真 Electron + 一次性 HOME | 跨模块，一条需求从 CLI 到结果 |
| **E2E** | `*.e2e.test.ts` | CDP | 真实进程里用户能不能点到 |

⚠️ `*.dom.test.ts` 是**环境标记**（happy-dom），不是层级标记 —— 它仍是单元测试。
首行必须写 `// @vitest-environment happy-dom`。

---

## 维度二：手法（冻结不确定性的工具）

| 手法 | 冻结什么 | 在哪用 |
|---|---|---|
| stub / fake | 依赖对象 | 任意层 |
| **clock mock** | 时间 | 任意层 |
| **golden（录制回放）** | **LLM 事件流、HTTP 响应、协议报文** | 任意层 |
| snapshot | 渲染结构、提示词 | 单元 / DOM |

**黄金测试和 clock mock 是同一个位置的东西** —— 都是「把某个非确定来源拍平成可重放的 fixture」。

### 矩阵：同一份 fixture 能被四层复用

| | 真依赖 | stub | **golden 回放** | clock mock |
|---|---|---|---|---|
| 单元 | 纯函数直接测 | 注入假 store | `toBlocks(fixture.textOnly)` | 测超时逻辑 |
| DOM | 测渲染 | 假 gateway | `replay(x).asModel()` → 断言渲染出黄点 | 测「思考中」延时 |
| 意图 | 真 CLI + 真文件 | — | 回放 abort → 断言 journal 写 `aborted{source}` | 测退避窗口 |
| E2E | 真点击 | — | 回放后断言界面真的变了 | — |

---

## 黄金测试：用环境变量装配真模型

### 唯一入口

```bash
export DIY_TEST_LLM_BASE_URL="https://opencode.ai/inference/go/openai/v1"
export DIY_TEST_LLM_KEY="$OPENCODE_API_KEY"
export DIY_TEST_LLM_MODEL="deepseek-v4.1-flash"
```

**测试代码只认这三个变量，不读数据根、不用 bot 配置。**

理由：bot 配置是**运行时状态**（会被 UI 改、被 seed 覆盖、随版本迁移），
拿它当测试输入 ⇒ 测试结果取决于「本机当前怎么配的」。env 是**测试自己的输入**。

```ts
import { testLlm, testLlmConfig } from "@diy-agent/test-llm";

if (!testLlmConfig()) return it.skip(missingEnvText());  // 缺 env 跳过，不变红
const { model } = testLlm();
```

`testLlm()` 会自动给 opencode.ai 加 `x-opencode-session` 头（否则 400 `MissingSessionID`），
额外头用 `DIY_TEST_LLM_HEADERS='{"k":"v"}'`。

### fixture 是源码，且在 gen/ 里

```
pkgs.ts/test/llm/tests/fixtures/llm/
├── index.ts                       手写 · 只汇总导出
└── gen/                           **自动生成 · 文件名一律 *.gen.ts**
    ├── text-only.gen.ts
    ├── tool-ok.gen.ts
    ├── tool-error.gen.ts
    ├── tool-multi-step.gen.ts
    ├── think.gen.ts
    ├── abort.gen.ts
    ├── model-unavailable.gen.ts
    ├── rate-limit.gen.ts
    ├── context-overflow.gen.ts
    └── empty.gen.ts
```

**`gen/` + `.gen.ts` 这个组合就是「别手改」的唯一标记** —— 一眼看出哪份是生成物。
gen/ 进版本库（fixture 是测试资产，要保证任何机器回放一致），但与手写代码分开住：
review 时看 gen/ 的 diff 就知道「模型行为变了」，不会和业务改动混在一起。

| | 外部 jsonl | **代码内 .ts** |
|---|---|---|
| 协议变了 | 静默失效 | **编译报错** |
| 存储版本变了 | 读不出来 | **完全无关**（不读任何数据根） |
| review | 一大段 JSON diff | 带类型的结构 diff |

### 录制

```bash
node --experimental-strip-types tools/record-llm.mts list        # 看哪些已录
node --experimental-strip-types tools/record-llm.mts tool-ok     # 录一个，覆盖写 .ts
node --experimental-strip-types tools/record-llm.mts text-only --dry   # 只看不写
```

**录制必须走 provider 层**（`model.doStream()` 的原始 part），不能录 `streamText().fullStream`
—— 后者是 ai-sdk 抽象层（`start` / `start-step`），与 `MockLanguageModelV3` 期望的
`LanguageModelV3StreamPart`（`stream-start` / `text-start` / `finish`）**不是同一套**，
录错层回放会抛 `Unhandled chunk type: start`（实测踩到）。

### 一个关键分工

**provider 层录制只含模型输出，不含工具执行结果。**

- fixture 里：`tool-call`（模型给的 toolCallId + 参数）
- 没有：`tool-result`（那是**我们的代码**执行出来的）

所以测「工具失败」时，fixture 给调用，测试自己让工具抛错 —— 这才是被测行为。

### 场景清单（错误场景必须来自真实数据）

**全量扫描 `~/.diy/log/network/`（16 个文件 / 2.5G / 32478 条 LLM 请求）的结论：
只有 200 / 400 / 429 三种状态码，没有 5xx、没有 404。**

| 场景 | 文件 | 来源 | 出现次数 | 覆盖 |
|---|---|---|---|---|
| 纯文本 | `text-only.gen.ts` | 真模型 | — | 基础链路 |
| 思考流 | `think.gen.ts` | 真模型 | — | reasoning 块收/展 |
| 工具成功 | `tool-ok.gen.ts` | 真模型 | — | tool-call 配对、状态点 |
| 工具失败 | `tool-error.gen.ts` | 真模型 | — | 错误块、不崩 |
| 多步工具 | `tool-multi-step.gen.ts` | 真模型 | — | step 边界 |
| 用户中断 | `abort.gen.ts` | 真模型 | — | AbortError 分支 |
| 上游 endpoint 不可用 | `endpoint-unavailable.gen.ts` | **真实样本** | **21×** | 429 `server_error` · 退避重试 |
| reasoning 未回传 | `reasoning-not-passed.gen.ts` | **真实样本** | **15×** | 400 `invalid_request_error` · **不可重试** |
| 上游模型临时不可用 | `rate-limit.gen.ts` | **真实样本** | **3×** | 429 `rate_limit_error` · 短暂退避 |

### ⚠️ 一条硬规矩：错误场景必须来自真实数据

我最初按「常见错误」凭空合成了 `context_length_exceeded` 和 `model_coming_soon`，
**这两个在 32478 条真实请求里一次都没发生过**，已删除。

> **编造场景比没有场景更坏** —— 它会让下游为不存在的情况写防御代码，
> 而真正的 bug（`reasoning_content` 必须回传）反而没有 fixture 覆盖。

**新增错误场景的流程**：

```bash
# 1. 先在真实日志里找
grep -c '"status":429' ~/.diy/log/network/*.jsonl
# 2. 有 → 提取 resBody.head 作为样本，注释里写明出现次数
# 3. 没有 → 不录，等它真的发生（或先写 issue 观察）
```

### 探针测试（`*.probe.test.ts`）—— 真实故障兑现为测试

**黄金测试与复现测试不是一回事，别混。**

| | 黄金（golden） | 探针（probe） |
|---|---|---|
| 数据来源 | **正常行为**的录制 | **真实故障**（日志、用户报告） |
| 目的 | 冻结预期行为 | 复现还没理解的坑 |
| 产生时机 | 功能先有 | **bug 先有** |
| 生命周期 | 长期保留 | 修好后可归档 |

一句话：**golden = 这个功能应该这样工作；probe = 这个功能曾经这样坏过。**

#### 四段头注释（缺一不予合入）

```ts
// <名字>.probe.test.ts — <一句话症状>
//
// ① 现象：<看到什么>       证据：<哪个日志 / 谁的哪次报告>
// ② 根因：<真因，不是症状>
// ③ 修复：<commit hash>
// ④ 现在守什么：<回归判据>
```

没有这四段，半年后没人知道这条测试为什么存在。

#### 核心手法：**先红后绿**

探针测试必须能证明「不修就坏」：

```ts
// 【核心】不修 ⇒ 在 wire 上缺字段；修后 ⇒ 每条都有
const broken = await captureWire(msgs);            // 对照组：模拟 bug 发生时的状态
expect(broken.filter((m) => m.reasoning_content === undefined).length).toBeGreaterThan(0);

const fixed = await captureWire(ensureReasoningReplay(msgs, opts));
for (const m of fixed) expect(m.reasoning_content).toBeDefined();
```

只断言「修之后对」是不够的 —— 那种测试在逻辑被删掉后**可能仍然绿**（比如字段本来就有）。

#### 生命周期（探针的三段）

```
故障报告 / 日志
    ↓ ① 提取：fixtures/incident/<name>/trace.txt + README.md（脱敏）
    ↓ ② 写 *.probe.test.ts         ← 此时必须**红**
    ↓ ③ 修
    ↓ ④ 变绿                      ← 「故障兑现为测试」
    ↓
    ├─ 协议约束 / 高频 → 长期保留（如 reasoning_content 那条）
    └─ 一次性（某次上游抽风）→ 3 个月后移到 tests/probe/archive/
                               （不删逻辑，只从默认 run 里摘出去）
```

**归档 ≠ 删除**：把 `include` 从默认配置里摘掉即可，代码和历史留着 —— 同类故障再犯时能直接复用。

#### 现有样板

`pkgs.ts/model/provider/tests/reasoning-replay.probe.test.ts`
（15 次真实 400 · 多步会话第 85 步 · 四段头注释齐全）

### 三条纪律

1. **脱敏** —— key / 用户内容换成 `$REDACTED`（录制脚本会带出 requestBodyValues）
2. **随协议重录** —— `LanguageModelV3StreamPart` 类型变了就重录，**别手改**
3. **一 fixture 一事** —— 要测「成功后再失败」，录第三份，不要在回放器里拼

---

## 什么时候写哪一层（决策树）

```
这块代码有 LLM 参与吗？
├─ 有 ──► 用 golden 回放 fixture；在哪一层取决于测多大范围
│          └─ 想验「真发出去长什么样」？→ 不写测试，写 docs/model-testing.md
└─ 没有
    ├─ 纯函数 / 状态机 ──────────────► 单元（.test.ts）
    ├─ 产出 DOM 结构 ────────────────► 单元 + happy-dom（.dom.test.ts）
    ├─ 是「一条需求」的完整链路 ──────► 意图（cli.intent.*.test.ts）
    └─ 是「用户能不能点到」 ──────────► E2E（.e2e.test.ts）
```

**别写重复的**：同一件事只在**最能暴露问题的那一层**写一次。

| 例子 | 该在哪层 |
|---|---|
| `createBot` 参数校验 | 单元 |
| `createBot` 写文件 | 意图 |
| 「+新 bot」按钮点得动 | E2E |
| 收到 tool-call 后渲染黄点 | 单元 + happy-dom（用 golden fixture） |

---

## 目录与命名

```
pkgs.ts/<域>/<包>/tests/
├── <主题>.test.ts              单元
├── <主题>.dom.test.ts          单元 + happy-dom
└── fixtures/
    ├── models.ts               模型元数据（不是事件流）
    └── llm/                    golden fixture（源码常量）

pkgs.ts/test/llm/               测试用 LLM 能力包
├── src/env.ts                  按 DIY_TEST_LLM_* 装配真模型
├── src/replay.ts               把 fixture 包成 LanguageModel
└── tests/fixtures/llm/         录制产物

apps/<app>/tests/
├── <主题>.test.ts              单元 / 装配守卫
├── cli.intent.<主题>.test.ts   意图
└── e2e/<主题>.e2e.test.ts      E2E（默认不跑）
```

---

## 现状与差距（2026-11-04）

| 项 | 现有 | 差距 |
|---|---|---|
| 单元 `.test.ts` | **438** | 够 |
| 单元 `.dom.test.ts` | **3** | 偏少，UI 包应各有一份 |
| golden fixture | **3 份**（text-only / tool-ok / abort，刚建） | 还差 7 个场景 |
| 意图 `cli.intent.*` | **58**（全在 diy-app） | 新 app 一条没有 |
| E2E `.e2e.test.ts` | **1**（chat） | web / minimal 没有 |

**最近的教训**：「+新 bot 模型列表恒为空」在 48 个绿测试下长期存活 ——
它是「意图」和「E2E」的缺口，单元层再多也抓不到。

---

## 跑法

```bash
./sha.sh test                                             # 单元（含 dom）
cd apps/chat && ./sha.sh build && npm run test:e2e        # E2E
node --experimental-strip-types tools/record-llm.mts list # 看 golden fixture 状态
```
