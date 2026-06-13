# diy-llm

本地 LLM 代理 — multi-provider AI gateway via LiteLLM。

CLI → credential pool → model sync → LiteLLM proxy。
目标：统一管理多个上游渠道（TokenHub、TokenPlan、HyTokenPlan 等），让下游 Hermes / PI agent / 其他工具通过单一端口接入。

## 架构（当前，待重构）

```
type.yaml + models.defaults.json  →  auth.json  →  locks/*.lock.json  →  LiteLLM proxy
     (2个文件)                          (凭据池)        (运行时快照)              (单 provider)
```

**已知问题（从本次审查中发现的）：**

- `models.defaults.json` 与 `type.yaml` 是同一件事的两种格式，不应拆成两个文件
- sync 的 merge 方向反了——lock（用户可改）覆盖 provider 定义（不可改的能力事实）
- `reasoning` / `context_window` / `cost` 等是 API 事实，不应在 lock 中看起来可编辑
- 所有业务逻辑都堆在 `cli.py`（731 行），GUI 无法复用
- `serve` 只启动单个 provider，无法代理全部
- `~/.diy-llm/.env` 被写入但从未加载
- provider 命名不统一（`tencentcloud-tokenhub`）

---

## 重设计任务

### R1: provider 命名统一

**当前：** `tencentcloud-tokenhub`
**目标：** `tencent-tokenhub`（与后续的 `tencent-token-plan`、`tencent-hy-token-plan` 一致）

**命名规范：**

```
tencent-<服务>-<渠道>
  tencent-tokenhub      — TokenHub (tokenhub.tencentmaas.com)
  tencent-token-plan    — 腾讯云 token plan（计划中）
  tencent-hy-token-plan — 混元 token plan（计划中）
```

**模型 ID 格式：** `tencent-tokenhub/hy3-preview`、`tencent-tokenhub/deepseek-v4-flash-202605`

**影响范围：**
- [ ] `src/diy_llm/providers/tencentcloud-tokenhub/` → 重命名为 `tencent-tokenhub/`
- [ ] `type.yaml` 内 `type` 字段改为 `tencent-tokenhub`
- [ ] `models.defaults.json` → 删除（合并到 type.yaml，见 R2）
- [ ] `auth.json` 中所有引用 `tencentcloud-tokenhub` 的 entries → 迁移或重新 auth set
- [ ] `~/.diy-llm/locks/tencentcloud-tokenhub.lock.json` → 重命名并更新 `provider` / `provider_type` 字段
- [ ] `config.json` 中 `default_model` 和 `exclude_models` 的 key
- [ ] 所有文档中的引用
- [ ] `hermes-agent` skill 中的引用
- [ ] `diy-llm-provider-design` skill 中的引用

**状态：** ✅ 已完成 (2026-06-14)

---

### R2: 合并 type.yaml 和 models.defaults.json

**当前：** provider 定义拆成两个文件——`type.yaml`（auth/protocol） + `models.defaults.json`（模型元数据）
**问题：** 两个文件两种格式描述同一件事；"defaults" 暗示可覆盖，实际是 API 事实

**目标：** 模型元数据并入 `type.yaml` 的 `models:` 段，一个 provider = 一个 YAML 文件：

```yaml
# src/diy_llm/providers/tencent-tokenhub/type.yaml
type: tencent-tokenhub
name: 腾讯云 TokenHub

auth:
  scheme: api_key
  header: Authorization
  prefix: "Bearer "

api:
  protocol: openai-compatible
  default_base: https://tokenhub.tencentmaas.com/v1

models:
  deepseek-v4-flash-202605:
    name: DeepSeek V4 Flash 202605 (直通官网)
    reasoning: true
    context_window: 1000000
    cost: {input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0}
  
  deepseek-v4-pro-202606:
    name: DeepSeek V4 Pro 202606 (直通官网)
    reasoning: true
    context_window: 1000000
    cost: {input: 3, output: 6, cacheRead: 0.025, cacheWrite: 0}

  deepseek-v4-pro:
    name: DeepSeek V4 Pro
    reasoning: true
    context_window: 1000000
    cost: {input: 3, output: 6, cacheRead: 0.025, cacheWrite: 0}

  deepseek-v4-flash:
    name: DeepSeek V4 Flash
    reasoning: true
    context_window: 1000000
    cost: {input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0}

  deepseek-r1:
    name: DeepSeek R1
    reasoning: true
    context_window: 128000
    cost: {input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0}

  hy3-preview:
    name: 混元 3 Preview
    reasoning: false
    context_window: 128000
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
```

