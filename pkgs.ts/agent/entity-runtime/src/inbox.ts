// inbox.ts —— AgentInbox：每 actor 一个待消费队列（node:sqlite 状态表）。
//
// 规则（本轮拍板）：
//   · 状态表，不是 append-only；可以 update/delete；
//   · 只有 pending / claimed 两态；claimed 超时可回收；
//   · 每 actor 一个串行执行器（调用方保证），这里只做存储。

import { DatabaseSync } from 'node:sqlite';

import type { InboxItem, InboxMode } from './types';

export class Inbox {
    private seq = 0;

    constructor(private readonly db: DatabaseSync) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS inbox (
                id TEXT PRIMARY KEY,
                actor TEXT NOT NULL,
                seq INTEGER NOT NULL,
                mode TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                claimed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS inbox_actor ON inbox(actor, status, seq);
        `);
        const row = db.prepare('SELECT MAX(seq) AS max FROM inbox').get() as { max: number | null } | undefined;
        this.seq = row?.max ?? 0;
    }

    post(actor: string, kind: 'chat' | 'notice', payload: Record<string, unknown>, mode: InboxMode = 'now'): InboxItem {
        const item: InboxItem = {
            id: `ib-${Date.now().toString(36)}-${++this.seq}`,
            actor,
            seq: ++this.seq,
            mode,
            kind,
            payload,
            status: 'pending',
            createdAt: Date.now(),
        };
        this.db
            .prepare('INSERT INTO inbox (id, actor, seq, mode, kind, payload, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(item.id, item.actor, item.seq, item.mode, item.kind, JSON.stringify(item.payload), 'pending', item.createdAt);
        return item;
    }

    /** 原子取走：pending → claimed，按 seq 升序 */
    drain(actor: string, limit = 20): InboxItem[] {
        const rows = this.db
            .prepare("SELECT * FROM inbox WHERE actor = ? AND status = 'pending' ORDER BY seq ASC LIMIT ?")
            .all(actor, limit) as Record<string, unknown>[];
        const now = Date.now();
        const claim = this.db.prepare("UPDATE inbox SET status='claimed', claimed_at=? WHERE id=? AND status='pending'");
        const items: InboxItem[] = [];
        for (const row of rows) {
            const result = claim.run(now, String(row['id']));
            if (result.changes === 0) continue; // 被别的消费者抢走
            items.push({
                id: String(row['id']),
                actor: String(row['actor']),
                seq: Number(row['seq']),
                mode: row['mode'] as InboxMode,
                kind: row['kind'] as 'chat' | 'notice',
                payload: JSON.parse(String(row['payload'])) as Record<string, unknown>,
                status: 'claimed',
                createdAt: Number(row['created_at']),
                claimedAt: now,
            });
        }
        return items;
    }

    complete(ids: string[]): void {
        const del = this.db.prepare('DELETE FROM inbox WHERE id = ?');
        for (const id of ids) del.run(id);
    }

    release(ids: string[]): void {
        const rel = this.db.prepare("UPDATE inbox SET status='pending', claimed_at=NULL WHERE id = ?");
        for (const id of ids) rel.run(id);
    }

    /** 卡住的 claimed（进程崩了）回收 */
    sweep(olderThanMs = 60_000): number {
        const cutoff = Date.now() - olderThanMs;
        const result = this.db
            .prepare("UPDATE inbox SET status='pending', claimed_at=NULL WHERE status='claimed' AND claimed_at < ?")
            .run(cutoff);
        return Number(result.changes);
    }

    list(actor: string): InboxItem[] {
        const rows = this.db.prepare('SELECT * FROM inbox WHERE actor = ? ORDER BY seq ASC').all(actor) as Record<string, unknown>[];
        return rows.map((row) => ({
            id: String(row['id']),
            actor: String(row['actor']),
            seq: Number(row['seq']),
            mode: row['mode'] as InboxMode,
            kind: row['kind'] as 'chat' | 'notice',
            payload: JSON.parse(String(row['payload'])) as Record<string, unknown>,
            status: row['status'] as 'pending' | 'claimed',
            createdAt: Number(row['created_at']),
            claimedAt: row['claimed_at'] === null ? undefined : Number(row['claimed_at']),
        }));
    }
}
