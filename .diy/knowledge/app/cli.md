---
desc: CLI 与 RPC 契约（option 形状 / zod 补丁顺序 / 读文件语义）
updated: 2026-10-22
---

## append-strip

`--append-body*` 的**剥头判据比整篇侧更严**：只有 frontmatter **同时含 `state` / `created` / `updated`** 才算「整份任务文件」→ 才剥头；因此追加一份**自带 front matter 的普通文档**时其文档头**保留**（不会莫名消失）。三选一：`--append-body <file|->` / `--append-body-file` / `--append-body-text`。

（见 8ef8f82a:docs/task-write-contract.md:23）

## cli-inline-text

「值必须是**内联文本**」的护栏（`_CliOptionMeta.inlineText`，##338）也判在**调用方进程**的 parser：整值单 token + 形如路径（`/` `./` `../` `~/` / 盘符）**或**该文件确实存在（`cli/_parser.ts::pathLikeValue`）→ `CliParseError`（exit=2）+ 提示改 `--body-file` / `--body-text`。存在性要看 cwd，只有调用方判得准；触发缘起：`--body` 收文本而 `--append-body` 收 `<file|->`，两侧不对称 → 三例把路径当正文静默存下（##290/##294/##87）。**三选一**裁决在 `main/core/task.ts::resolveBodyOverride`（`resolveBodyInputs` 是它在 edit 侧多带一组追加的壳）。**挂三处**：`task edit` / `task create` / `task drafts set` 的 `--body`（##376 补后两者；此前只有 edit 挂，同族静默收路径串）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:159）

## cli-kebab

CLI 选项名默认取 schema 字段名（camelCase），parser 另注册 kebab 别名并**在 help 里显示 kebab**（`--by-agent`），两种写法都接受 —— 新增 camelCase 选项无需额外处理

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:156）

## cli-readfile

CLI 的 `readFile` 选项（如 `task edit --append-body <file|->`）**在调用方进程的 parser 里读**（`pkgs.ts/core/rpc/src/cli/_parser.ts`）：handler 跑在 app 进程，它的 fd 0 / cwd 都不是调用方的，在调用方读才两件事都对。故含 `-`（stdin）的调用必须**绕开 /cli 转发**（`diy.sh` 的 http 模式已按 argv 判定并落回直连 CLI）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:158）

## head-note

**关键设计理由都写在各自文件头注**（`src/main/core/steer-queue.ts` / `persona.ts` / `drafts.ts` / `src/main/services/local-agent.ts`）：改动前先读头注，别只看函数名

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:160）

## rpc-gap

**CLI 骨架优势已用足、皮囊与 RPC 并发力未用**（2026-07 评估，结论仍成立的方向）：单一事实源（RPC meta 反射）+ 强类型 + 与 RPC 一体是多数 CLI 没有的架构；缺的是 help 示例 / 拼写建议 / TTY·颜色感知 / exit code 细分，以及「RPC 原生 + 并发执行」这个差异化能力**没暴露给用户**（当前死板的一进程一命令）。落地顺序见文档第五节，`docs/cli-meta-gen-evaluation.md` 是 help 生成侧的评估。

（见 8ef8f82a:docs/rpc-cli-modern-design.md:11）

## rpc-output-schema

RPC 的 `outputSchema` **只用于类型推导，运行期不校验也不剥字段**（`pkgs.ts/core/rpc/src/core/meta.ts`；只有 input 走 zod）。故漏写字段**不会报错**：handler 原样送出的字段仍在，但类型上没有 → 消费端「拿不到、画不出」，且改起来像幽灵 bug。共享形状必须落成 schema（如 `shared/usage.ts` 的 `ModelCostSchema`）并被两侧引用，别手写第二份子集

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:155）

## zod-cli-meta-order

**zod schema 必须在 `_cli-meta.ts` 补丁之后创建**（v4 实例创建即定死原型链，事后打补丁看不见）。打包会把**被多个 chunk 共用**的模块提升成独立 chunk 并**先于入口模块体求值** ⇒ 一个带 schema 的模块（`main/core/task-state.ts`）只要被拖进共享 chunk（如 `shared/task-head.ts` 之类共享常量模块一旦 import 了 `shared/task-detail.ts`），启动即 `TypeError: TaskStateSchema.cliArg is not a function`。判据：**共享常量模块必须零依赖**（清单归它、zod 形状归消费方）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:157）
