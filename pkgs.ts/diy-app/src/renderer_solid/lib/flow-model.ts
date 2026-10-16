/**
 * flow-model.ts — 泳道视图（##320）的**形状与纯派生**（不碰 RPC ⇒ 可单测）。
 *
 * 取数（`flow show` / `flow view` / `params set`）在 `lib/flow-view.ts` —— 那里 import 了
 * renderer 的 RPC 客户端，测试环境（无 window）进不去，故形状与纯函数单独放本文件。
 *
 * 三条口径：
 *  1. **数据全走 RPC**（域真源 `src/main/services/api-def.ts` 的 flow 组）—— UI 永不读 `flow/*.json`。
 *  2. 本文件只做**形状声明 + 纯派生**：`FlowView` 的字段形状（`FlowInstanceView`）、产物契约
 *     （##337）、泳道推导、参数读写的小工具。IO 一律在 `flow-view.ts`。
 *  3. 领域态是唯一真源（rule.core-log / rule.domain-first）：只做**形状转换**，不做事件流重放。
 *
 * 已知**数据缺口**（写在这里，省得下游各自踩一遍）：
 *  · `FlowView` 没有**节点全表**（只有当前节点 `node` + 出边 `next.edges`）⇒ 泳道只能按「折线里
 *    出现过的节点 ∪ 出边目标」推导；既没走过、也不是出边目标的节点**没有显示名**（回退显示 id）。
 *    补法（留给后续任务 / ##337）：`FlowView` 增 `nodes[]`，或 `flow show` 带全表。
 *  · `FlowView.next.pending` 只有**不可观测**（`prompt:`）那部分 guard；可观测项（`pred:` / `action:`）
 *    本版宿主未注册插件、内核 `status()` 只报 pending（见 `main/core/flow.ts` 的 `FlowNextView` 注释）
 *    ⇒ 节点详情只能逐条标「不可观测」，**不能凭空标出「可观测」项**（订正 6 的同一立场）。
 */

export type FlowEdgeKind = "next" | "bounce";
/** 参数类型全集（内核 `PARAM_TYPES`：`string | number | boolean | enum | list`，**不支持嵌套对象**） */
export type ParamType = "string" | "number" | "boolean" | "enum" | "list";
export type ParamScalar = string | number | boolean;
export type ParamValue = ParamScalar | readonly ParamScalar[];

export interface FlowNodeBrief {
    readonly id: string;
    readonly name: string;
    readonly actor: string;
    readonly hint: string;
}

export interface FlowEdgeBrief {
    readonly to: string;
    readonly toName: string;
    readonly kind: FlowEdgeKind;
    readonly when: string | null;
}

export interface FlowNextBrief {
    readonly mode: "entry" | "system" | "actor";
    /** 不可观测（`prompt:`）的 guard 原文 —— 等人宣布，系统判不了 */
    readonly pending: readonly string[];
    readonly edges: readonly FlowEdgeBrief[];
    /** 结构事实：已进入且当前位置没有 `next` 出边（打回边不算下一步） */
    readonly terminal: boolean;
}

/** 折线上一次驻留（领域事实）—— `seq >= 2` 即「打回后重返」 */
export interface FlowVisitBrief {
    readonly node: string;
    readonly seq: number;
    readonly kind: FlowEdgeKind;
    readonly at: string;
    readonly ref?: Readonly<Record<string, string>>;
}

/** 一条参数声明（全限定：`path` = `节点 id.局部名`） */
export interface FlowParamEntry {
    readonly node: string;
    readonly name: string;
    readonly path: string;
    readonly type: ParamType;
    readonly label: string;
    readonly default: ParamValue;
    readonly enum?: readonly string[];
    readonly min?: number;
    readonly max?: number;
    readonly unit?: string;
}

