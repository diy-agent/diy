// src/main/services/watch-sinks/task.ts
// 🎯 `task:` 出口 —— 变化写成**任务 journal** 的一条（`author: system`）。
//
// 为什么第一个真落地的是它（用户 2026-10-26）：「先做 task:，先给 266 用」。
// ##266 的痛点是 `dispatch-watch` 每 30 分钟无条件唤醒 agent；换成 watch 之后，
// 变化的落点就是那个任务的 journal —— 谁都能查、进同一条时间线、不占任何会话的
// 上下文。这也正是用户说的「类似于当前的任务 journal，就是一个历史信息」。
//
// 三个决定：
//   ① 复用 `addSystemEvent`（`author: system`、带 code 前缀）而不是 `addEntries`。
//      理由：watch 是**系统自己观察到的客观事实**，不是模型自述；journal 的代码读侧
//      已经按 author 区分「客观 / 叙述」，走同一条通道才不会分叉。
//   ② **去重窗关掉**（`windowMs: 0`）：`addSystemEvent` 缺省 10 分钟内同 code 只留一条，
//      而 watch 的两次变化是**两次真事件**，不该被折叠。
//   ③ 失败**不上抛**：journal 写不进去（任务没了 / 盘满）不该让 watch 的这一拍炸掉，
//      由 registry 收进投递报告里。

import { addSystemEvent } from "../journal-store";
import type { SystemEventInput } from "../journal-store";
import { watchEventText } from "../../../shared/watch-event";
import type { WatchEvent } from "../../../shared/watch-event";
import type { WatchSink } from "./index";

const PREFIX = "task:";

/**
 * journal 写入函数（注入点）。
 *
 * 为什么不像别处那样直接调：`scripts/check-no-vi-mock.sh` 禁止 tests 里 `vi.mock`
 * （`test-unit` 用 `--no-isolate`，mock 会静默失效 —— 比直接报错更糟）。所以真实现
 * 走缺省参数，测试传假函数。
 */
export type JournalWriter = (taskUri: string, input: SystemEventInput) => unknown;

/**
 * 「投进会话并（空闲时）开一轮」的注入点。返回 Promise 也行 —— 真实现是 fire-and-forget。
 *
 * 为什么不直接 import：`local-agent` 是重量级模块（拉 Electron / provider），
 * 让 sink 层静态依赖它会把单测也拖进去。所以缺省走**动态 import**。
 */
export type WakeFn = (taskUri: string, text: string) => void | Promise<void>;

/** 缺省唤醒：复用 job 结束通知那条通道（同一语义：往会话投一句，空闲则开一轮）。 */
async function defaultWake(taskUri: string, text: string): Promise<void> {
    const { wakeTaskWithSteer } = await import("../local-agent");
    wakeTaskWithSteer(taskUri, text, "watch");
}

export function taskSink(addr: string, write: JournalWriter = addSystemEvent, wake: WakeFn = defaultWake): WatchSink {
    const taskUri = addr.slice(PREFIX.length);
    return {
        addr,
        async deliver(ev: WatchEvent): Promise<void> {
            const { title, body } = watchEventText(ev);
            // ① 账：journal（author=system，可查、权威）
            write(taskUri, {
                code: ev.kind === "broken" ? "job/watch-broken" : "job/watch-change",
                title,
                // `broken` 是出事（pitfall）；`changed` 是里程碑（progress）
                kind: ev.kind === "broken" ? "pitfall" : "progress",
                ...(body ? { body } : {}),
                windowMs: 0,
            });
            // ② 唤醒：投进那个任务的会话流（`meta.author = "watch"`），空闲则开一轮。
            //    用户 2026-10-26 定案：**这就是 266 取代轮询的形态** —— 变化才说话，
            //    说完模型自己决定要不要动。失败不上抛：账已经记上了，叫醒失败下一轮还能看见。
            try {
                await wake(taskUri, `${title}\n\n${body}`);
            } catch {
                // 叫不醒不算投递失败（journal 那条在）
            }
        },
    };
}
