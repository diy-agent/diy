// src/renderer_solid/lib/traffic-body.ts
// 🎯 流量记录里「首尾法保留的正文」→ 可展示的值（纯函数，不碰 DOM / RPC，故单测可直接跑）。
//
// ##425 的核心判据落在这里：存档截断（`archive`）与正文被截（`wire`）**必须长得不一样**。
// 原实现只插一句 `<中间省略 N 字节（正文共 M 字节）>`，读者分不出「原文完整、只是日志没存」
// 和「发出去的就是残缺的」—— 最初那次误判（把任务 body 的 425 KB 当成真被塞进请求）就出在这。

import { cutMarker } from "@diy-agent/context/format/cut-marker";
import type { BodyCaptureSchema } from "../../shared/traffic-record";
import type { z } from "zod";

/** 首尾法保留的一段正文（`shared/traffic-record.ts` 的 `BodyCaptureSchema` 的值形状） */
export type BodyCapture = z.infer<typeof BodyCaptureSchema>;

/**
 * 还原成可展示的值：未截断且能解析成 JSON → 结构；否则 → 文本。
 * 被截断时，中间那段换成 `<cut by="traffic-log" scope="archive" …/>`（原文完整，只是存档没存）。
 */
export function bodyValue(c: BodyCapture | null, note: string | null): unknown {
    if (!c) return note ?? "（无正文）";
    if (!c.truncated) {
        try {
            return JSON.parse(c.head);
        } catch {
            return c.head;
        }
    }
    // `archive` 档：**不是 `wire`**。原文完整（请求真发过、模型真收到全文），
    // 只是日志为省盘只留头 + 尾（`capture-off` = 没开「记录完整请求内容」）。
    return `${c.head}\n${cutMarker({
        by: "traffic-log",
        scope: "archive",
        why: "capture-off",
        unit: "bytes",
        total: c.totalBytes,
        kept: c.headBytes + c.tailBytes,
    })}\n${c.tail}`;
}
