// src/main/services/inbox-sweep.ts
// 🎯 启动扫尾：把「已经不可能再被取走」的留言落成信箱条目（##436 顺带治的洞）。
//
// 只治**一种**现场（##266 查真盘后收窄的结论，别再加别的）：
//   会话已**结案**（不再接受新轮次），`.diy/drafts.yaml` 的 `steers` 里却还压着留言 ——
//   **没有下一次轮次来取走它们**（##229：`projects/4/tasks/229` 那条 `steer/1`，任务
//   2026-10-04 起就是 done，躺了 21 天）。
//
// 为什么只有这一种：
//   · 「扫 `deliveries.jsonl` 里停在 queued/running 的僵尸账」这一条**本轮不做**（##266 裁的）：
//     派发方在 `~/.diy/projects` 与 `~/.diy/local` 下搜到 0 个文件。**补充事实**（本刀实查）：
//     真位置是 `~/.diy/rooms/<roomId>/deliveries.jsonl`（19 个文件），按 eventId 归并后
//     确有 **3 条**最后一笔停在 `running`（收件人都是 `agent:main`）—— 数量太小、判据（多久
//     没动算僵尸 / 要不要重投）本轮没定，故**记账先不做**，等 ##266 另开刀。
//   · CLI 那条路造不出僵尸：TurnGate 在建轮之前就拒（给结案任务 `chat` 直接回
//     `session/closed`，消息**根本没进队列**）。
//   · 造得出来的只有 UI 输入框：`localChatStore` 直接往 `drafts.yaml` 追加 steer，
//     **不经 TurnGate**。
//
// 只做**记账**：不改投递、不重投、不删 drafts、不改任务状态（本轮三条硬约束）；但**不许静默**。
// 而且文案必须写明「可逆」—— 任务随时可以改回 active，那时这条留言照样会被取走。
//
// 为什么在启动时扫而不是常驻轮询：判据是「这个任务已经结案了」，与进程无关；启动扫一遍
// 就够，常驻轮询白烧 IO。幂等靠信箱里已有的 `data.dedupeKey`（不是进程内 flag ——
// 后者只能挡住同一进程内的两次调用）。

import { readDrafts } from "../core/drafts";
import { getTask } from "../core/state";
import { listTasks } from "../core/task";
import { TERMINAL_SESSION_STATES } from "../../shared/turn-gate";
import { inboxEntryOf, inboxHub, stuckSteerEntryOf } from "./inbox";

/**
 * 「不再接受新轮次」的状态集。
 *
 * = `TERMINAL_SESSION_STATES`（done / cancelled / closed，`shared/turn-gate` 的共享词表）
 *   **∪** `shelved`（##266 点名要算的：搁置的会话没人会去开轮次）。
 *
 * ⚠️ 注意 `shelved` 在 `turn-gate` 里**不是**终态（搁置可以重新激活、会话仍可续），
 * 所以它比"真终态"更容易是**误报**；代价只是一条点进去发现"改回 active 就好"的条目，
 * 比"一句留言躺 21 天没人知道"便宜得多 —— 故按 ##266 的口径收进来。
 */
const NO_NEW_TURN_STATES: ReadonlySet<string> = new Set<string>([...TERMINAL_SESSION_STATES, "shelved"]);


/**
 * 扫一遍所有任务：结案了但 `steers` 还非空的 ⇒ 每条留言落一条 `lost` 条目。
 *
 * 返回新落的条数（0 = 现场干净）。读盘失败一律吞掉（记账不该让启动挂住）。
 */
export async function sweepStuckSteers(): Promise<number> {
    const existing = await inboxHub.list();
    const seen = new Set<string>();
    for (const e of existing) {
        if (e.kind !== "lost") continue;
        const k = e.data?.["dedupeKey"];
        if (typeof k === "string") seen.add(k);
    }

    let noted = 0;
    for (const uri of listTasks()) {
        const state = getTask(uri)?.state ?? "";
        if (!NO_NEW_TURN_STATES.has(state)) continue;

        const drafts = readDrafts(uri);
        const steers = drafts?.steers ?? [];
        if (steers.length === 0) continue;

        for (const steer of steers) {
            const key = `${uri}#${steer.id}`;
            if (seen.has(key)) continue;
            try {
                await inboxHub.push(
                    inboxEntryOf(
                        stuckSteerEntryOf({ taskUri: uri, state, steer, dedupeKey: key }),
                    ),
                );
                seen.add(key);
                noted++;
            } catch (e) {
                console.error(`[inbox-sweep] 落条目失败（${key}）:`, e);
            }
        }
    }
    return noted;
}

/**
 * 启动入口（`main/index.ts` 的 `whenReady` 调；**异步、不阻塞窗口、失败只出声**）。
 *
 * 返回值目前没人要 —— 留 `number` 是为了测试能断言"扫出几条"，也方便将来日志用。
 */
export async function sweepInboxOnStartup(): Promise<number> {
    try {
        const noted = await sweepStuckSteers();
        if (noted > 0) {
            console.warn(`[inbox-sweep] 启动扫尾：结案任务里的滞留留言 ${noted} 条（详见信箱）`);
        }
        return noted;
    } catch (e) {
        console.error("[inbox-sweep] 启动扫尾失败（不影响运行）:", e);
        return 0;
    }
}
