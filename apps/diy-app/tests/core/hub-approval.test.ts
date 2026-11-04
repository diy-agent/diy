// 🎯 全局审批弹窗（##500 续）的可判定语义 —— 纯函数单测（不依赖 Electron）。
//
// 锁死的契约（判据 25/26）：
//   1. 队列合并：在队的保持原顺序、新来的追加、消失的移除（弹窗不跳动）
//   2. 轮询判据：窗口不可见 / 上一轮未回 / 未到间隔 → 不发
//   3. 行文案：displayName 为空时退回 nodeId；时间只取时分秒
import { describe, expect, it } from "vitest";
import {
  APPROVAL_POLL_MS,
  approvalHeadline,
  approvalView,
  decideApprovalPoll,
  mergeApprovalQueue,
  type HubPendingRow,
} from "../../src/shared/hub-approval";

function row(id: string, over: Partial<HubPendingRow> = {}): HubPendingRow {
  return {
    requestId: `req_${id}`,
    nodeId: `diy-${id}`,
    displayName: `node-${id}`,
    requestedAt: "2026-11-02T14:22:59.935+0800",
    ...over,
  };
}

describe("mergeApprovalQueue", () => {
  it("保持已有顺序，新请求追加到末尾", () => {
    const prev = [row("a"), row("b")];
    const next = mergeApprovalQueue(prev, [row("b"), row("c"), row("a")]);
    expect(next.map((r) => r.requestId)).toEqual(["req_a", "req_b", "req_c"]);
  });

  it("消失的请求被移除（已批准 / 拒绝 / 别人处理）", () => {
    const next = mergeApprovalQueue([row("a"), row("b")], [row("b")]);
    expect(next.map((r) => r.requestId)).toEqual(["req_b"]);
  });

  it("同一 requestId 的新内容覆盖旧内容", () => {
    const next = mergeApprovalQueue([row("a", { displayName: "旧名" })], [row("a", { displayName: "新名" })]);
    expect(next).toHaveLength(1);
    expect(next[0]!.displayName).toBe("新名");
  });

  it("空 → 有 / 有 → 空", () => {
    expect(mergeApprovalQueue([], [row("a")])).toHaveLength(1);
    expect(mergeApprovalQueue([row("a")], [])).toEqual([]);
  });
});

describe("decideApprovalPoll", () => {
  const base = { visible: true, inFlight: false, lastPollAt: null as number | null, now: 10_000 };

  it("第一次（还没轮询过）立刻发", () => {
    expect(decideApprovalPoll(base)).toBe(true);
  });

  it("窗口不可见不发", () => {
    expect(decideApprovalPoll({ ...base, visible: false })).toBe(false);
  });

  it("上一轮未回不发（串行，不堆请求）", () => {
    expect(decideApprovalPoll({ ...base, inFlight: true })).toBe(false);
  });

  it("未到间隔不发，到点才发", () => {
    const lastPollAt = 10_000;
    expect(decideApprovalPoll({ ...base, lastPollAt, now: 10_000 + APPROVAL_POLL_MS - 1 })).toBe(false);
    expect(decideApprovalPoll({ ...base, lastPollAt, now: 10_000 + APPROVAL_POLL_MS })).toBe(true);
  });

  it("可注入间隔（测试用短间隔）", () => {
    expect(decideApprovalPoll({ ...base, lastPollAt: 10_000, now: 10_500, intervalMs: 500 })).toBe(true);
  });
});

describe("approvalView", () => {
  it("一级 / 二级文案", () => {
    const v = approvalView(row("a"));
    expect(v.title).toBe("node-a 请求加入");
    expect(v.subtitle).toBe("diy-a · 14:22:59");
  });

  it("displayName 为空退回 nodeId（不显示空白名字）", () => {
    expect(approvalView(row("a", { displayName: "  " })).title).toBe("diy-a 请求加入");
  });

  it("时间不是本地 ISO 时原样保留（不编造）", () => {
    expect(approvalView(row("a", { requestedAt: "unknown" })).subtitle).toBe("diy-a · unknown");
  });
});

describe("approvalHeadline", () => {
  it("带上数量", () => {
    expect(approvalHeadline(1)).toBe("1 个设备请求加入");
    expect(approvalHeadline(3)).toBe("3 个设备请求加入");
  });
});
