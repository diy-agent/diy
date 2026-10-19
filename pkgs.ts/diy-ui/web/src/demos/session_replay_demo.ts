import { DomApp } from "../../../src/providers/dom.js";
import { BlockStore, compactOps, toForest, type Op, type BlockNode } from "../lib/op-fold.js";

/**
 * session_replay_demo —— 用**真实大会话**压 diy-ui。
 *
 * 数据：mac 拷来的 DIY_HOME（`/d/share/diy-home/local`），经 `/sessions/*` 中间件直读。
 * 目标会话 `projects_4_tasks_262`：877,050 条 op、85 万个 token 级 delta、75.7MB ——
 * 就是历史上把 SolidJS 端拖死的那份（见 local-blocks.ts 头注）。
 *
 * 三条要量的曲线：
 *   ① fold    ：Op 流 → 块树（数据层成本，与框架无关）
 *   ② render  ：块树 → DOM（框架 rerun 一次的全量重建成本）
 *   ③ rerun(n)：清空重建 n 行的成本 —— 流式重放时它按 token 次数重复，即 O(N²) 的源
 *   ④ scroll  ：全量在 DOM 时滚动的帧率
 */

const DEFAULT_FILE = "/sessions/projects_4_tasks_262-8bc858df8037.ops.jsonl";

interface Row {
  depth: number;
  kind: string;
  text: string;
}

