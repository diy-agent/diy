// errors.ts — provider 的唯一异常类型 + 上游失败分类。
//
// 为什么分类放在这里：调用方要据此决定**动作**（换 key / 等一下 / 换模型 / 报网络故障），
// 而 HTTP 细节（状态码、undici 的错误名、ai-sdk 的包装层）不该漏给他们。
// 但**策略**不在这里：本包不重试、不退避、不排队 —— 那是另一个包的活。

/** 可辨识的错误码（`<域>/<kebab>`，同仓约定） */
export type LlmProviderErrorCode =
    | 'llm-provider/unauthorized'
    | 'llm-provider/rate-limit'
    | 'llm-provider/timeout'
    | 'llm-provider/network'
    | 'llm-provider/upstream'
    | 'llm-provider/unknown';

/** 上游失败：code 是可判别的动作依据（`statusCode` 有值 = 上游真的回了 HTTP 响应） */
export class LlmProviderError extends Error {
    readonly code: LlmProviderErrorCode;
    /** 上游 HTTP 状态码；没有响应（网络 / 超时）时缺省 */
    readonly statusCode?: number;
    /** 可安全重试吗（429 / 5xx / 网络类 = true；401 = false） */
    readonly retryable: boolean;

    constructor(
        code: LlmProviderErrorCode,
        message: string,
        options: { statusCode?: number; retryable?: boolean; cause?: unknown } = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'LlmProviderError';
        this.code = code;
        if (options.statusCode !== undefined) this.statusCode = options.statusCode;
        this.retryable = options.retryable ?? RETRYABLE.has(code);
    }
}

const RETRYABLE: ReadonlySet<LlmProviderErrorCode> = new Set<LlmProviderErrorCode>([
    'llm-provider/rate-limit',
    'llm-provider/timeout',
    'llm-provider/network',
    'llm-provider/upstream',
]);

/** 网络层错误的 code 词表（Node / undici / 各家 fetch 的并集，够用即可） */
const NETWORK_CODES: ReadonlySet<string> = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);

const TIMEOUT_CODE = /ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|ESOCKETTIMEDOUT/;
const TIMEOUT_NAME = /^(?:TimeoutError|AbortError|ConnectTimeoutError|HeadersTimeoutError|BodyTimeoutError)$/;
const TIMEOUT_TEXT = /timed?\s*out|timeout/i;

/**
 * 把任意上游异常翻译成本包的错误。
 *
 * 判据顺序（先「确定的事实」再「模糊的文本」）：
 *   ① 已经是我们自己的错误 → 原样返回（不重复包装）
 *   ② `statusCode`（ai-sdk 的 APICallError 带它）→ 401/403 / 429 / 其余
 *   ③ 沿 `cause` 链找 name / code / message 里的超时与网络特征
 *   ④ 都不命中 → unknown（宁可说不认识，也不假报成可重试）
 */
export function classifyError(cause: unknown): LlmProviderError {
    if (cause instanceof LlmProviderError) return cause;

    const status = statusOf(cause);
    if (status !== undefined) {
        if (status === 401 || status === 403) {
            return new LlmProviderError('llm-provider/unauthorized', `上游拒绝鉴权（HTTP ${status}）`, {
                statusCode: status,
                retryable: false,
                cause,
            });
        }
        if (status === 429) {
            return new LlmProviderError('llm-provider/rate-limit', '上游限流（HTTP 429）', {
                statusCode: status,
                cause,
            });
        }
        return new LlmProviderError('llm-provider/upstream', `上游返回 HTTP ${status}`, { statusCode: status, cause });
    }

    const shape = shapeOf(cause);
    if (shape.timeout) {
        return new LlmProviderError('llm-provider/timeout', '请求超时（上游未在预期时间内回应）', { cause });
    }
    if (shape.network) {
        return new LlmProviderError('llm-provider/network', '网络不可达（连接失败或被重置）', { cause });
    }
    return new LlmProviderError('llm-provider/unknown', messageOf(cause), { cause });
}

/** 沿 cause 链找 HTTP 状态码（APICallError.statusCode / Response.status） */
function statusOf(cause: unknown): number | undefined {
    for (const node of chain(cause)) {
        if (!node || typeof node !== 'object') continue;
        const record = node as { statusCode?: unknown; status?: unknown };
        const raw = record.statusCode ?? record.status;
        if (typeof raw === 'number' && raw >= 400) return raw;
    }
    return undefined;
}

/** 沿 cause 链找超时 / 网络特征 */
function shapeOf(cause: unknown): { timeout: boolean; network: boolean } {
    let timeout = false;
    let network = false;
    for (const node of chain(cause)) {
        if (!node || typeof node !== 'object') continue;
        const record = node as { name?: unknown; code?: unknown; message?: unknown };
        const name = typeof record.name === 'string' ? record.name : '';
        const code = typeof record.code === 'string' ? record.code : '';
        const message = typeof record.message === 'string' ? record.message : '';
        if (TIMEOUT_NAME.test(name) || TIMEOUT_CODE.test(code)) timeout = true;
        else if (TIMEOUT_TEXT.test(message)) timeout = true;
        if (NETWORK_CODES.has(code)) network = true;
    }
    return { timeout, network };
}

/** 有限深度遍历 cause 链（防自引用 / 深链） */
function chain(cause: unknown): unknown[] {
    const out: unknown[] = [];
    let node: unknown = cause;
    for (let i = 0; i < 8 && node !== undefined && node !== null; i += 1) {
        out.push(node);
        if (typeof node !== 'object') break;
        const next: unknown = (node as { cause?: unknown }).cause;
        if (next === node) break;
        node = next;
    }
    return out;
}

function messageOf(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}
