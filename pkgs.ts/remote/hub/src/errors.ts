// 机器可判的错误码（CLI / UI 据此决定说什么，不解析文案）。

export type HubErrorCode =
    | 'hub/not-initialized'
    | 'hub/bad-input'
    | 'hub/protocol-mismatch'
    | 'invite/not-found'
    | 'invite/expired'
    | 'invite/exhausted'
    | 'invite/revoked'
    | 'invite/already-consumed'
    | 'invite/bad-secret'
    | 'pair/not-found'
    | 'pair/not-pending'
    | 'membership/not-found'
    | 'membership/revoked'
    | 'auth/unauthorized'
    | 'auth/forbidden'
    | 'pair/needs-tailscale'
    | 'keychain/unavailable'
    | 'tls/requires-trusted-cert';

export class HubError extends Error {
    constructor(
        readonly code: HubErrorCode,
        message: string,
        readonly detail?: string,
    ) {
        super(message);
        this.name = 'HubError';
    }
}

export function isHubError(e: unknown, code?: HubErrorCode): e is HubError {
    return e instanceof HubError && (code === undefined || e.code === code);
}
