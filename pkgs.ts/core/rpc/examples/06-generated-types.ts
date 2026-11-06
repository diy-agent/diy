/**
 * 06-generated-types — 生成物怎么用（`<dir>/src/gen/api.generated.d.ts`）
 *
 * 前提：本目录的 `demo/src/api.ts` 就是**真·api 定义**（和 `pkgs.ts/ui/workbench/src/api.ts`
 * 同一种形状），跑一次生成器就有类型：
 *
 *   npx tsx pkgs.ts/core/rpc/scripts/gen-service-types.ts
 *
 * 生成物是**派生**的，不进手写目录：
 *   examples/demo/src/api.ts                 ← 手写，唯一真源
 *   examples/demo/src/gen/api.generated.d.ts ← 生成（别手改）
 *
 * ⚠️ 为什么示例不用别的包的生成物：`@diy-agent/rpc` 是**核心包**，不能依赖
 * `@diy-agent/workbench` 这类上层包 —— 连 `import type` 都不行（依赖方向反了）。
 * 示例自己定义、自己生成，才是能照抄的示范。
 */
import type { TaskClient, TaskServer } from "./demo/src/gen/api.generated";
import { taskService } from "./demo/src/api";
import type { ChannelClientBinding } from "../src/core/channel-client-binding";

// ── 客户端侧 ──
declare const client: ChannelClientBinding;
async function useClient(): Promise<void> {
    const task: TaskClient = taskService.use(client);

    // 方法签名里是**完整的内联类型**（默认 naming=none）：
    //   list(input: { status?: "pending" | "done"; limit?: number }, options?) => Promise<{ uri; title; done }[]>
    const pending = await task.task.list({ status: "pending", limit: 10 });
    console.log(pending.map((t) => `${t.title}${t.done ? " ✓" : ""}`).join("\n"));

    const one = await task.task.get({ uri: "projects/4/tasks/87" });
    console.log(one.title);
}

// ── 服务端侧 ──
declare const server: Parameters<typeof taskService.bind>[0];
function useServer(): void {
    // handler 的 opts 多一个 signal，且允许同步返回（不必包 async）
    taskService.bind(server, {
        task: {
            list: ({ input }) => loadTasks(input.status, input.limit),
            get: ({ input }) => loadOne(input.uri),
        },
    } satisfies TaskServer);
}

declare function loadTasks(status?: string, limit?: number): { uri: string; title: string; done: boolean }[];
declare function loadOne(uri: string): { uri: string; title: string; done: boolean };

// 生成物的价值：类型不匹配时，报错指向**具体的方法签名**而不是一坨 Proxy 条件类型。
void useClient;
void useServer;
