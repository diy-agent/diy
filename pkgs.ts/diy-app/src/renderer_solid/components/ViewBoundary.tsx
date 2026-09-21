/**
 * ViewBoundary — 单个 view 的错误边界。
 *
 * 为什么必须有：ViewGrid 把多个 view 装进同一页，views 来自不同代码路径
 * （chat / 编辑器 / 试验场）。任一 view 抛错若冒泡到根，整页树被卸载 → 白屏，
 * 用户连切换 view 的入口都点不到。这里把故障限制在**单个 view 的矩形内**，
 * 并在界面上写明是哪个 view 出的错（而不是静默空白）。
 */
import { ErrorBoundary, type JSX } from "solid-js";

export function ViewBoundary(props: { viewId: string; children: JSX.Element }) {
    return (
        <ErrorBoundary
            fallback={(err, reset) => (
                <div class="flex flex-col gap-2 items-start p-3 text-xs overflow-auto">
                    <div class="font-bold text-error">view「{props.viewId}」渲染失败</div>
                    <pre class="whitespace-pre-wrap opacity-70">
                        {err instanceof Error ? err.message : String(err)}
                    </pre>
                    <button class="btn btn-xs" onClick={reset}>
                        重试
                    </button>
                </div>
            )}
        >
            {props.children}
        </ErrorBoundary>
    );
}
