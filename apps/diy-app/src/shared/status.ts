/**
 * shared/status.ts — 几个跨域复用的 `{ status }` 形状
 *
 * 2026-11-06 从 `main/services/api-def.ts` 提出来。
 *
 * **为什么必须提**：这些常量原来定义在 `api-def.ts` **内部且没导出**，
 * 域拆到 `api-domains/*` 后各自复制一份 —— 光 `StatusOk` 就散在 6 个文件里。
 * 改一处忘另一处 = 契约漂移（同一个 `diy.notice.list` 的返回值形状可能与
 * `diy.llmProxy.status` 不一致，而两边都"看着对"）。
 */
import { z } from "zod";

/** 只有状态：`{ status }` —— 启动 / 停止 / 种入这类操作的统一返回 */
export const StatusOk = z.object({ status: z.string() });

/** 状态 + 新建对象的 id：`{ status, data: { id } }` —— 创建类操作的统一返回 */
export const StatusDataId = z.object({ status: z.string(), data: z.object({ id: z.string() }) });

/** 状态 + uri：`{ status, data: { uri } }` —— 更新类操作的统一返回 */
export const StatusDataUri = z.object({ status: z.string(), data: z.object({ uri: z.string() }) });
