/**
 * mountStream 单测 —— 「异步流 → 每条 insert」的语义与生命周期。
 *
 * 无 DOM：用一个记录调用的假 GenNode（mountStream 只用到 `insert` 和 `ownScope`），
 * 以及一个可手动 push 的假异步源（能观察 `return()` 是否被调用 = 有没有泄漏）。
 */

import { describe, it, expect, vi } from "vitest";
import { html, mountStream, type GenNode, type Spec } from "../src/providers/dom-gen.js";

// ── 假节点 ──────────────────────────────────────────────────

interface Probe {
  node: GenNode;
  inserted: Array<{ key: unknown; rev: unknown; text: unknown }>;
  ownScope: Array<() => void>;
}

function probe(): Probe {
  const inserted: Probe["inserted"] = [];
  const ownScope: Array<() => void> = [];
  const node = {
    insert(spec: Spec, opts: { key?: unknown; rev?: unknown } = {}) {
      inserted.push({ key: opts.key, rev: opts.rev, text: spec.props.text });
      return node;
    },
    ownScope,
  } as unknown as GenNode;
  return { node, inserted, ownScope };
}

// ── 假异步源（可手动 push / 观察 return） ───────────────────

interface Source<T> {
  it: AsyncIterableIterator<T>;
  push(v: T): void;
  /** 迭代器被 return() 的次数 —— 取消后应为 1（否则就是泄漏） */
  readonly returned: number;
}

function source<T>(): Source<T> {
  const q: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let returned = 0;

  const it: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return it;
    },
    async next() {
      for (;;) {
        if (q.length > 0) return { done: false, value: q.shift() as T };
        if (closed) return { done: true, value: undefined as never };
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
    async return() {
      returned++;
      closed = true;
      wake?.();
      wake = null;
      return { done: true, value: undefined as never };
    },
  };

  return {
    it,
    push(v: T) {
      q.push(v);
      wake?.();
      wake = null;
    },
    get returned() {
      return returned;
    },
  };
}

/** 让 mountStream 里的 await 链跑完（一次宏任务即可） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── 用例 ────────────────────────────────────────────────────

describe("mountStream", () => {
  it("按到达顺序逐条插入，并把 key / rev / 下标透传下去", async () => {
    const p = probe();
    const s = source<string>();
    mountStream(p.node, s.it, (v, i) => html.div({ text: `${i}:${v}` }), {
      key: (v) => `k:${v}`,
      rev: (v) => `r:${v}`,
    });

    s.push("a");
    await flush();
    s.push("b");
    await flush();

    expect(p.inserted).toEqual([
      { key: "k:a", rev: "r:a", text: "0:a" },
      { key: "k:b", rev: "r:b", text: "1:b" },
    ]);
  });

  it("不给 key/rev 时不传（走 node.insert 的无 key 路径）", async () => {
    const p = probe();
    const s = source<number>();
    mountStream(p.node, s.it, (v) => html.div({ text: String(v) }));

    s.push(7);
    await flush();

    expect(p.inserted).toEqual([{ key: undefined, rev: undefined, text: "7" }]);
  });

  it("stop() 之后不再插入，并且关掉迭代器（不停在 await 上）", async () => {
    const p = probe();
    const s = source<string>();
    const stop = mountStream(p.node, s.it, (v) => html.div({ text: v }));

    s.push("a");
    await flush();
    expect(p.inserted).toHaveLength(1);

    stop();
    await flush();
    expect(s.returned).toBe(1);

    // 取消后再来数据也不应触发插入
    s.push("b");
    await flush();
    expect(p.inserted).toHaveLength(1);
  });

  it("节点销毁（执行 ownScope 里的 disposer）会自动停止", async () => {
    const p = probe();
    const s = source<string>();
    mountStream(p.node, s.it, (v) => html.div({ text: v }));

    // 挂在节点自身作用域上：removeSelf / keyed prune 时会执行
    expect(p.ownScope).toHaveLength(1);
    p.ownScope[0]?.();
    await flush();

    expect(s.returned).toBe(1);
    s.push("x");
    await flush();
    expect(p.inserted).toHaveLength(0);
  });

  it("外部 AbortSignal 也能停（组件切走 / 卸载用）", async () => {
    const p = probe();
    const s = source<string>();
    const ac = new AbortController();
    mountStream(p.node, s.it, (v) => html.div({ text: v }), { signal: ac.signal });

    s.push("a");
    await flush();
    expect(p.inserted).toHaveLength(1);

    ac.abort();
    await flush();
    expect(s.returned).toBe(1);

    s.push("b");
    await flush();
    expect(p.inserted).toHaveLength(1);
  });

  it("源抛错时交给 onError，已插入的内容保留、后续不再插", async () => {
    const onError = vi.fn();
    const p = probe();

    async function* boom(): AsyncGenerator<string> {
      yield "ok";
      throw new Error("boom");
    }

    mountStream(p.node, boom(), (v) => html.div({ text: v }), { onError });
    await flush();
    await flush();

    expect(p.inserted.map((x) => x.text)).toEqual(["ok"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("boom");
  });

  it("源正常结束时自然退出（不报错、不调 return）", async () => {
    const p = probe();
    const onError = vi.fn();

    async function* finite(): AsyncGenerator<string> {
      yield "1";
      yield "2";
    }

    mountStream(p.node, finite(), (v) => html.div({ text: v }), { onError });
    await flush();
    await flush();

    expect(p.inserted.map((x) => x.text)).toEqual(["1", "2"]);
    expect(onError).not.toHaveBeenCalled();
  });
});
