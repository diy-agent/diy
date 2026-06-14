# diy-llm

配置同步 — provider 模型信息 → PI agent / Hermes。

CLI → credential pool → model sync → export。
目标：统一管理多个上游渠道（TokenHub、TokenPlan、HyTokenPlan 等），把 provider 配置同步到下游 PI agent 和 Hermes。

## 架构

```
provider.yaml  →  providers/*.json  →  export → PI agent / Hermes
  (模型白名单)      (source+api_base+models)  (models.json / config.yaml)
```

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

**模型 ID 格式：** `tencent-tokenhub/deepseek-v4-flash-202605`

**影响范围：**
- [x] `src/diy_llm/providers/tencentcloud-tokenhub/` → 重命名为 `tencent-tokenhub/`
- [x] `provider.yaml` 内 `type` 字段改为 `tencent-tokenhub`
- [x] `~/.diy-llm/providers/tencent-tokenhub.json` 中的 `source`/`api_base` 重新 auth set
- [x] 所有文档中的引用

**状态：** ✅ 已完成 (2026-06-14)

---

### R2: provider.yaml 统一模型定义

**当前：** 原拆成 `type.yaml`（auth/protocol） + `models.defaults.json`（模型元数据）
**问题：** 两个文件两种格式描述同一件事；"defaults" 暗示可覆盖，实际是 API 事实

**目标：** 模型元数据并入 `provider.yaml` 的 `models:` 段，一个 provider = 一个 YAML 文件。详见实际文件 `src/diy_llm/providers/tencent-tokenhub/provider.yaml`。

**字段角色：** 以上字段是 API 事实，不可被用户覆盖。`max_tokens` 和 `enabled` 是客户端参数，放在 state 文件的 `editable` 块。merge 策略见 `core.py:ensure_state()` 的 docstring。

**影响范围：**
- [x] 模型定义并入 `provider.yaml` 的 `models:` 段
- [x] 删除 `models.defaults.json` 文件
- [x] 所有文档中的引用更新

**状态：** ✅ 已完成 (2026-06-14)

---

### R3: core 模块拆分

