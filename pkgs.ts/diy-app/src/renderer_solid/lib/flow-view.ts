/**
 * flow-view.ts — 泳道视图（##320）的**取数**（RPC 出入参的唯一出口）。
 *
 * 形状与纯派生在 `lib/flow-model.ts`（那份不碰 RPC，故可被单测直接 import）；
 * 本文件只做三件事：`flow show` / `flow params set` / `flow view`（##337 的产物命令）。
 *
 * 两条口径：
 *  1. 数据全走 RPC —— UI 永不读 `flow/*.json`（域真源 = `src/main/services/api-def.ts` 的 flow 组）。
 *  2. **产物命令未接入（##337 未合入）时返回 `{ ok: false, reason }`**，UI 显示占位 ——
 *     **绝不自己造数据**（##166 §14.8 的教训：假数据会让「画出来了」的判据失去意义）。
 */
import { diyService } from "./rpc";
import type { ArtifactProbe, FlowArtifactView, FlowInstanceView } from "./flow-model";

export * from "./flow-model";

// ═══════════════════════════════════════════════════════════════
// 取数
// ═══════════════════════════════════════════════════════════════

/** 看实例（折线 / 当前节点 / 参数 / 终态）。`showFlow` 含 state.json 与 path.jsonl 的对账，不一致即抛 */
export async function loadFlow(uri: string): Promise<FlowInstanceView> {
    const out = await diyService.diy.flow.show({ uri });
    return out as unknown as FlowInstanceView;
}

/**
 * 改参数值（**只在尚未进入时**合法：换配置 = 另起一次运行，内核与宿主同一立场）。
 * 入参是 CLI 形态的 `节点 id.局部名=值`（与 `diy flow params set` 同一份契约）。
 */
export async function saveParams(uri: string, params: readonly string[]): Promise<FlowInstanceView> {
    const out = await diyService.diy.flow.params.set({ uri, param: [...params] });
    return out as unknown as FlowInstanceView;
}

/**
 * 取某节点的产物（##337 的只读命令）。
 *
 * **存在性判据**用的是 typed-client 的实现细节（`core/typed-client.ts` 的 `buildProxy`）：
 * 未注册的过程名返回的是**下一层 Proxy 对象**而非函数 ⇒ `typeof fn === "object"` 即「命令不存在」。
 * 这条判据只用于**给出人话的占位原因**，调用失败（命令在但出错）走 catch 分支。
 */
export async function fetchArtifact(uri: string, node: string): Promise<ArtifactProbe> {
    const ns = diyService.diy.flow as unknown as Record<string, unknown>;
    const fn = ns["view"];
    if (typeof fn !== "function") {
        return { ok: false, reason: "主进程未提供 `diy flow view` 命令（##337 未合入）" };
    }
    try {
        const out = await (fn as (input: { uri: string; node?: string }) => Promise<unknown>)({ uri, node });
        return { ok: true, value: (out ?? null) as FlowArtifactView | null };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
}
