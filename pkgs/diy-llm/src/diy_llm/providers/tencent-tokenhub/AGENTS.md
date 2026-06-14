# tencent-tokenhub — Provider

腾讯云 TokenHub API 的 diy-llm provider，上游协议为 OpenAI-compatible。

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

上游 API 路径为 `/v1/chat/completions`，所以 base URL 必须自带 `/v1`。

**正确：** `https://tokenhub.tencentmaas.com/v1`

**错误：** `https://tokenhub.tencentmaas.com` → 拼出 `/chat/completions` → **404**。

涉及位置：`provider.yaml` 的 `api.default_base`。

### 2. supportsDeveloperRole 必须为 false

TokenHub 只接受 `system`、`user`、`assistant`、`tool` 四种角色，不接受 `developer` role。

涉及位置：`provider.yaml` 中每个模型的 `compat.supportsDeveloperRole`。

### 3. 凭据

`provider state` 文件中 `source` 字段只存 `env:VAR_NAME`，不存明文 key。key 在环境变量中。

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