**模型字段语义：**

| 字段 | 类型 | 语义 | 来源 |
|------|------|------|------|
| `name` | string | 显示名 | provider 定义 |
| `reasoning` | bool | 是否支持深度思考 | provider 定义（API 事实） |
| `context_window` | int | 上下文窗口大小 | provider 定义（API 事实） |
| `cost` | object | 价格信息 | provider 定义（API 事实） |
| `cost.input` | float | 输入价格（元/百万tokens） | provider 定义 |
| `cost.output` | float | 输出价格（元/百万tokens） | provider 定义 |
| `cost.cacheRead` | float | 缓存命中价格 | provider 定义 |
| `cost.cacheWrite` | float | 缓存写入价格 | provider 定义 |

以上字段是 API 事实，不可被 lock 覆盖。`max_tokens` 是客户端生成参数，不在 provider 定义中声明，由用户通过 lock 或 config 配置。

**API事实 merge 方向修正：**

`_ensure_lock` 中 API 事实的 merge 顺序应为：**provider 定义 > lock（即 provider 定义覆盖 prev）**

```python
# 正确方向
"name":          meta.get("name", prev.get("name", mid)),
"reasoning":     meta.get("reasoning", prev.get("reasoning", False)),
"context_window": meta.get("context_window", prev.get("context_window", 128000)),
"cost":          meta.get("cost", prev.get("cost", {"input": 0, "output": 0})),
"compat":        meta.get("compat", prev.get("compat", {})),

# max_tokens 是客户端参数，prev 可覆盖
"max_tokens":    prev.get("max_tokens", meta.get("max_tokens", 4096)),

# 运行时状态字段：prev 保留 + 默认值
"enabled":       prev.get("enabled", True),
"status":        prev.get("status", "ok"),
```

**影响范围：**
- [ ] `_ensure_lock` merge 方向修正
- [ ] `meta` 来源改为 `_load_provider_type(ptype).get("models", {})`（不再读单独文件）
- [ ] 删除 `_defaults_path()` 函数
- [ ] 删除 `models.defaults.json` 文件
- [ ] 删除 `models.defaults.json` 被提到的所有文档

**状态：** ✅ 已完成 (2026-06-14)

---

### R3: core 模块拆分

**当前：** 所有逻辑在 `cli.py`（731 行），包含：
- credential 管理（读写 auth.json）
- model sync（`_ensure_lock`, `_fetch_model_ids`）
- lock 管理（读写 lock.json）
- provider 发现（`_discover_provider_types`）
- serve 配置生成
- Cyclopts CLI 定义

**问题：** GUI（后续 PySide6 系统托盘）无法复用这些逻辑。

**目标结构：**

```
src/diy_llm/
├── __init__.py
├── cli.py              # 薄 CLI 层（Cyclopts app 定义 + 命令 handler）
├── core.py             # 核心：provider 发现、sync、lock 管理、serve 配置生成
├── auth.py             # 凭据管理：读写 auth.json、env 解析
├── providers/          # provider 类型定义
│   └── tencent-tokenhub/
│       ├── type.yaml
│       └── AGENTS.md
```

**core.py 导出函数：**

```python
# 供 CLI 和 GUI 使用
def discover_provider_types() -> dict[str, Path]
def load_provider_type(ptype: str) -> dict | None
def load_lock(provider_name: str) -> dict | None
def save_lock(provider_name: str, lock: dict) -> None
def ensure_lock(name: str, api_base: str, api_key: str, ptype: str) -> tuple[dict, str]
def fetch_model_ids(api_base: str, api_key: str) -> list[str] | None
def build_litellm_config(name: str, api_base: str, api_key: str, models: dict) -> dict
def get_enabled_models(name: str) -> dict[str, dict]
```

