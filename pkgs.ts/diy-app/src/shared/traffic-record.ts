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
  attempt: z.number().describe("本轮第几次请求（每次重试即一次 HTTP 往返，逐次自增）"),
  maxRetries: z.number(),
  status: z.number().nullable().describe("HTTP 状态码；null = 未收到响应（网络错 / 超时）"),
  ms: z.number().describe("耗时 ms"),
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
