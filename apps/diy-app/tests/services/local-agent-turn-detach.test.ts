// tests/services/local-agent-turn-detach.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 轮次生命周期独立于消费端连接（##305）
//
// 定案（用户 2026-10-14 拍板）：无人消费**继续烧 token**（agent 对话是后台进程的维护，
// 窗口只是它的使用窗口），代价由 **`maxSteps`（缺省 200）步数上限**自然收口 ——
// **不设时间维度的回收**（离开两小时不该误杀正常长任务）。真正要处置的是"卡死/无进展"，
// 由人在全局会话视图上手动强制中断（[5] ##308）。
//
// 故本文件钉两条**反向**行为（防止"顺手加个超时"把定案改回去）：
//   ① 无观察者 + 长时间无进展 → **不回收**（signal 不被 abort、轮次仍在 activeTurnList）；
//   ② 可见性数据源：`watchers` = chat 流消费端 + op 订阅（UI 打开会话 = 有人在看），
//      断开 chat 流后 op 订阅仍计（[5] ##308 的 `subscribers` 由它算）；
//   ③ RPC 形态断开（卡在 `await next()`、无 op 窗口）→ chat 流订阅**即时**释放（不许滞留到
//      下一帧）—— review1-R1：chat 自己那条订阅也接了 RPC 的 `signal`（与 ops-feed 同修法）。
//
// 无网络、无 Electron：桩模型吐两个 token 后挂起等 abort（与 stop-cut 同手法）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import { opsFeed } from "../../src/main/services/ops-feed";
import { activeTurnList } from "../../src/main/services/runtime-context";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { hangingModel } from "../helpers/hanging-model";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let PROJECT = "1";
let seq = 0;
const newUri = (): string => createTask({ title: `轮次脱钩 ${++seq}`, project: PROJECT });

beforeAll(() => {
  process.env["OPENCODE_API_KEY"] = "test-key"; // 过 chat 入口校验；本用例的 mock 不出网
  PROJECT = createProject(mkdtempSync(join(tmpdir(), "turn-detach-")));
});

function readOps(uri: string): Array<{ op: string; id: string; kind?: string; fields?: Record<string, unknown> }> {
  const fp = opsFile(uri);
  if (!existsSync(fp)) return [];
  return readFileSync(fp, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { op: string; id: string; kind?: string; fields?: Record<string, unknown> });
}

/** 起一轮挂住的生成，消费到首个 delta 后像刷新页面那样断开（只退订，不打断） */
async function startThenDetach(uri: string, mgr: LocalAgentManager): Promise<void> {
  const it = mgr.chat(uri, "会挂住的轮次");
  for (let i = 0; i < 10; i++) {
    const r = await it.next();
    if (r.done) break;
    if (r.value.op === "delta") break;
  }
  expect(activeTurnList().some((t) => t.taskUri === uri), "断开前应在跑").toBe(true);
  await it.return({ failed: false } as never);
}


/** 消费到首个 delta 后确认"不再有新 op"—— 返回时生成器停在 `await next()`（q 已空） */
async function consumeToQuiet(gen: AsyncGenerator<{ op: string }>): Promise<void> {
  let seenDelta = false;
  for (let i = 0; i < 40; i++) {
    const r = await gen.next();
    if (r.done) return;
    if (r.value.op === "delta") seenDelta = true;
    if (seenDelta) {
      // 再等 40ms 看是否还有 op；没有则视为排空（注意这次 next() 会留下悬挂的请求）
      const more = await Promise.race([gen.next().then((x) => ({ x })), sleep(40).then(() => null)]);
      if (more === null) return;
      if (more.x.done) return;
    }
  }
}

/** 挂一个**不 await** 的 next()：RPC 层真实形态就是一直 await 下一个 op。断言它在窗口内不 resolve */
async function parkOnNext(gen: AsyncGenerator<{ op: string }>): Promise<void> {
  let resolved = false;
  void gen.next().then((r) => {
    resolved = true;
    return r;
  });
  await sleep(60);
  expect(resolved, "生成器应卡在 await next()（q 已空）").toBe(false);
}

describe("轮次不随消费端断开而死（##305）", () => {
  it("无观察者且长时间无进展 → **不回收**（不设时间超时）；仍由主动停止收尾且留痕", async () => {
    const uri = newUri();
    const mgr = new LocalAgentManager(() => hangingModel("挂住的生成"));
    await startThenDetach(uri, mgr);

    // 断开之后没有任何观察者，等足"若真有超时早就触发"的时间
    await sleep(600);
    expect(mgr.watchers(uri), "断开后应无观察者").toBe(0);
    expect(
      activeTurnList().some((t) => t.taskUri === uri),
      "无人观察也不得自动回收（##305 定案：以步数为界，不设时间超时）",
    ).toBe(true);

    // 收尾只能由人手动（全局视图的强制中断 = cancel）
    expect(mgr.cancel(uri), "cancel 应命中在途轮次").toBe(true);
    await sleep(60);
    expect(activeTurnList().some((t) => t.taskUri === uri)).toBe(false);

    // 收尾留痕：ops 里落 aborted 的 endReason（不许静默结束）
    const patch = readOps(uri).find((o) => o.op === "patch" && o.fields && "endReason" in o.fields);
    expect(patch?.fields?.["endReason"]).toMatchObject({ type: "aborted" });
  });

  it("可见性数据源（[5] ##308）：watchers 计入 op 订阅，chat 流退了仍算有人看", async () => {
    const uri = newUri();
    const mgr = new LocalAgentManager(() => hangingModel("挂住的生成"));
    await startThenDetach(uri, mgr);
    expect(mgr.watchers(uri), "chat 流断开 + 无 op 订阅 = detached").toBe(0);

    // UI 打开这个会话 = 订阅 op 流（##307 读侧）：即使 chat 流已退，也算有人在看
    const iter = opsFeed.subscribe(uri, 0)[Symbol.asyncIterator]();
    expect(mgr.watchers(uri), "op 订阅应计入观察者").toBe(1);

    await iter.return?.();
    expect(mgr.watchers(uri)).toBe(0);

    mgr.cancel(uri); // 清场
    await sleep(60);
  });

  it("RPC 形态断开（卡在 await next()、无 op 窗口）→ chat 流订阅**即时**释放（review1-R1/R7）", async () => {
    const uri = newUri();
    const mgr = new LocalAgentManager(() => hangingModel("挂住的生成"));
    const ac = new AbortController();
    const gen = mgr.chat(uri, "会挂住的轮次", undefined, undefined, ac.signal) as unknown as AsyncGenerator<{ op: string }>;

    // 排空已产出的 op —— 生成器随即停在 `await next()`（RPC 真实形态：一直 await 下一个 op）
    await consumeToQuiet(gen);
    expect(mgr.watchers(uri), "断开前 chat 流订阅在").toBe(1);

    await parkOnNext(gen);
    // 传输断开：abort（signal = 第二条出口）+ 不 await 的 return（排在悬挂的 next() 之后）
    const ret = gen.return({ failed: false } as never);
    ac.abort();
    await sleep(80);

    expect(mgr.watchers(uri), "无 op 窗口断开 → 订阅必须即时释放（不许滞留到下一帧）").toBe(0);
    expect(
      activeTurnList().some((t) => t.taskUri === uri),
      "断开只退订，轮次仍在跑（##305 核心语义）",
    ).toBe(true);

    mgr.cancel(uri); // 清场：唯一"停"入口
    await Promise.race([ret, sleep(500)]);
    await sleep(60);
    expect(activeTurnList().some((t) => t.taskUri === uri)).toBe(false);
  });
});
