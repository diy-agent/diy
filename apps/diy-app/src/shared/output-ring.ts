/**
 * output-ring.ts — ⚠️ 实现已迁到 `@diy-agent/jobs`。
 *
 * 它是后台 job 的输出环（纯函数、零 IO），属于 jobs 能力的一部分 ——
 * 留在 app 里导致新架构（apps/chat 用 @diy-agent/jobs）拿不到，面板分不清
 * 「没有输出」和「输出被截了」。
 *
 * 这里只做转发，保住 diy-app 的调用点。
 */
export * from "@diy-agent/jobs";
