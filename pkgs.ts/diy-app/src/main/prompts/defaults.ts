// src/main/prompts/defaults.ts
// 🎯 内置提示词模版唯一真相源（随 app 发布走，运行时只读）
//
// 为什么是 TS 常量而不是 .md 文件：
//   main 进程产物是 vite lib 单文件（out/main/index.mjs），非 TS 资源不会自动打进包；
//   CLI 走 tsx 源码，不支持 `?raw` 导入。用常量则三处（CLI/RPC 单测/打包产物）行为一致。
// 每份模版都是完整 .md 文本（frontmatter 自描述 + 正文），UI 展示的文件树即这些 relpath。
//
// frontmatter 字段：
//   title        通用标题，常显
//   desc         通用描述，常显（理解用）
//   version      内置版本；save 覆盖时记入 sidecar，供 stale 判定
//   overridable  { value, tip }：value=false 时 UI 禁用编辑，tip 进禁用按钮 tooltip

export const PROMPT_DEFAULTS: Record<string, string> = {
  "system.md": `---
title: 系统身份
desc: 本地代码助手的身份与语气，运行在任务所属项目目录。随便改，这是试验场的主角。
version: 1
overridable: { value: true, tip: "" }
---
## 系统身份

你是 diy 管控台的本地代码助手，运行在任务所属项目目录。
需要查看文件、运行命令时优先使用工具；拿到结果后用中文简明总结。
回答保持精炼，代码与命令原样引用。
硬规则：diy 自己就跑在 Electron 里，禁止执行会杀死宿主进程的命令
（如 pkill/killall Electron、kill 掉 diy 自身的 pid/进程组）。
需要重启 diy 时告诉用户手动操作，不要自己杀进程。

`,
  "context.md": `---
title: 项目上下文
desc: 任务与项目关系的描述模版，变量由注册表在构造请求时渲染。改句式、加字段都在这里试。
version: 1
overridable: { value: true, tip: "" }
---
## 项目上下文

当前项目目录：{{cwd}}
项目：{{project_label}}（{{project_path}}）
任务：{{task_uri}}
模型：{{model}}（maxSteps={{maxSteps}}，maxOutputTokens={{maxOutputTokens}}）

`,
  "skills.md": `---
title: Skills 总描述
desc: 插入 skills 总描述的槽位。当前本地 agent 尚未消费 skills，这里是占位，先调格式。
version: 1
overridable: { value: true, tip: "" }
---
<!-- skills 尚未接入：此槽位渲染为空，保留格式待后续填充 -->
## 可用技能

{{skills}}

`,
  "tools/bash.md": `---
title: bash 工具描述
desc: 发给模型的 bash 工具说明。改措辞会直接改变模型何时愿意调 shell。
version: 1
overridable: { value: true, tip: "" }
---
在项目目录执行 bash 命令并返回输出（查文件、跑命令、看系统信息）。

`,
  "tools/read.md": `---
title: read 工具描述
desc: 发给模型的 read 工具说明。
version: 1
overridable: { value: true, tip: "" }
---
读取文件的文本内容（相对路径按项目目录解析）。

`,
  "guard/self-kill.md": `---
title: 自杀护栏回执
desc: 拦截到杀宿主命令时回给模型的话术。措辞 must 是“已结束、别换姿势重试杀进程”，否则模型会换写法绕过。
version: 1
overridable: { value: false, tip: "保命屏障：拦截到杀宿主命令时回给模型的话术。措辞一松（如改成待办口吻），模型会换写法绕过拦截、杀掉管控台自身进程导致白屏，仅可看" }
---
## 自杀护栏回执

[已拦截] 该命令可能杀死 diy 自身进程，未执行。
diy 的界面与本地 agent 跑在同一个 Electron 进程树里，杀掉它们等于自杀。
正确做法：只做查询（ps/pgrep 不加 kill）；重启 diy 交给用户手动执行，不要在 agent 里杀进程。

`,
  "protocol/interrupted-tool.md": `---
title: 中断工具终态
desc: tool 块断流后写进 ops 的终态文案。语意必须是已结束的历史事实，不能有一丝待办味道。
version: 1
overridable: { value: false, tip: "终态文案必须是已结束的历史事实。若改成待办口吻（如「请重新发起」），模型会重发被中断的命令（含杀进程命令），仅可看" }
---
## 中断工具终态

[此调用已中断（上一轮未跑完），没有结果；这是已结束的历史记录，不要重试]

`,
};
