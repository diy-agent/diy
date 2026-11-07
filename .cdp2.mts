const wsUrl = process.argv[2]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(wsUrl);
await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error("ws")); });
let seq = 0; const pend = new Map<number, (v: any) => void>();
ws.onmessage = (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.id) pend.get(m.id)?.(m); };
const send = (method: string, params: any = {}, sid?: string) => new Promise<any>((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); });
const t = await send("Target.getTargets");
const page = (t.result.targetInfos as any[]).find((x) => x.type === "page");
const sid = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result.sessionId;
const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value;
console.log("url:", page.url);
// 打开该任务（点历史里第一个任务链接 / 或直接改 hash 路由）
console.log("tabs:", await ev(`[...document.querySelectorAll('[role=tab],button')].map(b=>b.textContent?.trim()).filter(Boolean).slice(0,25).join(' | ')`));
// 悬停环
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('窗口占用')); if(!b) return 'no-ring'; b.dispatchEvent(new Event('pointerenter',{bubbles:true})); return 'ok'; })()`);
await sleep(1500);
console.log("card:", await ev(`(() => { const el=document.querySelector('[data-compact-cut-bar]'); if(!el) return 'absent';
  return (el.textContent||'').replace(/\\s+/g,' ').trim(); })()`));
const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
if (shot.result?.data) { const fs = await import("node:fs"); fs.writeFileSync("/tmp/lab-card.png", Buffer.from(shot.result.data, "base64")); console.log("shot /tmp/lab-card.png"); }
ws.close();
