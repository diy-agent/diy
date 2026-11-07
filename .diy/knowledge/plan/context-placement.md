---
desc: 提示词落点研究：缓存前缀 / 三通道 / 易变内容挪出 system 的验收需求
updated: 2026-10-22
---

## cache-defect

`diy` 把**每轮都可能变**的内容（`<task>` 正文、`<project_context>` 链）放在 **leading system 前缀**里 —— 任务正文一改，整个前缀失配（provider 前缀缓存按**首条消息字节**匹配）。参考实现实测：切换点 uncached 输入 14.7k → ~300 tokens（**约 50×**）。这不是「缺动态上下文」的小优化，而是**长会话的主要成本项**。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:10）

## constraints

四条语义约束（决定落点，不只为缓存）：① in-history system 必须是**完整 prompt**，不能是 delta（模型把最新 system 当完整提示，delta 会静默丢掉未变段）；② system 必须排在**该步 user 输入之前**；③ 清空要清**所有活跃 system 节点**（只清最新会让旧 prompt 复活）；④ node 0 受保护、不可被压缩/遮蔽，后续 system 节点可。代理层改写/重排 system 会静默破坏语义 —— 真实 API 的 cache-hit e2e 是唯一探测器。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:96）

## diy-gap

`diy` 现状（`_system.md`：identity → diy → project → task → rules → skills → guard，全部一条 leading system，每轮全量重算）：`identity`/`diy`/`rules`/`_guard` 不变 ✅ 留 system；`project.md` 的 `<project_context>`（随 AGENTS.md 变）偶尔变 ⇒ 应挪；`task.md`（`task.body` 用户随时改、`cwd.*` 随回退变）**每轮可能变** ⇒ 必须挪到尾部 user 快照；`skills.md` 会话内基本不变 ⇒ system 可接受。病根 = **把易变内容放在最贵的位置**。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:164）

## measured

实测数字（真实 provider）：变化事实放 dynamic system section ⇒ 切换轮 cache-read 256 / uncached **14,691–14,782**；放尾部 user 快照 ⇒ cache-read 14,848–15,872 / uncached **59–306**。**缓存收益是测量结论**；措辞 / 模型行为层面的收益**未被统计验证**（预注册实验两个阳性对照都失败）—— 别拿「缓存命中」当「措辞更好」的证据。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:76）

## prefix-cache

理论依据：**provider prefix cache 按前缀字节完整匹配**（DeepSeek 尤其），首条 wire 消息一变，system+history 的长前缀全部失效 —— 长 agentic 会话反复付这笔。Anthropic 指引同向：变化的 per-request context 应放在稳定缓存前缀**之后**。跨 harness：Codex 把权限建模成 developer 角色 `WorldState` + fingerprint（只在变时发）；Hermes 会话内 system 固定、变化通知 prepend 到下一条 user。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:56）

## requirements

实现验收（下一轮，需求级）：**R1** 易变内容（`task.body`/`cwd.note`/`chain[].content`）变化时 leading system **逐字节不变**；**R2** 变化事实渲染成尾部 user 消息、正文自带 supersede 语义；**R3** 内容未变不发（避免 token 堆积）；**R4** 全部消失要发**显式清空**文案（否则旧快照继续生效）；**R5** system 在前、snapshot 在该步 user 输入之前；**R6** 预算口径仍判「实际发送的完整 system 部分」，快照是否计入实现时定并写进测试；**R7** 渲染失败 / 变量缺失沿用严格硬错，不得降级为空快照。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:185）

## three-channels

三通道判据（不是两个）：① **leading system（node 0）** = 整会话几乎不变（身份 / persona / 工具指引）；② **in-history system append** = 偶尔变、且模型声明支持 `systemPromptUpdate:'in-history'`；③ **尾部 user 消息** = 每步都可能变或需逐次重算（snapshot / notice / instructions / relay / recall 五 form）。dsh 原话：prompt 在**大多数步**都变的，就该挪进 **runtime context**。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:39）

## undecided

未决（实现前敲定）：① 尾部 user 追加 vs in-history system append —— 取决于 `diy` 模型池是否支持 mid-convo system（AI SDK + openai-compatible 目前无能力位抽象）；② `<project_context>` 先不挪（变化频率远低于 task.body，可先只挪 `task.*` 观察收益）；③ 快照是否计入 64KB 预算（若计入，预算语义从「system 预算」变「上下文预算」，需改名与告警文案）；④ 变更粒度按渲染文本比较即可，不依赖事件；⑤ 分段归属（dsh 的 `sections`）可延后；⑥ skills 非空后留 system 还是进快照。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:265）

## user-channel-cost

user 通道的固有代价：`source:{kind,plugin,form}` **不发给模型**（只用于日志/UI），模型只能靠正文 frame 文案识别「这不是用户说的」（opencode 用 `<system-reminder>` + 提示词声明；dsh 用 `Current runtime context … supersedes earlier …`）。in-history 的成本：追加节点**每次请求都付自己的 token** 直到被压缩遮蔽 ⇒ 变化少 → append 划算；几乎每步都变 → 下沉 user。

（见 b0ff9948:docs/plans/2026-09-21-prompt-cache-and-dynamic-context.md:116）
