// src/main/core/serial-queue.ts
// 🎯 串行队列 —— Go「单协程 + channel」顺序执行模式在 TS 的等价物
//
// Go 的做法：所有操作提交到一个 channel，由单个 goroutine for-range 顺序消费，
// 状态只被这一个执行体触摸 → 天然无锁、天然按提交顺序。
//
// TS 没有 goroutine，但单线程事件循环 + promise 链可以表达完全相同的语义：
// 每个任务挂到队尾 promise（tail）上，严格按提交顺序 settle 后执行下一个。
//
// 用法对照：
//   Go:                             TS:
//     ch := make(chan func())         const q = new SerialQueue()
//     go func() {                     await q.run(async () => {
//       for f := range ch { f() }       // 顺序执行体
//     }()                             })
//     ch <- fn                        q.run(fn)
//
// 三个典型场景：
//   - SerialQueue.run        —— 纯顺序操作（prompt 互斥链）
//   - KeyedSerialQueue.run   —— 按实体内存去重/串行（ensure 防双会话）
//   - KeyedSerialQueue.runGen—— 整个事件流排他（流式对话订阅→收完 stop）

/** 串行队列：任务严格按提交顺序逐个执行 */
export class SerialQueue {
  /** 队列尾 promise：上一个任务 settle 后才轮到下一个 */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * 提交一个任务，排到队尾顺序执行。
   * 前一个任务 settle（成功或失败）后，本任务才开始。
   * 错误不会打断队列：失败只向上冒泡给本任务调用方，后续任务照常排队。
   */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task);
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
   * 用法：yield* queue.runGen(async function* () { ... })
   */
  runGen<T>(gen: () => AsyncGenerator<T>): AsyncGenerator<T> {
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
  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    return this.for(key).run(task);
  }

  /** 排他运行 async 生成器：整个生命周期独占该 key 的队列（见 SerialQueue.runGen） */
  runGen<T>(key: string, gen: () => AsyncGenerator<T>): AsyncGenerator<T> {
    return this.for(key).runGen(gen);
  }
}