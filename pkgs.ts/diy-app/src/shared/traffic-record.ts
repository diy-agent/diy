// src/shared/traffic-record.ts
// 🎯 流量日志一条记录的 **zod 契约**（纯 zod，无 node 依赖；main + renderer 共用）。
//
// 从 `main/services/api-def.ts` 搬到这里的原因（##310）：
//   变量树里有个 `reqlog` 节点要**列字段名**，而"字段名真源"只能是这份 schema。
//   若由 `prompt-registry` 直接 import `api-def`，就在 main 的启动链上多出一条边 ——
//   实测把打包后的模块初始化顺序顶歪：`api-def` 的顶层代码**先于** `@diy-agent/rpc` 的
//   zod 扩展（`n` / `cliArg` / `cliOption`，side-effect 安装）执行 → 主进程启动即崩
//   （`TypeError: TaskStateSchema.cliArg is not a function`）。
//   搬进 shared 后：api-def 从 shared 取（契约仍是一份），prompt-registry 也只依赖 shared。
//
// 约定：本文件只放 schema/类型，禁止 import node:*（renderer 会打进包）。

import { z } from "zod";

/** 一条流量记录（一次 HTTP 往返；body 形状任意，故用 any） */
export const BodyCaptureSchema = z.object({
  head: z.string().describe("首段文本（未截断时即全文）"),
  tail: z.string().describe("尾段文本（只保留最后一段；未截断时为空串）"),
  headBytes: z.number().describe("首段保留的字节数"),
  tailBytes: z.number().describe("尾段保留的字节数"),
  totalBytes: z.number().describe("正文完整字节数"),
  truncated: z.boolean().describe("是否被截断（headBytes + tailBytes < totalBytes 即截断）"),
});
export const LogLocSchema = z.object({
  file: z.string().describe("日志文件（相对 DIY_HOME，如 log/network/2026-10-13.jsonl）"),
  offset: z.number().describe("该条记录在文件中的起始字节"),
  len: z.number().describe("该条记录的字节长度"),
  line: z.number().describe("行号（1 起；一行 = 一条记录）"),
  abs: z.string().describe("文件绝对路径（界面展示 / 打开文件位置用）"),
});
export const TrafficRecordSchema = z.object({
  id: z.number(),
  ts: z.number().describe("请求发出时刻（epoch ms）"),
  kind: z.enum(["llm", "probe", "http"]).describe("来源：LLM 对话 / 模型配置探测 / 其它"),
  session: z.string().describe("x-opencode-session（归属键，反查 task/turn 用）；无归属则空串"),
  taskUri: z.string().nullable().describe("归属任务；未知则 null"),
  turnId: z.string().nullable().describe("归属轮次"),
  provider: z.string().describe("provider id"),
  model: z.string().describe("模型 id"),
  baseUrl: z.string(),
  method: z.string(),
  url: z.string().describe("完整请求 URL"),
  host: z.string().describe("主机名（含端口）"),
  path: z.string(),
  attempt: z
    .number()
    .describe(
      "【老字段】本 run 内第几次 HTTP 往返（跨步累计、重试也算一次）。" +
        "它既**不是步序**（一步可能有多次往返），也**不是重试序号**（跨步累计不归零）；" +
        "定位「某一步的第几次尝试」用 stepSeq + attemptInStep",
    ),
  stepSeq: z
    .number()
    .nullable()
    .optional()
    .describe(
      "该往返属于本轮第几个**逻辑步**（1 起，与变更历史的 stepNo / stepId 的 _s<N> 同号）；" +
        "null 或缺失 = 没有步归属（模型配置探测、摘要这类一次性调用，或本字段上线前的老记录）",
    ),
  attemptInStep: z
    .number()
    .nullable()
    .optional()
    .describe(
      "该步内第几次 HTTP 往返（1 = 首试，2 = 第 1 次重试…）；" +
        "同一步的多条记录按它排就是**重试链**（各自带 status / ms / err）。null = 没有步归属",
    ),
  maxRetries: z.number(),
  status: z.number().nullable().describe("HTTP 状态码；null = 未收到响应（网络错 / 超时）"),
  ms: z.number().describe("这次往返的耗时 ms（发出 → 收口）。重试是另一次往返、另一条记录，不合并计一个数"),
  ttfbMs: z
    .number()
    .nullable()
    .optional()
    .describe(
      "从发出到收到**响应头**的耗时 ms（≈ 连接 + 排队 + 上游首字节）。" +
        "null 或缺失 = 没收到响应头（网络错 / 连接超时，看 err）：此时 ms 巨大说明时间全花在「连不上」",
    ),
  reqBytes: z.number().describe("请求正文字节数（完整大小，不受截断影响）"),
  resBytes: z.number().describe("响应正文字节数（完整大小；未收到为 0）"),
  reqHeaders: z.record(z.string(), z.string()).describe("已脱敏（authorization 只留尾 4 位）"),
  reqBody: BodyCaptureSchema.nullable().describe("请求正文（首尾法保留，见字段说明）"),
  resHeaders: z.record(z.string(), z.string()),
  resBody: BodyCaptureSchema.nullable().describe("响应正文（首尾法保留）；未捕获时为 null，原因见 resNote"),
  resNote: z.string().nullable().describe("未能保留响应正文时的说明（如正文过大）"),
  traceId: z.string().nullable().describe("上游追责凭据（响应头 x-trace-id / x-request-id / x-opencode-log-id）"),
  err: z.string().nullable().describe("网络层异常消息"),
  log: LogLocSchema.nullable().describe("该条落盘位置（界面按位置随机读；null = 未落盘）"),
});
export type TrafficRecord = z.infer<typeof TrafficRecordSchema>;
