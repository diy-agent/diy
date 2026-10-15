// components/SessionOverviewPage.tsx — 全局会话可见性总览（##308）。
//
// 用户原话要的是「**总的消费 view**」：不点进任何任务页，也能看到哪个会话在跑、token 在涨、
// 步数走到几；无人值守仍在烧的轮次必须在这里可见、可切进去看、可手动中断（##305 定案）。
//
// 数据 = sessionStore（全应用唯一的注册表订阅）；判据全在 shared/session-overview（纯函数）。
// 本文件只做三件事：排版、把动作接到既有出口（进会话 / cancel / setLimits）、把"为什么这么显示"
// 写进 tooltip（用户不该从颜色去猜）。
import { createMemo, createSignal, For, Show } from "solid-js";
import { SessionChip, SessionDot } from "./SessionChip";
import { ConfirmDialog } from "./ConfirmDialog";
import { sessionStore } from "../store/sessionStore";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";
import { getRendererActions } from "../lib/renderer-actions";
import { diyService } from "../lib/rpc";
import { findNode } from "../lib/task-lineage";
import { endMarkOf } from "../../shared/turn-end";
import {
    fmtDuration,
    fmtTokens,
    idleMsOf,
    newStepsOf,
    queueViewOf,
    stalledOf,
    stepsProgressOf,
    tipOf,
} from "../../shared/session-overview";
import type { SessionEntry } from "../../shared/registry-frame";

/** 条目的对外键（与 sessionStore 同口径：任务会话按 task uri 关联） */
function uriOf(e: SessionEntry): string {
    return e.refs.find((r) => r.kind === "task")?.uri ?? e.id;
}

/**
 * 单轮步数上限编辑器（**全局**：`maxSteps` 是运行限制，不是某个会话的属性）。
 *
 * 语义照 RPC `agent.local.setLimits`：写 `$DIY_HOME/local/limits.json` + 即时失效缓存
 * ⇒ **下一轮生效**（在跑的轮次沿用起跑时的值，不中途换挡）。
 * ⚠️ 环境变量 `DIY_LOCAL_MAX_STEPS` 优先级更高：被钉死时写文件对它无效 —— 而返回值是
 * "合并后的生效值"，故回显以返回值（`sessionStore.maxSteps`）为准，不乐观写自己那个数。
 */
