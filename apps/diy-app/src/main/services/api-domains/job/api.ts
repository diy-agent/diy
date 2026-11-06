/**
 * api-domains/job/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

export const jobRoutes = RpcSchema.group({desc: `后台 run 的管理（**\`job\` = 后台活的总称，本域装的唯一实体是 run**；只管 \`background\` 起的长活，前台命令不登记 —— 见 ##408 刀 16）`,
        children: {
          ps: RpcSchema.unary({
            desc: `
            **在跑什么**（活体表，刀 8 起）：后台 run 的当前快照 —— 不是历史账。

            返回 runs（运行中的在前，同状态按启动时间倒序）· running（在跑几条）· total。
            每行含：state/stateLabel · pid（null = 没起来或非进程型）· title · **command（原始命令行全文）** ·
            cwd · startedAt/endedAt · durationText · exitCode/signal/exitText · outputBytes/outputText ·
            origin/originText（哪个任务/轮/步/工具调用起的）· logPath · dir。
            `,
            input: {
              all: z
                .boolean()
                .optional()
                .cliOption({ desc: "也列出已结束的（缺省只列运行中；app 退出后表即空 —— 这是刻意的，不做恢复）" }),
              noScan: z
                .boolean()
                .optional()
                .cliOption({ desc: "不扫 ps（跳过「未登记」进程那一列；缺省扫）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }),
          }),
          detachables: RpcSchema.unary({
            desc: `
            **现在能转后台的前台调用**（##408 刀 21）：哪条工具调用还跑着、已经跑了多久。

            只列**本任务**、**还在跑**、**拿得到 toolCallId** 的前台 bash —— 三项缺一就不列
            （转不了的按钮不如没有）。转完就从这里消失，去 \`job.ps\` 里看它。
            `,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI（只看这个任务的）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }),
          }),
          detach: RpcSchema.unary({
            desc: `
            把一条**还在跑的前台命令**转成后台 run（对应 opencode 的 \`ctrl+b\`）。

            语义：**不重启进程、不丢前半段输出** —— 只换"谁在等"和"输出写到哪"。
            转成功后工具调用立刻返回 \`[已转后台] <runId>\`，模型据此去 \`job status\`；
            结束时会照常插话唤醒。拒绝是**正常时序**不是缺陷：命令恰好结束了（\`agent/job-already-ended\`）、
            已经转过了（\`agent/job-not-found\`）、不属于这个任务（\`agent/job-foreign\`）。
            `,
            input: {
              toolCallId: z.string().cliArg({ desc: "工具调用 id（`job.detachables` 里给的）" }),
              taskUri: z.string().cliArg({ desc: "任务 URI（**必填**：属主对不上就拒，见 `job-fence`）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          procs: RpcSchema.unary({
            desc: `
            **这台 app 起过、现在还在的全部进程**（ps 现扫，不只我们登记过的）。

            为什么要它：模型可以在命令里写 \`nohup xxx & \` —— 那种进程从没经过活体表，
            但归我们管（按**进程组**认领，见 \`shared/proc-scan.ts\`）。这里把它一并列出来，
            回答「我起的那些东西现在到底有哪些在跑」。
            `,
            input: {
              scan: z.boolean().optional().cliOption({ desc: "预留：是否重扫（当前恒重扫，ps 一次约几十毫秒）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }),
          }),
          killproc: RpcSchema.unary({
            desc: `
            结束一条**未登记**的进程（按 pid；同组且组不是 app 自己时按组杀）。

            两道闸都过才动手：① 调用时**重新扫一遍** ps，pid 不在"归我们管"的名单里就拒绝；
            ② 归属校验（\`shared/job-fence.ts\`）—— 你声明的 \`taskUri\` 必须与组名册 / run origin
            记下的归属一致，否则拒绝（跨任务不代杀；归属不明的也不动，请用 ps / kill 手工来）。
            `,
            input: {
              pid: z.number().cliArg({ desc: "进程 pid（`diy job procs` 里看到的）" }),
              taskUri: z.string().cliArg({ desc: "任务 URI（**必填**：这个 pid 归哪个任务）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          kill: RpcSchema.unary({
            desc: `
            停止一条 run（进程型按**进程组** SIGTERM → 2s → SIGKILL）。返回是否真的发出了停止。

            \`taskUri\` **必填**：这条 run 的 \`origin.taskUri\` 必须与它一致（\`shared/job-fence.ts\`）。
            跨任务不代杀 —— kill 是按组发的，认错一次带走的是整组无关进程。
            `,
            input: {
              id: z.string().cliArg({ desc: "run id（形如 r-mvlmxmuf-qxmr：r-<base36 毫秒>-<4 位随机>，用 diy job ps 查）" }),
              taskUri: z.string().cliArg({ desc: "这条 run 属于哪个任务（`job.ps` 每行的 `taskUri`）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          tail: RpcSchema.unary({
            desc: `读一条 run 的输出尾部（从它自己的 out.log 读；给了 lines 就按行切，同时受 16KB 字节上限）。`,
            input: {
              id: z.string().cliArg({ desc: "run id" }),
              lines: z.number().optional().cliOption({ desc: "要最后几行（缺省 40）" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          meta: RpcSchema.unary({
            desc: `看一条 run **实际落盘的东西**：meta.json 原文 + out.log 路径/字节数 + 目录（面板「存储数据」tab 用）。`,
            input: {
              id: z.string().cliArg({ desc: "run id" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
        },});

export const jobService = defineService({ name: "diy.job", api: jobRoutes });
