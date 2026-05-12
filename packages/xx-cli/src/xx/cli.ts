import { Command } from "commander";
import { syncDependencies } from "../common/sync.js";
import { logger } from "../common/logger.js";
import { workflowCli } from "../common/workflow/workflow-cli.js";

const program = new Command();
program
  .name("xx-cli")
  .description("xx 统一入口")
  .exitOverride();

program
  .command("sync")
  .action(async () => {
    const log = logger.withTag("sync");
    syncDependencies().catch(err => {
      log.error("同步失败:", err);
      process.exit(1);
    });
  });

program.addCommand(workflowCli());

program.parseAsync(process.argv).catch((err: any) => {
  // exitOverride 让帮助信息等正常场景抛 CommanderError 而不是 process.exit(1)
  // 打印帮助后正常退出即可
  if (err?.code === "commander.help" || err?.code === "commander.helpDisplayed") {
    process.exit(0);
  }
  throw err;
});
