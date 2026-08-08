/**
 * codes.ts — grpc/connectrpc 错误码 ↔ HTTP 状态映射
 *
 * wire 上 code 用 grpc canonical 名；HttpRaw 绑定负责把 code 归一化并映射到 HTTP 状态码。
 * 内部自定义 code（TIMEOUT/ABORTED/…）在 http 上归一化为 grpc canonical，让 HTTP 语义对齐。
 */

/** grpc canonical code → HTTP status（connectrpc 标准映射表） */
const GRPC_TO_HTTP: Record<string, number> = {
  OK: 200,
  CANCELLED: 499,
  UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
  UNAUTHENTICATED: 401,
};

/** 内部自定义 code → grpc canonical */
const INTERNAL_TO_GRPC: Record<string, string> = {
  INTERNAL_ERROR: 'INTERNAL',
  TIMEOUT: 'DEADLINE_EXCEEDED',
  ABORTED: 'CANCELLED',
  DISPOSED: 'UNAVAILABLE',
  STREAM_ERROR: 'DATA_LOSS',
  INVALID_ACK: 'INTERNAL',
};

/** 把任意 code 归一化为 grpc canonical（已知的保留，未知的透传） */
export function normalizeCode(code: string): string {
  return INTERNAL_TO_GRPC[code] ?? code;
}

/** code → HTTP 状态（归一化后查表，未知默认 500） */
export function httpStatusForCode(code: string): number {
  return GRPC_TO_HTTP[normalizeCode(code)] ?? 500;
}

/** HTTP 状态 → grpc canonical（反向，给客户端标注用；未知 → 'UNKNOWN'） */
export function codeForHttpStatus(status: number): string {
  const hit = Object.entries(GRPC_TO_HTTP).find(([, s]) => s === status);
  return hit ? hit[0] : 'UNKNOWN';
}
