/**
 * TrafficLogCleanup — 流量日志**清理面板**（##324）。
 *
 * 口径（任务 ##324 body，实现前定稿）：
 *   · 清理单位 = **整个按天文件**（`log/network/YYYY-MM-DD.jsonl`）。不做「按条删 / 截断单文件」
 *     —— 一天一个文件本就是为了好清理。
 *   · **今天（正在写入）的文件不可删**：主进程 Writer 持着它的 fd（`ensureFd` 只在跨天时重开），
 *     unlink 后 fd 悬空、后续记录写进**已删除的 inode** → 重启后这批记录凭空消失。故该行置灰、
 *     主进程删除侧也拒绝（见 core/traffic-log.ts::cleanLogs）。
 *   · 删除**不可恢复**（直接 unlink，不进回收站、不先归档）→ 必须走应用内二次确认
 *     （`ConfirmDialog`，禁原生 `window.confirm`，见 tool.confirm）。
 *
 * 入口是 `TrafficLogCleanButton`（「清理…」按钮 + 面板），流量页与抽屉共用，避免两处各写一遍。
 */
import { createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { fmtBytes } from "../lib/bytes";

/** 与 RPC `traffic.logFiles` 的 `detail` 同构（前端只读） */
interface LogFileRow {
    file: string;
    date: string;
    bytes: number;
    mtimeMs: number;
    /** 当天文件（正在写入 → 不可清理） */
    today: boolean;
}

/** 「只留最近 N 天」的截止日期（含今天 → 减 N-1 天）；与主进程 cleanLogs 的 cutoff 口径一致 */
function cutoffStr(keepDays: number): string {
    const d = new Date();
    d.setDate(d.getDate() - (Math.max(1, Math.floor(keepDays)) - 1));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeStr(ms: number): string {
    if (!ms) return "—";
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 「清理…」按钮 + 面板（流量页 / 抽屉共用入口） */
export function TrafficLogCleanButton(props: { onDone?: () => void }) {
    const [open, setOpen] = createSignal(false);
    return (
        <>
            <button
                class="btn btn-xs"
                data-testid="traffic-log-clean-open"
                title="清理磁盘日志：删旧的按天文件（今天正在写入的那个不可删；删除不可恢复）"
                onClick={() => setOpen(true)}
            >
                清理…
            </button>
            <Show when={open()}>
                <LogCleanupPanel onClose={() => setOpen(false)} onDone={props.onDone} />
            </Show>
        </>
    );
}

function LogCleanupPanel(props: { onClose: () => void; onDone?: () => void }) {
    const [rows, setRows] = createSignal<LogFileRow[]>([]);
    const [checked, setChecked] = createSignal<Set<string>>(new Set());
    const [keepDays, setKeepDays] = createSignal(7);
    const [busy, setBusy] = createSignal(false);
    const [err, setErr] = createSignal<string | null>(null);
    /** 待二次确认的删除集（null = 无确认弹窗） */
    const [pending, setPending] = createSignal<string[] | null>(null);

    const cleanable = createMemo(() => rows().filter((r) => !r.today));
    const totalBytes = createMemo(() => rows().reduce((n, r) => n + r.bytes, 0));
    const picked = createMemo(() => rows().filter((r) => checked().has(r.file)));
    const pickedBytes = createMemo(() => picked().reduce((n, r) => n + r.bytes, 0));

    const reload = async () => {
        const r = await diyService.diy.traffic.logFiles({});
        setRows(r.detail as LogFileRow[]);
    };

    // 面板每次打开都重新拉一次文件清单（别的窗口 / 事件流可能刚写过日志）
    onMount(() => {
        void reload();
    });

    const toggle = (file: string) => {
        setChecked((s) => {
            const next = new Set(s);
            if (next.has(file)) next.delete(file);
            else next.add(file);
            return next;
        });
    };
    /** 「只留最近 N 天」：勾上比截止日更早的文件（等价于主进程的 keepDays） */
    const selectOlderThan = () => {
        const cut = cutoffStr(keepDays());
        setChecked(new Set(cleanable().filter((r) => r.date < cut).map((r) => r.file)));
    };

    const doClean = async (files: string[]) => {
        setPending(null);
        setBusy(true);
        setErr(null);
        try {
            // 输入类型是 z.infer（可选键也要显式给出 undefined）—— 同 TrafficView 的 query 调用惯例
            const res = await diyService.diy.traffic.cleanLogs({ files, keepDays: undefined, dryRun: undefined });
            await reload();
            setChecked(new Set<string>());
            const extra = res.skipped.length > 0 ? `，跳过 ${res.skipped.length} 个` : "";
            notificationStore.addToastLegacy(
                res.deleted.length > 0 ? "success" : "info",
                `已清理 ${res.deleted.length} 个日志文件，释放 ${fmtBytes(res.freedBytes)}${extra}`,
            );
            props.onDone?.();
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    // Esc 关面板：捕获阶段 + stopPropagation（与 ConfirmDialog / TaskParentPicker 同款 ——
    // 一次 Esc 只关一层，不把背后的抽屉 / 任务详情面板一起关掉）。
    // 确认弹窗开着时让给它处理（同节点上的捕获监听按注册顺序跑，stopPropagation 拦不住后来者）。
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || pending()) return;
            e.stopPropagation();
            props.onClose();
        };
        document.addEventListener("keydown", onKey, true);
        onCleanup(() => document.removeEventListener("keydown", onKey, true));
    });

    return (
        <div
            class="fixed inset-0 z-[120] flex items-center justify-center bg-neutral/40 p-6"
            data-testid="traffic-log-cleanup"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div
                class="flex max-h-[80vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
                role="dialog"
                aria-modal="true"
                aria-label="清理流量日志"
                onClick={(e) => e.stopPropagation()}
            >
                <div class="flex items-center gap-2 border-b border-base-300 px-3 py-2">
                    <span class="text-prose font-semibold">清理流量日志</span>
                    <span class="text-caption opacity-60">
                        共 {rows().length} 个文件 · {fmtBytes(totalBytes())}
                    </span>
                    <div class="flex-1" />
                    <button class="btn btn-xs btn-ghost" onClick={props.onClose}>
                        关闭
                    </button>
                </div>

                {/* 快捷：只留最近 N 天（把更早的勾上；再点「删除选中」才真删） */}
                <div class="flex items-center gap-2 border-b border-base-300 px-3 py-2 text-body flex-wrap">
                    <span class="opacity-70">只留最近</span>
                    <input
                        type="number"
                        min="1"
                        class="input input-bordered input-xs w-16"
                        value={keepDays()}
                        onInput={(e) => setKeepDays(Math.max(1, Number(e.currentTarget.value) || 1))}
                        data-testid="traffic-log-keep-days"
                    />
                    <span class="opacity-70">天</span>
                    <button class="btn btn-xs" onClick={selectOlderThan} data-testid="traffic-log-select-old">
                        选中更早的
                    </button>
                    <button class="btn btn-xs btn-ghost" onClick={() => setChecked(new Set(cleanable().map((r) => r.file)))}>
                        全选可清理
                    </button>
                    <button class="btn btn-xs btn-ghost" onClick={() => setChecked(new Set<string>())}>
                        清空选择
                    </button>
                </div>

                <ul class="overflow-auto py-1" data-testid="traffic-log-cleanup-list">
                    <For each={rows()}>
                        {(r) => (
                            <li
                                class={`flex items-center gap-2 px-3 py-1.5 text-body ${r.today ? "opacity-50" : "hover:bg-base-200"}`}
                                data-testid="traffic-log-file"
                                data-file={r.file}
                                data-today={r.today ? "1" : "0"}
                            >
                                <input
                                    type="checkbox"
                                    class="checkbox checkbox-xs"
                                    disabled={r.today}
                                    checked={checked().has(r.file)}
                                    onChange={() => toggle(r.file)}
                                />
                                <span class="font-mono w-28 shrink-0">{r.date}</span>
                                <span class="w-20 shrink-0 text-right">{fmtBytes(r.bytes)}</span>
                                <span class="text-caption opacity-60 w-32 shrink-0">{timeStr(r.mtimeMs)}</span>
                                <Show when={r.today}>
                                    <span class="text-caption opacity-70">今天 · 正在写入，不可清理</span>
                                </Show>
                            </li>
                        )}
                    </For>
                    <Show when={rows().length === 0}>
                        <li class="px-3 py-3 text-body opacity-50">还没有日志文件</li>
                    </Show>
                </ul>

                <div class="flex items-center gap-2 border-t border-base-300 px-3 py-2">
                    <span class="text-caption opacity-70">
                        <Show when={picked().length > 0} fallback={<>未选中任何文件（今天那个不参与清理）</>}>
                            将删除 {picked().length} 个 · 释放 {fmtBytes(pickedBytes())} · <span class="text-error">不可恢复</span>
                        </Show>
                    </span>
                    <div class="flex-1" />
                    <Show when={err()}>
                        <span class="text-caption text-error">{err()}</span>
                    </Show>
                    <button
                        class="btn btn-xs btn-error"
                        disabled={picked().length === 0 || busy()}
                        data-testid="traffic-log-delete-selected"
                        onClick={() => setPending(picked().map((r) => r.file))}
                    >
                        {busy() ? "清理中…" : `删除选中（${picked().length}）`}
                    </button>
                </div>
            </div>

            {/* 二次确认：删除不可恢复（不进回收站）—— 应用内 ConfirmDialog，禁原生 window.confirm */}
            <Show when={pending()}>
                {(files) => (
                    <ConfirmDialog
                        title={`删除 ${files().length} 个日志文件？`}
                        message={`将删除 ${files().length} 个按天日志文件，释放约 ${fmtBytes(pickedBytes())}。删除不可恢复（不进系统回收站）。`}
                        confirmLabel="删除"
                        onCancel={() => setPending(null)}
                        onConfirm={() => void doClean(files())}
                    />
                )}
            </Show>
        </div>
    );
}