export function sessionReplayDemo(el: HTMLElement): void {
  const app = new DomApp({ mount: el });

  const hud = app.signal("就绪。点「① 折叠全量」开始。");
  const results = app.signal<string[]>([]);
  const rows = app.signal<Row[]>([]);

  let store: BlockStore | undefined;
  let flat: Row[] = [];
  let lastRerunMs = 0;

  const bench: Record<string, unknown> = { file: DEFAULT_FILE };
  (window as unknown as { __BENCH__: unknown }).__BENCH__ = bench;

  const pushResult = (line: string): void => {
    results.value = [...results.value, line];
    console.log("[bench] " + line);
  };
  const setHud = (t: string): void => {
    hud.value = t;
  };

  // ── 控件 ─────────────────────────────────────────────
  app.row(() => {
    app.button({ name: "① 折叠全量", onClick: () => void foldAll() });
    app.button({ name: "② 渲染全部", onClick: () => renderAll() });
    app.button({ name: "③ rerun 成本曲线", onClick: () => benchRerun() });
    app.button({ name: "④ 滚动 3s FPS", onClick: () => void scrollBench() });
  });

  app.column().cell((stage) => {
    stage.label(hud.value);
  });
  app.column().cell((stage) => {
    for (const r of results.value) stage.label(r);
  });

  const list = app.column();
  list.el.classList.add("session-scroll");
  list.cell((stage) => {
    const t0 = performance.now();
    for (const r of rows.value) {
      const d = stage.label(r.text);
      d.el.className = `diy-text row-${r.kind} row-d${r.depth}`;
    }
    lastRerunMs = performance.now() - t0;
  });

  // ── ① 折叠 ───────────────────────────────────────────
  async function foldAll(): Promise<void> {
    setHud("拉取 + 折叠中…");
    const t0 = performance.now();
    const res = await fetch(DEFAULT_FILE);
    if (!res.body) {
      setHud("fetch 失败");
      return;
    }
    const bytes = Number(res.headers.get("content-length") ?? 0);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const s = new BlockStore();
    let buf = "";
    let ops = 0;
    let applyMs = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const a0 = performance.now();
        s.apply(JSON.parse(line) as Op);
        applyMs += performance.now() - a0;
        ops++;
      }
    }
    if (buf.trim()) {
      s.apply(JSON.parse(buf) as Op);
      ops++;
    }
    const totalMs = performance.now() - t0;
    store = s;
    const compact = compactOps(s);
    bench.fold = { ops, blocks: s.blocks.size, bytes, compactOps: compact.length, totalMs, applyMs, issues: s.issues.length };
    setHud(`折叠完成：${ops.toLocaleString()} ops → ${s.blocks.size.toLocaleString()} 块（${(totalMs / 1000).toFixed(1)}s，apply ${(applyMs / 1000).toFixed(1)}s）`);
    pushResult(`① fold: ${ops} ops → ${s.blocks.size} blocks / compact ${compact.length} ops / ${totalMs.toFixed(0)}ms (apply ${applyMs.toFixed(0)}ms)`);
  }

  // ── ② 渲染全部 ───────────────────────────────────────
  function renderAll(): void {
    if (!store) {
      setHud("先跑 ①");
      return;
    }
    const t0 = performance.now();
    const forest = toForest(store);
    const treeMs = performance.now() - t0;
    flat = [];
    flatten(forest, flat, 0);
    const assign0 = performance.now();
    rows.value = flat; // 触发 list cell rerun（清空 + 重建）
    const assignMs = performance.now() - assign0;
    const nodes = list.el.querySelectorAll("*").length;
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    bench.render = { rows: flat.length, treeMs, rerunMs: lastRerunMs, assignMs, nodes, heapMB: heap / 1048576 };
    setHud(`渲染 ${flat.length.toLocaleString()} 行：tree ${treeMs.toFixed(0)}ms / rerun ${lastRerunMs.toFixed(0)}ms / DOM ${nodes.toLocaleString()} 节点 / 堆 ${(heap / 1048576).toFixed(0)}MB`);
    pushResult(`② render: ${flat.length} rows / tree ${treeMs.toFixed(0)}ms / rerun ${lastRerunMs.toFixed(0)}ms / DOM ${nodes} nodes / heap ${(heap / 1048576).toFixed(0)}MB`);
  }

  // ── ③ rerun 成本曲线（流式重放的 O(N²) 源）────────────
  function benchRerun(): void {
    if (!flat.length) {
      setHud("先跑 ①②");
      return;
    }
    const sizes = [100, 500, 1000, 2000, 4000, 8000, 16000, 32000].filter((n) => n <= flat.length);
    const curve: Array<{ n: number; ms: number }> = [];
    for (const n of sizes) {
      const slice = flat.slice(0, n);
      const t0 = performance.now();
      rows.value = slice;
      curve.push({ n, ms: performance.now() - t0 });
    }
    rows.value = flat;
    bench.rerunCurve = curve;
    for (const c of curve) pushResult(`③ rerun n=${c.n}: ${c.ms.toFixed(1)}ms`);
    setHud("rerun 曲线已记录。");
  }

  // ── ④ 滚动 FPS ───────────────────────────────────────
  async function scrollBench(): Promise<void> {
    const box = list.el;
    box.scrollTop = 0;
    const fps = await new Promise<number>((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      const total = Math.max(1, box.scrollHeight - box.clientHeight);
      const step = (): void => {
        frames++;
        const dt = performance.now() - t0;
        box.scrollTop = (dt / 3000) * total;
        if (dt < 3000) requestAnimationFrame(step);
        else resolve(frames / (dt / 1000));
      };
      requestAnimationFrame(step);
    });
    bench.scroll = { fps };
    setHud(`滚动 3s：${fps.toFixed(1)} FPS`);
    pushResult(`④ scroll: ${fps.toFixed(1)} FPS`);
  }

  // ── headless 钩子 ────────────────────────────────────
  (window as unknown as { __demo: unknown }).__demo = {
    foldAll,
    renderAll,
    benchRerun,
    scrollBench,
    bench,
    state: () => ({ rows: rows.value.length, hud: hud.value }),
  };

  app.mount();
}

function flatten(nodes: BlockNode[], out: Row[], depth: number): void {
  for (const n of nodes) {
    out.push({ depth, kind: n.tag, text: rowText(n) });
    if (n.children.length) flatten(n.children, out, depth + 1);
  }
}

function rowText(n: BlockNode): string {
  const a = n.attrs as Record<string, unknown>;
  switch (n.tag) {
    case "turn":
      return `# turn ${n.id}`;
    case "step":
      return `▸ step ${n.id}${a.model ? " · " + String(a.model) : ""}`;
    case "text":
      return String(a.content ?? "");
    case "think":
      return String(a.content ?? "");
    case "tool":
      return `${String(a.tool ?? "tool")} [${String(a.status ?? "")}]\n${String(a.output ?? a.input ?? "")}`;
    case "error":
      return `error: ${String(a.message ?? "")}`;
    default:
      return n.tag;
  }
}
