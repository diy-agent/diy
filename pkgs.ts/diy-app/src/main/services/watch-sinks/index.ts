// src/main/services/watch-sinks/index.ts
// 🎯 JobWatch 的**出口注册表**（##408 v2）：把一个中性 `WatchEvent` 翻译成各家自己的形状。
//
// 为什么要有这一层（用户 2026-10-26 的硬要求）：**订阅者不止 room** —— 任务 journal、
// 人的信箱、将来的「通话」（直接 DM 某个 agent）都是订阅者。所以核心层（`shared/job-watch.ts`）
// 只认**字符串地址**（`<前缀>:<目标>`），一行 sink 实现都不许出现在那里；新增一类出口 =
// 在这里注册一个工厂，核心零改动。
//
// 当前只有 `task:` 是**真实现**（先给 ##266 用）。其余三个（`room` / `member` / `inbox`）
// 只登记了「未实现」占位：
//   · `room:`  —— 要动 `room-service`（系统发言者 + 只投 focus 不广播），
//                 语义与将来的「通话」有交叉，等通话定案再开；
//   · `inbox:` —— 条目契约在（`shared/inbox.ts`），缺 UI 面板与去重策略；
//   · `member:`—— 与通话同一件事，一起做。
// **未实现的出口不抛**：定义可以先写着（比如 `room:<taskUri>`），投递时记一条
// `unimplemented` 进报告，其余出口照投 —— 否则一个人写错前缀就让整条 watch 哑掉。
//
// 投递纪律：
//   · **顺序投**（sinks 有序），但**互不阻断**：一个出口失败，后面的照投；
//   · 失败**不上抛**给 tick（那一拍要照常走完），全部收进 `SinkResult[]`。

import type { WatchEvent } from "../../../shared/watch-event";
import { JobWatchError } from "../../../shared/job-watch";
import { taskSink } from "./task";
import type { JournalWriter } from "./task";

export interface WatchSink {
    /** 地址原文（`task:projects/4/tasks/408`） */
    readonly addr: string;
    /** 投递一条事件。可抛：registry 会收进报告。 */
    deliver(ev: WatchEvent): void | Promise<void>;
}

/** 一次投递的结果（`job.watch.peek` / 排查用）。 */
export interface SinkResult {
    readonly addr: string;
    readonly ok: boolean;
    /** `ok:false` 的原因：`unimplemented` / 具体错误信息 */
    readonly error?: string;
}

type SinkFactory = (addr: string) => WatchSink;

/** 造 sink 时可注入的依赖（测试用；生产缺省 = 真实现）。 */
export interface SinkDeps {
    /** `task:` 出口的 journal 写入口 */
    readonly journal?: JournalWriter;
}

/** 前缀 → 工厂。**只登记真实现** —— 未实现的前缀在下面显式列出来。 */
const FACTORIES: Record<string, SinkFactory> = {
    task: taskSink,
};

/** 已登记但还没有实现的出口（写出来是为了让「定义了却不投」变得可见）。 */
export const UNIMPLEMENTED_PREFIXES = ["room", "member", "inbox"] as const;

function unimplementedSink(addr: string): WatchSink {
    return {
        addr,
        deliver() {
            throw new JobWatchError("agent/sink-unimplemented", `出口 ${addr.split(":")[0]}: 尚未实现`);
        },
    };
}

/** 按地址造 sink。前缀不认识 ⇒ 抛（调用前应已过 `sinkAddressError`）。 */
export function createSink(addr: string, deps: SinkDeps = {}): WatchSink {
    const prefix = addr.slice(0, addr.indexOf(":"));
    if (prefix === "task" && deps.journal) return taskSink(addr, deps.journal);
    const factory = FACTORIES[prefix];
    if (factory) return factory(addr);
    if ((UNIMPLEMENTED_PREFIXES as readonly string[]).includes(prefix)) return unimplementedSink(addr);
    throw new JobWatchError("agent/unknown-sink", `未知出口前缀 "${prefix}"`);
}

/** 顺序投给全部出口，互不阻断。**不抛**。 */
export async function deliverToSinks(
    sinks: readonly string[],
    ev: WatchEvent,
    deps: SinkDeps = {},
): Promise<SinkResult[]> {
    const out: SinkResult[] = [];
    for (const addr of sinks) {
        try {
            const sink = createSink(addr, deps);
            await sink.deliver(ev);
            out.push({ addr, ok: true });
        } catch (e) {
            out.push({ addr, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return out;
}