**auth.py 导出函数：**

```python
def load_auth() -> dict
def save_auth(auth: dict) -> None
def load_dotenv() -> None              # 新增：从 ~/.diy-llm/.env 加载环境变量
def get_active_credential(name: str) -> dict | None
def resolve_api_key(cred: dict) -> str | None
def fingerprint(value: str) -> str
```

**cli.py 保持轻量：** 每个命令仅调用 core/auth 的函数，处理参数→函数→输出映射

**影响范围：**
- [ ] 创建 `core.py`，迁移 `_ensure_lock`, `_fetch_model_ids`, `_build_litellm_config` 等
- [ ] 创建 `auth.py`，迁移 `_load_auth`, `_save_auth`, `_get_active_credential` 等
- [ ] `cli.py` 简化为命令注册 + core/auth 调用的薄层
- [ ] 更新 `pyproject.toml` entry points 确保导入路径正确
- [ ] 测试：当前无测试文件，需建 `tests/test_core.py`

**状态：** ✅ 已完成 (2026-06-14)

---

### R4: serve 支持多 provider

**当前：** `diy-llm serve <provider>` 只启动一个 provider 的代理

**目标：** `diy-llm serve` 不带参数时，启动所有已配置 provider 的代理

```bash
diy-llm serve                     # 所有 provider（默认）
diy-llm serve tencent-tokenhub    # 指定单一 provider
diy-llm serve --list-providers    # 查看 provider 状态表
```

**LiteLLM config 包含所有 provider 的模型：**

```yaml
model_list:
  - model_name: tencent-tokenhub/deepseek-v4-flash-202605
    litellm_params:
      model: custom_openai/deepseek-v4-flash-202605
      api_base: https://tokenhub.tencentmaas.com/v1
      api_key: sk-xxx
  - model_name: tencent-tokenhub/hy3-preview
    litellm_params:
      model: custom_openai/hy3-preview
      api_base: https://tokenhub.tencentmaas.com/v1
      api_key: sk-xxx
  - model_name: tencent-token-plan/deepseek-v4-pro
    litellm_params:
      model: custom_openai/deepseek-v4-pro
      api_base: https://api.lkeap.cloud.tencent.com/v1
      api_key: sk-yyy
```

**逻辑：**
1. 发现所有 provider types
2. 对每个 provider，找 active credential → resolve api_key → load lock → get enabled models
3. 合并所有 model_list entries
4. 生成统一 LiteLLM config，启动一个代理进程

**`/v1/models` 端点：** LiteLLM 自动列出全部 `model_name`，对应上述 model_list

**影响范围：**
- [ ] `_build_litellm_config` 改为接受 providers 列表
- [ ] `serve` 命令默认遍历所有 provider
- [ ] UI 输出显示所有 provider 的模型（按 provider 分组）
- [ ] 单一 provider 仍然可用（向后兼容）

**状态：** 🔴 待实现

---

### R5: 模型可见性控制

**需求：**

1. **只有 provider.yaml 中声明的模型，才通过 `/v1/models` 暴露。**
   - 可见模型 = provider.yaml 中声明 + state 中 `enabled=true` + state 中 `status != "error"`
   - 不在 provider.yaml 中的上游模型不自动暴露

2. **sync 时，若上游下架了模型，在用户 state 中标记 `error: {code: "MODEL_DEPRECATED", message: "上游已下架，不再建议使用"}`。**
   - 这是用户数据出现了错误——上游不认这个模型了
   - 语义：**废弃**（deprecated），前端展示黄色警告
   - state 保留条目，不自动删除（用户下游配置可能引用）

3. **MODEL_DEPRECATED 的模型不自动删除。**
   - `status` 变为 `"error"`，serve 跳过
   - 用户通过 `diy-llm model clean <provider>` 手动删除
   - 如果上游恢复了这模型，sync 清除 error，status 回到 `"ok"`

