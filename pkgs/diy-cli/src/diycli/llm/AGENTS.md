# diy llm — LLM Provider 配置同步

`diy llm` 统一管理多个上游渠道（TokenHub、DeepSeek 等），把 provider 配置同步到下游 PI agent 和 Hermes。

CLI → credential pool → model sync → export。

## 架构

```
src/diycli/llm/
├── _app.py            # Cyclopts App (diy llm ...)
├── auth.py            # 凭据管理（读 env:VAR_NAME → 写 state）
├── core.py            # provider 发现、sync、state 管理
├── export.py          # 导出：PI agent / Hermes 配置同步
└── providers/         # provider 类型定义（随包分发）
    ├── tencent-tokenhub/
    │   ├── provider.yaml
    │   └── AGENTS.md
    └── deepseek/
        └── provider.yaml
```

数据流：
```
provider.yaml  →  ~/.diy/models/*.json  →  export → PI agent / Hermes
 (模型白名单)       (source+api_base+models)   (models.json / config.yaml)
```

## 命令

```
diy llm sync diy   # 同步 state（fetch models → ~/.diy/models/）
diy llm sync pi    # 同步到 PI agent (~/.pi/agent/models.json)
diy llm sync all   # 全 pipeline：state + PI + Hermes
diy llm auth ...   # 凭据管理
diy llm model ...  # 模型列表/清理
```

## 核心设计

### state 与 provider.yaml 分离

- **provider.yaml** — API 事实（label/reasoning/context_window/cost/compat），随包分发，不可被用户覆盖
- **state JSON** (`~/.diy/models/<provider>.json`) — 运行时状态：editable（max_tokens/enabled）+ status/error
- merge 策略：editable 外 = provider.yaml 覆盖，editable 内 = 用户地盘 sync 不碰

### 模型可见性

- 只有 provider.yaml 声明的模型才暴露给下游
- sync 时上游下架的模型标记 `MODEL_DEPRECATED`（status=error）
- export 跳过 status=error 的模型
- `diy llm model clean` 手动删除废弃条目

### 凭据

- `source` 存 `env:VAR_NAME`，不存明文 key
- `~/.diy/.env` 在 CLI 启动时自动加载到 os.environ
- 和 Hermes 一致：provider 的认证信息属于 provider 配置，不拆成两个文件

## 命名规范

```
tencent-<服务>-<渠道>
  tencent-tokenhub      — TokenHub (tokenhub.tencentmaas.com)
```

模型引用格式：`provider/model_id`（如 `tencent-tokenhub/deepseek-v4-pro-202606`）

## provider.yaml 格式

```yaml
type: <provider-type>          # 唯一标识
label: <显示名称>
auth:
  scheme: api_key
  header: Authorization
  prefix: "Bearer "
api:
  protocol: openai-compatible  # 或 anthropic
  default_base: https://...
models:
  <model-id>:
    label: <显示名>
    reasoning: true/false
    context_window: <int>
    cost: {input, output, cacheRead, cacheWrite}
    compat: {supportsDeveloperRole, thinkingFormat, ...}
```

## 参考文档

- TokenHub 模型价格: https://cloud.tencent.com/document/product/1823/130055
- TokenHub 模型列表: https://cloud.tencent.com/document/product/1823/129605
- Hermes custom_providers: https://hermes-agent.nousresearch.com/docs/integrations/providers
