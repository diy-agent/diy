// apps/chat/scripts/agent-smoke.mts
// 🎯 S2 的可演示切片：**一个 bot 的完整状态板**（不是测试，是给人看的）。
//
//   DIY_HOME=/tmp/agent-demo npx tsx apps/chat/scripts/agent-smoke.mts           # 造一轮完整经历（假模型）
//   AGENT_MODEL=aug@opencode-go/deepseek-v4.1-flash npx tsx ... --real          # 真模型（花钱）
//   DIY_HOME=/tmp/agent-demo npx tsx apps/chat/scripts/agent-smoke.mts --restart  # 重启后看同一份状态
//
// 演示四件事：
//   ① 状态是**内存对象**（seq / turns / 历史 / job 表），不是从 ops 回放推出来的；
//   ② 命令有回执：accepted / seq / 拒绝原因；
//   ③ 压缩把历史折成 checkpoint（模型看到的第一条就是它），旧的原文只在 raw 视图里；
//   ④ 关掉进程再起，全部原样回来（快照恢复，不涉及回放）。

import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgent, filePersist, llmPorts, resolveProvider, type AgentPorts } from "@diy-agent/bot";

const home = process.env["DIY_HOME"] ?? join(process.cwd(), ".agent-demo");
const dir = join(home, "agent", "demo");
mkdirSync(dir, { recursive: true });
const restart = process.argv.includes("--restart");
/** `--real` = 用真模型（需 AGENT_MODEL=account@provider/model）；缺省假 port，确定性、不花钱 */
const real = process.argv.includes("--real");

/** 假 port：确定性回答，带轮次编号，便于肉眼对照 */
function fakePorts(): AgentPorts & { calls: string[][] } {
  const calls: string[][] = [];
  let n = 0;
  return {
    calls,
    async *complete(messages) {
      calls.push(messages.map((m) => `${m.role}:${m.content}`));
      yield `（第 ${++n} 次回答）我看到 ${messages.filter((m) => m.role === "user").length} 条用户消息`;
    },
  };
}

const ports: AgentPorts = real
  ? llmPorts(
      resolveProvider(
        home,
        process.env["AGENT_MODEL"] ?? (() => {
          throw new Error("--real 需要 AGENT_MODEL=account@provider/model（例如 aug@opencode-go/deepseek-v4.1-flash）");
        })(),
      ),
    )
  : fakePorts();
const agent = createAgent({ id: "bot_demo", ports, persist: filePersist(dir) });
const waitIdle = async (): Promise<void> => {
  const t0 = Date.now();
  while (agent.snapshot().running && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
};

async function board(title: string): Promise<void> {
  const s = agent.snapshot();
  console.log(`\n──────── ${title} ────────`);
  console.log(`seq=${s.seq}  turns=${s.turns}  运行中=${s.running}  历史(投递视图)=${s.historyLength}`);
  console.log(`job: ${Object.keys(s.jobs).length === 0 ? "（无）" : JSON.stringify(s.jobs)}`);
  const rows = agent.history();
  console.log("投递视图（模型看到的就是这些）：");
  for (const e of rows) {
    console.log(`  [${String(e.seq).padStart(2)}] ${e.kind}${e.role ? `/${e.role}` : ""}  ${(e.content ?? "").replace(/\n/g, " ").slice(0, 64)}`);
  }
  const raw = agent.history({ raw: true });
  if (raw.length !== rows.length) {
    console.log(`原始日志（含被压缩掉的，共 ${raw.length} 条）：`);
    for (const e of raw) console.log(`  [${String(e.seq).padStart(2)}] ${e.kind}${e.role ? `/${e.role}` : ""}  ${(e.content ?? "").slice(0, 48)}`);
  }
}

await board(restart ? "启动时（从快照恢复）" : "启动时（全新）");

if (!restart) {
  console.log("\n=== ① 两轮对话 ===");
  for (const q of ["你好，介绍一下你自己", "刚才我问了什么？"]) {
    const r = await agent.send({ content: q });
    console.log(`  send(${q}) → 回执 ${JSON.stringify(r)}`);
    await waitIdle();
  }

  console.log("\n=== ② 外部事件：后台 job 完成（不打断对话、不进模型） ===");
  const before = agent.snapshot().running;
  const rj = await agent.post({ type: "job.completed", jobId: "r-demo", result: "build ok" });
  console.log(`  post(job.completed) → 回执 ${JSON.stringify(rj)}；当时 running=${before}`);
  console.log(`  job 表：${JSON.stringify(agent.snapshot().jobs)}`);

  console.log("\n=== ③ 压缩：只保留最近 1 轮 ===");
  const rc = await agent.compact({ kind: "keepTurns", turns: 1 });
  console.log(`  compact(keepTurns:1) → 回执 ${JSON.stringify(rc)}`);

  console.log("\n=== ④ 拒绝也要看得见 ===");
  const rr = await agent.compact({ kind: "keepTurns", turns: 99 });
  console.log(`  compact(keepTurns:99) → 回执 ${JSON.stringify(rr)}`);
} else {
  console.log("\n=== 重启后继续用：发一条，证明 seq / 历史都接得上 ===");
  const r = await agent.send({ content: "重启后你还记得我吗" });
  console.log(`  send(...) → 回执 ${JSON.stringify(r)}`);
  await waitIdle();
}

await board(restart ? "结束（重启后）" : "结束（本轮走完）");

await new Promise((r) => setTimeout(r, 60)); // 等 fire-and-forget 的快照落盘
const auditPath = join(dir, "audit.jsonl");
const lines = existsSync(auditPath) ? readFileSync(auditPath, "utf-8").trim().split("\n") : [];
console.log(`\n数据根：${dir}`);
console.log(`  快照 state.json  ${existsSync(join(dir, "state.json")) ? "已写" : "未写"}`);
console.log(`  审计 audit.jsonl ${lines.length} 行（只追加，不参与逻辑）`);
console.log(`\n再加 --restart 跑一次：上面的 seq / turns / 历史应当接着上次，而不是从 0 开始。`);
