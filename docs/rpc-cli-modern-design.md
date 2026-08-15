# 评估：diy RPC-CLI 体系 vs 业界最新 CLI 最佳实践 + 完整现代 CLI 结构设计

日期：2026-08-11　分支：`feat/cli-meta-gen`（worktree: `../diy-feat-cli-meta-gen`）
依据：CLIG (Command Line Interface Guidelines, clig.dev) 全 18 章 + 当前 diy 代码事实源
（`pkgs.ts/diy-rpc/src/cli/*`、`pkgs.ts/diy-app/src/cli/index.ts`、`api-def.ts`、py `_forward.py`）

---

## 一、一句话结论

当前 diy CLI 的**骨架已经站在现代 CLI 的肩上**——单一事实源（RPC meta 反射）+ 强类型 + 与 RPC 天然一体，这是绝大多数 CLI 没有的架构优势。但**皮囊还停在 1990 年代**：help 无示例、无拼写建议、无交互感知、无 TTY/颜色控制、exit code 不细分。RPC 并发执行这个差异化能力**完全没有暴露给用户**（当前是「一进程一命令」的死板形态）。

评估的价值不在补丁式修 help，而在把「RPC 原生 + 并发执行」这个根本差异，从**内部机制**升级为**一等用户特性**。

---

## 二、业界最新 CLI 最佳实践盘点（CLIG 基准）

CLIG 是 2024-2025 公认最权威的 CLI 设计指南（Docker Compose 作者主导）。核心原则与 guideline 提炼：

### 哲学层（决定 CLI 气质）
| 原则 | 要点 | 对 diy 的含义 |
|------|------|-------------|
| Human-first | 命令主要给人用，不是给程序 | 输出要友好，不只 JSON |
| Simple parts that work together | 可组合、可管道、可脚本化 | `--json`/`--plain` 机器可读，stdout/stderr 纪律 |
| Consistency | 跨命令、跨程序一致 | 统一 flag 命名、统一输出格式 |
| Ease of discovery | 帮用户发现功能 | help 要全、要有示例、要能猜 |
| Conversation as norm | CLI 是对话，试错-纠错循环 | 错误要可理解、要建议正确命令 |

### 操作层 guideline（CLIG Guidelines 全 18 节，最相关的 12 节）

**The Basics（底线，必须）：**
1. 用参数解析库 ✅（diy 自研 parser，等价）
2. 成功 exit 0，失败非 0 ⚠️（diy 只有 0/1，未细分失败模式）
3. 主输出 → stdout ✅
4. 消息/日志/错误 → stderr ✅

**Help（帮助）：**
5. `-h`/`--help` 显示**全面**帮助 ✅
6. 默认（无参数）显示**简洁**帮助 ✅
7. **Lead with examples** ❌ —— diy 完全无示例！CLIG 反复强调「用户最依赖示例」
8. 常见命令/flag 放 help 开头 ✅
9. 错误时**猜用户想说什么**（did-you-mean）❌ —— `Unknown command: xyz` 无建议
10. 命令期望 stdin 但 stdin 是 TTY 时，立即显示 help 而非挂起 ❌
11. `myapp help subcommand` 也提供帮助 ⚠️（diy 只有 `subcommand --help`）

**Output（输出）：**
12. Human-readable 为主，TTY 检测 ❌
13. 机器可读不损害可用性 → `--plain`/`--json` ✅（diy 有 `--json`，无 `--plain`）
14. 改状态要告知用户 ✅（`{status:'ok', data:{uri}}`）
15. **NO_COLOR**/非 TTY 禁色、`--no-color` ❌
16. 非 TTY 不显示动画/进度条 ❌
17. 大量文本用 pager (`less -FIRX`) ⚠️（无）
18. stderr 不当日志文件用（默认不打 ERR/WARN 标签）⚠️

**Errors（错误）：**
19. 捕获并改写成人类可读 ❌（`Error: ${msg}` 直接透传，stack 仅 dev 模式）
20. 信噪比——同类错误分组 ❌
21. 意外错误给 debug + 提交 bug 指引 ⚠️

