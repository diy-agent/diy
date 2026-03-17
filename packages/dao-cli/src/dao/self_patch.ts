import { Command } from "commander";
import path from "path";
import { promises as fs } from "fs";

/**
 * Self-patch heartbeat mechanism for DAO evolution cycles.
 * This ensures each cycle produces at least one observable change,
 * improving system observability and recovery tracking.
 */
async function main() {
  const program = new Command();
  program
    .option("--prompt-file <path>")
    .requiredOption("--worktree <path>");
  program.parse(process.argv);
  const opts = program.opts() as { promptFile?: string; worktree: string };
  const worktree = path.resolve(opts.worktree);
  const readme = path.join(worktree, "README.md");
  
  // Ensure README exists
  try {
    await fs.access(readme);
  } catch {
    await fs.writeFile(readme, "# DAO TS 自主进化循环\n\n", "utf-8");
  }
  
  // Update heartbeat section with current timestamp
  const marker = "\n## 自主进化心跳\n";
  const now = new Date().toISOString();
  const line = `- 心跳时间: ${now}\n`;
  const text = await fs.readFile(readme, "utf-8");
  const updated = text.includes(marker) ? text + line : text + marker + line;
  await fs.writeFile(readme, updated, "utf-8");
  
  // Write cycle marker to state directory for observability
  const stateDir = path.join(worktree, "state");
  try {
    await fs.access(stateDir);
  } catch {
    await fs.mkdir(stateDir, { recursive: true });
  }
  const heartbeatPath = path.join(stateDir, "heartbeat.json");
  const heartbeat = {
    last_heartbeat: now,
    cycle_marker: `heartbeat-${Date.now()}`,
    status: "active"
  };
  await fs.writeFile(heartbeatPath, JSON.stringify(heartbeat, null, 2) + "\n", "utf-8");
}

main();
