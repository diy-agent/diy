// tests/wait.ts
// 🎯 E2E 有界轮询：把「动作 → 立即断言最终状态」改成「动作 → 轮询到条件成立（有上限）」
//
// 为什么需要：意图测试是真实 CLI + Electron，状态变更经过
//   renderer 处理器 → main 写盘（同步）→ 另一次 CLI 往返读树
// 这条链上任一段（RPC 转发、CLI 冷启动探活、监听推送）在高负载下都可能慢一拍，
// 单次断言就会假红。轮询把「慢」与「错」区分开：慢 → 等到成立；错 → 到上限后
// **把真实值交回给断言**，报错信息仍然完整（不吞错）。

export interface WaitOptions {
    /** 上限（毫秒）。到点后返回最后一次取值，由调用方断言报错 */
    timeoutMs?: number;
    /** 轮询间隔（毫秒） */
    intervalMs?: number;
    /** 每次失败时的说明（进日志，便于判断是慢还是错） */
    label?: string;
}

/**
 * 轮询 fn 直到 ok(v) 为真；到上限仍未成立则**返回最后一次取值**（不抛错）。
 * 用法：`expect(await waitUntil(treeText, (t) => t.includes('X'))).toContain('X')`
 */
export async function waitUntil<T>(
    fn: () => Promise<T>,
    ok: (v: T) => boolean,
    opts: WaitOptions = {},
): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const intervalMs = opts.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let last!: T;
    for (;;) {
        last = await fn();
        if (ok(last)) return last;
        if (Date.now() >= deadline) {
            if (opts.label) console.error(`[waitUntil] ${opts.label} 到上限 ${timeoutMs}ms 仍未成立，交回断言`);
            return last;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
