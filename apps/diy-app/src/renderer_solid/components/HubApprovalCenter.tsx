/**
 * HubApprovalCenter — 全局配对审批弹窗（##500 续，判据 25/26）。
 *
 * 为什么不是 HubPage 里的那个浮层：配对请求是**随时**来的，人可能正停在任务页 /
 * 会话页 / 日志页。只在配对页看得见等于"没弹"（HubPage 的浮层已删，这里是唯一出口）。
 *
 * 三条约束：
 *   ① 跨页面：挂在 App 根（与 ToastContainer 同级），不依赖当前路由；
 *   ② 单一数据源：`hubApprovalStore`（3s 轮询 `hub.pending`；窗口不可见时停）；
 *   ③ 处理要能当场完成：同意 / 拒绝直接调 `hub.approve|reject`，成功即从队列消失并给 toast。
 *
 * 位置在**右下**：右上已被 Toast 占用，两条叠在一起会互相遮挡。
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { approvalHeadline, approvalView } from "../../shared/hub-approval";
import { hubApprovalStore, startApprovalWatch, type HubPendingRow } from "../store/hubApprovalStore";

export function HubApprovalCenter() {
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [dismissedError, setDismissedError] = createSignal<string | null>(null);

  onMount(() => {
    const stop = startApprovalWatch();
    onCleanup(stop);
  });

  const rows = createMemo(() => hubApprovalStore.requests);
  const error = createMemo(() => {
    const e = hubApprovalStore.error;
    return e && e !== dismissedError() ? e : null;
  });

  async function decide(requestId: string, action: "approve" | "reject"): Promise<void> {
    setBusyId(requestId);
    try {
      await (action === "approve" ? hubApprovalStore.approve(requestId) : hubApprovalStore.reject(requestId));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Show when={rows().length > 0 || error()}>
      <div class="fixed bottom-4 right-4 z-[9998] w-[22rem] max-w-[calc(100vw-2rem)]" data-hub-approval>
        <div class="card bg-base-100 shadow-xl border border-warning/40">
          <Show when={rows().length > 0}>
            <div class="card-body p-3 gap-2">
              <div class="flex items-center gap-2">
                <span class="text-warning text-lg">🔔</span>
                <span class="font-semibold" data-hub-approval-count={rows().length}>
                  {approvalHeadline(rows().length)}
                </span>
              </div>
              <For each={rows()}>
                {(row) => <ApprovalRow row={row} busy={busyId() === row.requestId} onDecide={decide} />}
              </For>
              <div class="text-[11px] opacity-60">
                批准后 Token 经卫星的长轮询回到它自己的钥匙串；Hub 只留 SHA-256。
              </div>
            </div>
          </Show>
          <Show when={error()}>
            <div class="alert alert-error m-2 py-1 text-xs">
              <span class="flex-1 break-all">{error()}</span>
              <button class="btn btn-ghost btn-xs" onClick={() => setDismissedError(hubApprovalStore.error)}>
                ✕
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

function ApprovalRow(props: {
  row: HubPendingRow;
  busy: boolean;
  onDecide: (requestId: string, action: "approve" | "reject") => Promise<void>;
}) {
  const view = createMemo(() => approvalView(props.row));
  return (
    <div class="rounded-box bg-base-200/70 px-2 py-1.5" data-hub-approval-row={props.row.requestId}>
      <div class="font-semibold truncate" data-hub-approval-title>
        {view().title}
      </div>
      <div class="text-[11px] opacity-60 font-mono truncate">{view().subtitle}</div>
      <div class="flex justify-end gap-1 mt-1">
        <button
          class="btn btn-xs btn-ghost"
          disabled={props.busy}
          data-hub-approval-action="reject"
          onClick={() => void props.onDecide(props.row.requestId, "reject")}
        >
          拒绝
        </button>
        <button
          class="btn btn-xs btn-success"
          disabled={props.busy}
          data-hub-approval-action="approve"
          onClick={() => void props.onDecide(props.row.requestId, "approve")}
        >
          {props.busy ? "处理中…" : "同意"}
        </button>
      </div>
    </div>
  );
}
