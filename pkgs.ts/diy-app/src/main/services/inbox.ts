// src/main/services/inbox.ts
// 🎯 通知信箱（##429 要求 ④/⑤）：N1 提示的**落盘留痕 + 可回看**那一半。
//
// 与两个邻居的分工，别混：
//   · `model-notice.ts` —— 模型不可用，**进程内存 ring**（描述"此刻有什么坏了"，cache）；
//   · `env-watch.ts`    —— 磁盘满 / 网断，条件恢复自动消（cache）；
//   · 本模块            —— "刚刚发生了一次损失"，**append-only jsonl**（描述"发生过什么"，
//                          不是 cache：重启后回看正是它的主要用途）。
//
// 为什么必须落盘而不是又一个内存 ring：这两类提示（被输出上限截断 / 这轮花太多钱）
// 的价值全在"事后"——用户关掉 app、第二天想查"昨晚那个 131072 输出是谁"，内存 ring 早就没了。
// 落盘位置 `$DIY_HOME/local/inbox.jsonl`（`local/` 是**会话数据**，不在可清之列）。
//
// 写侧纪律：**不阻断发送**。落盘失败只出声（`console.error`），绝不因为记不上账而让一轮对话失败。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { diyHome } from "../core/state";
import { isHumanAuthor } from "../core/drafts";
import { AsyncQueue, withCleanup } from "./async-queue";
import { INBOX_MAX, inboxPreviewOf, type InboxEntry } from "../../shared/inbox";

/** 信箱文件（**不按天切**：条目本就稀疏，按天切只会让"翻上周那条"变成翻十个文件） */
export function inboxFile(): string {
    return path.join(diyHome(), "local", "inbox.jsonl");
}

let seq = 0;

/** 组装一条信箱条目（id / ts 由这里补，调用方只给事实） */
export function inboxEntryOf(
    partial: Omit<InboxEntry, "id" | "ts">,
    now = new Date(),
): InboxEntry {
    return { id: `ib-${now.getTime()}-${++seq}`, ts: now.toISOString(), ...partial };
}

/**
 * 信箱中心：内存 ring（回看 / 订阅源）+ append-only 文件（留痕）。
 *
 * 相对 model-notice 的 ring 多一件事：**首次使用时从文件尾部回填** —— 否则
 * "重启后回看"这条承诺只在文件里成立、在 `diy notice inbox`（内存 list）里不成立。
 */
class InboxHub {
    private entries: InboxEntry[] = [];
    private loaded = false;
    private loading: Promise<void> | null = null;
    private queues = new Set<AsyncQueue<InboxEntry>>();

    /** 读盘回填（只读尾部 INBOX_MAX 行；文件不存在 = 空信箱，不是错误） */
    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return;
        if (this.loading) return this.loading;
        this.loading = (async () => {
            try {
                const raw = await readFile(inboxFile(), "utf-8");
                const lines = raw.split("\n").filter((l) => l.trim().length > 0);
                const tail = lines.slice(-INBOX_MAX);
                for (const l of tail) {
                    try {
                        this.entries.push(JSON.parse(l) as InboxEntry);
                    } catch {
                        /* 尾部半行（进程被杀时写坏的）：跳过，别让一条坏行吃掉整个信箱 */
                    }
                }
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                    console.error(`[inbox] 读 ${inboxFile()} 失败（按空信箱处理）:`, e);
                }
            } finally {
                this.loaded = true;
                this.loading = null;
            }
        })();
        return this.loading;
    }

    /** 落一条：内存 ring + 文件 + 广播（三处**都不许抛** —— 记账不该拖垮对话） */
    async push(entry: InboxEntry): Promise<void> {
        await this.ensureLoaded();
        this.entries.push(entry);
        if (this.entries.length > INBOX_MAX) this.entries.splice(0, this.entries.length - INBOX_MAX);
        for (const q of this.queues) q.push(entry);
        try {
            await mkdir(path.dirname(inboxFile()), { recursive: true });
            await appendFile(inboxFile(), `${JSON.stringify(entry)}\n`, "utf-8");
        } catch (e) {
            console.error(`[inbox] 写 ${inboxFile()} 失败（条目只留在内存）:`, e);
        }
    }

    /** 最近的条目（时间升序）；`taskUri` 给定时只取该任务的 */
    async list(opts: { taskUri?: string; limit?: number } = {}): Promise<InboxEntry[]> {
        await this.ensureLoaded();
        const rows = opts.taskUri ? this.entries.filter((e) => e.taskUri === opts.taskUri) : this.entries;
        const limit = opts.limit && opts.limit > 0 ? opts.limit : rows.length;
        return rows.slice(-limit);
    }

    /**
     * 订阅：**只推增量，不回放**。
     *
     * 与 model-notice 的 `watch` 刻意不同（那边订阅即回放）：回放的历史条目在 renderer
     * 会被当成"刚发生的事"再弹一轮 toast —— 每一次窗口重载都糊一脸。历史要看请走 `list`
     * （`diy notice inbox`），语义各归各的。
     */
    subscribe(signal?: AbortSignal): AsyncIterable<InboxEntry> {
        const q = new AsyncQueue<InboxEntry>();
        this.queues.add(q);
        return withCleanup(q, () => this.queues.delete(q), signal);
    }
}

