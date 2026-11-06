/**
 * 05-cli — 同一份 schema 变成命令行
 *
 * `RpcSchema.router` 的树天然是命令树：
 *   `demo.math.add --a 2 --b 3`  →  `math.add({ a: 2, b: 3 })`
 *
 * 生成 CLI 参数名靠 schema 的**字段名** —— 这也是 `input` 永不摊平的原因之一：
 * 摊成位置参数就丢掉名字，CLI 只能生成 `--arg0 --arg1`。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "../src/index";

const routes = RpcSchema.router({
    math: RpcSchema.router({
        add: RpcSchema.unary({
            input: { a: z.number(), b: z.number() },
            output: z.number(),
            desc: "两数相加",
        }),
    }),
    task: RpcSchema.router({
        list: RpcSchema.unary({
            input: {
                status: z.enum(["pending", "done"]).optional(),
                limit: z.number().int().positive().optional(),
            },
            output: z.array(z.object({ uri: z.string(), title: z.string() })),
            desc: "列任务（可按状态过滤）",
        }),
    }),
});

export const demoService = defineService({ name: "demo", api: routes });

/**
 * 真实用法（见 `@diy-agent/rpc/cli`）：
 *
 * ```ts
 * import { createCliApp } from "@diy-agent/rpc/cli";
 *
 * const app = createCliApp({ name: "demo", api: routes, desc: "示例 CLI" });
 * app.bind(server);            // 同一份 handlers
 * await app.run(process.argv.slice(2));
 * ```
 *
 * 跑起来像这样：
 *   demo math add --a 2 --b 3        →  5
 *   demo task list --status pending  →  [{ uri, title }]
 *   demo task list --limit 10        →  [...]
 *   demo --help                      →  命令树 + 每个命令的选项
 *   demo math add --help             →  该命令的用法（自动生成）
 */
console.log("schema 就绪：math.add / task.list（CLI 示例见上方注释）");
