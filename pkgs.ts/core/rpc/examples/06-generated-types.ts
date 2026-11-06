/**
 * 06-generated-types — 生成物怎么用（`src/gen/api.generated.d.ts`）
 *
 * 生成器把 Proxy 下钻的类型摊平成接口，读代码 / 看报错都直接。
 * 生成物是**派生**的，不进手写目录：
 *
 *   <pkg>/src/api.ts                 ← 手写，唯一真源
 *   <pkg>/src/gen/api.generated.d.ts ← 生成（别手改）
 *
 * 跑生成：`npx tsx pkgs.ts/core/rpc/scripts/gen-service-types.ts`
 * 校验：  `npx tsx ... --check`（已接进 `./sha.sh check`）
 */
import type { WorkbenchClient, WorkbenchServer } from "../../../ui/workbench/src/gen/api.generated";

// ── 客户端侧 ──
declare const wb: WorkbenchClient;
async function useClient(): Promise<void> {
    // 方法签名里是**完整的内联类型**（默认 naming=none）：
    //   list(input: Record<string, never>, options?: RpcCallOptions) => Promise<{ id, title, description? }[]>
    const pages = await wb.page.list({});
    console.log(pages.map((p) => p.title).join(", "));

    // invoke 的 args 故意是 unknown（每个插件方法自己定义形状）
    await wb.page.invoke({ pageId: "home", method: "greet", args: { name: "amy" } });
}

// ── 服务端侧 ──
declare const serverImpl: WorkbenchServer;
async function useServer(): Promise<void> {
    // handler 多一个 signal，且允许同步返回（不必包 async）
    const pages = serverImpl.page.list({ input: {}, signal: new AbortController().signal });
    console.log(pages);
}

// 生成物的价值：类型不匹配时，报错指向**具体的类型名**而不是一坨 Proxy 条件类型。
// 若想要「报错只显示 `PageInvokeInput`」，把命名策略换成 `naming: "all"`。

void useClient;
void useServer;
