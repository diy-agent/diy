# @diy-agent/tools

diy **工具层内核**：`read` / `write` / `edit` 三个工具的装配，外加它们依赖的文件原语
（原子写 / 行窗口读取 / 局部替换 / unified diff）。

宿主无关：只认 `cwd`、可选预算、可选审计回调。任务系统（taskUri / 会话目录 / 审计落盘位置）、
进程与后台作业（`bash` / `job`）、OS 策略选型（shell 探测）都不在这里 —— 那些由宿主注入或自己装配。

```ts
import { buildTools } from "@diy-agent/tools";

const tools = buildTools({
    cwd: "/path/to/project",
    limits: { readMaxBytes: 100 * 1024 },
    onAudit: (e) => console.log(e.phase, e.cwd, e.result), // 可选
    extraTools: {}, // 宿主自己的 bash / job 等（不得与 read/write/edit 重名）
});
// tools.read / tools.write / tools.edit —— AI SDK 的 ToolSet
```

## 边界（最容易破的三条）

1. **别把任务概念拉进来**（`taskUri` / `anchor` / `$DIY_HOME` / 会话目录都在宿主）；
2. **别在这里做 OS 探测**（shell 路径 / 平台分支属宿主 `src/main/os/`）；
3. **行为语义只搬不改**：read 读不到 = 抛错、write/edit 失败 = 抛错（不 return 字符串），
   与 diy-app 原先的口径逐字一致 —— 抽包只换依赖注入方式。

## 测试

`./sha.sh test` = `tests/**`（原 diy-app `tests/core/file-*` + `atomic-write`，随实现一起搬来）。
