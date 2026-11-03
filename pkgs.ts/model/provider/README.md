# @diy-agent/llm-provider

OpenAI 兼容的 LLM provider：**发请求 + 翻流 + 模型目录**，仅此而已。

## 边界（做歪了就返工）

| 属于本包 | 不属于本包 |
|---|---|
| HTTP 请求构造 / 流式解析 | system prompt / 人设（谁注入谁管） |
| 模型目录（id / name / window / 价目） | 工具定义与执行（调用方给，下一刀） |
| token 用量回报（含缓存桶） | 会话状态 / 压缩 / 落盘 |
| 失败分类（鉴权 / 限流 / 超时 / 网络） | 重试策略（可另起包） |

判据：`grep -c 'persona\|systemPrompt\|你是' src/*.ts` = 0；
`grep -c 'node:fs\|diyHome\|electron' src/*.ts` = 0。两条都由 `tests/` 外的人工核对，别让它们变红。

## 用法

```ts
import { createOpenAiCompatible, DEFAULT_MODEL_ID } from "@diy-agent/llm-provider";
import { createSession } from "@diy-agent/session";

const llm = createOpenAiCompatible({
    baseURL: process.env["LLM_BASE_URL"]!,   // 如 https://api.deepseek.com/v1
    apiKey: process.env["LLM_API_KEY"]!,
    model: process.env["LLM_MODEL"] ?? DEFAULT_MODEL_ID,
});

const session = createSession({ id: "demo", llm });
for await (const delta of session.send("你好")) {
    // delta.type === "text" 时拼正文；"usage" 时记账（多带 cacheReadTokens / cacheWriteTokens）
}
```

配置**全部外部传入**：本包不读环境变量、不读应用数据根、不碰文件系统。
因此同一份代码能在 Electron 主进程、CLI、单测里跑，测试给它一个假 `fetch` 就行。

## provider 策略（`@diy-agent/llm-provider/strategies`）

某个 provider 的**私有约定**（网关专属请求字段 / 必需 header）写在它自己的策略文件里，
不写在应用层，也不写成「按 provider 名分支」（##491）。

```ts
import { bodyTransformFor, headersFor } from "@diy-agent/llm-provider/strategies";

const transformBody = bodyTransformFor(baseUrl);            // undefined = 不补（别挂恒等函数）
const headers = headersFor(baseUrl, { sessionId });        // {} = 不补
```

| 文件 | 认领 | 做什么 |
|---|---|---|
| `strategies/opencode.ts` | `host === opencode.ai` | 补 `prompt_cache_retention=24h` + 会话路由头 |
| `strategies/venice.ts` | 无（占位） | 什么都不做：字段未实测 ⇒ 不发（##486 原则） |
| `strategies/passthrough.ts` | 一切（注册表末尾） | 什么都不做：安全默认值 |

注册表 `STRATEGIES` **按顺序匹配，第一个命中的生效**。加新 provider = **新增一个文件 + 在
`index.ts` 里加一行**；不认识的端点一律走 passthrough（未验证的字段不发）。

## 失败

所有上游失败统一抛 `LlmProviderError`：

| code | 触发 | 可重试 |
|---|---|---|
| `llm-provider/unauthorized` | 401 / 403 | ✗ |
| `llm-provider/rate-limit` | 429 | ✓ |
| `llm-provider/upstream` | 其余 4xx / 5xx | ✓ |
| `llm-provider/timeout` | 超时类错误名 / 错误码 | ✓ |
| `llm-provider/network` | 连不上 / 被重置 | ✓ |
| `llm-provider/unknown` | 都不命中 | ✗ |

`statusCode` 有值 = 上游真的回了 HTTP 响应。本包**不重试**（`maxRetries: 0`）。

## 模型目录

`DEFAULT_MODELS` 只有 3 条示例数据，用于 demo / 测试 / 最小工作台。
它**不是**真源：宿主的模型目录（可用账号、价目、可见性）永远优先。未知 id 原样透传给上游。
