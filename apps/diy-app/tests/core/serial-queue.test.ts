// tests/core/serial-queue.test.ts
// 🎯 SerialQueue / KeyedSerialQueue —— Go「单协程+channel」顺序模式的验证

import { describe, it, expect } from "vitest";
import { SerialQueue, KeyedSerialQueue, QueueAbortError } from "../../src/main/core/serial-queue";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("SerialQueue", () => {
  it("严格按提交顺序执行（交错 await 不破坏顺序）", async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const delays = [30, 10, 20]; // 后提交的先完成，验证不被完成时间打乱

    await Promise.all(
      delays.map((ms, i) =>
        q.run(async () => {
          await new Promise((r) => setTimeout(r, ms));
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2]);
  });

  it("前一个失败不打断队列，后续任务照常执行", async () => {
    const q = new SerialQueue();
    const got: string[] = [];

    const p1 = q.run(() => { throw new Error("boom"); });
    const p2 = q.run(async () => { got.push("b"); });

    await expect(p1).rejects.toThrow("boom");
    await p2;
    expect(got).toEqual(["b"]);
  });

  it("run 返回值透传给调用方", async () => {
    const q = new SerialQueue();
    expect(await q.run(() => 42)).toBe(42);
  });
});

describe("KeyedSerialQueue.run 并发去重", () => {
  it("同一 key 串行，不同 key 互不阻塞", async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];

    // key-a 串行
    await Promise.all([
      q.run("a", async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("a1");
      }),
      q.run("a", async () => {
        order.push("a2");
      }),
    ]);
    expect(order).toEqual(["a1", "a2"]);

    // 不同 key 并行：b 先提交但先完成，不阻塞 c
    const order2: string[] = [];
    await Promise.all([
      q.run("b", async () => {
        await new Promise((r) => setTimeout(r, 30));
        order2.push("b");
      }),
      q.run("c", async () => {
        order2.push("c");
      }),
    ]);
    // c（无延迟）应在 b（30ms）之前完成
    expect(order2).toEqual(["c", "b"]);
  });

  it("模拟 ensure 双会话场景：并发 check-act 只建一次", async () => {
    const q = new KeyedSerialQueue();
    let created = 0;
    const sessions = new Map<string, number>();

    const ensure = (taskUri: string) =>
      q.run(taskUri, async () => {
        const existing = sessions.get(taskUri);
        if (existing) return existing;
        await new Promise((r) => setTimeout(r, 10)); // loadOrCreate 的 await 缺口
        created += 1;
        const id = created;
        sessions.set(taskUri, id);
        return id;
      });

    // 两个并发 ensure 同一 task：必须只创建一次，且都拿到同一个 session id
    const [a, b] = await Promise.all([ensure("t1"), ensure("t1")]);
    expect(a).toBe(b);
    expect(created).toBe(1);
  });
});

describe("KeyedSerialQueue.runGen 流排他", () => {
  async function* range(n: number, tag: string): AsyncGenerator<string> {
    for (let i = 0; i < n; i++) {
      await tick();
      yield `${tag}${i}`;
    }
  }

  it("两个并发流串行：B 收到的是完整 A 流之后才开始的", async () => {
    const q = new KeyedSerialQueue();
    const gotA: string[] = [];
    const gotB: string[] = [];

    // 模拟 streamChatEvents：两个并发调用同一 task
    const streamA = q.runGen("t", () => range(3, "a"));
    const streamB = q.runGen("t", () => range(2, "b"));

    const consume = async (gen: AsyncGenerator<string>, out: string[]) => {
      for await (const s of gen) out.push(s);
    };
    await Promise.all([consume(streamA, gotA), consume(streamB, gotB)]);

    // A 流完整收完，B 才收到自己的；不会出现 a0 b0 a1 这种交错
    expect(gotA).toEqual(["a0", "a1", "a2"]);
    expect(gotB).toEqual(["b0", "b1"]);
  });

  it("runGen 与其他 run 混用同一队列：流结束前 run 不启动", async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];

    const stream = q.runGen("t", async function* () {
      order.push("stream-start");
      yield "x";
      await tick();
      order.push("stream-end");
    });
    const runTask = q.run("t", () => { order.push("run"); });

    const consume = async () => {
      for await (const _ of stream) { /* 消费完 */ }
    };
    await Promise.all([consume(), runTask]);
    expect(order).toEqual(["stream-start", "stream-end", "run"]);
  });

  it("生成器提前 return（消费中断）也释放队列", async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];

    const stream = q.runGen("t", async function* () {
      try {
        yield "a";
        await tick();
        yield "b";
      } finally {
        order.push("gen-finally");
      }
    });
    const runTask = q.run("t", () => { order.push("run"); });

    // 只消费一个元素就 break（模拟客户端断开）
    const consume = async () => {
      const it = stream[Symbol.asyncIterator]();
      await it.next();
      await it.return(undefined as any); // 提前结束
    };
    await Promise.all([consume(), runTask]);
    // finally 已跑 → gate 已打开 → run 任务才执行
    expect(order).toEqual(["gen-finally", "run"]);
  });
});

describe("队列取消（AbortSignal）", () => {
  it("run：排队中 abort → 跳过执行体，reject QueueAbortError", async () => {
    const q = new SerialQueue();
    const ac = new AbortController();
    const order: string[] = [];

    // 先占一个慢任务，让后提交的任务处于「排队中」
    const slow = q.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
    });
    const cancelled = q.run(
      async () => { order.push("cancelled-run"); },
      { signal: ac.signal },
    );
    ac.abort(); // 在 cancelled 任务执行前取消

    await slow;
    await expect(cancelled).rejects.toThrow(QueueAbortError);
    expect(order).toEqual(["slow"]); // 被取消的任务没执行
  });

  it("run：abort 不阻塞队列，后续任务照常执行", async () => {
    const q = new SerialQueue();
    const ac = new AbortController();
    const order: string[] = [];

    const cancelled = q.run(
      async () => { order.push("should-not-run"); },
      { signal: ac.signal },
    );
    const after = q.run(() => { order.push("after"); });
    ac.abort();

    await expect(cancelled).rejects.toThrow(QueueAbortError);
    await after;
    expect(order).toEqual(["after"]); // 队列未被取消卡死
  });

  it("runGen：排队中 abort → 空流（跳过执行体）且释放队列", async () => {
    const q = new KeyedSerialQueue();
    const ac = new AbortController();
    const order: string[] = [];

    const slow = q.run("t", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
    });
    const stream = q.runGen(
      "t",
      async function* () { order.push("skip-me"); yield "x"; },
      { signal: ac.signal },
    );
    const after = q.run("t", () => { order.push("after"); });
    ac.abort();

    await slow;
    const got: string[] = [];
    for await (const s of stream) got.push(s);
    await after;
    expect(got).toEqual([]); // 空流
    expect(order).toEqual(["slow", "after"]); // 执行体被跳过，无死锁
  });
});