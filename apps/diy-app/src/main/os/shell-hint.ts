// 🎯 shell 能力的**事实句** —— 实现已搬到 `@diy-agent/tools`（##515 第 1 步），这里只留转发。
//
// 用户 2026-10-31 裁定：bash 与 pwsh 是两种能力；没有 bash 不是错误，降级到 pwsh 即可。
// 只有当**两种都没有**时才需要这条文案（正常 Windows 一定有 powershell.exe）。

export { noShellHint } from "@diy-agent/tools";
