// index.ts — UI 测试驱动（CDP）：各 app 的 e2e 共用这一份。
//
// 为什么集中：apps/chat、apps/web、apps/minimal 都要"起服务 → 点界面 → 断言"，
// 各写一份驱动器 = 三套行为不一致（有的用 element.click() 假绿，有的不走命中测试）。
//
// 关键约束（踩过）：**不用 element.click()** —— 它跳过分层/遮挡判断，
// 被浮层挡住的按钮也「成功」，于是测试永远绿。这里走 Input.dispatchMouseEvent，
// 与真人点击同一条路径（完整命中测试 → 捕获/冒泡 → 默认行为链）。

import WebSocket from "ws";

interface Target {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
}

/** 连接方式：CDP 端口（Electron / Chromium --remote-debugging-port） */
export interface AttachOptions {
    port: number;
    /** 等 page target 出现的最长时间 */
    timeoutMs?: number;
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

    static async attach({ port, timeoutMs = 30_000 }: AttachOptions): Promise<Driver> {
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
        const rect = await this.eval<{ x: number; y: number } | null>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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

    /** 鼠标移到元素上（触发 CSS :hover —— 收起态的侧栏、hover 展开的菜单要靠它） */
    async hover(selector: string): Promise<void> {
        const rect = await this.eval<{ x: number; y: number } | null>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        if (!rect) throw new Error(`hover 失败：${selector} 不存在或尺寸为 0`);
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
        await new Promise((r) => setTimeout(r, 250));
    }

    /** 输入文字（先聚焦，再赋值并派发 input/change） */
    async type(selector: string, text: string): Promise<void> {
        await this.click(selector);
        await this.eval(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            el.value = ${JSON.stringify(text)};
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
    }

    /** 页面里抛过的未捕获异常 */
    errors(): string[] {
        return [...this.events];
    }

    close(): void {
        this.ws.close();
    }
}

/** 轮询 HTTP 直到返回 2xx/3xx（Web 模式用：服务起来需要时间） */
export async function waitHttp(url: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(url);
            if (r.ok) return true;
        } catch {
            /* 还没起来 */
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}