function MaxStepsEditor(props: { compact?: boolean }) {
    const [draft, setDraft] = createSignal<string>("");
    const [busy, setBusy] = createSignal(false);
    const apply = async () => {
        const n = Number(draft());
        if (!Number.isFinite(n) || n <= 0) {
            notificationStore.addToast("error", "步数上限必须是正数");
            return;
        }
        setBusy(true);
        try {
            await sessionStore.setMaxSteps(n);
            setDraft("");
            notificationStore.addToast("success", `单轮步数上限已设为 ${n}（下一轮生效）`);
        } catch (e) {
            notificationStore.addToast("error", `写运行限制失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };
    return (
        <span class="inline-flex items-center gap-1" title="单轮最大模型步数（全局；下一轮生效。环境变量 DIY_LOCAL_MAX_STEPS 优先级更高，被钉死时写文件对它无效）">
            <Show when={!props.compact}>
                <span class="opacity-70">单轮上限</span>
                <span class="font-mono">{sessionStore.maxSteps ?? "—"}</span>
            </Show>
            <input
                class="input input-xs w-20 font-mono"
                placeholder={String(sessionStore.maxSteps ?? "")}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") void apply();
                }}
            />
            <button class="btn btn-xs" disabled={busy() || !draft()} onClick={() => void apply()}>
                应用
            </button>
        </span>
    );
}

export function SessionOverviewPage() {
    /** 行内「阈值」展开的那一行（全局值，展开只是省一次滚动） */
    const [limitFor, setLimitFor] = createSignal<string | null>(null);
    /** 待确认的强制中断目标 */
    const [confirmFor, setConfirmFor] = createSignal<SessionEntry | null>(null);

    const rows = createMemo(() => sessionStore.entries);
    const working = createMemo(() => rows().filter((e) => e.turn !== null));

    const enter = (uri: string) => getRendererActions().openTaskRun?.(uri);

    /**
     * 强制中断（承 ##305 的"人在全局视图上手动停"出口）。
     *
     * 直接走 `cancel` RPC —— 它与会话页停止按钮**同一个入口**（main 侧幂等，无在途返 false 不抛错）。
     * 若本窗口正开着该会话，它的页面会在 main 收尾的 op/真值刷新里自己归位（不必本页代管状态）。
     */
    const forceCancel = async (e: SessionEntry) => {
        const uri = uriOf(e);
        setConfirmFor(null);
        try {
            const r = await diyService.diy.agent.local.cancel({ taskUri: uri });
            notificationStore.addToast(
                r.cancelled ? "success" : "info",
                r.cancelled ? `已中断 ${uri} 的轮次` : "该会话此刻没有在跑的轮次（可能刚好收尾了）",
            );
        } catch (err) {
            notificationStore.addToast("error", `中断失败：${err instanceof Error ? err.message : String(err)}`);
        }
    };

    return (
        <div class="flex flex-col p-4 h-full min-h-0 gap-3">
            <div class="shrink-0">
                <h2 class="text-display font-bold">会话总览</h2>
                <div class="text-body opacity-70 mt-1 flex items-center gap-3 flex-wrap">
                    <span>
                        本次启动后活跃过 <b>{rows().length}</b> 个会话，其中在跑 <b>{working().length}</b> 个
                    </span>
                    <Show when={sessionStore.connection !== "live"}>
                        <span class="badge badge-warning badge-sm">
                            {sessionStore.connection === "down" ? "注册表订阅已断，重连中…" : "连接注册表…"}
                        </span>
                    </Show>
                    <span class="text-body opacity-60">
                        窗口最小化 ≠ 停止：轮次归 main 驱动，仅由单轮步数上限收口（##305）
                    </span>
                </div>
            </div>

            <div class="shrink-0 flex items-center gap-2 flex-wrap text-body">
                <MaxStepsEditor />
                <span class="opacity-60">在跑的轮次不换挡；改完从下一轮起生效</span>
            </div>

            <div class="flex-1 min-h-0 overflow-auto">
                <Show
                    when={rows().length > 0}
                    fallback={
                        <div class="text-center opacity-60 py-10">
                            本次启动后还没有活跃过的会话
                            <div class="text-body opacity-70 mt-1">
                                （注册表是**内存态**：启动即空，只记"这次启动后动过的会话"，不列历史）
                            </div>
                        </div>
                    }
                >
                    <table class="table table-sm w-full">
                        <thead class="sticky top-0 bg-base-100 z-10">
                            <tr>
                                <th class="w-24">活动</th>
                                <th>任务</th>
                                <th class="w-32">模型</th>
                                <th class="w-40">步数</th>
                                <th class="w-28">token（本轮/累计）</th>
                                <th class="w-40">待投递留言</th>
                                <th class="w-16">看客</th>
                                <th class="w-24">已跑</th>
                                <th class="w-28">上次结束</th>
                                <th class="w-44">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            <For each={rows()}>
                                {(e) => {
                                    const uri = () => uriOf(e);
                                    const node = () => findNode(taskStore.nodes, uri());
                                    const prog = () => stepsProgressOf(e, sessionStore.maxSteps);
                                    const q = () => queueViewOf(e);
                                    const mark = () => endMarkOf(e.lastEndReason, e.turn !== null);
                                    const add = () => newStepsOf(e, sessionStore.seenStepsOf(uri()));
                                    const runMs = () => {
                                        if (!e.turn) return null;
                                        const t = Date.parse(e.turn.startedAt);
                                        return Number.isFinite(t) ? sessionStore.nowMs - t : null;
                                    };
                                    const stalled = () => stalledOf(e, sessionStore.nowMs);
                                    return (
                                        <tr class="border-b hover:bg-base-200" title={tipOf(e, sessionStore.maxSteps, sessionStore.nowMs)}>
                                            <td class="whitespace-nowrap">
                                                <span class="inline-flex items-center gap-1">
                                                    <SessionDot uri={uri()} />
                                                    <Show
                                                        when={e.turn}
                                                        fallback={<span class="opacity-60">idle</span>}
                                                    >
                                                        <span class="text-primary font-medium">working</span>
                                                    </Show>
                                                    <Show when={stalled()}>
                                                        <span class="badge badge-warning badge-xs">
                                                            停滞 {fmtDuration(idleMsOf(e, sessionStore.nowMs) ?? 0)}
                                                        </span>
                                                    </Show>
                                                </span>
                                            </td>
                                            <td class="text-body">
                                                <span class="inline-flex items-center gap-1 flex-wrap">
                                                    <button
                                                        class="diy-link underline-offset-2 hover:underline cursor-pointer text-left"
                                                        onClick={() => enter(uri())}
                                                    >
                                                        {node()?.num ? `#${node()!.num} ` : ""}
                                                        {node()?.title ?? uri()}
                                                    </button>
                                                    <SessionChip uri={uri()} />
                                                </span>
                                                <div class="text-body opacity-50 font-mono truncate">{uri()}</div>
                                            </td>
                                            <td class="text-body font-mono opacity-80">{e.turn?.model ?? "—"}</td>
                                            <td class="text-body">
                                                <span class="font-mono">{prog().text}</span>
                                                <Show when={prog().pct !== null}>
                                                    <progress
                                                        class={`progress w-24 align-middle ml-2 ${prog().pct! >= 0.9 ? "progress-error" : "progress-primary"}`}
                                                        value={prog().done}
                                                        max={prog().limit!}
                                                    />
                                                </Show>
                                                <Show when={add() > 0}>
                                                    <span class="badge badge-ghost badge-xs ml-1" title="距你上次看这个会话，它又走了这么多步">
                                                        +{add()}
                                                    </span>
                                                </Show>
                                            </td>
                                            <td class="text-body font-mono opacity-80 whitespace-nowrap">
                                                {fmtTokens(e.turn?.tokens ?? 0)} / {fmtTokens(e.totalTokens)}
                                            </td>
                                            <td class="text-body">
                                                <Show when={q().kind !== "none"} fallback={<span class="opacity-40">—</span>}>
                                                    <span class="badge badge-warning badge-sm" title={q().tip}>
                                                        {q().label}
                                                    </span>
                                                </Show>
                                            </td>
                                            <td class="text-body font-mono opacity-80">{e.viewers}</td>
                                            <td class="text-body font-mono opacity-80 whitespace-nowrap" title={`轮次起始 ${e.turn?.startedAt ?? "—"}`}>
                                                {runMs() === null ? "—" : fmtDuration(runMs()!)}
                                            </td>
                                            <td class="text-body whitespace-nowrap">
                                                <Show when={mark().icon} fallback={<span class="opacity-40">—</span>}>
                                                    <span
                                                        class={
                                                            mark().tone === "err"
                                                                ? "text-error"
                                                                : mark().tone === "ok"
                                                                  ? "text-success"
                                                                  : "text-warning"
                                                        }
                                                        title={mark().tip}
                                                    >
                                                        {mark().icon} {mark().tip}
                                                    </span>
                                                </Show>
                                            </td>
                                            <td class="whitespace-nowrap">
                                                <div class="flex items-center gap-1">
                                                    <button class="btn btn-xs" onClick={() => enter(uri())}>
                                                        进入会话
                                                    </button>
                                                    <button
                                                        class="btn btn-xs btn-error"
                                                        disabled={!e.turn}
                                                        title="中断在跑的轮次（main 侧幂等；无人值守也可停）"
                                                        onClick={() => setConfirmFor(e)}
                                                    >
                                                        强制中断
                                                    </button>
                                                    <button
                                                        class="btn btn-xs btn-ghost"
                                                        title="调整单轮步数上限（全局）"
                                                        onClick={() => setLimitFor(limitFor() === uri() ? null : uri())}
                                                    >
                                                        阈值
                                                    </button>
                                                </div>
                                                <Show when={limitFor() === uri()}>
                                                    <div class="mt-1">
                                                        <MaxStepsEditor compact />
                                                    </div>
                                                </Show>
                                            </td>
                                        </tr>
                                    );
                                }}
                            </For>
                        </tbody>
                    </table>
                </Show>
            </div>

            <Show when={confirmFor()}>
                {(e) => (
                    <ConfirmDialog
                        title="强制中断这一轮？"
                        message={`将中断 ${uriOf(e())} 正在跑的轮次（模型会停手，本轮按"被中断"收尾）。无人值守的轮次也照样能停。`}
                        confirmLabel="中断"
                        onCancel={() => setConfirmFor(null)}
                        onConfirm={() => void forceCancel(e())}
                    />
                )}
            </Show>
        </div>
    );
}
