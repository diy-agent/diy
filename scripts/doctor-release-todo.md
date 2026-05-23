# Doctor 系统 — 多端渲染诊断框架设计文档

> 生成: 2026-05-23，最后更新: 2026-05-23
> 状态: 设计阶段，待开发
> 语言选择: 待定（Py 或 TS，取决于 diyui.py/.ts 的进展）

---

## 1. 定位与分类

### 1.1 Doctor 是什么

Doctor 是一套**通用诊断数据结构 + 多端渲染框架**。它从系统当前实际状态出发，
告诉使用者三件事：

- 这个工作是怎么运行的（机制说明）
- 当前状态是什么、下一步该做什么（状态快照 + 下一步建议）
- 出了什么故障、怎么修（故障诊断 + 可执行命令）

### 1.2 两类使用场景

```
┌─ 开发者自用（sha.sh doctor）─────────────────────┐
│  脚本入口:      sha.sh doctor release             │
│  消费者:        开发者（终端）/ AI agent（--json）  │
│  诊断对象:      diy 项目自身                       │
│                 · release 流程正确性               │
│                 · CI 配置                          │
│                 · 分支状态、依赖一致性             │
│                 · 开发环境就绪检查                  │
│                                                  │
│  实现位置:      scripts/doctor-lib/               │
│                 或 packages/diy-cli/src/doctor/   │
└──────────────────────────────────────────────────┘

┌─ 应用对开发者（diyui doctor）─────────────────────┐
│  入口:          diyui 诊断面板 / marimo notebook   │
│  消费者:        使用 diyui 的开发者                │
│  诊断对象:      用户的应用                         │
│                 · diyui 运行时健康检查              │
│                 · signal 依赖图验证                │
│                 · 组件树一致性                     │
│                 · 性能诊断                         │
│                                                  │
│  实现位置:      packages/diyui.py/src/diyui/      │
│                 或 packages/diyui.ts/src/         │
└──────────────────────────────────────────────────┘
```

### 1.3 入口层次

```
sha.sh doctor <subcommand>  ← 开发者入口，构建/诊断用
  sha.sh doctor release     ← release 流程诊断
  sha.sh doctor ci          ← CI 配置诊断
  sha.sh doctor deps        ← 依赖一致性诊断
  sha.sh doctor env         ← 开发环境就绪检查

diyui 诊断面板               ← 应用诊断入口
  diyui.show_doctor()       ← 运行时健康面板（Panel/GUI）
  marimo doctor notebook    ← 探索性诊断（未来）
```

---

## 2. 核心洞察

### 2.1 不是 bash vs TS/Python 的二选一，而是分层

```
数据采集层（bash 胶水）  →  调用系统命令（gh、jq、git、uv、npm）
      ↓
诊断逻辑层（TS 或 Py）   →  纯函数，可测试，可跨场景复用
      ↓
DoctorReport 数据模型    →  声明式数据结构（7 种渲染原语）
      ↓
多端渲染层              →  同一份模型，多种渲染器
```

### 2.2 诊断报告不是布局问题，是原语问题

诊断报告的本质是**层次化列表 + 严重程度 + 建议**，不需要网格/弹性布局。
一套极少量的渲染原语即可覆盖所有诊断场景。

---

## 3. 核心数据结构: DoctorReport

### 3.1 渲染原语（DoctorNode）

总共 7 种 `kind`，足以覆盖所有诊断场景：

```ts
// 语言无关的类型定义（可用 TS 或 Python pydantic）
interface DoctorNode {
  kind: 'report' | 'section' | 'check' | 'group' | 'info' | 'command';
  level?: 'pass' | 'warn' | 'fail' | 'info';  // 严重程度
  title: string;            // 单行摘要
  detail?: string;          // 多行描述（markdown 格式，含代码块、链接）
  suggestion?: string;      // 建议文本
  command?: string;         // 可执行的修复命令
  children?: DoctorNode[];  // 嵌套子节点
  meta?: Record<string, unknown>; // 渲染器特定扩展（尽量不用）
}
```

`detail` 和 `suggestion` 的区别：
- `detail` — "这到底是什么"（机制说明、当前状态描述）
- `suggestion` — "你该做什么"（下一步建议、修复方案）

### 3.2 示例: 一条检查的多种渲染

