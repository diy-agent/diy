import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';

/**
 * 剩余项探针：HTTP createBodyReader() 的 listener 生命周期（R19 §三 P2）。
 *
 * 判据拆成两个可独立判定的事实，避免把「未显式清理」误报成「真实泄漏」：
 *   A. per-chunk 增长：发 200 个 chunk 后 data listener 数不得增加（逐 chunk 泄漏 = 真缺陷）。
 *   B. 终态显式清理：stream 收到 end 后，createBodyReader 注册的 listener 是否被移除
 *      （不移除 => 依赖 GC/stream 销毁，属 P3 记录项）。
 */
const api = RpcSchema.router({
  collect: RpcSchema.clientStream({ input: {}, chunkIn: z.number(), output: z.number() }),
});

class FakeStream extends EventEmitter {
  closed = false;
  constructor() { super(); this.setMaxListeners(0); }
  write(): boolean { return true; }
  end(): void { this.closed = true; }
  respond(): void {}
  close(): void { this.closed = true; this.emit('close'); }
  private listenersTotal(): number {
    return ['data', 'end', 'aborted', 'close'].reduce((n, e) => n + this.listenerCount(e), 0);
  }
  total(): number { return this.listenersTotal(); }
}

async function main() {
  const binding = new HttpServerBinding();
  binding.on(api.collect, async ({ stream }) => {
    let seen = 0;
    for await (const _ of stream) seen++;
    return seen;
  });

  const stream = new FakeStream();
  void binding.handleStream(stream as any, {
    ':path': '/collect',
    'x-diy-params': JSON.stringify({ input: {}, meta: {} }),
  } as any);

  const before = stream.listenerCount('data');
  for (let i = 0; i < 200; i++) stream.emit('data', Buffer.from(`${i}\n`));
  const afterChunks = stream.listenerCount('data');

  stream.emit('end');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const totalAfterEnd = stream.total();

  console.log('[http-body-reader-listeners]', { before, afterChunks, totalAfterEnd });

  if (afterChunks !== before) {
    console.error('FAIL: listener count grows with chunk volume (per-chunk leak)');
    process.exitCode = 1;
  } else {
    console.log('PASS: no per-chunk listener growth');
    if (totalAfterEnd > 0) {
      console.log(`NOTE: ${totalAfterEnd} listener(s) remain after end — terminal cleanup not explicit (P3, relies on stream GC)`);
    }
  }

  binding.destroy();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