**Arguments and flags：**
22. 优先 flags 而非 positional args ✅（diy 区分 cliArg/cliOption）
23. 全名 + 短名都要 ✅（`-p, --parent`）
24. 单字母 flag 只用于常用项 ⚠️
25. 两个以上 positional args 多半是设计问题 ⚠️
26. 用标准 flag 名（`-a/--all`、`-f/--force`、`-q/--quiet`、`--json`）⚠️
27. 默认值给大多数用户最佳体验 ✅
28. **--no-input** 关闭所有交互 ❌
29. 危险操作确认 / `-f` 强制 ⚠️（py 侧有部分）
30. **flag/args/subcommand 顺序无关** ⚠️（diy 位置参数需在 option 前，见 parser 循环）
31. 不从 flag 读 secret ❌（暂无关，但应立规矩）

**Interactivity：**
32. 仅当 stdin 是 TTY 才交互 ❌（`stdinAsync` 直接 `createInterface`）
33. `--no-input` 时完全不交互 ❌
34. 密码不回显 ⚠️（暂无关）
35. 让用户能逃逸（Ctrl-C 始终可用）⚠️

**Subcommands：**
36. 跨子命令一致 ✅（同 meta 反射）
37. 多层子命令用 `noun verb` 一致命名 ✅（`task create`、`subject add`）
38. 不要含糊/相近命令名 ⚠️

**Robustness：**
39. 校验输入 ✅（zod parse）
40. 响应性 > 快速（<100ms 出点东西）❌
41. 长操作显示进度 ❌
42. 并行但注意输出交错 ✅/⚠️（并发是这个项目独有的优势，见下）
43. 网络超时可配置、合理默认 ❌（`CallOptions.timeout` 有但 CLI 未暴露）
44. 可恢复（up+enter 重跑）⚠️
45. crash-only / 幂等 ⚠️

**Future-proofing：**
46. 加性变更优先 ⚠️
47. 破坏性变更前警告 ⚠️
48. 输出对人类可改（鼓励脚本用 `--plain`/`--json`）✅
49. 不要 catch-all 子命令 ❌
50. **不要子命令任意缩写** ⚠️（`_routeResolve` 是精确匹配，好）

**Configuration / Env：**
51. XDG-spec ⚠️（diy 用 `~/.diy` DIY_HOME，不走 XDG）
52. 配置优先级 flags > env > project > user ⚠️
53. env 只放「运行环境相关」⚠️

**Naming：**
54. 短而好打、不太泛 ⚠️

---

## 三、diy 的差异化：RPC 原生 + 并发执行（当前未被利用）

这是 diy 与所有传统 CLI（git/gh/heroku/clap/oclif）的本质区别，也是本次设计的核心。

### 传统 CLI 的架构（隐含约束）
```
进程 = 一次命令执行
  启动 → 解析 → 执行 → 输出 → 退出
每次调用都新起进程，状态靠文件/环境变量传递
并发 = 多进程，各管各的，无共享状态
```
CLIG 的所有 guideline 都是围绕「一次性进程」这个模型设计的——所以才有「一进程一命令、退出码、stdout/stderr 纪律」这些概念。

### diy 的架构（RPC 原生）
```
进程（CLI gateway）= 常驻 RPC 客户端
  CLI 进程连 app 进程的 RPC 端口 → 发命令 → 收结果
  命令在 app 进程执行，CLI 只是透传/代理
并发 = 天然多路复用（HTTP/2 或内存 transport 一个连接承载多命令）
```
py 侧已体现：`forward_to_app` 锁内双检 socket，命令走 `_send_to_socket`；TS 侧 `cli/index.ts` 读 `app.port` → `HttpClientBinding`（HTTP/2，天然并发多路复用），端口不可达回退 `createMemTransportPair` 本地执行。

**并发执行的真正含义（当前未暴露）：**
1. **命令在 app 常驻进程内执行** —— 不是冷启动一个进程，共享 app 的运行态（state.yaml、task 树、LLM 连接池、已有 handler 实例）。
2. **多个 CLI 命令可并发跑在同一 app 进程** —— HTTP/2 多路复用，一个连接发多个请求。这远超「并行 fork 进程」。
3. **CLI 是代理，不是实现** —— CLI 进程本身零业务逻辑，`task create` 在 app 进程内执行 handler。CLI 可以做极薄的体验层。
4. **常驻连接意味着有 session/状态** —— 可做「连接级上下文」：当前 task、当前 subject、profile 隔离（clig 的 multiple-isolated-sessions）。

