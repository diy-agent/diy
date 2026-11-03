// tests/core/session-view.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 本地会话「运行态」判据（任务 194）
//
// 被修的两个相反方向的误报，都由"用本地私有 running 解释整轮死活"引起：
//   假阴性：别人（CLI/另一窗口）在跑 → 本地 sending=false → 未收 stop 的块被判成
//           「本轮未完成（流中断/崩溃恢复）」，且没有停止入口；
//   假阳性：自己点停止 → 本地 sending 要等服务端 end 帧才复位 → 按钮卡在停止态。
//
// 判据纯函数化（shared/session-view.ts），这里钉死它的边界：
//   ① main 真值优先：remoteActive 时必须 live（中断警告不许出现、停止入口必须给）
//   ② 本地在途只是子集：sending 单独为真时也要 live（自己发的流没结束）
//   ③ 停止是本地确定终态：点了就立刻 busy=false，整个收尾期间都呈现"停止中"
//   ④ 宽限期**只**用来区分"正常收尾"与"疑似卡住"（stoppingStuck），
//      **不**用来把状态退回 busy —— 退回等于界面说"可以发"，而服务端会拒发
//   ⑤ 不许把"块未收 stop"当直播中：live 只由两个运行态来源决定（见 ④/②的反例）
// 纯函数，无 Electron、无网络、无 DOM
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { sessionView, STOP_GRACE_MS } from "../../src/shared/session-view";

const NOW = 1_800_000_000_000;

describe("session-view —— 假阴性：别人在跑（CLI 发起的轮次）", () => {
    it("main 报活跃 → live（中断警告的 gating 必须为真）", () => {
        const v = sessionView({ sending: false, remoteActive: true, stopRequestedAt: null, now: NOW });
        expect(v.live).toBe(true);
    });

    it("main 报活跃 → busy（必须给出停止入口）", () => {
        const v = sessionView({ sending: false, remoteActive: true, stopRequestedAt: null, now: NOW });
        expect(v.busy).toBe(true);
        expect(v.stopping).toBe(false);
    });
});

describe("session-view —— 假阳性：自己点停止后按钮卡死", () => {
    it("停止请求后立刻不再是 busy（本地确定终态，不等服务端 end 帧）", () => {
        const v = sessionView({ sending: false, remoteActive: true, stopRequestedAt: NOW, now: NOW + 10 });
        expect(v.busy).toBe(false);
        expect(v.stopping).toBe(true);
    });

    it("停止后 main 仍在收尾也算 live（不许显示成流中断，那轮正在被收尾）", () => {
        const v = sessionView({ sending: false, remoteActive: true, stopRequestedAt: NOW, now: NOW + 10 });
        expect(v.live).toBe(true);
    });

    it("宽限期内：停止中，且不算卡住", () => {
        const v = sessionView({ sending: false, remoteActive: true, stopRequestedAt: NOW, now: NOW + STOP_GRACE_MS - 1 });
        expect(v.stopping).toBe(true);
        expect(v.stoppingStuck).toBe(false);
        expect(v.busy).toBe(false);
    });

    it("宽限期过后 main 仍活跃 → 仍是停止中（不许退回 busy），但标记为卡住", () => {
        const v = sessionView({ sending: false, remoteActive: true, stopRequestedAt: NOW, now: NOW + STOP_GRACE_MS });
        // 关键：不回退。退回 busy 会让输入框解锁、发送按钮出现，而服务端仍会拒发 ——
        // 界面结论与服务端相反，用户点了只会拿到错误。
        expect(v.stopping).toBe(true);
        expect(v.busy).toBe(false);
        // 卡住要有更强的出口（UI 用 stoppingStuck 把按钮从禁用改成"强制中断"）
        expect(v.stoppingStuck).toBe(true);
    });
});

describe("session-view —— 本地在途与真值的组合", () => {
    it("本地在途（自己发的流）单独为真 → live/busy", () => {
        const v = sessionView({ sending: true, remoteActive: false, stopRequestedAt: null, now: NOW });
        expect(v.live).toBe(true);
        expect(v.busy).toBe(true);
    });

    it("两边都不活跃 → 既不 live 也不 busy（历史/真中断场景：中断警告该出现）", () => {
        const v = sessionView({ sending: false, remoteActive: false, stopRequestedAt: NOW, now: NOW + 1 });
        expect(v.live).toBe(false);
        expect(v.busy).toBe(false);
        expect(v.stopping).toBe(false);
    });

    it("自己那轮在途时点停止 → 立刻 busy=false、转停止中（本地不等待 end 帧）", () => {
        const v = sessionView({ sending: true, remoteActive: true, stopRequestedAt: NOW, now: NOW + 1 });
        expect(v.busy).toBe(false);
        // sending 可能还会真一小会儿（AbortSignal 让 for await 收尾）：按钮位先归位，不算"还在生成"
        expect(v.stopping).toBe(true);
        expect(v.live).toBe(true);
    });
});
