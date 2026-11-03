/**
 * FlowStage.tsx — 泳道图（**折线轨迹 + 每步产物 view**）。
 *
 * 硬约束（##320 / ##166 §11.2 · §14.5）：**层叠一次性画清**
 *   背景泳道(LANE_Z=0) → 连线(WIRE_Z=2) → 节点(NODE_Z=3)
 * `#wires` 层必须 `pointer-events:none`（否则连线抢走卡片的点击）。
 * 这两条是**像素判据能成立的前提**：红线被底纹盖住时，图看着"有东西"、实际一条线都没有
 * （§14.5 的 A/B 像素对照：正常 1742 个饱和红像素，把连线层置底后 0）。
 *
 * 连线颜色**两色**（订正 6 的收窄）：`next` 蓝实线 / `bounce` 红虚线 + 箭头。
 * 「agent 宣布蓝 / 系统自动绿」三色在本版宿主的真数据里不存在（guard 全是 `prompt:` ⇒
 * 恒 `actor`），硬造第三种颜色就是给像素判据掺假数据。
 */
import { For, Show, createMemo } from "solid-js";
import type { FlowInstanceView, FlowVisitBrief, FlowArtifactView } from "../../lib/flow-view";
import { deriveLanes } from "../../lib/flow-view";
import { visitKey, type ArtifactState } from "../../lib/flow-model";
import { ACTOR_COLOR, LANE_Z, NODE_Z, WIRE_Z, WIRE_COLOR, buildStage, type StageVisit } from "./swimlane";
import { renderFlowView } from "./ViewRenderer";

// 产物取数态与驻留 key 的**唯一出处**在纯派生层（`lib/flow-model.ts`）——
// 那里不碰 RPC，故能被单测直接 import（tests/core/flow-artifacts.test.ts 用它钉死 P1-1）。
// 此处 re-export 只为让组件侧的 import 面不变。
export { type ArtifactState, visitKey };

function ArtifactBox(props: { state: ArtifactState | undefined; visit: FlowVisitBrief }) {
    return (
        <div
            data-flow-artifact={visitKey(props.visit.node, props.visit.seq)}
            class="mt-1 overflow-hidden rounded border border-base-300 bg-base-100/80 p-1"
            style={{ height: "88px" }}
        >
            <Show when={props.state} fallback={<div class="text-body opacity-40">产物：加载中…</div>}>
                {(st) => (
                    <Show
                        when={st().kind === "ready" ? (st() as { kind: "ready"; value: FlowArtifactView }) : null}
                        fallback={
                            <div class="text-body opacity-60">
                                <Show when={st().kind === "unavailable"} fallback={<>无产物（该节点未声明 art）</>}>
                                    <>产物区待接入：{(st() as { kind: "unavailable"; reason: string }).reason}</>
                                </Show>
                            </div>
                        }
                    >
                        {(ready) => (
                            <div class="flex h-full flex-col gap-0.5 overflow-auto">
                                <div class="flex items-center gap-1 text-body opacity-60">
                                    <span class="badge badge-xs">{ready().value.view?.renderer ?? "—"}</span>
                                    <span class="truncate" title={ready().value.art?.raw}>
                                        {ready().value.art?.raw ?? ""}
                                    </span>
                                </div>
                                <Show when={ready().value.view}>
                                    {(v) => <div class="min-h-0">{renderFlowView(v().renderer, v().payload)}</div>}
                                </Show>
                            </div>
                        )}
                    </Show>
                )}
            </Show>
        </div>
    );
}