### 当前 CLI 没利用这个差异的具体表现
| 传统能力 | diy 现状 | 本可做到 |
|---------|---------|---------|
| 一命令一进程 | CLI 进程连一次就退出 | CLI 常驻，多命令复用连接 |
| 无跨命令状态 | 无 | 连接级 session：`--context task=<uri>` |
| 并发 | 用户没法用 | 显式 `--parallel` 命令组并发 |
| 长任务进度 | 无 | server-stream 已支持但 CLI 未展示进度 |
| 交互 | stdinAsync 直读 | 交互会话复用 RPC 连接，双向流 |

---

## 四、完整的现代 rpc-cli 体系设计

### 设计原则（对齐 CLIG + 发扬 RPC 差异）

1. **CLI 是薄代理 + 体验层**，所有逻辑在 app 进程（RPC handler）。CLI 只做：argv→RPC 映射、输出格式化、交互体验。
2. **单一事实源不破**：命令树/参数/帮助全部从 RPC meta 反射，绝不手写第二份 CLI 定义。
3. **并发是默认能力**：CLI 进程复用连接，支持多命令、并行组、长任务流。
4. **CLIG 逐条对齐**：help 带示例、did-you-mean、TTY/颜色控制、--no-input、stdin 检测、exit code 细分。

### 分层结构（现代 rpc-cli 应有四层）

```
┌─────────────────────────────────────────────────────────┐
│ L0 呈现层（CLI 进程内）                                  │
│    argv 收集 → transport 选择(HTTP2/mem) → CliApp.parse │
│    输出格式化(人性化/JSON/plain) + TTY/颜色 + pager      │
│    [ 每进程一个，薄，无业务逻辑 ]                        │
├─────────────────────────────────────────────────────────┤
│ L1 协议层（RPC wire）                                    │
│    unary / server-stream / client-stream / bidi          │
│    CLI 命令 → 具体 RPC 调用（method = proc.path）        │
│    并发：一个 ClientBinding 承载多命令（HTTP/2 复用）    │
├─────────────────────────────────────────────────────────┤
│ L2 语义层（app 进程内）                                  │
│    RpcServer / Router / Handler 表（来自 api-def）       │
│    命令 = RPC procedure，handler 即命令实现              │
├─────────────────────────────────────────────────────────┤
│ L3 域模型层（app 进程内）                                │
│    task/subject/ref/agent 业务逻辑 + state.yaml          │
└─────────────────────────────────────────────────────────┘
```

### 要补齐的模块（按 CLIG 缺口 + 并发差异）

**A. Help 现代化（最高优先，CLIG 缺口最多）**
1. **Examples**：`ProcedureMeta` 加 `examples?: string[]` 字段，help 里每个命令显示 `$ diy task create "标题" --subject <path>`。CLIG 头号建议。
2. **did-you-mean**：`_routeResolve` 未命中时，对 argv[0] 做编辑距离/前缀匹配，输出 `Did you mean: task create?`。
3. **`diy help <subcommand>`**：等价 `diy <subcommand> --help`。
4. **stdin 交互检测**：命令需要 stdin（client/bidi mode）但 stdin 是 TTY 且无重定向 → 显示 help 提示而非挂起。
5. **`diy` 裸命令 + 无参数 → 简洁 help**（已有，但补 examples 一行 + `--help` 指引）。

**B. 输出现代化**
6. **TTY 检测 + NO_COLOR + `--no-color`**：非 TTY / NO_COLOR / TERM=dumb 禁色；`--json` 时强制禁色。
7. **`--plain`**：表格/美化输出拆行时提供 `--plain` 一行一记录。
8. **pager**：`--json` 之外，大量文本输出用 `less -FIRX`（仅 TTY 时）。
9. **exit code 细分**：`CliParseError`→2（用法错误）、RPC 业务错误→按 code 映射、成功→0。

**C. 并发 & 长任务（发扬 RPC 差异，diy 独有）**
10. **连接复用 / 常驻会话**：CLI 进程读完 argv 后不立即退出，支持 `--session` 交互 REPL（复用同连接）。至少做到「一次 CLI 调用 = 一次连接，多命令可脚本内串行复用」。
11. **连接级上下文**：可选 `--context task=<uri>|subject=<path>`，注入 RPC 调用的 meta/header，命令省略当前上下文参数（对齐 py `dai ui task detail` 设 `_current_task_uri` 的模式）。
12. **并行命令组**：`--parallel` 让多个命令同时发（依赖 HTTP/2 多路复用），`diy task list --parallel subject list` 合并输出。这是传统 CLI 做不到的。
13. **长任务进度**：server-stream 模式的命令（如 `agent stream`、`ref sync`）在 TTY 下显示进度/spinner，非 TTY 逐行输出。