**源数据:**
```json
{
  "kind": "check",
  "level": "fail",
  "title": "secret UV_PUBLISH_TOKEN 未配置",
  "detail": "workflow `publish-diyui-py` 需要此 secret 发布到 PyPI。\nrelease-please 的两步机制中，合并 release PR 后会触发此 job。",
  "suggestion": "在 https://pypi.org/manage/account/token/ 创建 token，然后运行:",
  "command": "gh secret set UV_PUBLISH_TOKEN --repo your/repo"
}
```

**终端渲染（默认）:**
```
  ✗ secret UV_PUBLISH_TOKEN 未配置
    workflow publish-diyui-py 需要此 secret 发布到 PyPI。
    release-please 的两步机制中，合并 release PR 后会触发此 job。
    → 在 https://pypi.org/manage/account/token/ 创建 token，然后运行:
    → gh secret set UV_PUBLISH_TOKEN --repo your/repo
```

**JSON 渲染（--json，AI 消费）:**
```json
{"kind":"check","level":"fail","title":"secret UV_PUBLISH_TOKEN 未配置","detail":"workflow publish-diyui-py 需要...","command":"gh secret set UV_PUBLISH_TOKEN --repo your/repo"}
```

**Panel 渲染（GUI）:**
```python
pn.Card(
    pn.pane.Markdown("## ✗ secret UV_PUBLISH_TOKEN 未配置"),
    pn.pane.Markdown("workflow 需要此 secret 发布到 PyPI"),
    pn.widgets.Button(name="复制修复命令", description="gh secret set UV_PUBLISH_TOKEN ..."),
    title="凭证检查",
    collapsed=False,
    header_background="#fdd",
)
```

### 3.3 kind 与渲染器的映射契约

| kind | 终端 | JSON（AI） | Panel / GUI |
|---|---|---|---|
| `report` | 顶部标题 + 摘要统计 | 顶层对象 | `pn.Column` / 整体容器 |
| `section` | `── 标题 ──` | `sections[]` | `pn.Card(title=..., collapsible=True)` |
| `check` pass | `  ✓ title` 绿 | `{level:"pass", ...}` | 绿色行 |
| `check` warn | `  ⚠ title` 黄 | `{level:"warn", ...}` | 黄色行 |
| `check` fail | `  ✗ title` 红 | `{level:"fail", ...}` | 红色行，自动展开 |
| `info` | `    text` 灰 | `{kind:"info", ...}` | `pn.pane.Markdown` |
| `command` | `  → cmd` 灰 | `{kind:"command", ...}` | 可点击复制按钮 |
| `group` | 缩进嵌套 | `children[]` | `pn.Row` |

---

## 4. 分层架构

### 4.1 数据采集层（bash 胶水）

每个 doctor 子命令有自己的采集脚本，薄壳 ~50 行：

```bash
# scripts/doctor/release.sh  → 只做数据采集
#   1. 调用 gh、jq、git 采集原始数据
#   2. 传给诊断逻辑层（TS/Py 模块）
#   3. 根据 --json 选择渲染器输出

# scripts/doctor/ci.sh
# scripts/doctor/deps.sh
# scripts/doctor/env.sh
```

`sha.sh` 中注册：
```bash
# sha.sh
doctor() {
  local sub="${1:-}"
  case "$sub" in
    release) bash scripts/doctor/release.sh "${@:2}" ;;
    ci)      bash scripts/doctor/ci.sh "${@:2}" ;;
    deps)    bash scripts/doctor/deps.sh "${@:2}" ;;
    env)     bash scripts/doctor/env.sh "${@:2}" ;;
    *)       echo "用法: sha.sh doctor {release|ci|deps|env}" ;;
  esac
}
```

### 4.2 诊断逻辑层（TS 或 Py — 纯函数）

