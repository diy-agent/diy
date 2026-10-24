// 🎯 「这个 run / 进程归谁」的唯一判据（纯函数，零 IO）—— ##408 刀 22
//
// 病（review §1.7）：`job.kill` / `job.killPid` 原来只校验"这个 id 存在"，不校验归属 ——
// 同一 app 里多个任务/agent 并行时，A 任务能列到 B 任务的命令全文（可能含密钥/路径），
// 也能把 B 任务的后台活 kill 掉。而 kill 是按**进程组**发的（`kill(-pgid)`），
// 认错一次带走的是整组无关进程 —— 这不是越权，是事故。
//
// 判据：**动手的人必须声明「我替哪个任务动手」，且这条 run / 进程的归属必须与声明一致。**
//
//   declared（调用方声明）  owner（我们记录的归属）   结论
//   ─────────────────────  ────────────────────────  ──────────────────────────────
//   缺 / 空                任意                      拒绝 `agent/job-task-required`
//   有                     null（证明不了）          拒绝 `agent/job-owner-unknown`
//   有                     字符串但不相等            拒绝 `agent/job-foreign`
//   有                     相等                     放行
//
// 为什么"缺声明"也要拒：可选参数等于没有闸 —— 两条调用路径里总有一条忘了传，
// 而忘了传的后果是**杀错进程**，不是少个字段。写死在签名里，漏传当场红。
//
// 为什么"归属未知"也拒：能证明归属的进程都有组名册（`owned-groups`）或 run 的 origin；
// 证明不了的多是祖先链兜上来的 app 子进程。这类"谁起的说不清"的进程，宁可让人用
// `ps` / `kill` 手工处理，也不让任意调用方凭一个 pid 就发信号。
//
// 边界（如实说）：这是**诚实调用方**的闸 —— 它挡的是"复制了一个 id、以为是自己的"
// 这类真实事故，挡不住蓄意撒谎（那种情况任何同进程内的校验都挡不住，得靠 OS 权限）。

/** 归属校验的结论。`ok:false` 时 `code` 直接进错误消息（与 `error-triage` 同一套域/格式）。 */
export type FenceResult = { ok: true } | { ok: false; code: string; msg: string };

/**
 * 校验「替 `declared` 任务动手」是否成立。
 *
 * @param declared 调用方声明的任务 URI（CLI / RPC 入参）
 * @param owner    我们记录到的归属（run 的 `origin.taskUri` / 组名册的 `taskUri`）
 * @param what     被操作对象的说法（"这条 run" / "进程 1234"），只用于错误消息
 */
export function fenceTaskOwner(
    declared: string | null | undefined,
    owner: string | null | undefined,
    what: string,
): FenceResult {
    const d = (declared ?? "").trim();
    if (!d) {
        return {
            ok: false,
            code: "agent/job-task-required",
            msg: `没说明替哪个任务动手 —— ${what} 的归属一律要显式声明（--task-uri <taskUri>），否则拒绝：认错归属杀的是别人的活`,
        };
    }
    const o = (owner ?? "").trim();
    if (!o) {
        return {
            ok: false,
            code: "agent/job-owner-unknown",
            msg: `${what} 的归属不明（没有组名册 / run origin 记录），不敢动 —— 确需处理请用 ps / kill 手工来`,
        };
    }
    if (o !== d) {
        return {
            ok: false,
            code: "agent/job-foreign",
            msg: `${what} 属于 ${o}，不是 ${d} —— 跨任务的活不代杀（要动它请以那个任务的身份来）`,
        };
    }
    return { ok: true };
}
