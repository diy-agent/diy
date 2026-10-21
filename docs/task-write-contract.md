# 任务正文写入契约（`task edit` / `task create` / `task drafts set`）

> 二次披露文档：`AGENTS.md::rule.task-write` 只留一行结论。
> 契约原文以 `diy task edit --help` 为准（本文是索引与来由，不是权威）。

## 一、任务文件头是权威（##322）

读侧 `task show` / `getTask` / 上下文里的 `task.*` 给的就是文件 frontmatter **同一份** —— 确认任务不必 `cat` 任务文件。

## 二、整篇覆盖（`task edit`）

三种写法二选一，多给即报错：

- `--body <文本>` —— **只收内联正文**；值形如单行路径即**拒**并提示（##338）
- `--body-text <文本>` / `--body-file <file|->` —— 逃生口，值含路径样字符串时用这两个

收到「整份文件」（带 front matter）一律**剥头**，返回值回报剥掉的键与原文，便于核对。

## 三、追加（`task edit --append-body`）

`--append-body <file|->` / `--append-body-file <file|->` / `--append-body-text <文本>`（同样三选一）。

追加侧判据**更严**：只有同时含 `state` / `created` / `updated` 才算「整份任务文件」→ 才剥头。故追加一份自带 front matter 的**普通文档**时，其文档头**保留**。

## 四、同族同护栏（##376）

`task create --body` 与 `task drafts set --body` 也挂同样的 `inlineText` 判据（镜像 `resolveBodyOverride`），逃生口 `--body-text` / `--body-file` 同样可用。

差别只有 create **不剥头**：新建任务无头可覆盖，传整份文件会把 front matter 写进正文。
