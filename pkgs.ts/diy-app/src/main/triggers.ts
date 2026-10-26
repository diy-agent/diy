/**
 * 内置触发器目录 —— **全部从零注册**，没有"内置常量表"这种东西。
 *
 * 这里每一行都是一次 `defineTrigger()`，和插件将来要写的形式**一模一样**。
 * 区别只在命名空间（`job:` / `watch:` / `env:` / `notice:` / `inbox:`）。
 *
 * ⚠️ 本文件被 `main/index.ts` 在启动最早期 import，**必须早于任何会 emit 的服务**
 * （`run-registry` 的 onSettle、`core-ticker` 的第一拍）。顺序反了 → 第一批事件丢。
 *
 * 判据（##408 v2）：一条东西该不该是触发器，看它是不是**受外部条件支配**、
 * 用户**可能想关掉或降级**、且需要**知道它发生过**。
 *   ✅ 时间到了 / 别的进程结束了 / 远端状态变了 / 机器坏了
 *   ❌ 本次操作的直接结果（"你的命令返回非零"）—— 那是反馈，不是触发
 */

import { defineTrigger } from "./services/trigger-registry";

/* ─────────────────────────── job 域 ─────────────────────────── */

/**
 * 后台 run 结束。
 *
 * 今天：`runRegistry.setNotifier` 写死「投给 run.owner」，所以**别的任务收不到**——
 * 「408 等 266 的 dispatch job」做不到。接上触发器后，投给谁由 `sinks` 决定（`owner`
 * 仍解析成 run 的 taskUri，行为不变；要跨任务投就换地址）。
 *
 * 字段为什么需要：
 *   runId      —— 点回去看输出（`job tail <runId>`）
 *   owner      —— `sinks: ["owner"]` 解析它，也用于权限/归属
 *   exitCode   —— 好/坏的第一判据，人也最关心这个
 *   durationMs —— 「跑了 3 秒」和「跑了 45 分钟」是两种消息
 * 放弃：命令全文（日志里有，重复塞进事件只会让通知变长）、stdout 尾部（同上）。
 */
export const runSettled = defineTrigger<{
    runId: string;
    owner: string;
    exitCode: number | null;
    durationMs: number | null;
}>({
    id: "job:run-settled",
    desc: "后台 run 结束（exited / killed）",
    level: "N1",
    sinks: ["owner"],
});

/**
 * 会话异常中断：模型挂 / 输出被截断 / 成本超限 / 工具连续失败。
 *
 * 今天：**散在三处硬编码**（`local-agent.ts:6285` 成本告警、`:6356` max-tokens、
 * 以及 model-notice 的降级路径），各自挑 inbox / turn.notice，谁也说不清一共有几种。
 *
 * 字段为什么需要：
 *   taskUri   —— 投给谁
 *   reason    —— 分级与文案都靠它（`max-tokens` 和 `model-down` 不是一个急法）
 *   step      —— 出在第几步，用户回看时唯一的定位锚
 *   selfTurn  —— 本轮刚结束；此时 wake 自己没意义（sink 侧据此跳过 wake，
 *                而不是在三个调用点各自特判）
 * 放弃：完整 endReason 对象（在 turn 日志里，事件只需要能说清"哪种中断"）。
 */
export const sessionAborted = defineTrigger<{
    taskUri: string;
    reason: "max-tokens" | "cost-limit" | "model-down" | "tool-failed";
    step: number;
    selfTurn: boolean;
}>({
    id: "job:session-aborted",
    desc: "会话异常中断（模型挂 / 截断 / 成本超限 / 工具连续失败）",
    level: "N1",
    sinks: ["owner", "inbox"],
});

/* ────────────────────────── watch 域 ────────────────────────── */

/**
 * 观察对象变了（指纹与上一拍不同）。
 *
 * 这是 pull 源的出口。**基线不在这里** —— 触发器只负责"发现了变化"，不负责
 * "上次是什么"；后者是 watch 定义自己的事（落盘在 `$DIY_HOME/jobs/watch/state/`）。
 *
 * 字段为什么需要：
 *   watchId   —— 哪条 watch（点回去看定义与历史）
 *   taskUri   —— 投给谁（观察对象可能不属于任何任务，故可空）
 *   diff      —— **唯一的内容**：只带变化那几行（≈380B），不是全量快照
 * 放弃：完整指纹（人能读的部分只有 diff）、探针 spec（定义里有）。
 */
export const watchChanged = defineTrigger<{
    watchId: string;
    taskUri: string | null;
    diff: string;
}>({
    id: "watch:changed",
    desc: "观察对象变了（glob 指纹变化 / 任务状态变化）",
    level: "N2",
    sinks: ["def"],
});

/* ─────────────────────── env / notice 域 ────────────────────── */

/**
 * 机器环境坏了：磁盘满 / 网断。恢复时也会发一次（`ok: true`）。
 *
 * 今天是顶栏红条 + `env.watch` 流，没有"系统一共会告诉你几种环境问题"的清单。
 *
 * 字段为什么需要：
 *   kind      —— 哪一类（决定文案与给什么建议）
 *   ok        —— 恢复也要说一声，否则红条消失了像幻觉
 *   detail    —— 数字证据（`free: 512MB` / `hint: …`），否则没人信
 * 放弃：完整快照（env-watch 的 `EnvNotice` 会更全，这里只带人要看的那句）。
 */
export const envBroken = defineTrigger<{
    kind: "disk" | "network";
    ok: boolean;
    detail: string;
}>({
    id: "env:broken",
    desc: "机器环境坏了（磁盘满 / 网断），恢复时也发一次",
    level: "N0",
    sinks: ["ui"],
});

/**
 * 模型不可用（真发失败）。
 *
 * 今天：`ModelUnavailableBar`（顶栏）+ model-notice。人不在窗口前就完全错过。
 *
 * 字段为什么需要：
 *   model     —— 哪个模型（换一个就能继续）
 *   upstream  —— 上游原文的一句话（"401 invalid api key" 比 "模型不可用" 有用得多）
 * 放弃：完整响应体（流量日志里有）。
 */
export const modelDown = defineTrigger<{
    model: string;
    upstream: string;
}>({
    id: "notice:model-down",
    desc: "模型不可用（真发失败）",
    level: "N0",
    sinks: ["ui"],
});

/* ────────────────────────── inbox 域 ───────────────────────── */

/**
 * 别的 agent / CLI 投来一句话。
 *
 * 今天：`api-impl.ts:541` 与 `room-service.ts:692` 两个硬编码入口，各自 `noteInbox`。
 *
 * 字段为什么需要：
 *   taskUri   —— 投给谁（收件人是那个任务的 agent）
 *   from      —— 谁说的（回话要认人）
 *   preview   —— 一句话摘要（正文在会话里，事件只带前 80 字）
 * 放弃：正文全文（会进会话，事件里重复等于两倍 token）。
 */
export const inboxMessage = defineTrigger<{
    taskUri: string;
    from: string;
    preview: string;
}>({
    id: "inbox:message",
    desc: "别的 agent / CLI 投来一句话",
    level: "N2",
    sinks: ["inbox"],
});

/**
 * 启动时调一次：**保证上面这些 `defineTrigger` 已经执行过**。
 *
 * 模块顶层 define 本身在 import 时就生效；这个函数只是给入口一个**可读的调用点**
 * （启动顺序是真实约束：早于 run-registry / core-ticker）。
 */
export function registerBuiltinTriggers(): void {
    // 无操作：注册已在模块求值时完成。存在的意义是启动清单里能看见这一行。
}
