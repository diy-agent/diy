// 直接挂到**已经在跑的** lab 实例（不走 vitest）：看压缩点面板在某个任务上的实际状态。
const wsUrl = process.argv[2]!;
const taskUri = process.argv[3] ?? "projects/1/tasks/1";
const log = (...a: unknown[]) => console.log(...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(wsUrl);
await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error("ws")); });
let seq = 0; const pend = new Map<number, (v: any) => void>();
ws.onmessage = (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.id) pend.get(m.id)?.(m); };
const send = (method: string, params: any = {}, sid?: string) => new Promise<any>((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); });
const t = await send("Target.getTargets");
const page = (t.result.targetInfos as any[]).find((x) => x.type === "page");
const sid = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result.sessionId;
const ev = async (x: string) => {
  const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }, sid);
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
};
log("page:", page.url);

// 打开该任务的会话页
await ev(`(async () => { const m = await import('/assets/index-vgobqMpT.js').catch(()=>null); return 'x'; })()`);
// 走 UI：点导航/搜索太麻烦 —— 直接用 RPC 打 ledger，看数据层对不对
const rpc = await ev(`(async () => {
  const r = await fetch("http://127.0.0.1:" + location.port + "/rpc", { method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({ method: "diy.agent.local.compact.ledger", params: { taskUri: ${JSON.stringify(taskUri)} } }) }).catch(e => ({ err: String(e) }));
  return typeof r?.json === "function" ? await r.json().catch(e => ({ err: String(e) })) : r;
})()`);
log("ledger:", JSON.stringify(rpc).slice(0, 1200));
ws.close();