```
doctor-lib/                      # 实现位置待定
                                 # 可能: scripts/doctor-lib/
                                 # 可能: packages/diy-cli/src/doctor/
  types.ts                       # DoctorNode 类型定义（所有医生共用）
  renderers/
    terminal.ts                  # 终端彩色树形渲染器
    json.ts                       # JSON 序列化（trivial）
  release/                       # release 流程诊断
    config-check.ts              # 配置文件完整性
    version-consistency.ts       # 逐包版本一致性
    github-actions.ts            # workflow 运行状态 + 两步机制说明
    secrets.ts                   # 凭证检查
    branch-cleanup.ts            # 远程分支/PR 清理建议
    index.ts                     # 聚合: runReleaseDiagnostics() → DoctorNode
  ci/                            # CI 配置诊断
  deps/                          # 依赖一致性诊断
  env/                           # 开发环境就绪检查
```

每个诊断模块签名：
```ts
// 输入: 运行时采集的原始数据
// 输出: DoctorNode（section 子树或 check 列表）
function checkConfigFiles(rawData: { configPath: string; config: ParsedConfig }): DoctorNode[]
```

### 4.3 渲染层

```
renderers/
  terminal.ts      # 终端彩色树形文本（开发者默认）
  json.ts           # JSON 序列化（AI 消费: sha.sh doctor release --json）
  panel.py          # Panel UI 组件树（diyui 诊断面板）
  marimo.py         # marimo notebook cell（探索性诊断，未来）
```

---

## 5. AI 可见性设计

### 5.1 三层可读性

```
AI 最易消费  →  JSON 输出（--json）
                结构化，每个字段有明确含义
                command 字段可供 AI 直接提议执行

AI 可读      →  终端文本输出
                通过标准 ✓/✗/⚠ 符号和缩进结构
                可 grep，但不如 JSON 精确

AI 不可读    →  GUI 渲染（Panel / marimo）
                AI 应通过 JSON 接口读取，不解析 UI
```

### 5.2 给 AI agent 的 skill

```markdown
# skill: diy-doctor
用于诊断 diy 项目状态。
触发词: "诊断"、"检查"、"发布流程"、"release 失败"

命令:
  sha.sh doctor release --json   # JSON 输出，AI 解析
  sha.sh doctor ci --json
  sha.sh doctor deps --json
```

---

## 6. 代码与文档的统一

### 6.1 原则: 代码嵌文档，非文档嵌代码

诊断的概念说明、工作原理、范例都放在代码的文档注释中：

```ts
/**
 * # 配置文件检查
 * 
 * release-please 依赖两个 JSON 配置文件:
 * - `.release-please-config.json` — 定义包路径、发布策略
 * - `.release-please-manifest.json` — 记录每个包的当前版本
 * 
 * ## 工作原理
 * 每次 push main 时，release-please-action 读取这两个文件，
 * 扫描自上次 tag 以来的 conventional commits 决定是否创建 release PR。
 * 
 * ## 两步机制
 * ① push 触发 → 检测 conventional commits → 开 release PR
 * ② 合并 PR → 打 tag + 创建 GitHub Release → 触发发布 job（如 PyPI）
 */
export function checkConfigFiles(...): DoctorNode[] { ... }
```

终端渲染时，JS doc 的顶部注释自动提取为 section 的 `detail`（或生成一条 `info` 节点）。

### 6.2 流程图: 同目录 .mmd

只有当代码确实无法表述（如多步骤异步状态机）时才用独立文件：

```
doctor-lib/release/
  workflow.mmd       ← mermaid 格式，与诊断逻辑同目录
```

### 6.3 为什么

- 修改代码时文档在同一个 diff 里 — 不会忘记更新
- 删除废弃功能时文档随之消失 — 不会有僵尸文档
- AI 读代码时自然读到描述 — 不需要额外文件上下文
- 重构时描述跟着走 — 不会出现文档指向已失效函数

---

## 7. 多消费者设计

```
消费者              入口             格式          DoctorNode 渲染器
───────────────────────────────────────────────────────────────
开发者终端           sha.sh doctor    彩色文本      terminal.ts
AI agent            --json 参数       compact JSON  json.ts
CI 检查              sha.sh doctor    退出码+文本   terminal.ts (exit 0/1)
开发者深度排查        marimo notebook 表格/图表     marimo.py (未来)
diyui 应用开发者     diyui 诊断面板    GUI 组件     panel.py
```

所有消费者共享同一份 `DoctorNode` 树，只是渲染器不同。

---

## 8. 渲染器实现要点

### 8.1 终端渲染器

