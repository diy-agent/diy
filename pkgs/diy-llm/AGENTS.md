# diy-llm

本地 LLM 代理 — multi-provider AI gateway via LiteLLM。

CLI → credential pool → model sync → LiteLLM proxy。目标：统一管理多个上游渠道（TokenHub、LKEAP、OpenAI-compatible 等），让下游 PI agent / 其他工具通过单一端口接入。

## 架构

```
type.yaml  ──→  auth.json  ──→  locks/*.lock.json  ──→  LiteLLM proxy
(类型描述)       (凭据池)       (运行时快照)              (OpenAI 兼容端口)
                     │                                            │
               diy-llm auth set                             diy-llm serve
               diy-llm sync ←─────────── 唯一写入者 ──────────── 只读
```

### 层次说明

| 层 | 路径 | 内容 | 更新方式 |
|---|---|---|---|
| **type** | `src/diy_llm/providers/<name>/type.yaml` | auth scheme, default_base, 模型元信息 | 打包时固定 |
| **auth** | `~/.diy-llm/auth.json` | credential pool (fingerprint, status) | `diy-llm auth set` |
| **config** | `~/.diy-llm/config.json` | default_model, exclude_models | `diy-llm model set/exclude` |
| **lock** | `~/.diy-llm/locks/<name>.lock.json` | per-model enabled/status/cost | `diy-llm sync` |
| **proxy** | 内存 (litellm 进程) | model_list, api_base, api_key | `diy-llm serve` → `os.execvp` |

## CLI

框架：**Cyclopts**（已从 argparse 迁移）。

```
diy-llm auth set <type> --key $ENV_VAR      # 注册凭据 + 初始 sync
diy-llm sync <name>                           # 刷新 lock
diy-llm serve [name] [--port] [--list-providers]  # 启动代理
diy-llm model set <provider> <model_id>       # 设默认模型
diy-llm model show [provider]                 # 看默认
diy-llm model unset [provider]                # 清默认
diy-llm model exclude <provider> <model_id>   # 禁用模型
diy-llm model include <provider> [model_id]   # 恢复 / 列出已排除
```

## Provider 系统

一个 provider = 一个目录 `src/diy_llm/providers/<name>/`，包含：

```
<name>/
├── type.yaml               # 必需 — 类型描述
│   type: <name>
│   api:
│     protocol: openai-compatible
│     default_base: https://...
│   auth:
│     scheme: Bearer        # 或 api_key
│     credential_source: env:TOKENHUB_KEY
│   models: ...             # 可选默认列表
│
├── models.defaults.json    # 可选 — 默认模型元信息（cost, context_window 等）
└── docs.md                 # 可选 — 参考文档
```

### 现有 Provider

| Provider | 上游 | 协议 |
|---|---|---|
| `tencentcloud-tokenhub` | tokenhub.tencentmaas.com | OpenAI-compatible (via LiteLLM custom_openai) |
| *(规划)* `tencentcloud-lkeap` | api.lkeap.cloud.tencent.com | TBD |

### 添加 Provider 步骤

1. `pkgs/diy-llm/src/diy_llm/providers/<name>/` 建目录
2. 写 `type.yaml`（auth scheme、default_base、协议）
3. 可选 `models.defaults.json`（模型 ID、名称、cost、context_window）
4. `diy-llm auth set <name> --key $ENV_VAR` 注册凭据
5. `diy-llm sync <name>` 获取 lock
6. `diy-llm serve <name>` 启动

## 关键设计决策

### api_base 必须自带 /v1

LiteLLM `custom_openai` 在接受请求时，会在 api_base 后追加 `chat/completions`。如果上游 API 的完整路径是 `/v1/chat/completions`，那么 api_base 必须包含 `/v1`，否则 LiteLLM 会拼成错误的 `/chat/completions`（导致 404）。

### os.execvp 使用全路径 litellm 二进制

`serve` 命令通过 `os.execvp` 替换为 litellm 进程。在 uv venv 下 `litellm` 不在 PATH 上，必须用 `os.path.join(os.path.dirname(sys.executable), "litellm")` 获取准确路径。不能用 `python -m litellm`，因为 uv run 的模块解析在某些情况下找不到入口。

### 凭据池拒绝明文 key

credential 只存 `source: env:VAR_NAME`，不能 inline key。key 由用户在 `~/.bashrc`（或其他机密存储）管理。

### exclude_models

`config.json` 的 `exclude_models.{provider: [ids]}` 列表用于在 sync 和 serve 时自动禁用模型。避免在 `/v1/models` 返回大量模型时手动编辑 lock。

### 默认端口

18888。

## Config 参考 (`~/.diy-llm/config.json`)

```json
{
  "version": 1,
  "default_model": {
    "tencentcloud-tokenhub": "deepseek-v4-flash"
  },
  "exclude_models": {
    "tencentcloud-tokenhub": ["deepseek-v3.2"]
  }
}
```

## 上下游关系

```
PI agent → diy-llm serve (:18888) → TokenHub / LKEAP / ...
```

PI agent 配置在 `~/.pi/agent/models.json` 和 `settings.json`。diy-llm proxy 启动后，PI 的 provider 指向 `localhost:18888`。

### PI agent models.json 示例

```json
{
  "tencentcloud-tokenhub": {
    "baseUrl": "http://localhost:18888",
    "api": "openai-completions",
    "models": [
      {
        "id": "tencentcloud-tokenhub/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash (DIY Proxy)",
        "contextWindow": 1000000,
        "cost": {"input": 1, "output": 2, "cacheRead": 0.2}
      }
    ]
  }
}
```

## TokenHub 价格 (参考)

来源：https://cloud.tencent.com/document/product/1823/130055

| 模型 | 输入 (元/百万tokens) | 缓存命中 | 输出 |
|---|---|---|---|
| DeepSeek V4 Flash | 1 | 0.2 | 2 |
| DeepSeek V4 Pro | 3 | 0.025 | 6 |

## 未来规划

-   **PySide6 系统托盘 App** — 背景常驻，一点开关
-   **Observability** — 请求统计、成本追踪、状态通知
-   **`tencentcloud-lkeap` provider** — `api.lkeap.cloud.tencent.com/plan/v3`
-   **自动刷新** — 后台定时 sync（用 cronjob）
-   **Provider 健康检测** — credential pool 自动降级
-   **多 lock / 多 serve 同端口路由** — 一个端口分发到多个 provider

## 约束

-   **GPG 签名**：monorepo 强制，禁止 `--no-gpg-sign`。
-   **语言**：文档/CLI 输出用中文 + 技术英文术语。
-   **代码风格**：类型标注（typing.Annotated）、函数文档字符串（""""""）、单行 120 字符。

## 参考文档

-   **模型价格**: https://cloud.tencent.com/document/product/1823/130055
-   **模型列表**: https://cloud.tencent.com/document/product/1823/129605
-   **LiteLLM config**: https://docs.litellm.ai/docs/proxy/configs
-   **Cyclopts**: https://cyclopts.readthedocs.io/
