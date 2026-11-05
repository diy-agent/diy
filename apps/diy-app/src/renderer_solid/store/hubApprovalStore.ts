// store/hubApprovalStore.ts — 全局审批队列（##500 续）
//
// 为什么不是组件各自的 signal：审批是**跨页面**的（判据 25）—— 任务页 / 会话页 / 日志页
// 都可能来请求。弹窗组件、HubPage 的列表、将来的通知中心必须看同一份队列，否则
// "答应了但另一处还显示待批准"就是必然。
//
// 数据源 `diy.hub.pending`（主进程只读 peers.json，不起服务），所以 3s 一次也不贵。
// 轮询判据在 `shared/hub-approval.ts::decideApprovalPoll`（纯函数 + 单测）。

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "./notificationStore";
import {
  APPROVAL_POLL_MS,
  approvalView,
  decideApprovalPoll,
  mergeApprovalQueue,
  type HubPendingRow,
} from "../../shared/hub-approval";

export type { HubPendingRow };

const [requests, setRequests] = createSignal<HubPendingRow[]>([]);
const [error, setError] = createSignal<string | null>(null);
const [loaded, setLoaded] = createSignal(false);

let inFlight = false;
let lastPollAt: number | null = null;
let stopped = true;
let timer: ReturnType<typeof setInterval> | null = null;

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 拉一次队列（并发调用只发一次；失败记进 error，不清空已有队列） */
async function refresh(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  lastPollAt = Date.now();
  try {
    const r = await diyService.diy.hub.pending({});
    setRequests((prev) => mergeApprovalQueue(prev, r.data.requests));
    setError(null);
    setLoaded(true);
  } catch (e) {
    setError(msgOf(e));
  } finally {
    inFlight = false;
  }
}

/** 处理一条申请；成功返回 true。成功后**立刻重拉**（队列里可能还有别的）。 */
async function decide(requestId: string, action: "approve" | "reject"): Promise<boolean> {
  const row = requests().find((r) => r.requestId === requestId);
  try {
    if (action === "approve") await diyService.diy.hub.approve({ requestId });
    else await diyService.diy.hub.reject({ requestId });
    if (row) {
      const v = approvalView(row);
      notificationStore.addToast("success", action === "approve" ? `已批准：${v.title}` : `已拒绝：${v.title}`, {
        source: "配对审批 · hubApprovalStore（store/hubApprovalStore.ts）",
        reason: `${v.subtitle}（${action === "approve" ? "同意" : "拒绝"}）`,
        detail: [
          action === "approve"
            ? "批准后 Token 经卫星的长轮询回到它自己的钥匙串；Hub 侧只留 Token 的 SHA-256。"
            : "拒绝不会创建成员关系；卫星需重新取邀请码再申请。",
          "这条提示由全局审批弹窗产生（任何页面都会弹）。",
        ].join("\n"),
      });
    }
    await refresh();
    return true;
  } catch (e) {
    setError(msgOf(e));
    return false;
  }
}

function tick(): void {
  if (stopped) return;
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  if (!decideApprovalPoll({ visible, inFlight, lastPollAt, now: Date.now() })) return;
  void refresh();
}

/** 起全局轮询（组件 onMount 调；返回停止函数，onCleanup 调）。重复 start 无副作用。 */
export function startApprovalWatch(): () => void {
  if (stopped) {
    stopped = false;
    if (timer === null) timer = setInterval(tick, APPROVAL_POLL_MS);
    void refresh();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", tick);
  }
  return () => {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", tick);
    lastPollAt = null;
  };
}

export const hubApprovalStore = {
  get requests() {
    return requests();
  },
  get error() {
    return error();
  },
  /** 至少成功拉过一次（用于区分"没有请求"和"还没拉到"） */
  get loaded() {
    return loaded();
  },
  refresh,
  approve: (requestId: string) => decide(requestId, "approve"),
  reject: (requestId: string) => decide(requestId, "reject"),
  /** 仅测试用：清空队列与轮询状态（不碰真实数据） */
  _reset(): void {
    setRequests([]);
    setError(null);
    setLoaded(false);
    inFlight = false;
    lastPollAt = null;
  },
};
