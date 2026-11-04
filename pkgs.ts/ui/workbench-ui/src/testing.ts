// testing.ts — 意图测试钩子（renderer 侧执行端，2026-11-05 B2）
//
// 链路：测试 → main（rpc client）→ preload（rpc server）→ **这里** → 真 DOM
//
// 为什么不用 E2E 那套真鼠标：`Input.dispatchMouseEvent` 会受命中测试、遮挡、动画影响，
// 慢且脆；意图测试要的是「逻辑对不对」，直接设值/派事件/等状态即可。
// 见 docs/testing.md 的分层（意图 > core API 意图 > E2E > 单元）。
//
// 生产环境零开销：只有 E2E/意图测试进程会调 `installTestHooks()`。

interface TestCommand {
    type: "fill" | "click" | "waitState" | "readState";
    selector?: string;
    value?: unknown;
    path?: string;
    equals?: unknown;
    timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 从 `window.__diyTestState` 按点路径取值（页面自己往上挂状态，见 installTestHooks 的 doc） */
function readPath(path: string): unknown {
    const root = (window as unknown as { __diyTestState?: Record<string, unknown> }).__diyTestState;
    if (root === undefined) return undefined;
    let cur: unknown = root;
    for (const seg of path.split(".")) {
        if (cur === null || cur === undefined) return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

function el(selector: string): HTMLElement {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`[意图测试] 找不到元素：${selector}`);
    return node;
}

async function run(cmd: TestCommand): Promise<unknown> {
    switch (cmd.type) {
        case "fill": {
            const node = el(cmd.selector!);
            const input = node as HTMLInputElement | HTMLTextAreaElement;
            input.value = String(cmd.value ?? "");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return undefined;
        }
        case "click": {
            el(cmd.selector!).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return undefined;
        }
        case "waitState": {
            const deadline = Date.now() + (cmd.timeoutMs ?? 5000);
            while (Date.now() < deadline) {
                if (JSON.stringify(readPath(cmd.path!)) === JSON.stringify(cmd.equals)) return undefined;
                await sleep(20);
            }
            throw new Error(
                `[意图测试] 等 ${cmd.path} === ${JSON.stringify(cmd.equals)} 超时（实际 ${JSON.stringify(readPath(cmd.path!))}）`,
            );
        }
        case "readState":
            return readPath(cmd.path!);
    }
}

/**
 * 安装命令处理器。**只该在测试进程里调**（生产调了也没人发命令，等于挂个空 Listener）。
 *
 * 页面要暴露状态时，把快照挂到 `window.__diyTestState`（可以每帧更新，读时现取）：
 *
 * ```ts
 * window.__diyTestState = { bots: store.bots.map(b => b.name), panelOpen: signal() };
 * ```
 */
export function installTestHooks(): void {
    const hooks = (window as unknown as { __diyTestHooks?: { setHandler(h: (cmd: unknown) => Promise<unknown>): void } })
        .__diyTestHooks;
    if (hooks === undefined) return; // 没有 preload 桥（如纯浏览器预览）—— 静默跳过
    hooks.setHandler((cmd) => run(cmd as TestCommand));
}