/** `diy flow show` 的载荷（形状与 `main/core/flow.ts` 的 `FlowView` 一一对应） */
export interface FlowInstanceView {
    readonly uri: string;
    readonly workflowId: string;
    readonly workflowName: string;
    readonly entry: string;
    readonly entered: boolean;
    readonly position: string | null;
    readonly node: FlowNodeBrief | null;
    readonly done: boolean;
    readonly bounces: number;
    readonly next: FlowNextBrief;
    readonly trajectory: readonly FlowVisitBrief[];
    readonly params: Readonly<Record<string, unknown>>;
    readonly paramsSchema: readonly FlowParamEntry[];
    readonly auditSkipped: number;
}

// ═══════════════════════════════════════════════════════════════
// 产物（##337 契约；UI 侧只依赖命令，不依赖 FlowView 的新字段）
// ═══════════════════════════════════════════════════════════════

/** 引擎侧九种固定渲染器（真源 = `@diy/flow` 的 `RENDERERS`；此处为 UI 侧镜像，改动要一起改） */
export type FlowRenderer = "doc" | "diff" | "table" | "timeline" | "video" | "badge" | "kline" | "heatmap" | "equity";

/** `art` 三段链：`raw`（节点产出的原始数据）→ `plugin`（render 插件名，可为 null）→ `renderer`（引擎渲染器） */
export interface FlowArt {
    readonly raw: string;
    readonly renderer: FlowRenderer;
    readonly plugin?: string | null;
    readonly note?: string;
}

/** `render` 插件的产物：renderer + 该渲染器要吃的 data（形状见 `@diy/flow` 的 `ViewShapes`） */
export interface FlowViewPayload {
    readonly renderer: FlowRenderer;
    readonly payload: unknown;
    readonly note?: string;
}

/** `diy flow view <uri> [--node <id>]` 的载荷（##337） */
export interface FlowArtifactView {
    readonly uri: string;
    readonly node: string;
    readonly seq: number;
    readonly art: FlowArt | null;
    readonly view: FlowViewPayload | null;
}

/** 探测结果：`ok: false` = 命令尚未在 main 上（##337 未合并）/ 调用失败 —— **不是**「这个节点没产物」 */
export type ArtifactProbe = { readonly ok: true; readonly value: FlowArtifactView | null } | { readonly ok: false; readonly reason: string };

/** 驻留的 key（同一节点多次驻留**各取各的**产物 —— `seq` 是领域事实，不是显示细节） */
export const visitKey = (node: string, seq: number): string => `${node}#${seq}`;

/** 一个驻留的产物取数态（四态；`unavailable` 专指命令不在/调用失败，与「本来就没产物」分开） */
export type ArtifactState =
    | { readonly kind: "loading" }
    | { readonly kind: "unavailable"; readonly reason: string }
    | { readonly kind: "none" }
    | { readonly kind: "ready"; readonly value: FlowArtifactView };

/** 取一份产物的函数（IO 注入点：真实现是 `flow-view.ts` 的 `fetchArtifact`，单测传桩） */
export type ArtifactFetcher = (uri: string, node: string, seq?: number) => Promise<ArtifactProbe>;

/**
 * 逐驻留取产物 —— **每个驻留用「它自己的 seq」取数**。
 *
 * 这里是 ##320 review1 的 P1-1 修点：`diy flow view` 不给 `--seq` 时缺省 = 该节点
 * **最后一次**驻留（##337 的 `resolveSeq`），于是同一节点的每个驻留卡都拿到最后一次的产物；
 * 若再按 `visitKey(node, seq)` 各落各的 key，早前驻留就会**显示后一次的产物**（打回后
 * 「第 2 次评审结论」盖掉「第 1 次的」）。⇒ 取数粒度必须与落位粒度一致：**驻留级**。
 *
 * 纯派生：IO 由调用方注入（`fetch` 必给），故本函数可在 node 环境的单测里直接跑
 * （tests/core/flow-artifacts.test.ts 用它把「每个驻留各带自己的 seq」钉死）。
 */
