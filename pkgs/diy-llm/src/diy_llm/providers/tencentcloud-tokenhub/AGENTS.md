# tencentcloud-tokenhub — Provider

腾讯云 TokenHub API 的 diy-llm provider。通过 LiteLLM `custom_openai` 代理到 `tokenhub.tencentmaas.com`。

## 关键事实（agent 需要知道的）

| 项目 | 值 |
|---|---|
| **type 名** | `tencentcloud-tokenhub`（非 `qcloud-tokenhub`、非 `tencentcloud`） |
| **上游协议** | OpenAI-compatible |
| **`type.yaml`** | `src/diy_llm/providers/tencentcloud-tokenhub/type.yaml` |
| **默认模型** | `src/diy_llm/providers/tencentcloud-tokenhub/models.defaults.json` |
| **凭据** | `env:TENCENT_CLOUD_TOKENHUB_KEY`（用户维护在 `~/.bashrc`，代理不应管理） |
| **认证方式** | `Authorization: Bearer` |

## ⚠️ 已知陷阱

### 1. api_base 必须包含 `/v1`

**根源：** LiteLLM `custom_openai` 在 api_base 后追加 `chat/completions`。上游只认 `/v1/chat/completions`，所以 base URL 必须自带 `/v1`。

**正确：** `https://tokenhub.tencentmaas.com/v1`

**错误：** `https://tokenhub.tencentmaas.com` → LiteLLM 拼出 `/chat/completions` → **404**。

**涉及位置：**
- `type.yaml` 的 `api.default_base`
- `auth.json` 中每条 credential 的 `api_base`
- 任何新加 provider 的 base URL

### 2. servir 启动路径

`diy-llm serve` 用 `os.execvp` 替换为 litellm 进程。必须用全路径：
```python
litellm_bin = os.path.join(os.path.dirname(sys.executable), "litellm")
os.execvp(litellm_bin, [litellm_bin, "--config", config_path, "--port", str(port)])
```
不能用 `"litellm"`（不在 PATH 上）或 `python -m litellm`（uv run 下模块解析有问题）。

### 3. 凭据池

`auth.json` 只存 `source: env:VAR_NAME`，不存明文 key。key 在环境变量中。

### 4. 命名约束

provider 名已定稿为 `tencentcloud-tokenhub`：
- ~~`qcloud-tokenhub`~~（旧名，已废弃）
- ~~`tencentcloud`~~（太宽泛，会跟未来 LKEAP provider 混淆）

## 模型管理

### 添加模型

修改 `models.defaults.json`，在 `models` 下加一项：

```json
"deepseek-v3.2": {
  "name": "DeepSeek V3.2",
  "reasoning": true,
  "context_window": 1000000,
  "max_tokens": 384000,
  "cost": {"input": 1, "output": 2, "cacheRead": 0.2, "cacheWrite": 0}
}
```

### 排除模型

如果要屏蔽某个模型（如 `deepseek-v3.2`）：

```bash
diy-llm model exclude tencentcloud-tokenhub deepseek-v3.2
```

这会写入 `config.json` 的 `exclude_models`，sync 和 serve 时自动禁用。

### 价格

**来源：** https://cloud.tencent.com/document/product/1823/130055（TokenHub 官方定价页）
**单位：** 元/百万 tokens（人民币，不是 USD）

| 模型 | 输入 | 缓存命中 | 输出 |
|---|---|---|---|
| DeepSeek V4 Flash | 1 | 0.2 | 2 |
| DeepSeek V4 Pro | 3 | 0.025 | 6 |
| DeepSeek R1 | 0.14* | — | 0.28* |

> `*` R1 尚未在 TokenHub 控制台确认价格，沿用 DeepSeek 官方 USD 价。

`cost` 字段格式：`{"input": N, "output": N, "cacheRead": N, "cacheWrite": 0}`

### lock 字段说明

每个模型在 lock 中有以下字段：

```json
{
  "id": "deepseek-v4-flash",
  "name": "DeepSeek V4 Flash",
  "enabled": true,           // exclude 时设为 false
  "context_window": 1000000,
  "max_tokens": 384000,
  "reasoning": true,
  "cost": {"input": 1, "output": 2, "cacheRead": 0.2, "cacheWrite": 0},
  "status": "ok",
  "stale": false             // 上游不再返回时被标记
}
```

## PI agent 集成

PI agent 中该 provider 的配置：

```json
{
  "tencentcloud-tokenhub": {
    "baseUrl": "http://localhost:18888",
    "api": "openai-completions",
    "apiKey": "...",
    "models": [
      { "id": "tencentcloud-tokenhub/deepseek-v4-flash", ... }
    ]
  }
}
```

路径：`~/.pi/agent/models.json` 和 `settings.json`。

## 参考链接

- [模型价格](https://cloud.tencent.com/document/product/1823/130055)
- [模型列表](https://cloud.tencent.com/document/product/1823/129605)
- [API 调用指南](https://cloud.tencent.com/document/product/1823/129603)
