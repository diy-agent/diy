/**
 * job-trigger.ts — job 的**触发规则**：结构 + 时间计算，纯函数（##408 刀 3）。
 *
 * 形状遵守 `~/AGENTS.md::rule.discriminated-union`：`{ type, data }`，分支私有数据进 `data`。
 *
 * ── 本文件只做「算什么」，不做「什么时候跑」（v2 才做）──
 *   这里没有 `setInterval`、没有调度器、不持有任何状态：`nextAt(trigger, from)` 是**纯函数**，
 *   给定规则 + 一个时刻，算出下一次应当在哪个时刻跑。调度器（v2）只负责「拿着 now 来问」。
 *   分开的好处：时间计算的全部边角（跨天 / 时区 / DST / 边界）在单测里一次钉死，
 *   调度器那边就只剩「循环 + 记账」两件事。
 *
 * ── `event` 为什么没有 nextAt ──
 *   事件型没有「下一次」这个概念：它由 `emit(topic)` 推着走，问它「几点跑」本身就是错的。
 *   故 `nextAt` 对它返回 `null`（**明确的「无日程」**，不是「算不出来」）。
 */

import { z } from "zod";
import { invariant } from "./error-triage";

const nonEmpty = z.string().min(1);

/** interval 的最小步长：秒级以下用后台 job 没意义，且最容易是手滑写出来的 0 / 负数。 */
export const MIN_INTERVAL_MS = 1000;

export type JobTrigger =
    | {
          readonly type: "interval";
          readonly data: {
              /** 间隔毫秒数（≥ `MIN_INTERVAL_MS`） */
              readonly every: number;
          };
      }
    | {
          readonly type: "daily";
          readonly data: {
              /** 本地墙钟时刻 `HH:MM`（24 小时制）—— 用本地时间，人才会觉得「每天九点」是对的 */
              readonly at: string;
          };
      }
    | {
          readonly type: "event";
          readonly data: {
              /** 事件主题（`emit(topic)` 同一套字符串） */
              readonly topic: string;
          };
      };

export const JOB_TRIGGER_TYPES = ["interval", "daily", "event"] as const;

/** `HH:MM`（24 小时制，00:00 ~ 23:59）。 */
const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const triggerSchema = z.discriminatedUnion("type", [
    z
        .object({
            type: z.literal("interval"),
            data: z
                .object({
                    every: z
                        .number()
                        .int()
                        .min(MIN_INTERVAL_MS, `间隔不得小于 ${MIN_INTERVAL_MS}ms`),
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            type: z.literal("daily"),
            data: z.object({ at: z.string().regex(DAILY_AT_RE, "须为 HH:MM（24 小时制）") }).strict(),
        })
        .strict(),
    z
        .object({
            type: z.literal("event"),
            data: z.object({ topic: nonEmpty }).strict(),
        })
        .strict(),
]);

/**
 * 校验触发规则 —— 形状不对一律 `agent/invalid-job-trigger`。
 *
 * ⚠️ code 域没有 `job`（`error-triage.ts::CODE_RE` 是闭集 `llm|fs|net|rpc|agent|db|ui`），
 *    故归 `agent/`；单开 `job` 域属契约变更，另议（见 ##408 刀 2 裁决）。
 */
export function assertTrigger(value: unknown, where = ""): JobTrigger {
    const parsed = triggerSchema.safeParse(value);
    if (!parsed.success) {
        const why = parsed.error.issues
            .map((i) => `${i.path.join(".") || "<root>"} ${i.message}`)
            .join("; ");
        invariant(false, "agent/invalid-job-trigger", `trigger 非法：${why}${where ? ` @${where}` : ""}`);
    }
    return parsed.data;
}

function parseDailyAt(at: string): { readonly hh: number; readonly mm: number } {
    const m = DAILY_AT_RE.exec(at);
    invariant(m !== null, "agent/invalid-job-trigger", `daily.at 非法：${at}`);
    return { hh: Number(m[1]), mm: Number(m[2]) };
}

/**
 * 下一次该跑的时刻（严格**晚于** `from`；`event` / 无日程 ⇒ `null`）。
 *
 * 判据细节（写在单测名里，不是注释里）：
 *   · `interval`：`from + every` —— 永不早于现在，也不会补算错过的那些（补齐是 v2 的 missed-run 策略）。
 *   · `daily`：**本地墙钟**意义上的下一次 `HH:MM`。
 *       - 今天还没到点 ⇒ 今天；已经到了或正好等于 `from` ⇒ 明天（严格大于，否则 `from == 到期点` 会原地打转）。
 *       - 用「逐日试探 + 回读本地钟」而不是做时区算术：DST 那天的 `02:30` 可能**不存在**
 *         （会被 `Date` 顺延到 `03:30`），回读发现 `getHours() !== hh` 就跳到下一天 ——
 *         宁可少跑一次，也不要在一个「不存在的时刻」反复触发。
 */
export function nextAt(trigger: JobTrigger, from: Date): Date | null {
    switch (trigger.type) {
        case "interval":
            return new Date(from.getTime() + trigger.data.every);
        case "event":
            return null;
        case "daily": {
            const { hh, mm } = parseDailyAt(trigger.data.at);
            for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
                const candidate = new Date(
                    from.getFullYear(),
                    from.getMonth(),
                    from.getDate() + dayOffset,
                    hh,
                    mm,
                    0,
                    0,
                );
                const landed = candidate.getHours() === hh && candidate.getMinutes() === mm;
                if (landed && candidate.getTime() > from.getTime()) return candidate;
            }
            // 8 天内没有合法落点 = 这个 HH:MM 在本机时区不可能成立（理论上到不了）
            return null;
        }
        default: {
            const never: never = trigger;
            return never;
        }
    }
}

/** 触发规则的人话（面板「触发规则」列 / CLI `job ls` 共用，别在 UI 层各拼一份）。 */
export function describeTrigger(trigger: JobTrigger): string {
    switch (trigger.type) {
        case "interval": {
            const every = trigger.data.every;
            if (every % 3_600_000 === 0) return `每 ${every / 3_600_000} 小时`;
            if (every % 60_000 === 0) return `每 ${every / 60_000} 分钟`;
            if (every % 1000 === 0) return `每 ${every / 1000} 秒`;
            return `每 ${every} 毫秒`;
        }
        case "daily":
            return `每天 ${trigger.data.at}`;
        case "event":
            return `事件 ${trigger.data.topic}`;
        default: {
            const never: never = trigger;
            return never;
        }
    }
}