export async function collectArtifacts(
    uri: string,
    visits: readonly FlowVisitBrief[],
    fetch: ArtifactFetcher,
): Promise<Record<string, ArtifactState>> {
    /** 先全置 loading：key 与落位 key 同一套（`visitKey`），避免「加载中」查不到 */
    const out: Record<string, ArtifactState> = {};
    for (const v of visits) out[visitKey(v.node, v.seq)] = { kind: "loading" };

    await Promise.all(
        visits.map(async (v) => {
            const key = visitKey(v.node, v.seq);
            let probe: ArtifactProbe;
            try {
                probe = await fetch(uri, v.node, v.seq);
            } catch (e) {
                probe = { ok: false, reason: e instanceof Error ? e.message : String(e) };
            }
            out[key] = !probe.ok
                ? { kind: "unavailable", reason: probe.reason }
                : probe.value
                  ? { kind: "ready", value: probe.value }
                  : { kind: "none" };
        }),
    );
    return out;
}

// ═══════════════════════════════════════════════════════════════
// 讨论线程（##342）：形状 + 纯派生
// ═══════════════════════════════════════════════════════════════
//
// 线程**挂在锚点上**（= 折线上真发生过的一次打回边），不占位置、不产生新历史 ——
// 于是「泳道视图」与「讨论视图」是同一份事件流的两种投影，锚点就是它们之间的键。
// 形状与 `main/core/flow-store.ts` 的 `FlowPost` / `main/core/flow-thread.ts` 的 `FlowThreadView` 一一对应。

/** 线程锚点：`{from: 打回前节点, to: 落点节点, seq: 落点那次驻留的序号}` */
export interface FlowAnchorBrief {
    readonly from: string;
    readonly to: string;
    readonly seq: number;
}

/** 发言类型：普通发言 / 宣布线程已解决 / 升级人裁决 */
export type FlowPostType = "note" | "resolved" | "escalate";

export interface FlowPostView {
    readonly id: string;
    readonly at: string;
    /** 谁说的：`cli` / agent 标识 / `human` */
    readonly author: string;
    readonly type: FlowPostType;
    readonly anchor: FlowAnchorBrief;
    readonly text: string;
}

export type FlowThreadStatus = "open" | "resolved" | "escalated";

export interface FlowThreadView {
    /** 线程 id：`from->to#seq`（UI 的 `data-flow-thread`、CLI 的 `--thread` 用的是同一个键） */
    readonly id: string;
    readonly anchor: FlowAnchorBrief;
    readonly fromName: string;
    readonly toName: string;
    /** 打回源那次驻留的序号（从折线推；假锚点 ⇒ null） */
    readonly fromSeq: number | null;
    /** 折线上确有这条打回边（false = 讨论流里有、折线上查无 ⇒ 坏数据，界面亮出来而不是藏起来） */
    readonly real: boolean;
    /** 折线上的次序（第几次位置变更；假锚点 ⇒ -1） */
    readonly at: number;
    readonly status: FlowThreadStatus;
    readonly posts: readonly FlowPostView[];
}

/** `flow thread list` 的载荷 */
export interface FlowThreadsView {
    readonly uri: string;
    readonly threads: readonly FlowThreadView[];
    readonly skipped: number;
    readonly error: string | null;
    readonly file: string;
}

/** 线程 id（与 main 的 `anchorKey` 同一形）：折线第 `index` 次驻留若**是打回进来的**，它就是那个线程；否则 null */
export function threadIdOfVisit(visits: readonly FlowVisitBrief[], index: number): string | null {
    const visit = visits[index];
    if (!visit || visit.kind !== "bounce") return null;
    const source = visits[index - 1];
    if (!source) return null;
    return `${source.node}->${visit.node}#${visit.seq}`;
}

/** 线程状态徽标文案（唯一处：界面与单测共用一份口径） */
export const THREAD_STATUS_LABEL: Record<FlowThreadStatus, string> = {
    open: "进行中",
    resolved: "已解决",
    escalated: "已升级人裁决",
};

