// ErrorBar —— 会话级错误（传输/加载失败）的统一样子。
//
// state.error 之前两个表面都没人渲染：请求失败时界面"什么都没发生"。
// 这个条是 surface 无关的，两边共用，位置固定在消息区顶部。

export function ErrorBar({ error, onRetry }: { error?: string; onRetry?: () => void }) {
    if (error === undefined || error === '') return null;

    return (
        <div
            role="alert"
            className="flex items-start gap-2 border-b border-red-500/25 bg-red-500/10 px-4 py-1.5 text-xs text-red-300"
        >
            <span className="min-w-0 flex-1 break-words">{error}</span>
            {onRetry !== undefined && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="shrink-0 rounded border border-red-400/30 px-1.5 py-0.5 hover:bg-red-500/15"
                >
                    重试
                </button>
            )}
        </div>
    );
}