**state.json 范例（模型被下架后的状态）：**

```json
{
  "deepseek-v4-flash-202605": {
    "label": "DeepSeek V4 Flash 202605 (直通官网)",
    "editable": {
      "max_tokens": 384000,
      "enabled": true
    },
    "status": "error",
    "error": {
      "code": "MODEL_DEPRECATED",
      "message": "上游已下架，不再建议使用",
      "time": "2026-07-01T10:00:00+0800"
    }
  }
}
```

**影响范围：**
- [ ] sync 检测到 upstream 不含某模型 → 设置 `status: "error"` + `error: {code: "MODEL_DEPRECATED", ...}`
- [ ] serve 生成 model_list 时过滤 `status == "error"` 的模型
- [ ] `diy-llm model list` 显示 `⚠ 废弃`
- [ ] `diy-llm model clean <provider>` 命令删除 status=error 的模型
- [ ] 上游没有 `/v1/models`（如 TokenHub 404），不标记任何模型为 error，模型来源是 provider.yaml

**状态：** 🔴 待实现

---

### R6: .env 文件加载

**当前：** `~/.diy-llm/.env` 在 `auth set` 时被写入（cli.py:475），但从未被加载到环境变量中。

**问题：** `sync` 和 `serve` 命令依赖 `env:VAR_NAME` 来源解析 API key，但若用户把 key 写在 `~/.diy-llm/.env` 里（而不是 shell profile），这些命令看不到。

**目标：** 参考 Hermes 的 `.env` 加载方式，在 core/auth 初始化时自动加载：

```python
# auth.py
import os

def load_dotenv(path: Path | None = None) -> None:
    """Load ~/.diy-llm/.env into os.environ, matching Hermes convention."""
    env_file = path or (Path.home() / '.diy-llm' / '.env')
    if not env_file.is_file():
        return
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value
```

**调用时机：** CLI entry point (`main()`) 启动时 + core API 对外暴露以便 GUI/其他入口调用

**影响范围：**
- [ ] `auth.py` 新增 `load_dotenv()`
- [ ] `cli.py` 的 `main()` 内调用 `load_dotenv()`
- [ ] `auth set` 写入 `.env` 后自动生效（已存在，load_dotenv 保证后续加载）
- [ ] 文档更新：说明 `.env` 支持

**状态：** ✅ 已完成 (2026-06-14)

---

### R7: auth.json 简化为 provider → source 映射

**当前：**
```json
{
  "version": 1,
  "credential_pool": {
    "tencentcloud-tokenhub": [{
      "id": "sha256",                          // sha256(key)[:6]，无意义标识
      "label": "主账号",
      "auth_type": "api_key",
      "priority": 0,                           // 多 key 轮换用，当前单 key 不需要
      "source": "env:TENCENT_CLOUD_TOKENHUB_KEY",
      "api_base": "https://tokenhub.tencentmaas.com/v1",  // 与 type.yaml 重复
      "provider_type": "tencentcloud-tokenhub",           // 与 type.yaml 重复
      "request_count": 0,
      "secret_fingerprint": "sha256:596f4162a52f315b",    // key hash，单 key 场景冗余
      "last_status": "ok"                                  // 与 error 字段重复
    }]
  }
}
```

**问题逐个拆解：**

| 字段 | 问题 | 处理 |
|------|------|------|
| `credential_pool` | Hermes 概念泄漏——diy-llm 不需要「池」概念，单 key 场景这个包装无意义 | 改为 `providers` |
| 数组包裹 | 一个 provider = 一个 key，不需要数组包装 | 去数组，直接对象 |
| `id` | `sha256(key)[:6]`，Hermes 里的短标识——但单 key 根本不需要 ID | 删除 |
| `priority` | 多 key 轮换/fallback 用的——当前不需要 | 删除 |
| `secret_fingerprint` | 对 key 做 SHA256 取前 16 位——用于验证 key 没被改过。单 key 场景，key 是否 Change 看一眼 env var 就行 | 删除 |
| `last_status` | `"ok"` / `"error"` / `"exhausted"`——但 error 字段（`error_last_code` 等）本身就能表达状态：`null` = 正常，有值 = 异常。「ok」只是默认值，不承载实际信息 | 删除 |
| `label` + `auth_type` | label 是显示名，auth_type 从 type.yaml 已知 | 删除 |
| `provider_type` | 与 type.yaml 重复 | 删除 |
| `api_base` | 与 type.yaml 重复，除非用户在 `auth set` 时覆盖 | 仅保留覆盖值，否则不存 |
| `request_count` | 未使用的计数器 | 删除 |