/** 发言类型徽标文案（唯一处） */
export const POST_TYPE_LABEL: Record<FlowPostType, string> = {
    note: "发言",
    resolved: "宣布已解决",
    escalate: "升级人裁决",
};

// ═══════════════════════════════════════════════════════════════
// 派生（纯函数；单测在 tests/core/flow-ui-swimlane.test.ts）
// ═══════════════════════════════════════════════════════════════

/** 一条泳道 = 一个节点（##166 §14.2：泳道 ≡ 节点 1:1，打回不新建节点） */
export interface FlowLane {
    readonly node: string;
    /** 显示名；名字表里没有 ⇒ 回退成 id（数据缺口见文件头） */
    readonly name: string;
    /** 显示名是否来自真实数据（false = 只能显示 id） */
    readonly named: boolean;
    /** 折线是否走到过（未走到 = 图上只作「未来的位置」出现） */
    readonly reached: boolean;
    /** 该节点在折线上的驻留次数（`>= 2` = 被打回后重返） */
    readonly visits: number;
}

/** 已知节点的显示名表：当前节点 + 出边目标（`FlowView` 只给得出这两处） */
function nameTableOf(view: FlowInstanceView): Map<string, string> {
    const m = new Map<string, string>();
    if (view.node) m.set(view.node.id, view.node.name);
    for (const e of view.next.edges) m.set(e.to, e.toName);
    return m;
}

/**
 * 泳道序列：**折线里首次出现的顺序**，再接上「当前节点的出边目标」（还没走到、但下一步可能去）。
 *
 * 为什么是这个顺序：`FlowView` 不给定义的节点全表 ⇒ 拿不到定义序（数据缺口见文件头）。
 * 折线按推进顺序记录，故首次出现序 ≈ 定义序；未到达的下一步节点只能从出边补。
 */
export function deriveLanes(view: FlowInstanceView): FlowLane[] {
    const names = nameTableOf(view);
    const order: string[] = [];
    const seen = new Set<string>();
    const count = new Map<string, number>();
    for (const v of view.trajectory) {
        count.set(v.node, (count.get(v.node) ?? 0) + 1);
        if (!seen.has(v.node)) {
            seen.add(v.node);
            order.push(v.node);
        }
    }
    for (const e of view.next.edges) {
        if (!seen.has(e.to)) {
            seen.add(e.to);
            order.push(e.to);
        }
    }
    return order.map((node) => {
        const named = names.has(node);
        return {
            node,
            name: names.get(node) ?? node,
            named,
            reached: (count.get(node) ?? 0) > 0,
            visits: count.get(node) ?? 0,
        };
    });
}

/** 参数值的全量缺省（`节点 id → 局部名 → 值`）：由声明派生 —— 表单拿它当初始值 */
export function paramsOfSchema(schema: readonly FlowParamEntry[]): Record<string, Record<string, ParamValue>> {
    const out: Record<string, Record<string, ParamValue>> = {};
    for (const e of schema) {
        (out[e.node] ??= {})[e.name] = e.default;
    }
    return out;
}

/** 实例值（`view.params` 的嵌套袋）取某个声明项 —— 缺失即回落声明里的 default */
export function paramValueOf(view: FlowInstanceView, entry: FlowParamEntry): ParamValue {
    const bag = view.params[entry.node];
    if (bag && typeof bag === "object") {
        const v = (bag as Record<string, unknown>)[entry.name];
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
        if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")) {
            return v as ParamScalar[];
        }
    }
    return entry.default;
}

/** 把表单值编回 CLI 形态的 `节点 id.局部名=值`（`list` 用 `,` 分隔，元素一律按字符串给） */
export function paramKv(entry: Pick<FlowParamEntry, "path">, value: ParamValue): string {
    const text = Array.isArray(value) ? value.map((x) => String(x)).join(",") : String(value);
    return `${entry.path}=${text}`;
}
