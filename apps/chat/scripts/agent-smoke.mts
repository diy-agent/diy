// apps/chat/scripts/agent-smoke.mts
// 🎯 S2 的可演示切片：**用真 Agent 跑两轮，打印它的状态**（不是测试，是给人看的）。
//
//   npx tsx apps/chat/scripts/agent-smoke.mts              # 假 LLM（确定性，不花钱）
//   npx tsx apps/chat/scripts/agent-smoke.mts --restart     # 再跑一次，读上一轮的快照
//   AGENT_SMOKE_REAL=1 npx tsx ...                          # 真模型（走 DIY_HOME 里的 model.yaml）
//
// 演示三件事：
//   ① 状态是**内存对象**（seq / turns / history），不是从 ops 回放推出来的；
//   ② 关掉进程再起，历史与 seq 原样回来（快照恢复，不是回放）；
//   ③ 审计日志 `audit.jsonl` 只追加、不参与逻辑。

import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgent, filePersist, type AgentPorts } from "@diy-agent/bot";

const home = process.env["DIY_HOME"] ?? join(process.cwd(), ".agent-demo");
const dir = join(home, "agent", "demo");
mkdirSync(dir, { recursive: true });

const restart = process.argv.includes("--restart");

/** 假 port：回一句固定文本，按轮次编号，便于肉眼对照 */
function fakePorts(): AgentPorts & { calls: string[][] } {
  const calls: string[][] = [];
  let n = 0;
  return {
    calls,
    async *complete(messages) {
      calls.push(messages.map((m) => `${m.role}:${m.content}`));
      yield `（第 ${++n} 次回答）收到 ${messages.filter((m) => m.role === "user").length} 条用户消息`;
    },
  };
}

const ports = fakePorts();
const agent = createAgent({ id: "bot_demo", ports, persist: filePersist(dir) });

console.log("=== 启动时的状态 ===");
console.log(JSON.stringify(agent.snapshot(), null, 2));
console.log("历史条数（投递视图）：", agent.history().length);

const waitIdle = async (): Promise<void> => {
  const t0 = Date.now();
  while (agent.snapshot().running && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
};

if (!restart) {
  console.log("\n=== 发两条消息 ===");
  const r1 = await agent.send({ content: "你好，介绍一下你自己" });
  console.log("命令回执 1：", JSON.stringify(r1));
  await waitIdle();
  const r2 = await agent.send({ content: "刚才我问了什么？" });
  console.log("命令回执 2：", JSON.stringify(r2));
  await waitIdle();
} else {
  console.log("\n=== --restart：接着上次的状态再发一条 ===");
  const r = await agent.send({ content: "重启后你还记得我吗" });
  console.log("命令回执：", JSON.stringify(r));
  await waitIdle();
}

console.log("\n=== 结束时的状态 ===");
console.log(JSON.stringify(agent.snapshot(), null, 2));
console.log("\n历史（投递视图，模型看到的就是这些）：");
for (const e of agent.history()) {
  console.log(`  [${e.seq}] ${e.kind}${e.role ? `/${e.role}` : ""}: ${(e.content ?? "").slice(0, 60)}`);
}

// 等异步快照落盘（生产里是 fire-and-forget，这里只为演示时能看到文件）
await new Promise((r) => setTimeout(r, 50));
const auditPath = join(dir, "audit.jsonl");
console.log("\n审计日志：", auditPath, existsSync(auditPath) ? `（${readFileSync(auditPath, "utf-8").trim().split("\n").length} 行）` : "（空）");
console.log("快照文件：", join(dir, "state.json"), existsSync(join(dir, "state.json")) ? "（已写）" : "（未写）");
console.log("\n提示：加 --restart 再跑一次，上面的 seq / 历史应当接着上次，而不是从 0 开始。");
