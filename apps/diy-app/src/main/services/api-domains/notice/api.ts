/**
 * api-domains/notice/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { StatusOk } from "../../../../shared/status";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { InboxEntrySchema } from "../../../../shared/inbox";
import { ModelUnavailableNoticeSchema } from "../../../../shared/model-unavailable";

export const noticeRoutes = RpcSchema.group({desc: `模型不可用通知（真发失败时产生；含人物 + 模型 + 上游原文）`,
        children: {
          /** 未关闭的通知，时间升序（CLI `diy notice list` 直接读它） */
          list: RpcSchema.unary({
            desc: `列出当前未关闭的「模型不可用」通知`,
            input: {},
            output: z.array(ModelUnavailableNoticeSchema),
          }),
          /**
           * 关闭 = "我知道了"：从 ring 移除，此后重连不再回放。
           * 为什么必须落 main 侧：只关界面的话，下一次重连的回放会把同一条又推回来 ——
           * 用户点了 ✕ 却关不掉的提示等于没关（bar 上"可关闭"是硬要求）。
           * 不给 id = **全关**（bar 一次只展示最新一条，点 ✕ 的语义就是"这波我都知道了"）。
           */
          dismiss: RpcSchema.unary({
            desc: `关闭通知（给 id 关一条；不给 = 全部关闭）`,
            input: { id: z.string().optional().cliArg({ desc: "通知 id（缺省 = 全部关闭）" }) },
            output: StatusOk,
          }),
          /**
           * 通知流：**订阅即回放**当前未关闭的通知，之后是增量。
           * 回放是刻意的：页面重载 / 断线重连后 bar 要能自己回来（用户重开窗口正是最容易
           * 错过提示的时刻），所以"当前事实"必须随订阅给全，而不是只推增量。
           */
          watch: RpcSchema.serverStream({
            desc: `通知流（订阅回放现存 + 增量推送；顶栏 bar 的数据源）`,
            input: {},
            output: ModelUnavailableNoticeSchema,
          }),
          /**
           * 通知信箱（##429 要求 ④/⑤ + ##436 的界面）：`level#inbox` 的「N1/N2 一律落信箱」。
           *
           * 条目种类（`shared/inbox.INBOX_KINDS`）：`max-tokens` / `cost-step` / `cost-turn`
           * （损失型，##429）· `message`（有留言投给某会话，##436：人署名 N2 / 机器 N1）·
           * `lost`（**任务已结案而插话队列里还压着留言** ⇒ 不会有下一次轮次来取走它；
           * 启动扫尾写入，不许静默。文案必须写明「改回 active 就会生效」——它是可逆的）·
           * `tools-surface`（##519：**换了 build 而工具描述改了字节** ⇒ 每个任务首个请求全价。
           * 启动时判定，`taskUri` 为空串 —— 它是**进程级**事实，不属于任何任务）。
           *
           * 与上面 `list/dismiss/watch`、下面 `env.*` 的关键差别是**数据定性**：那些是 cache
           * （进程内存 ring，重启即空 —— 描述“此刻怎么了”）；这里是 **append-only 落盘**
           * （`$DIY_HOME/local/inbox.jsonl`）—— 它描述“发生过什么”，重启后回看正是它的主要用途。
           *
           * 订阅语义刻意不同：`watch` **只推增量、不回放**。回放的历史条目会在 renderer 里
           * 被当成“刚发生”再弹一轮 toast（每次窗口重载糊一脸）；要回看走 `list`。
           */
          inbox: RpcSchema.group({
            desc: `通知信箱（落盘流水：撞输出上限 / 成本过阈 / 新留言 / 结案任务的滞留留言 / 工具面漂移；可回看）`,
            children: {
              list: RpcSchema.unary({
                desc: `列出信箱条目（时间升序；按任务可筛。人读用 diy notice inbox list）`,
                input: {
                  taskUri: z.string().optional().cliOption({ desc: "只看该任务的条目" }),
                  limit: z.number().optional().cliOption({ desc: "只要最近 N 条（缺省全部，上限 200）" }),
                },
                output: z.array(InboxEntrySchema),
              }),
              watch: RpcSchema.serverStream({
                desc: `信箱增量流（**不回放历史**：订阅后新落的才推；renderer 据此弹 N1 toast）`,
                input: {},
                output: InboxEntrySchema,
              }),
            },
          }),
        },});

export const noticeService = defineService({ name: "diy.notice", api: noticeRoutes });