export const inboxHub = new InboxHub();

/**
 * 「有新留言」条目的**组装**（##436 块 4）：`room-service` 与 `agent.local.chat --mode`
 * 两个投递入口共用这一份，别各写一套文案（同一条留言在两个入口会给出两种说法）。
 *
 * 为什么带上**原文**（`data.raw`）：用户被叫醒却“看不出要回什么”的根因就是只有一句话；
 * `text` 只给一行结论（列表用），原文整段进 `data.raw` + 展开面板（不截断 —— 截断等于
 * 又把原文藏起来）。
 *
 * 分级：信箱对**人 / 机器一视同仁**都记（“谁发的”写在 `source`）。要不要抢焦点是另一回事，
 * 判据完全归 `shared/session-alerts.pick()`（##435：只对人署名留言 L2）—— 这里不复刻、不另造。
 */
export function messageEntryOf(input: {
    taskUri: string;
    /** 投递正文（原样，未加工） */
    text: string;
    /** 署名：`human:<名>` / `job` / `agent:<名>` / 缺省 = 无署名 */
    author?: string;
    /** 房间投递才有：房间 id 与显示名（“谁发的”在跨任务时最缺） */
    roomId?: string;
    fromName?: string;
    /** 房间事件 id（`sayId`）/ 插话队列 id（`steerId`）—— 跳转定位的锚点原料 */
    sayId?: string;
    steerId?: string;
}): Omit<InboxEntry, "id" | "ts"> {
    const who = input.author && input.author.length > 0 ? input.author : "无署名";
    // 人 / 机器：**判据只此一处**（`core/drafts.isHumanAuthor`，与 ##435 的 L2 准入同一份实现）
    const human = isHumanAuthor(input.author);
    const via = input.roomId ? `房间 ${input.roomId}${input.fromName ? `（${input.fromName}）` : ""}` : "会话直投";
    const preview = inboxPreviewOf(input.text);
    return {
        // 人署名 = N2（顶栏角标，真的有人在等回复）· job/agent/无署名 = N1（只落条目，参见 #435）
        level: human ? "N2" : "N1",
        kind: "message",
        taskUri: input.taskUri,
        text: `${who} 给你留了一条留言：${preview}`,
        source: `留言投递 · ${via} · 署名 ${who}`,
        reason: "这个会话的插话队列刚进了一条待投递留言（它的收件人是 agent；你不需要逐条回复，但要知道有这回事）",
        detail: [
            "写入点在留言投递路径：`room-service.steerOrWake`（房间投递）与 `agent.local.chat --mode`（CLI / 别的 agent 代投）。",
            "只记**跃迁**（“来了一条消息”），不记“现在有 N 条未读”——后者是状态，由会话角标负责（与 shared/session-alerts 同一纪律）。",
            "原文在下面（未截断）。要看它落在哪一轮：点「去来源会话」；投递相当于是插进那一轮，目前还没有轮次锚点的就从会话尾部往前找这位署名。",
        ].join("\n"),
        data: {
            raw: input.text,
            author: input.author ?? null,
            roomId: input.roomId ?? null,
            fromName: input.fromName ?? null,
            sayId: input.sayId ?? null,
            steerId: input.steerId ?? null,
            senderKind: human ? "human" : "machine",
        },
    };
}