- 颜色: pass=绿, warn=黄, fail=红, info=灰（复用 sha.sh 的 M3 配色变量）
- 缩进: 每个 nesting level +2 空格
- `command` 自动加 `→ ` 前缀
- 报告自动统计 pass/warn/fail 计数
- 默认只展开 fail 和 warn 的 detail，pass 折叠
- `--verbose` 展开所有 detail

### 8.2 JSON 渲染器

- 直接 serialization，AI agent 消费
- compact 格式（不换行不缩进），减少 token 消耗
- `command` 字段让 AI 可直接提议执行

### 8.3 Panel 渲染器

- import JSON 格式的 DoctorNode
- `section` → `pn.Card(title=..., collapsible=True)`
- `check` fail → 红色卡片，自动展开 detail
- `check` pass → 绿色行，lazy 展开
- `command` → `pn.widgets.Button` 可点击复制
- 利用 diyui 的 `Signal<T>` 实现 Live 刷新: 后台定时重跑诊断 → UI 自动更新

---

## 9. 实施顺序

### Phase 0: 设计确认（当前）
- [ ] 决定实现语言（Py 还是 TS？取决于 diyui.py/.ts 的进展）
- [ ] 确认 DoctorNode 类型覆盖现有 `doctor-release.sh` 所有诊断场景

### Phase 1: 核心类型 + 终端渲染器
- [ ] 实现 `DoctorNode` 类型定义（TS 或 pydantic）
- [ ] 实现终端渲染器（~100 行）
- [ ] 把 `doctor-release.sh` 的 config-check 诊断用新框架重写
- [ ] `sha.sh` 中注册 `doctor` 命令

### Phase 2: JSON + CI 集成
- [ ] JSON 渲染器
- [ ] CI 集成（退出码映射）
- [ ] 逐模块迁移剩余 release 诊断逻辑

### Phase 3: 开发者自用诊断扩展
- [ ] `sha.sh doctor ci` — CI 配置诊断
- [ ] `sha.sh doctor deps` — 依赖一致性
- [ ] `sha.sh doctor env` — 开发环境就绪

### Phase 4: 应用诊断（diyui）
- [ ] Panel 渲染器（导入 JSON → Panel 组件树）
- [ ] diyui + Signal 实现 Live 刷行诊断仪表盘
- [ ] marimo notebook（如需要探索性诊断）

---

## 10. 关键决策记录

### 为什么入口是 `sha.sh doctor` 而非 `diy doctor`
`sha.sh` 是开发脚本入口，面向我自己（开发者）。release、CI、deps、env 都是开发内部事务，不应暴露给 `diy-cli` 的普通用户。诊断框架本身是通用的，两类入口共享同一个 `DoctorNode` 类型和渲染器。

### 为什么不用 markdown 嵌入代码（如 quarto）
代码是活的、markdown 是死的。代码嵌 markdown 保证修改代码时文档同步更新；
markdown 嵌代码无法执行，容易过时。

### 为什么不是测试用例形式
测试用例适合"这个检查应返回 fail/pass"，不适合"这是什么、现在状态是什么、下一步该做什么"。
测试用例是验证诊断逻辑的，不是替代诊断报告的。

### 为什么 marimo 只是渲染层之一
marimo 不适合作为诊断逻辑的唯一存放处:
- 无法 CI 集成
- AI 无法直接阅读（只能读 cell 源码）
- git diff 困难
- 优势是探索性数据诊断，适合做渲染器，不适合做逻辑存放处

### DoctorNode 为什么不用更复杂的 UI 模型
诊断报告的 UI 需求是层次化列表，不需要 Flex/Grid/定位等自由布局。
保持原语极简（7 种）的收益是每个渲染器都 ~100 行，总复杂度可控。

---

## 11. 参考实践

- **Panel param**: 根据字段类型自动生成对应 widget（`param.Integer` → `IntSlider`）
- **applab `_param_model.py`**: `UIField` / `TextField` 作为类型标记，驱动渲染
- **现有的 `scripts/doctor-release.sh`**: 所有诊断逻辑的参考实现（562 行，待迁移）
- **diyui provider/panel.py**: Panel 组件包装模式，diyui 响应式模型（Signal + ScopeNode）
- **sha.sh M3 配色**: `sha.common.sh` 已定义 pass/warn/fail/info 语义颜色，终端渲染器复用
