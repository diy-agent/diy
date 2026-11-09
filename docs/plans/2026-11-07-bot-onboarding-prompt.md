# 给 chat app 里 bot 的开工提示词（继续 ##519 的工作）

> 用法：在 chat app 里建一个 bot（模型选支持工具调用的，如 `aug@opencode-go/deepseek-v4.1-flash`），
> 把下面 `---` 之间的内容整段粘进第一条消息。

---

你现在接手 diy 仓库里的一项正在进行的工作（任务 ##519：Agent 聚合与压缩点 UI）。先按顺序做，别急着写代码。

## 0. 你的运行环境（很重要，别猜）

- 你的 bash 工作目录是 `<DIY_HOME>/bots/<你的botId>/workspace`，**不在仓库里**。要操作仓库必须显式 `cd /Users/ccc/git/diy/diy`（或用绝对路径）。
- 工具**直接执行、没有人工审批**；你唯一被拦的是「把自己宿主进程杀掉」。所以：破坏性命令（`rm -rf`、`git reset --hard`、`kill`）一律先问人。
- **一轮最多 8 个工具步**。任务大就拆成几条消息，每条只推进一小步，并在结束时报「下一步是什么」。

## 1. 先读规则（不要跳过）

```bash
cd /Users/ccc/git/diy/diy
diy facts brief rule     # 硬约束（语言/验证/worktree/结构化出口）
diy facts brief tool     # 工具偏好（fd/rg、write/edit、后台任务）
diy facts brief dev      # 开发流程与验证预算
```

`rule#worktree` 那条是硬要求：**改代码前先开 worktree**（`~/git/diy.worktrees/<标识>`），不要在 `/Users/ccc/git/diy/diy` 主仓当前分支上直接改。

## 2. 了解已完成的部分

```bash
cd /Users/ccc/git/diy/diy && git pull
less docs/plans/2026-11-07-agent-aggregate.md     # Agent 聚合抽象（接口与不变量）
less docs/plans/2026-11-07-agent-event-architecture.md  # 事件/订阅/seq 的决策
gh pr view 443 --json title,body                  # 上一轮合并了什么
```

关键代码位置：
- 聚合：`pkgs.ts/agent/bot/src/aggregate.ts`（内存态 + 串行队列 + checkpoint）
- 持久化：`pkgs.ts/agent/bot/src/persist.ts`（快照 + 审计，**不回放**）
- 适配层：`pkgs.ts/agent/bot/src/agent-host.ts`（接到 `BotChatHost` 契约）
- 模型接线：`pkgs.ts/agent/bot/src/model-ports.ts`
- 压缩面板：`pkgs.ts/ui/chat-page/src/renderer-diui.ts` 里的 `cutWrap/paint`
- 自动判据：`apps/chat/scripts/verify-compact.mts`

## 3. 你的验证义务（改完必须自己跑，不要把人工测试当验证）

```bash
cd /Users/ccc/git/diy/diy && ./sha.sh check      # 类型检查 + lint
cd pkgs.ts/agent/bot && npx vitest run tests/aggregate.test.ts   # 聚合 13 条
cd apps/chat && ./sha.sh build && npx tsx scripts/verify-compact.mts   # 压缩面板 6 条（--apply 会真压一次）
```

改 UI 的活，先跑 `verify-compact` 再交给人看；改聚合的活，先补/改 `aggregate.test.ts`。

## 4. 待办清单（挑一条做，不要并行）

按优先级：

1. `persist.save` 每次变更都全量序列化写盘（O(n²)）→ 改增量 append + 定期压紧；
2. 压缩可以在 LLM 执行中途插入（文档要求「等步边界」）→ 改成排队到轮末；
3. 命令返回语义不一致（Receipt / 快照 / 抛错三套）→ 统一并写进文档；
4. `agent-host.ts` / `model-ports.ts` 是否该留在 `bot` 包（现在 bot 依赖了 `model-catalog`，破坏零依赖边界）；
5. 把网络诊断/错误分类/日志包装抽成基础包（`apps/chat/main.ts` 的 Happy Eyeballs 兜底、`llm-provider` 的错误分类是候选）；
6. 压缩面板 `paint()` 整块重写 `innerHTML` 的交互稳定性 + diy-ui 整体设计（大改，先出方案再动手）。

## 5. 工作方式

- 中文回答，结论先行，不复述工具输出。
- 每条命令都要真的跑过再报结论；跑不过就说跑不过、贴关键报错。
- 改完代码：先 `./sha.sh check`，再相关测试，再开 PR（**不要直接合 main**，等人说合）。
- 遇到「测试全绿但人一试还是不行」的情况，优先怀疑**判据选错层**（我们踩过：bot 层测试通过，问题在投递装配层）。

开工前先回我三句话：① 你所在的数据根与工作目录；② 你打算先做哪一条待办、为什么；③ 你会用哪些命令验证。

---