/**
 * 落一条「投递丢了」的条目（##436 顺带治的洞）：进程重启后，`deliveries.jsonl` 里停在
 * `queued`/`running` 的那条话已经没人会看见了 —— 至少让人能在信箱里读到它是什么。
 *
 * **不静默**是硬要求（t266.room#queues）；**不重投**也是：重投要改投递路径，本轮硬约束
 * 明确禁止（“不改投递”）。所以这里只记账 + 说清“去房间看原文”。
 */
export function lostDeliveryEntryOf(input: {
    taskUri: string;
    roomId: string;
    sayId: string;
    memberId: string;
    status: string;
    text?: string;
    ts?: string;
    /** 幂等键（启动扫尾重启十次也只记一条；判据在 `inbox-sweep`） */
    dedupeKey: string;
}): Omit<InboxEntry, "id" | "ts"> {
    const raw = input.text ?? "";
    return {
        level: "N1",
        kind: "delivery-lost",
        taskUri: input.taskUri,
        text: `一条房间留言没送到（${input.roomId} · 停在 ${input.status}）${raw ? `：${inboxPreviewOf(raw, 40)}` : ""}`,
        source: `房间投递账 · ${input.roomId} · 收件成员 ${input.memberId}`,
        reason: `这条 say（${input.sayId}）的最后一笔投递状态停在 ${input.status}，而进程重启过 ⇒ 内存里的执行链已丢，没有 agent 会再取走它`,
        detail: [
            "机制：房间投递的执行链只在内存（`room-service.queues`），消息本体在 room events —— 链断了消息就没人送。",
            "本条是启动扫尾按 sayId 判出来的“已知丢失”，没有重投（重投要改投递路径，不在本轮范围）。",
            "想看原话与上下文：房间页 / `diy room get <roomId>`；想让 agent 处理：把原话重新发一遍。",
        ].join("\n"),
        data: {
            raw,
            sayId: input.sayId,
            roomId: input.roomId,
            memberId: input.memberId,
            status: input.status,
            at: input.ts ?? null,
            dedupeKey: input.dedupeKey,
        },
    };
}

/** fire-and-forget 落一条（记账失败只出声，绝不让投递因此失败） */
export function noteInbox(partial: Omit<InboxEntry, "id" | "ts">): void {
    void inboxHub.push(inboxEntryOf(partial)).catch((e) => console.error("[inbox] 落条目失败:", e));
}

/**
 * 落一条「永不投递的队列」条目（##436 顺带治的第二个洞）。
 *
 * 判据在 `inbox-sweep.sweepStuckQueues`：**任务已终态**（`shared/turn-gate` 的词表）却还压着
 * 待投递插话 —— 终态会话不再接受新轮次，那些留言永远不会被「轮末整批取走」。
 *
 * 原文全部带上（`data.items`）：用户要判断的正是"那几句该不该我处理"。
 */
export function stuckQueueEntryOf(input: {
    taskUri: string;
    state: string;
    steers: ReadonlyArray<{ id: string; text: string; author?: string; created: string }>;
    dedupeKey: string;
}): Omit<InboxEntry, "id" | "ts"> {
    const first = input.steers[0];
    return {
        level: "N1",
        kind: "delivery-lost",
        taskUri: input.taskUri,
        text: `这个会话已 ${input.state}，但队列里还压着 ${input.steers.length} 条留言（永远不会被投递）${first ? `：${inboxPreviewOf(first.text, 40)}` : ""}`,
        source: `插话队列 · ${input.taskUri} · .diy/drafts.yaml`,
        reason: `会话状态 ${input.state} 属于终态（不再接受新轮次）⇒ 队列没有下一次取走的机会；进程重启也不会让它们变新鲜`,
        detail: [
            "机制：留言存在任务的 `.diy/drafts.yaml` 里，只由**轮次**取走（`claimStepSteers` / 轮末整批）。",
            "终态任务不会再起轮次 ⇒ 这些条只会一直躺着（`deliveries` 里三条都没有，因为它们压根没开始投）。",
            "想处理：把任务恢复成可跑状态后再发一次，或把原话复制到新的任务里。本条由启动扫尾写入，不重投、不删除任何队列项。",
        ].join("\n"),
        data: {
            raw: input.steers.map((s) => `${s.author ? `${s.author}：` : ""}${s.text}`).join("\n---\n"),
            state: input.state,
            count: input.steers.length,
            steerIds: input.steers.map((s) => s.id).join(","),
            dedupeKey: input.dedupeKey,
        },
    };
}
