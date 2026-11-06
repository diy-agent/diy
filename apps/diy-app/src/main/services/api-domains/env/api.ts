/**
 * api-domains/env/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
/** 与 api-def.ts 的同名局部常量同形（那边没导出） */
const StatusOk = z.object({ status: z.string() });
import { EnvNoticeEventSchema, EnvNoticeSchema } from "../../../../shared/env-watch";

export const envRoutes = RpcSchema.group({desc: `环境感知通知（磁盘满 / 网断；含数字证据，条件恢复自动消）`,
        children: {
          /** 未关闭的通知（结构化行，供 UI / 程序消费；人读请用 `env ls`） */
          list: RpcSchema.unary({
            desc: `列出当前未关闭的环境通知（结构化行，供 UI / 程序消费）`,
            input: {},
            output: z.array(EnvNoticeSchema),
          }),
          /** 人读视图：对齐表格文本（`diy env ls` 的出口） */
          ls: RpcSchema.unary({
            desc: `列出当前未关闭的环境通知（人读表格；程序读请用 env list）`,
            input: {},
            output: z.string().describe("表格文本（无通知时给一句「环境正常」）"),
          }),
          /**
           * 关闭 = "这个条件我知道了"：从 ring 移除并**静音该类**，条件不变就不再弹。
           * 为什么必须落 main 侧：只关界面的话，下一次轮询（30s 后）会把同一条又推回来 ——
           * 用户点了 ✕ 却 30s 后又弹，等于没关。
           * 不给 id = 全关。条件恢复时静音自动解除（下次再坏要能重新提醒）。
           */
          dismiss: RpcSchema.unary({
            desc: `关闭环境通知（给 id 关一条；不给 = 全部关闭；同类条件不变不再弹）`,
            input: { id: z.string().optional().cliArg({ desc: "通知 id（缺省 = 全部关闭）" }) },
            output: StatusOk,
          }),
          /**
           * 通知流：**订阅即回放**当前未关闭的通知，之后是增量（upsert / resolve 两态）。
           * 回放是刻意的：页面重载 / 断线重连后红条要能自己回来（用户重开窗口正是最容易
           * 错过提示的时刻）。
           */
          watch: RpcSchema.serverStream({
            desc: `环境通知流（订阅回放现存 + 增量；resolve 事件 = 条件已恢复，bar 据此移除）`,
            input: {},
            output: EnvNoticeEventSchema,
          }),
          /**
           * **探针**：注入一条假的环境事实（磁盘水位 / 网络连败）—— **仅非生产环境**。
           *
           * 为什么需要：真造满盘会毁现场数据（2026-10-18 已经毁过 ##166 正文一次），真断网会
           * 打断本机所有实例。注入走的是与真事件**同一条**判据 + 同一个 ring + 同一个 bar，
           * 差别只在事实来源 —— 这是「bar 出现 / 关闭 / 回放 / 多条件堆叠」唯一可复现的活体验证。
           * 生产（`DIY_ENV=production`）一律拒绝：它不是"随手造个假红条"的入口。
           *
           * 用法：
           *   `diy env simulate --disk-avail 1048576 --disk-total 536870912`
           *   `diy env simulate --net-code ENOTFOUND --net-streak 3`
           *   `diy env simulate --disk-avail 200000000000 --disk-total 500000000000`（恢复 → 自动消）
           */
          simulate: RpcSchema.unary({
            desc: `探针：注入假环境事实（磁盘水位 / 网络连败）—— 仅非生产环境；恢复值会触发自动消`,
            input: {
              diskAvail: z.number().optional().cliOption({ desc: "磁盘可用字节数（给出 = 走磁盘分支）" }),
              diskTotal: z.number().optional().cliOption({ desc: "磁盘总字节数（缺省 500GiB）" }),
              diskMount: z.string().optional().cliOption({ desc: "挂载点标签（缺省 = 进程的探测目标）" }),
              netCode: z.string().optional().cliOption({ desc: "网络错误码（给出 = 走网络分支，如 ENOTFOUND）" }),
              netStreak: z.number().optional().cliOption({ desc: "连续失败次数（缺省 = 判据阈值 3；小于阈值 = 不亮）" }),
              netMessage: z.string().optional().cliOption({ desc: "错误消息（展示用）" }),
            },
            output: z.object({ notice: EnvNoticeSchema.nullable() }),
          }),
          /**
           * **探针**：立刻采一次磁盘水位并按判据推通知（不写盘、不填卷）。
           *
           * 为什么要有它：真造满盘会毁现场数据（2026-10-18 已经毁过 ##166 正文一次）。可复现的
           * 验证只有两条路 —— ① 单测注入假 statfs ② 这条 RPC 指向**小容量 hdiutil 镜像**
           * （`DIY_ENV_WATCH_TARGET` 或本参数）。这条命令就是 ② 的入口。
           */
          probe: RpcSchema.unary({
            desc: `立刻探一次磁盘水位并推通知（探针：可指定 path 指向小容量镜像，别填满根卷）`,
            input: {
              path: z.string().optional().cliOption({
                desc: "要探测的路径（缺省 = 进程的 DIY_ENV_WATCH_TARGET 或 /）",
                resolvePath: true,
              }),
            },
            output: z.object({
              sample: z.object({ mount: z.string(), availBytes: z.number(), totalBytes: z.number() }),
              /** 这次探测产出的通知（水位 ok 时 null，且会撤掉已有通知） */
              notice: EnvNoticeSchema.nullable(),
            }),
          }),
        },});

export const envService = defineService({ name: "diy.env", api: envRoutes });
