// tests/intent.store.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 内存会话存储「意图测试」—— 需求级（对应 ##474 判据 4）
//
//   T1  与 SessionStore 同接口：append / readFrom / readRange / latestSeq
//   T2  seq 判据与 jsonl 一致：缺 seq / 不连续一律拒绝（半批不写）
//   T3  readFrom(seq) 只返回 seq 更大的；readRange 按 at 闭区间
//   T4  maxEntries：超了丢最旧，latestSeq 不回退（读尾部仍然正确）
//   T5  clear()：清空后 latestSeq 归零、size = 0
//   T6  零落盘：拿真 Session 跑完一轮后，工作目录 / 数据根下**没有任何新文件**
//   T7  静态判据：源码不 import 任何 node:*（这层不该有文件系统）
// ═══════════════════════════════════════════════════════════════

import { readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, type ChatMessage, type LlmPort } from '@diy-agent/session';
import { MemoryStoreError, openMemorySessionStore } from '../src/index.js';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);

function message(seq: number, content: string, at = T0 + seq * 1000): ChatMessage {
    return { seq, role: 'user', type: 'human', text: content, at };
}

/** 递归列出目录下所有文件的相对路径（不存在 = 空） */
function listFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
        let items;
        try {
            items = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const item of items) {
            const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
            if (item.isDirectory()) walk(join(dir, item.name), rel);
            else out.push(rel);
        }
    };
    walk(root, '');
    return out.sort();
}

const fixedLlm: LlmPort = {
    async *chat() {
        yield { type: 'text', text: '收到' };
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 };
        yield { type: 'done', stopReason: 'stop' };
    },
};

describe('内存会话存储', () => {
    it('T1/T2/T3：接口与 seq 判据（追加连续 / 缺 seq 拒绝 / 越界不返回）', () => {
        const store = openMemorySessionStore();
        expect(store.latestSeq()).toBe(0);
        expect(store.readFrom(0)).toEqual([]);

        store.append([message(1, 'a'), message(2, 'b', T0 + 5000)]);
        expect(store.latestSeq()).toBe(2);
        expect(store.size).toBe(2);
        expect(store.readFrom(0).map((item) => item.text)).toEqual(['a', 'b']);
        expect(store.readFrom(1).map((item) => item.text)).toEqual(['b']);
        expect(store.readRange({ from: T0, to: T0 + 1000 }).map((item) => item.text)).toEqual(['a']);

        // 半批不写：第一条合法、第二条断号 ⇒ 整批拒绝
        expect(() => store.append([message(3, 'c'), message(5, 'd')])).toThrowError(MemoryStoreError);
        expect(store.latestSeq()).toBe(2);
        expect(store.size).toBe(2);

        expect(() => store.append([{ role: 'user', text: 'no seq' }])).toThrow(/message-without-seq/);
        expect(() => store.append([message(4, 'e')])).toThrow(/store\/gap/);
    });

    it('T4：maxEntries 丢最旧、latestSeq 不回退', () => {
        const store = openMemorySessionStore({ maxEntries: 3 });
        store.append([1, 2, 3, 4, 5].map((seq) => message(seq, `m${seq}`)));
        expect(store.size).toBe(3);
        expect(store.latestSeq()).toBe(5);
        expect(store.readFrom(0).map((item) => item.text)).toEqual(['m3', 'm4', 'm5']);
        expect(store.readFrom(4).map((item) => item.text)).toEqual(['m5']);
    });

    it('T5：clear() 归零', () => {
        const store = openMemorySessionStore();
        store.append([message(1, 'a')]);
        store.clear();
        expect(store.size).toBe(0);
        expect(store.latestSeq()).toBe(0);
        expect(store.readFrom(0)).toEqual([]);
        // 清空后可以从 1 重新开
        store.append([message(1, 'again')]);
        expect(store.latestSeq()).toBe(1);
    });

    it('T6：真 Session 跑完一轮后，数据根下没有任何新文件', async () => {
        const home = mkdtempSync(join(tmpdir(), 'diy-memory-store-'));
        roots.push(home);
        const before = listFiles(home);

        const store = openMemorySessionStore();
        const session = createSession({ id: 'try-1', llm: fixedLlm, store });
        for await (const _delta of session.send('在吗')) {
            // 只验落盘，不消费增量
        }
        await session.flush();

        expect(session.messages.map((item) => item.text)).toEqual(['在吗', '收到']);
        expect(store.latestSeq()).toBe(2);
        expect(listFiles(home)).toEqual(before);
        expect(before).toEqual([]);
    });

    it('T7：源码不 import node:*（零文件系统是看得见的）', () => {
        const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
        for (const file of ['index.ts', 'store.ts', 'errors.ts']) {
            const text = readFileSync(join(src, file), 'utf-8');
            expect(text).not.toMatch(/from ['"]node:/);
        }
    });
});