**D. 输入 & 安全（CLIG 明确要求）**
14. **`--no-input`**：非 TTY 时自动不交互；交互命令给 flag 替代。
15. **危险操作确认**：`task delete` 等 destructive 命令，TTY 下确认，脚本用 `-f/--force`。
16. **secret 纪律**：立规——RPC 参数里带 secret 的字段不接受 CLI flag（如 `--password`），只走 stdin/文件。当前 LLM apiKey 类需标注。

**E. meta 反射补强（衔接第一轮评估的增量点）**
17. zod `.description` 回退到 help（消除双描述源）。
18. `ProcedureMeta.summary/description` 接入 showHelp。
19. `inferTypeName` 补 object/union。
20. 命令级 Usage 用 cliRootPath 裁剪后的短名。

---

## 五、优先级排序与落地顺序（增量，先跑通再组合）

| 序 | 改动 | CLIG 节 | 价值 | 成本 |
|----|------|--------|------|------|
| 1 | zod `.description` 回退 + `summary/description` 接入 | Help | 中 | 极小 |
| 2 | **Examples**（meta 加字段 + help 渲染） | Help | 高 | 小 |
| 3 | **did-you-mean**（route 未命中编辑距离） | Help | 高 | 小 |
| 4 | TTY 检测 + NO_COLOR + `--no-color` + `--json` 禁色 | Output | 中 | 小 |
| 5 | exit code 细分（usage=2） | Basics | 中 | 小 |
| 6 | stdin 交互检测（client/bidi + TTY → help） | Help/Interactivity | 中 | 小 |
| 7 | `--no-input` | Interactivity | 中 | 小 |
| 8 | **连接复用/常驻 + 连接级上下文 `--context`** | (并发差异) | 高 | 中 |
| 9 | server-stream 进度显示 | Robustness | 中 | 中 |
| 10 | **`--parallel` 并行命令组** | Robustness | 高(独有) | 中-大 |
| 11 | `--plain` / pager | Output | 低 | 小 |
| 12 | 危险操作确认 `-f/--force` | Arguments | 低-中 | 中 |
| 13 | 命令级 Usage 短名 | Help | 低 | 极小 |

**建议落地顺序**：1→2→3→4→5→6（纯 CLI 呈现层，全在 `_parser.ts`/`cli/index.ts`，不动 RPC wire，低风险）→ 8（连接复用，动的点是 `cli/index.ts` 的 transport 生命周期）→ 9/10（并发特性，动 handler 调用方式）→ 其余。

1-7 是「补现代 CLI 皮囊」，不改架构；8-10 才是「发扬 RPC 并发差异」，是本项目区别于所有传统 CLI 的价值点，应重点投入。

---

## 六、不做的事（明确边界）

- **不做手写 CLI 定义**：绝不为追求帮助美观而另起一套手写 help/命令表，破坏单一事实源。一切从 meta 反射，缺的字段往 meta 加。
- **不引入外部 CLI 框架**（oclif/commander/clap）：diy 的 parser 已经是「zod schema 反射」这个现代思路，比任何框架都贴合「单一事实源」。引入框架会带回手写定义。
- **不做真 REPL/TUI**（除非用户明确要）：会话复用是「连接复用 + 循环读 argv」，不是全屏 TUI。
- **并发不做复杂调度**：`--parallel` 是「同一连接并发发多个 unary，结果分节输出」，不做任务依赖图/取消编排（那是 app 进程 handler 内部的事，不是 CLI 层）。

---

## 七、结论

diy 的 RPC-CLI 体系**架构底子是现代的，但表现层缺现代 CLI 的皮囊，且最独特的并发能力还没露出来**。价值最高的三步：
1. **help 现代化**（examples + did-you-mean + TTY/颜色）——CLIG 缺口，纯表现层，风险最低，立竿见影；
2. **连接复用 + 连接级上下文**——把「命令在常驻 app 进程执行」这个根本差异变成用户可感知的会话体验；
3. **`--parallel` 并发命令组 + 长任务进度**——传统 CLI 做不到的，利用 HTTP/2 多路复用的独有能力。

若认可方向，建议从第 1 步（1→7，纯呈现层）在当前 worktree 落地并跑 diy-app 意图测试，验证无回归后，再谈 8-10 的并发特性。
