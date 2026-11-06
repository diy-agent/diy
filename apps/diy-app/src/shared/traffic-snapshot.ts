/**
 * shared/traffic-snapshot.ts — 流量日志快照（`diy.traffic.snapshot` 的返回）
 *
 * 2026-11-06 从 `api-def.ts` 提出（原来定义在文件内且没导出，拆域时被复制了一份）。
 */
import { z } from "zod";
import { TrafficRecordSchema } from "./traffic-record";

export const TrafficSnapshotSchema = z.object({
    fullCapture: z.boolean().describe("是否记录完整请求内容（正文不截断）"),
    cap: z.number().describe("内存里最多留多少条"),
    total: z.number(),
    logDir: z.string().describe("日志目录（相对 DIY_HOME）"),
    records: z.array(TrafficRecordSchema),
});