export function FlowStage(props: {
    view: FlowInstanceView;
    artifacts: Record<string, ArtifactState>;
    selected: number | null;
    onSelect: (index: number) => void;
}) {
    const lanes = createMemo(() => deriveLanes(props.view));
    const stage = createMemo(() => buildStage(lanes(), props.view.trajectory));
    const isCurrent = (v: StageVisit) => props.view.position === v.visit.node && v.index === props.view.trajectory.length - 1;

    return (
        <div class="h-full overflow-auto bg-base-200 p-2">
            <div
                data-flow-stage=""
                class="relative"
                style={{ width: `${stage().width}px`, height: `${stage().height}px` }}
            >
                {/* ── 层 0：泳道底纹 + 表头（最底，绝不可盖住连线） ── */}
                <div data-flow-lanes="" class="absolute left-0 top-0" style={{ inset: "0", "z-index": LANE_Z }}>
                    <For each={stage().lanes}>
                        {(lane, i) => (
                            <div
                                class="absolute top-0 rounded-lg border border-base-300"
                                classList={{ "opacity-70": !lane.reached }}
                                data-flow-lane={lane.node}
                                data-flow-lane-reached={lane.reached ? "1" : "0"}
                                style={{
                                    left: `${lane.x}px`,
                                    width: `${lane.w}px`,
                                    height: `${stage().height}px`,
                                    "background-color": i() % 2 === 0 ? "rgba(148,163,184,0.10)" : "rgba(148,163,184,0.18)",
                                }}
                            >
                                <div class="px-2 pt-1 text-body font-bold" style={{ color: ACTOR_COLOR["agent"] }}>
                                    {lane.name}
                                    <Show when={lane.visits > 1}>
                                        <span class="ml-1 font-normal opacity-60">驻留 ×{lane.visits}</span>
                                    </Show>
                                    <Show when={!lane.named}>
                                        <span class="ml-1 font-normal opacity-60">（无显示名）</span>
                                    </Show>
                                </div>
                            </div>
                        )}
                    </For>
                </div>

                {/* ── 层 2：连线（`pointer-events:none` —— 不抢卡片点击） ── */}
                <svg
                    data-flow-wires=""
                    class="absolute left-0 top-0"
                    style={{ inset: "0", "z-index": WIRE_Z, "pointer-events": "none" }}
                    width={stage().width}
                    height={stage().height}
                    viewBox={`0 0 ${stage().width} ${stage().height}`}
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <defs>
                        <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                            <path d="M0,0 L10,5 L0,10 z" fill={WIRE_COLOR.next} />
                        </marker>
                        <marker id="flow-arrow-bounce" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                            <path d="M0,0 L10,5 L0,10 z" fill={WIRE_COLOR.bounce} />
                        </marker>
                    </defs>
                    <For each={stage().wires}>
                        {(w) => (
                            <path
                                data-wire-kind={w.kind}
                                data-wire-from={w.from}
                                data-wire-to={w.to}
                                d={w.d}
                                fill="none"
                                stroke={WIRE_COLOR[w.kind]}
                                stroke-width={w.kind === "bounce" ? 2 : 1.6}
                                stroke-dasharray={w.kind === "bounce" ? "6 5" : undefined}
                                marker-end={w.kind === "bounce" ? "url(#flow-arrow-bounce)" : "url(#flow-arrow)"}
                            />
                        )}
                    </For>
                    <For each={stage().wires}>
                        {(w) => (
                            <Show when={w.label}>
                                {(l) => (
                                    <text x={l().x} y={l().y} text-anchor="middle" font-size="10.5" fill={WIRE_COLOR[w.kind]}>
                                        {l().text}
                                    </text>
                                )}
                            </Show>
                        )}
                    </For>
                </svg>

                {/* ── 层 3：节点卡 + 产物区（最上；容器不吃点击，卡片自己吃） ── */}
                <div
                    data-flow-nodes=""
                    class="absolute left-0 top-0"
                    style={{ inset: "0", "z-index": NODE_Z, "pointer-events": "none" }}
                >
                    <For each={stage().visits}>
                        {(v) => (
                            <div
                                data-flow-visit={v.index}
                                data-flow-node={v.visit.node}
                                data-flow-seq={v.visit.seq}
                                data-flow-current={isCurrent(v) ? "1" : "0"}
                                data-flow-selected={props.selected === v.index ? "1" : "0"}
                                class="absolute cursor-pointer rounded-lg border bg-base-100 p-1.5 shadow-sm transition"
                                classList={{
                                    "border-primary ring-2 ring-primary/40": props.selected === v.index,
                                    "border-base-300": props.selected !== v.index,
                                }}
                                style={{
                                    left: `${v.x}px`,
                                    top: `${v.y}px`,
                                    width: `${v.w}px`,
                                    "pointer-events": "auto",
                                    "border-top": `3px solid ${WIRE_COLOR[v.visit.kind]}`,
                                }}
                                onClick={() => props.onSelect(v.index)}
                            >
                                <div class="flex items-center gap-1">
                                    <span class="font-mono text-body opacity-60">#{v.index + 1}</span>
                                    <span class="truncate font-bold">{v.visit.node}</span>
                                    <Show when={v.visit.seq > 1}>
                                        <span class="ml-auto badge badge-xs badge-error">第 {v.visit.seq} 次</span>
                                    </Show>
                                </div>
                                <div class="flex items-center gap-1 text-body opacity-70">
                                    <span
                                        class="inline-block h-2 w-2 rounded-full"
                                        style={{
                                            background:
                                                ACTOR_COLOR[lanes()[v.lane]?.node === props.view.node?.id ? props.view.node.actor : "agent"] ??
                                                ACTOR_COLOR["agent"],
                                        }}
                                    />
                                    <span>{v.visit.kind === "bounce" ? "打回进入" : "推进进入"}</span>
                                </div>
                                <ArtifactBox state={props.artifacts[visitKey(v.visit.node, v.visit.seq)]} visit={v.visit} />
                            </div>
                        )}
                    </For>
                </div>
            </div>
        </div>
    );
}
