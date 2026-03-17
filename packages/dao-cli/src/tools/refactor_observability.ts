import { Command } from "commander";
import path from "path";
import { promises as fs } from "fs";

async function ensureSafeLog(worktree: string): Promise<boolean> {
  const target = path.join(worktree, "src", "dao", "logging_utils.ts");
  try {
    await fs.access(target);
  } catch {
    return false;
  }
  const text = await fs.readFile(target, "utf-8");
  if (text.includes("export function safeLog(")) {
    return false;
  }
  const addition = `
export function safeLog(logger: pino.Logger, level: string, msg: string, ...args: any[]): boolean {
  try {
    const l = level.toLowerCase();
    const fn = (logger as any)[l] ?? logger.info.bind(logger);
    fn(msg, ...(args as any));
    return true;
  } catch {
    return false;
  }
}
`;
  const updated = text.trimEnd() + addition;
  await fs.writeFile(target, updated, "utf-8");
  return true;
}

async function main() {
  const program = new Command();
  program.requiredOption("--worktree <path>");
  program.parse(process.argv);
  const opts = program.opts() as { worktree: string };
  const ok = await ensureSafeLog(path.resolve(opts.worktree));
  process.exitCode = ok ? 0 : 0;
}

main();
