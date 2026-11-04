// tests/e2e/drive.ts — 最小 CDP 驱动器（自包含，无外部依赖）
//
// 为什么自己写而不搬 apps/diy-app/tests/ui-drive.ts：
//   那个是 623 行、依赖 ui-text / wait / cli inspect 的完整套件，跟着 diy-app 一起废弃。
//   这里只保留**新架构需要的最小面**：连 CDP、点元素、读 DOM、断言。
//   要扩展（拖拽 / 命中校验）时再按需补，别提前背复杂度。
//
// 关键：**不用 element.click()** —— 它跳过分层/遮挡判断，被浮层挡住的按钮也「成功」。
//   这里走 Input.dispatchMouseEvent（Chromium 原生输入注入），与真人点击同路径。

import WebSocket from "ws";

interface Target {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
}

export class Driver {
    private ws!: WebSocket;
    private seq = 1;
    private pending = new Map<number, (v: unknown) => void>();
    private events: string[] = [];

    private constructor(ws: WebSocket) {
        this.ws = ws;
        this.ws.onmessage = (e) => {
            const m = JSON.parse(String(e.data)) as {
                id?: number;
                result?: unknown;
                method?: string;
                params?: { exceptionDetails?: { exception?: { description?: string } } };
            };
            if (m.id && this.pending.has(m.id)) {
                this.pending.get(m.id)!(m.result);
                this.pending.delete(m.id);
            } else if (m.method === "Runtime.exceptionThrown") {
                this.events.push(m.params?.exceptionDetails?.exception?.description ?? "unknown");
            }
        };
    }

    static async attach(port: number, timeoutMs = 30_000): Promise<Driver> {
        const deadline = Date.now() + timeoutMs;
        let target: Target | undefined;
        while (Date.now() < deadline) {
            try {
                const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[];
                target = list.find((t) => t.type === "page");
                if (target) break;
            } catch {
                /* 端口还没起来，继续等 */
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        if (!target) throw new Error(`CDP ${port} 在 ${timeoutMs}ms 内没出现 page target`);

        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise<void>((res, rej) => {
            ws.onopen = () => res();
            ws.onerror = () => rej(new Error("CDP WebSocket 连接失败"));
        });
        const d = new Driver(ws);
        await d.send("Runtime.enable");
        return d;
    }

    private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        const id = this.seq++;
        return new Promise((res) => {
            this.pending.set(id, res);
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /** 在页面里求值（支持 async） */
    async eval<T = unknown>(expression: string): Promise<T> {
        const r = (await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        })) as { result?: { value?: T } };
        return r.result?.value as T;
    }

    /** 等条件成立（返回 false 超时） */
    async waitFor(expression: string, timeoutMs = 8000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.eval<boolean>(`Boolean(${expression})`)) return true;
            await new Promise((r) => setTimeout(r, 120));
        }
        return false;
    }

    /** 真实鼠标点击（不绕过命中测试） */
    async click(selector: string): Promise<void> {
        const rect = await this.eval<{ x: number; y: number; w: number; h: number } | null>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
        })()`);
        if (!rect) throw new Error(`点击失败：${selector} 不存在或尺寸为 0（不可见/被隐藏）`);

        // 先确认坐标处**确实是它**（不是被浮层挡住）
        const hit = await this.eval<boolean>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            const top = document.elementFromPoint(${String(rect.x)}, ${String(rect.y)});
            return top === el || el.contains(top);
        })()`);
        if (!hit) throw new Error(`点击失败：${selector} 被其它元素遮挡`);

        for (const type of ["mousePressed", "mouseReleased"]) {
            await this.send("Input.dispatchMouseEvent", {
                type,
                x: rect.x,
                y: rect.y,
                button: "left",
                clickCount: 1,
            });
        }
    }

    /** 输入文字（先聚焦，再逐字输入，触发 input 事件） */
    async type(selector: string, text: string): Promise<void> {
        await this.click(selector);
        await this.eval(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            el.value = ${JSON.stringify(text)};
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
    }

    /** 页面里抛过的异常 */
    errors(): string[] {
        return [...this.events];
    }

    close(): void {
        this.ws.close();
    }
}
