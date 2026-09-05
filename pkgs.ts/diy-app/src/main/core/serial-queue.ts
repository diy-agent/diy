// src/main/core/serial-queue.ts
// 🎯 串行队列 —— Go「单协程 + channel」顺序执行模式在 TS 的等价物
//
// Go 的做法：所有操作提交到一个 channel，由单个 goroutine for-range 顺序消费，
// 状态只被这一个执行体触摸 → 天然无锁、天然按提交顺序。
//
// TS 没有 goroutine，但单线程事件循环 + promise 链可以表达完全相同的语义：
// 每个任务挂到队尾 promise（tail）上，严格按提交顺序 settle 后执行下一个。
//
// 取消（对应 Go 的 context.Context）：run/runGen 接受 AbortSignal。
// - 排队中未执行的任务：轮到它时若已 abort → 跳过执行体（跳槽位），
//   不做任何事直接 settle，队列继续推进 —— 顺序不变量保持。
// - 正在执行的任务：队列层无法强停 JS 执行体（Go 里靠 goroutine 内
//   select ctx.Done() 自行配合），由业务层拿同一个 signal 自行协作中断。
//
// 用法对照：
//   Go:                             TS:
//     ch := make(chan func())         const q = new SerialQueue()
//     go func() {                     await q.run(async () => {
//       for f := range ch { f() }       // 顺序执行体
//     }()                             })
//     ch <- fn                        q.run(fn)
//
// 典型场景：
//   - SerialQueue.run        —— 纯顺序操作（prompt 互斥链）
//   - KeyedSerialQueue.run   —— 按实体内存去重/串行（ensure 防双会话）
//   - KeyedSerialQueue.runGen—— 整个事件流排他（流式对话订阅→收完 stop）

/** 队列任务可选的取消信号 */
export interface QueueTaskOptions {
  /** 取消信号：轮到执行时已 abort → 跳过执行体 */
  signal?: AbortSignal;
}

/** 统一的取消错误 */
export class QueueAbortError extends Error {
  constructor() {
    super("队列任务已取消");
    this.name = "QueueAbortError";
  }
}

/** 串行队列：任务严格按提交顺序逐个执行 */
export class SerialQueue {
  /** 队列尾 promise：上一个任务 settle 后才轮到下一个 */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * 提交一个任务，排到队尾顺序执行。
   * 前一个任务 settle（成功或失败）后，本任务才开始。
   * 错误不会打断队列：失败只向上冒泡给本任务调用方，后续任务照常排队。
   * signal 已 abort → 跳过执行体，直接 reject QueueAbortError。
   */
  run<T>(task: () => Promise<T> | T, opts?: QueueTaskOptions): Promise<T> {
    const { signal } = opts ?? {};
    const result = this.tail.then(() => {
      if (signal?.aborted) throw new QueueAbortError();
      return task();
    });
    // 链尾续接：吞掉错误，避免一个失败的任务卡死整条链
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 排他运行 async 生成器：占住本队列直到生成器被完整消费
   * （结束、提前 return 或抛出）才放行下一个任务。
   *
   * 为什么需要它：事件泵是会话级广播，流式对话必须先订阅再发 prompt，
   * 两个并发流会互收对方回合的事件。整个「订阅→prompt→收完 stop」
   * 必须独占队列，只串 prompt 发送是不够的。
   *
   * ⚠️ 提交时立即占位（非惰性）：调用 runGen 的瞬间就挂到队列尾，
   * 顺序语义与 Go 一致（提交顺序 = 执行顺序）。返回的生成器只是
   * 惰性执行体，首次 for-await 时等前一个任务收尾再展开。
   * 若创建后从不消费（不 for-await、不 return），队列会被永久占住。
   *
   * signal：轮到消费时已 abort → 直接空流（跳过执行体），释放队列。
   * 执行中的中断由业务层拿同一 signal 自行协作（如 agent.cancel）。
   *
   * 用法：yield* queue.runGen(async function* () { ... }, { signal })
   */
  runGen<T>(gen: () => AsyncGenerator<T>, opts?: QueueTaskOptions): AsyncGenerator<T> {
    const { signal } = opts ?? {};
    // 立即占位：按提交顺序把 gate 挂到队尾
    const prev = this.tail;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // 队列尾 = 上一次收尾后打开本次 gate；上次失败的错误已向调用方传播，
    // 这里不能让它污染链条（否则后续任务全被同一个错误卡死）
    this.tail = prev.then(
      () => gate,
      () => gate,
    );

    // 返回惰性执行体：消费时才等 prev，展开 gen，收尾时释放 gate
    return (async function* () {
      await prev.catch(() => undefined);
      try {
        if (signal?.aborted) return; // 已取消：跳过执行体，直接空流
        yield* gen();
      } finally {
        release();
      }
    })();
  }
}

/** 按 key 分队列：每个 key 一个独立 SerialQueue，不同 key 互不阻塞 */
export class KeyedSerialQueue {
  private queues = new Map<string, SerialQueue>();

  /** 取 key 对应的队列（惰性创建） */
  private for(key: string): SerialQueue {
    let q = this.queues.get(key);
    if (!q) {
      q = new SerialQueue();
      this.queues.set(key, q);
    }
    return q;
  }

  /** 提交任务并按 key 串行执行 */
  run<T>(key: string, task: () => Promise<T> | T, opts?: QueueTaskOptions): Promise<T> {
    return this.for(key).run(task, opts);
  }

  /** 排他运行 async 生成器：整个生命周期独占该 key 的队列（见 SerialQueue.runGen） */
  runGen<T>(key: string, gen: () => AsyncGenerator<T>, opts?: QueueTaskOptions): AsyncGenerator<T> {
    return this.for(key).runGen(gen, opts);
  }
}