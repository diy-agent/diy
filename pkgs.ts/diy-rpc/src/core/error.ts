/**
 * error.ts — 统一错误模型（第2层端口的一部分）
 *
 * code 用 grpc canonical 名（'INVALID_ARGUMENT'|'INTERNAL'|…）；
 * ext 是协议扩展袋，各协议把原始数据放自己的命名空间（http.status…），互不打架。
 *
 * 转换链：handler/zod 抛出的任意东西 → toRpcError → RpcError → toErrorPayload → wire。
 */

// ═══════════════════════════════════════════════════
//  协议扩展袋（各协议各自的原始数据，命名空间隔离）
// ═══════════════════════════════════════════════════

export interface ErrorProtocolExt {
  http?: { status: number; statusText?: string; headers?: Record<string, string> };
  grpc?: { code: number };
  ws?: { closeCode?: number };
}

export interface RpcErrorOptions {
  details?: unknown;
  ext?: ErrorProtocolExt;
}

// ═══════════════════════════════════════════════════
//  RpcError
// ═══════════════════════════════════════════════════

export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
    public opts?: RpcErrorOptions,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  get details(): unknown {
    return this.opts?.details;
  }

  get ext(): ErrorProtocolExt | undefined {
    return this.opts?.ext;
  }
}

// ═══════════════════════════════════════════════════
//  wire 错误载荷（可序列化）
// ═══════════════════════════════════════════════════

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
  ext?: ErrorProtocolExt;
}

// ═══════════════════════════════════════════════════
//  转换工具
// ═══════════════════════════════════════════════════

/**
 * duck-typing 判 ZodError（zod v4 用 `err.issues`，避免硬依赖 zod 类型。
 * 若未来 zod 移除 issues 或改名，这里集中改一处）。
 */
function isZodError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * 任意 throw → RpcError：
 *   - RpcError    → 透传（保留 code + details + ext）
 *   - ZodError    → INVALID_ARGUMENT，details 带 zod issues（逐字段错误）
 *   - 其他 Error  → INTERNAL
 */
export function toRpcError(err: unknown): RpcError {
  if (err instanceof RpcError) return err;
  if (isZodError(err)) {
    return new RpcError('INVALID_ARGUMENT', 'Invalid input', {
      details: (err as { issues?: unknown }).issues,
    });
  }
  const e = err as { code?: unknown; message?: unknown };
  return new RpcError(
    typeof e?.code === 'string' && e.code ? e.code : 'INTERNAL',
    typeof e?.message === 'string' ? e.message : String(err),
  );
}

/** RpcError → wire ErrorPayload（保留 details + ext） */
export function toErrorPayload(err: unknown): ErrorPayload {
  const r = toRpcError(err);
  return { code: r.code, message: r.message, details: r.details, ext: r.ext };
}

/** 从 wire ErrorPayload 还原 RpcError（保留 details + ext） */
export function fromErrorPayload(p: ErrorPayload): RpcError {
  return new RpcError(p.code, p.message, { details: p.details, ext: p.ext });
}
