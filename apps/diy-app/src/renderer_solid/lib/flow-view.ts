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
import { collectArtifacts } from "./flow-model";
import type {
    ArtifactProbe,
    ArtifactState,
    FlowArtifactView,
    FlowInstanceView,
    FlowThreadsView,
    FlowVisitBrief,
} from "./flow-model";

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
 * 取某节点**某次驻留**的产物（##337 的只读命令）。
 *
 * `seq` 必传（调用方总有它：折线上的每次驻留都带 `seq`）—— **不给就退化成「该节点最后一次
 * 驻留」**，那正是 ##320 review1 P1-1 的错配来源。此处把它设成**必填参数**，让「忘了传」
 * 在类型层就过不去；要「最后一次」的语义就显式传 `undefined`（见 `collectArtifacts` 的签名）。
 *
 * **存在性判据**用的是 typed-client 的实现细节（`core/typed-client.ts` 的 `buildProxy`）：
 * 未注册的过程名返回的是**下一层 Proxy 对象**而非函数 ⇒ `typeof fn === "object"` 即「命令不存在」。
 * 这条判据只用于**给出人话的占位原因**，调用失败（命令在但出错）走 catch 分支。
 */
export async function fetchArtifact(uri: string, node: string, seq?: number): Promise<ArtifactProbe> {
    const ns = diyService.diy.flow as unknown as Record<string, unknown>;
    const fn = ns["view"];
    if (typeof fn !== "function") {
        return { ok: false, reason: "主进程未提供 `diy flow view` 命令（##337 未合入）" };
    }
    try {
        const out = await (fn as (input: { uri: string; node?: string; seq?: number }) => Promise<unknown>)({ uri, node, seq });
        return { ok: true, value: (out ?? null) as FlowArtifactView | null };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * 折线上所有驻留的产物（**逐驻留取数**，P1-1）。
 *
 * 逻辑在 `flow-model.ts::collectArtifacts`（纯派生、可单测），此处只把它与真 RPC 绑起来；
 * 抽这一层是为了让「每个驻留各带自己的 seq」能被**单测**钉死（无 Electron 也能证），
 * 而那正是本条 bug 的判据。
 */
export async function loadArtifacts(uri: string, visits: readonly FlowVisitBrief[]): Promise<Record<string, ArtifactState>> {
    return collectArtifacts(uri, visits, fetchArtifact);
}

// ═══════════════════════════════════════════════════════════════
// 讨论线程（##342）—— 只读；UI 讨论区**只走 RPC**，永不读 `flow/*.json`
// ═══════════════════════════════════════════════════════════════

/** 探测结果：`ok: false` = 命令尚未在 main 上 / 调用失败 —— **不是**「这个打回没有发言」 */
export type ThreadsProbe = { readonly ok: true; readonly value: FlowThreadsView } | { readonly ok: false; readonly reason: string };

/**
 * 取讨论线程（`flow thread list`）。
 *
 * 讨论流坏**不在这里抛**（main 侧 `listThreads` 报 `skipped` / `error` 字段）—— 那是旁注，
 * 界面把它当**错误位**显示（对照 ##337 P2-B）。这里只兜「命令不在 / 调用失败」这类真异常。
 * 存在性判据同 `fetchArtifact`（typed-client 的未注册过程名返回对象 Proxy 而非函数）。
 */
export async function fetchThreads(uri: string, thread?: string): Promise<ThreadsProbe> {
    const ns = diyService.diy.flow as unknown as Record<string, unknown>;
    const threadNs = ns["thread"] as Record<string, unknown> | undefined;
    const fn = threadNs?.["list"];
    if (typeof fn !== "function") {
        return { ok: false, reason: "主进程未提供 `diy flow thread list` 命令（##342 未合入）" };
    }
    try {
        const out = await (fn as (input: { uri: string; thread?: string }) => Promise<unknown>)({ uri, thread });
        return { ok: true, value: out as FlowThreadsView };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
}