**当前：** 所有逻辑在 `cli.py`（731 行），包含：
- credential 管理（读写 provider state 文件）
- model sync（`ensure_state`, `fetch_model_ids`）
- state 管理（读写 providers/*.json）
- provider 发现
- Cyclopts CLI 定义

**问题：** GUI（后续 PySide6 系统托盘）无法复用这些逻辑。

**目标结构：**

```
src/diy_llm/
├── __init__.py
├── cli.py              # 薄 CLI 层（Cyclopts app 定义 + 命令 handler）
├── core.py             # 核心：provider 发现、sync、state 管理
├── auth.py             # 凭据管理：读写 provider state 文件（无独立 auth.json）
├── export.py           # 导出：PI agent / Hermes 配置同步
├── providers/          # provider 类型定义
│   └── tencent-tokenhub/
│       ├── provider.yaml
│       └── AGENTS.md
```

**core.py 导出函数：**

```python
# 供 CLI 和 GUI 使用
def discover_provider_types() -> dict[str, Path]
def load_provider_type(ptype: str) -> dict | None
def load_state(provider_name: str) -> dict | None
def save_state(provider_name: str, state: dict) -> None
def ensure_state(name: str, api_base: str, api_key: str, ptype: str) -> tuple[dict, str]
def fetch_model_ids(api_base: str, api_key: str) -> list[str] | None
def get_enabled_models(name: str) -> dict[str, dict]
```

**auth.py 导出函数：**

```python
def get_provider_auth(name: str) -> dict | None
def set_provider_auth(name: str, source: str, api_base: str) -> None
def remove_provider_auth(name: str) -> None
def list_providers_with_auth() -> dict[str, dict]
def resolve_api_key(source: str) -> str | None
def load_dotenv() -> None
def has_credential(name: str) -> bool
```

**cli.py 保持轻量：** 每个命令仅调用 core/auth/export 的函数，处理参数→函数→输出映射

**影响范围：**
- [x] 创建 `core.py`，迁移 sync 等逻辑
- [x] 创建 `auth.py`，迁移凭据管理逻辑
- [x] 创建 `export.py`，迁移 PI agent / Hermes 配置同步逻辑
- [x] `cli.py` 简化为命令注册 + core/auth/export 调用的薄层
- [x] 更新 `pyproject.toml` entry points

**状态：** ✅ 已完成 (2026-06-14)

---

### R4: 模型可见性控制

**需求：**

1. **只有 provider.yaml 中声明的模型，才暴露给下游。**
   - 可见模型 = provider.yaml 中声明 + state 中 `enabled=true` + state 中 `status != "error"`
   - 不在 provider.yaml 中的上游模型不自动暴露

2. **sync 时，若上游下架了模型，在用户 state 中标记 `error: {code: "MODEL_DEPRECATED", message: "上游已下架，不再建议使用"}`。**
   - 这是用户数据出现了错误——上游不认这个模型了
   - 语义：**废弃**（deprecated），前端展示黄色警告
   - state 保留条目，不自动删除（用户下游配置可能引用）

3. **MODEL_DEPRECATED 的模型不自动删除。**
   - `status` 变为 `"error"`，export 跳过
   - 用户通过 `diy-llm model clean <provider>` 手动删除
   - 如果上游恢复了这模型，sync 清除 error，status 回到 `"ok"`

**state.json 范例（模型被下架后的状态）：**

```json
{
  "deepseek-v4-flash-202605": {
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
- [x] sync 检测 upstream 不含某模型 → 标记 `MODEL_DEPRECATED`
- [x] export 过滤 `status == "error"` 的模型
- [x] `diy-llm model list` 显示 `⚠ 废弃`
- [x] `diy-llm model clean <provider>` 删除废弃模型
- [x] 上游没有 `/v1/models` 时不标记任何模型为 error

**状态：** ✅ 已完成 (2026-06-14)

---

### R5: .env 文件加载

**当前：** `~/.diy-llm/.env` 在 `auth set` 时被写入，但从未被加载到环境变量中。

**问题：** `sync` 命令依赖 `env:VAR_NAME` 来源解析 API key，但若用户把 key 写在 `~/.diy-llm/.env` 里（而不是 shell profile），这些命令看不到。

**目标：** 参考 Hermes 的 `.env` 加载方式，在 core/auth 初始化时自动加载：

```python
# auth.py
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

**状态：** ✅ 已完成 (2026-06-14)

---

### R6: auth.json 删除，认证并入 provider state 文件

**已变更 → 并入 `~/.diy-llm/providers/*.json`：**

```json
{
  "version": 1,
  "updated_at": "2026-06-14T07:58:11+0800",
  "provider": "tencent-tokenhub",
  "provider_type": "tencent-tokenhub",
  "source": "env:TENCENT_TOKENHUB_KEY",
  "api_base": "https://tokenhub.tencentmaas.com/v1",
  "models": { ... }
}
```

**设计理由：** 和 Hermes 一致——provider 的认证信息天然属于 provider 配置，不应拆成两个文件。

**状态：** ✅ 已完成 (2026-06-14)

---

### R7: config.json 简化

**目标：**
```json
{
  "version": 1,
  "default_model": "tencent-tokenhub/deepseek-v4-flash-202605"
}
```

- `default_model`：单个字符串，格式 `provider/model_id`
- `exclude_models`：彻底删除。白名单在 provider.yaml，模型下架通过 MODEL_DEPRECATED error 表达

**状态：** ✅ 已完成 (2026-06-14)

---

## 其他改进

### 测试

- `test_core.py`：provider type 发现、sync 逻辑、merge 方向
- `test_auth.py`：凭据读写、`.env` 加载
- `test_diy_llm_intent.py`：intent tests

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
- Cyclopts: https://cyclopts.readthedocs.io/
