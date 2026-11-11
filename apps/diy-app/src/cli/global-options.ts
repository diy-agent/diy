/**
 * global-options.ts — CLI 的**全局选项表**（进程级 flag）
 *
 * 单一真源：直连 CLI（`src/cli/index.ts`）与进程内 `/cli` 端点（`rpc-port.ts`）都从这里取，
 * 两边必须逐字一致 —— 否则同一句命令在两种入口下行为不同（历史上 `--json` 只在一处识别过）。
 *
 * 声明方式与 procedure 的 input 完全相同（zod + `.cliOption()`），不引入第二套 DSL。
 *
 * ⚠️ 界线：全局选项**只在 CLI 进程里消费**（输出格式 / 交互 / 路径基准）。
 * 命令实现跑在 app 进程，看不到这些值；想让服务端知道的东西属于 procedure 参数或调用级 meta。
 */
import { z } from "zod";
import "@diy-agent/rpc"; // .cliOption 的 zod 扩展（副作用补丁）

export const globalOptions = z.object({
    /** 脚本消费：输出包一层 `{ ok, data }`，不再是给人看的缩进 JSON */
    json: z.boolean().default(false).cliOption({ short: "j", desc: "以 JSON 输出（脚本消费）" }),
});
