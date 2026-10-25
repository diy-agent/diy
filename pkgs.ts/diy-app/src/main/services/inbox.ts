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
import { AsyncQueue, withCleanup } from "./async-queue";
import { INBOX_MAX, type InboxEntry } from "../../shared/inbox";

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