**目标：**
```json
{
  "version": 1,
  "providers": {
    "tencent-tokenhub": {
      "source": "env:TENCENT_TOKENHUB_KEY"
    }
  }
}
```

只保留最小信息：哪个 provider，key 从哪里来（env var）。api_base 从 type.yaml 取，error 状态从 lock.json 里的 per-model 字段取。没有冗余，没有多余抽象。

**影响范围：**
- [ ] `auth.py`：`_load_auth` 兼容新结构，`_save_auth` 写新结构
- [ ] `auth.py`：`_get_active_credential` 不再需要排序/fallback——直接取
- [ ] `auth.py`：删除 `_fingerprint`、`id` 生成逻辑
- [ ] `cli.py`：`auth set` 简化——不再存储 `label`/`priority`/`fingerprint`/`provider_type`/`auth_type`/`api_base`（除非显式覆盖）
- [ ] `cli.py`：`auth list` 输出简化
- [ ] 迁移：旧 auth.json 格式转换（或让用户重新 `diy-llm auth set`）
- [ ] 不再写 `~/.diy-llm/.env`（R6 加载 .env，但不写入——auth set 只写 auth.json）

**状态：** 🔴 待实现

---

### R8: config.json 简化

**当前：**
```json
{
  "version": 1,
  "default_model": {"tencentcloud-tokenhub": "deepseek-v4-flash"},
  "exclude_models": {"tencentcloud-tokenhub": ["deepseek-v3.2"]}
}
```

**问题：**
- `exclude_models`：R5 用 type.yaml 声明模型（白名单模式），不在声明中的模型本来就不会暴露到 `/v1/models`，所以 exclude 机制多余
- `default_model`：嵌套对象没必要——用带 provider 前缀的完整 model ID 即可

**目标：**
```json
{
  "version": 1,
  "default_model": "tencent-tokenhub/deepseek-v4-flash-202605"
}
```

- `default_model`：单个字符串，格式 `provider/model_id`。serve 启动时的 "← default" 标记在这个模型 ID 上
- `exclude_models`：彻底删除。白名单在 provider.yaml，模型下架通过 MODEL_DEPRECATED error 表达

**影响范围：**
- [ ] `_load_config` / `_save_config` 适配新结构
- [ ] `model set/show/unset` 命令适配新格式
- [ ] `model exclude/include` 命令**删除**（功能被 provider.yaml + MODEL_DEPRECATED 替代）
- [ ] `serve` 的 default 标记逻辑适配
- [ ] 迁移旧 config.json

**状态：** 🔴 待实现

---

## 其他改进（非阻塞）

### 测试

当前模块无测试。core 拆分后应覆盖：

- `test_core.py`：provider type 发现、sync 逻辑、merge 方向
- `test_auth.py`：凭据读写、`.env` 加载、fingerprint

---

## 约束

- **GPG 签名**：monorepo 强制，禁止 `--no-gpg-sign`。
- **Python 3.14+**：target 为当前环境版本
- **语言**：文档/CLI 输出用中文 + 技术英文术语。
- **代码风格**：类型标注（`typing.Annotated`）、函数文档字符串（`"""`）、单行 120 字符。

---

## 参考文档

- 模型价格: https://cloud.tencent.com/document/product/1823/130055
- 模型列表: https://cloud.tencent.com/document/product/1823/129605
- LiteLLM config: https://docs.litellm.ai/docs/proxy/configs
- Cyclopts: https://cyclopts.readthedocs.io/
