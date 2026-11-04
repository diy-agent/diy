// 🎯 后台 run 表 —— **装配点**（##515 第 3 步：账本内核已搬进 `@diy-agent/jobs`）
//
// 本文件只剩一件事：把 diy-app 的平台能力与 shell 探测注进去，拿到本进程唯一的那张表。
// 表的行为（spawn / 收口 / 通知 / tail / kill / wait / 退出即收）全在包里 —— 一份真源，
// bot 将来接同一个包，语义不会漂。
//
// 注入的三样东西：
//   · `caps`  ← `os` 策略（**唯一**允许看平台的地方）：进程组 / 杀树 / 判活 / 日志重定向方式；
//   · `shells` ← `os.resolveShells()`（探测要看安装位置与平台，是 OS 策略不是工具语义）；
//   · `rootDir` ← `readRuntimeConfig().home`（数据根由宿主配置决定）。
// `notifier` 不在这里注入：它接的是 agent 的插话唤醒（见 local-agent 末尾的 `setNotifier`）。

import { RunRegistry, defaultHome, type JobOsCaps } from "@diy-agent/jobs";
import { join } from "node:path";
import { readRuntimeConfig } from "../../runtime";
import { os } from "../os";
import { shellSpecs } from "../os";

export * from "@diy-agent/jobs";

/** diy-app 的平台能力位（语义见 `JobOsCaps`；Windows 的边界由 `os` 策略自己声明）。 */
const caps: JobOsCaps = {
    processGroups: os.caps.processGroups,
    shellRedirectsLog: os.caps.shellRedirectsLog,
    gracefulSignals: os.caps.gracefulSignals,
    killOwned: (targets, signal) => os.killOwned(targets, signal),
    jobAlive: (pid) => os.jobAlive(pid),
};

/** 数据根（配置缺席时退回 `~/.diy`，与 `defaultHome` 同口径）。 */
function homeOf(): string {
    try {
        return readRuntimeConfig().home;
    } catch {
        return defaultHome();
    }
}

/** 全局单例（一个 app 实例一张表）。 */
export const runRegistry = new RunRegistry({
    rootDir: join(homeOf(), "log", "job", "runs"),
    caps,
    shells: shellSpecs,
});
