// src/shared/cost-alarm.ts
// 🎯 成本门槛告警（##429 要求 ⑤）——**兜底网**，不是预算闸。
//
// 为什么需要它：输出预算（`shared/output-budget.ts`）管的是"单次吐多少"，
// 但一次贵请求的成因不止输出 —— 输入侧超长粘贴、多步工具循环、模型路由到贵档，
// 都能让成本悄悄上去而每一步都"没超预算"。于是再加一层**只看钱**的告警：
// 单步超阈值、单轮超阈值，各说一次。
//
// 设计取舍：
//   · **只告警不拦截**。拦（拒绝发请求 / 强制收尾）会让"贵但有价值"的工作没法做，
//     而用户要的正是"事后立刻知道", 不是"事后发现钱没了"（要求 ⑤ 原文：兜底网）。
//   · **每轮每类只触发一次**：同轮第 2、3 步继续贵，再弹就是刷屏；一轮只该被提醒一次。
//   · 阈值可配（`limits.json` / env，见 `DEFAULT_COST_ALARM`）；`null` = 关掉该类告警，
//     这是"我就是要跑一次很贵的实验"时的唯一正确出口。
//
// 约定：本文件只放纯函数，禁止 import node:*。

/** 一条待落信箱的告警（**不是** InboxEntry：id / ts 由产生侧补） */
export interface CostAlarm {
    kind: "cost-step" | "cost-turn";
    /** 一句话结论（toast 文案） */
    text: string;
    /** 结构化事实：金额与阈值 */
    data: { usd: number; thresholdUsd: number; step?: number };
}

/** 阈值（美元）。缺省 $0.10 / $0.50（##429 拍板值）；`null` = 该类告警关闭 */
export interface CostAlarmConfig {
    stepUsd: number | null;
    turnUsd: number | null;
}

export const DEFAULT_COST_ALARM: CostAlarmConfig = { stepUsd: 0.1, turnUsd: 0.5 };

/** 告警状态（每轮一份，跨步 carry）：已报过的不再报 */
export interface CostAlarmState {
    stepWarned: boolean;
    turnWarned: boolean;
}

export const newCostAlarmState = (): CostAlarmState => ({ stepWarned: false, turnWarned: false });

/**
 * 判据（纯函数）：给定这一步与本轮的累计金额，返回**本次要报的告警** + 新状态。
 *
 * @param stepUsd 这一步的金额；**null = 无价目**（不算 0，也不算超）
 * @param turnUsd 本轮累计金额；null = 一步都没价目
 */
export function costAlarmsOf(
    state: CostAlarmState,
    stepUsd: number | null,
    turnUsd: number | null,
    cfg: CostAlarmConfig = DEFAULT_COST_ALARM,
    stepNo?: number,
): { alarms: CostAlarm[]; state: CostAlarmState } {
    const next: CostAlarmState = { ...state };
    const alarms: CostAlarm[] = [];
    const stepT = cfg.stepUsd;
    if (!next.stepWarned && stepT !== null && stepT > 0 && stepUsd !== null && stepUsd > stepT) {
        next.stepWarned = true;
        alarms.push({
            kind: "cost-step",
            text: `单步花了 $${usdText(stepUsd)}，超过阈值 $${usdText(stepT)}`,
            data: { usd: round4(stepUsd), thresholdUsd: stepT, ...(stepNo ? { step: stepNo } : {}) },
        });
    }
    const turnT = cfg.turnUsd;
    if (!next.turnWarned && turnT !== null && turnT > 0 && turnUsd !== null && turnUsd > turnT) {
        next.turnWarned = true;
        alarms.push({
            kind: "cost-turn",
            text: `本轮已花 $${usdText(turnUsd)}，超过阈值 $${usdText(turnT)}`,
            data: { usd: round4(turnUsd), thresholdUsd: turnT },
        });
    }
    return { alarms, state: next };
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * 金额的**人读**形状（阈值可小到 $0.0005：固定两位会把阈值印成 `$0.00`，等于没说）。
 * 规则：≥ $0.01 给两位，否则给四位（不四舍五入到 0）。
 */
export function usdText(n: number): string {
    return n >= 0.01 ? n.toFixed(2) : n.toFixed(4);
}
