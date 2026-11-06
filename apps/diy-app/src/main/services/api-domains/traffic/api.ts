/**
 * api-domains/traffic/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
/** 与 api-def.ts 的同名局部常量同形（那边没导出） */
const TrafficSnapshotSchema = z.object({
  fullCapture: z.boolean().describe("是否记录完整请求内容（正文不截断）"),
  cap: z.number().describe("内存里最多留多少条"),
  total: z.number(),
  logDir: z.string().describe("日志目录（相对 DIY_HOME）"),
  records: z.array(TrafficRecordSchema),
});
/** 与 api-def.ts 的同名局部常量同形（那边没导出） */
const StatusOk = z.object({ status: z.string() });
import { TrafficRecordSchema } from "../../../../shared/traffic-record";

export const trafficRoutes = RpcSchema.group({desc: `流量（应用发出去的 HTTP 请求 / 收到的响应；内存留最近若干条 + 逐条追加到 log/network/ 磁盘日志）`,
        children: {
          snapshot: RpcSchema.unary({
            desc: `取当前流量快照（开关状态 + 内存里的记录）。withRecords=false 时只回状态、不带记录数组`,
            input: {
              withRecords: z
                .boolean()
                .optional()
                .cliOption({ desc: "是否带上记录数组（默认 true；界面只关心开关状态时可省）" }),
            },
            output: TrafficSnapshotSchema,
          }),
          clear: RpcSchema.unary({
            desc: `清空流量记录（仅内存里的即时列表；磁盘日志不动）`,
            input: {},
            output: StatusOk,
          }),
          readLog: RpcSchema.unary({
            desc: `按位置读取磁盘日志里的一条记录（文件失效 / 版本不符时 ok=false 并给原因）`,
            input: {
              file: z.string().cliArg({ desc: "日志文件（相对 DIY_HOME）" }),
              offset: z.number().cliArg({ desc: "起始字节" }),
              len: z.number().cliArg({ desc: "字节长度" }),
            },
            output: z.object({
              ok: z.boolean(),
              message: z.string().nullable().describe("失败原因（人话）"),
              record: z.any().nullable().describe("读到的原始记录"),
            }),
          }),
          query: RpcSchema.unary({
            desc: `按条件查磁盘日志（流量页数据源）：全文关键词 / 状态 / 方法 / 日期（不传或 all = 全部日期）`,
            input: {
              text: z.string().optional().cliArg({ desc: "全文关键词（匹配地址、方法、状态、模型、正文等）" }),
              status: z.enum(["all", "ok", "4xx", "5xx", "err"]).optional().cliArg({ desc: "状态过滤" }),
              method: z.string().optional().cliArg({ desc: "HTTP 方法（all = 不限）" }),
              date: z.string().optional().cliArg({ desc: "日期 YYYY-MM-DD / all" }),
              limit: z.number().optional().cliArg({ desc: "最多返回条数（默认 1000）" }),
            },
            output: z.object({
              records: z.array(z.any()).describe("命中的记录（含 log 位置），按时间倒序"),
              scanned: z.number().describe("扫过的行数"),
              files: z.array(z.string()).describe("扫过的文件"),
              hits: z.number().describe("命中数"),
              truncated: z.boolean().describe("是否因超过 limit 被截断"),
              ms: z.number().describe("耗时 ms"),
            }),
          }),
          logFiles: RpcSchema.unary({
            desc: `列出磁盘上的流量日志文件、日期与总体积（头部「日志大小」/ 日期过滤 / 清理面板用）`,
            input: {},
            output: z.object({
              dir: z.string(),
              files: z.array(z.string()),
              dates: z.array(z.string()).describe("出现过的日期（新的在前）"),
              bytes: z.number().describe("日志目录总字节数"),
              detail: z
                .array(
                  z.object({
                    file: z.string(),
                    date: z.string(),
                    bytes: z.number(),
                    mtimeMs: z.number(),
                    today: z.boolean().describe("当天文件（正在写入 → 不可清理）"),
                  }),
                )
                .describe("逐文件详情（清理面板：列文件 + 显示占用）"),
            }),
          }),
          cleanLogs: RpcSchema.unary({
            desc: `清理磁盘流量日志（删整个按天文件）。files 或 keepDays 二选一；今天正在写入的文件一律不删；dryRun 只算不删`,
            input: {
              files: z
                .array(z.string())
                .optional()
                .cliOption({ desc: `要删的文件（相对 DIY_HOME），JSON 数组如 '[\"log/network/2026-10-01.jsonl\"]'` }),
              keepDays: z
                .number()
                .int()
                .min(1)
                .optional()
                .cliOption({ desc: "只留最近 N 天（含今天），删更早的日期文件" }),
              dryRun: z.boolean().optional().cliOption({ desc: "试运行：只统计将删什么 / 释放多少，不动磁盘" }),
            },
            output: z.object({
              deleted: z.array(z.string()).describe("真删掉的文件"),
              freedBytes: z.number().describe("释放的字节数"),
              skipped: z.array(z.object({ file: z.string(), reason: z.string() })).describe("被跳过的（附原因）"),
              remaining: z.object({ files: z.number(), bytes: z.number() }).describe("清理后剩余（文件数 / 字节）"),
            }),
          }),
          revealLog: RpcSchema.unary({
            desc: `在系统文件管理器里定位到某个日志文件（打开所在目录并选中该文件）`,
            input: { file: z.string().cliArg({ desc: "日志文件（相对 DIY_HOME）" }) },
            output: z.object({
              ok: z.boolean(),
              message: z.string().nullable().describe("失败原因（人话）"),
            }),
          }),
          openUrl: RpcSchema.unary({
            desc: `在系统默认浏览器打开 URL（远程导航页「web 远程访问」；仅 http/https）`,
            input: { url: z.string().cliArg({ desc: "http(s) URL" }) },
            output: z.object({
              ok: z.boolean(),
              message: z.string().nullable().describe("失败原因（人话）"),
            }),
          }),
          setFullCapture: RpcSchema.unary({
            desc: `开关「记录完整请求内容」（开 = 正文不再截断，全留；默认关 = 超长正文只留首尾一段）`,
            input: { on: z.boolean().cliArg({ desc: "true 开 / false 关" }) },
            output: TrafficSnapshotSchema,
          }),
          setCap: RpcSchema.unary({
            desc: `设置内存保留条数上限`,
            input: {
              n: z.number().cliArg({ desc: "条数上限（1..5000）" }),
            },
            output: TrafficSnapshotSchema,
          }),
          events: RpcSchema.serverStream({
            desc: `流量变更事件流（记录 / 清空 / 开关变更时推版本号；UI 收到后拉 snapshot）`,
            input: {},
            output: z.object({ version: z.number() }),
          }),
        },});

export const trafficService = defineService({ name: "diy.traffic", api: trafficRoutes });
