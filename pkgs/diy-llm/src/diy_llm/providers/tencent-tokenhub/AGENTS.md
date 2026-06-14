# tencent-tokenhub — Provider

腾讯云 TokenHub API 的 diy-llm provider。通过 LiteLLM `openai` provider 代理到 `tokenhub.tencentmaas.com`。

## 关键事实（agent 需要知道的）

| 项目 | 值 |
|---|---|
| **type 名** | `tencent-tokenhub` |
| **上游协议** | OpenAI-compatible |
| **`provider.yaml`** | `src/diy_llm/providers/tencent-tokenhub/provider.yaml` |
| **凭据** | `env:TENCENT_CLOUD_TOKENHUB_KEY` |
| **认证方式** | `Authorization: Bearer` |

## ⚠️ 已知陷阱

### 1. api_base 必须包含 `/v1`

**根源：** LiteLLM 在 api_base 后追加 `chat/completions`。上游只认 `/v1/chat/completions`，所以 base URL 必须自带 `/v1`。

**正确：** `https://tokenhub.tencentmaas.com/v1`

**错误：** `https://tokenhub.tencentmaas.com` → LiteLLM 拼出 `/chat/completions` → **404**。

涉及位置：`provider.yaml` 的 `api.default_base`。

### 2. 必须用 `openai/` provider，禁用 `custom_openai/`

`custom_openai/` 全透传——所有请求 body 字段原样转发给上游。下游（Hermes）发的 `think` 等非标参数会导致上游 500。`openai/` 配合 `drop_params:true` 自动过滤不识别的参数。

LiteLLM 代理配置中每个 model entry 的 `litellm_params.model` 必须是 `openai/{model_id}`。

### 3. 凭据

`auth.json` 只存 `source: env:VAR_NAME`，不存明文 key。key 在环境变量中。

### 4. 模型管理

模型定义在 `provider.yaml` 的 `models:` 段。添加模型直接编辑 provider.yaml。

### 5. 价格

**来源：** https://cloud.tencent.com/document/product/1823/130055（TokenHub 官方定价页）
**单位：** 元/百万 tokens

| 模型 | 输入 | 缓存命中 | 输出 |
|---|---|---|---|
| DeepSeek V4 Flash / Flash 202605 | 1 | 0.2 | 2 |
| DeepSeek V4 Pro / Pro 202606 | 3 | 0.025 | 6 |
| DeepSeek R1 | 0.14 | 0.014 | 0.28 |

## 参考链接

- [模型价格](https://cloud.tencent.com/document/product/1823/130055)
- [模型列表](https://cloud.tencent.com/document/product/1823/129605)
- [API 调用指南](https://cloud.tencent.com/document/product/1823/129603)
