# 四种通信模式的 API 设计

## 第一层 API：Transport 层（信封协议）

### 1-a. Unary — 已实现

```ts
server.onInvoke('greet', (params) => `Hello, ${params.name}!`);

const result = await client.invoke('greet', { name: 'World' });
```

### 1-b. Server-Stream — 已实现

```ts
server.onServerStream('counter', (params) => (async function* () {
  for (let i = 1; i <= params.to; i++) yield i;
})());

const handle = await client.serverStream('counter', { to: 3 });
for await (const val of handle) { /* 1, 2, 3 */ }
```

### 1-c. Client-Stream — 待实现

Client 传一个 `AsyncGenerator` 作为流数据源。Server 接收 `StreamHandle<T>`（带 `cancel()` 的 `AsyncIterable`），与服务端流 Client 端对称。

`StreamHandle` 移入 `types.ts` 作为共享接口：

```ts
export interface StreamHandle<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
  cancel(): void;
}
```

```ts
// Server 端
server.onClientStream<TReq, TChunk, TRes>(
  'upload-log',
  async (params, chunks: StreamHandle<string>) => {
    let count = 0;
    for await (const chunk of chunks) {
      if (count >= 1000) {
        chunks.cancel(); // 不再接收，通知 client 停止发送
        break;
      }
      count++;
    }
    return { received: count };
  },
);
```

**取消机制**：Server 或 Client 任一方都可发起取消。

| 方向 | 发起方 | 动作 |
|------|--------|------|
| client→server | client 生成器抛出/提前结束 | 自动发 `stream-end`，server 消费循环自然退出 |
| server→client | server 调用 `chunks.cancel()` | 发 `stream-cancel`，client 生成器停止 yield |
| client→server | client 取消（如断开） | 发 `stream-cancel`，server 消费循环自然退出 |

// Client 端：传一个生成器
async function* readLog() {
  yield 'line1';
  yield 'line2';
}
const result = await client.clientStream('upload-log', { filename: 'app.log' }, readLog());
// result → { received: 2 }
```

**协议流：**
```
client → req{_stream:'client', id, method, params}
client ← res{id, streamId}           (init-ack)
client → stream-data{streamId, val}   ... (逐个 yield)
client → stream-end{streamId}          (生成器自然结束)
client ← res{id, result}             (最终响应)
```

`Client.clientStream` 内部实现：

```ts
async clientStream<TReq, TChunk, TRes>(
  method: string,
  params: TReq,
  chunks: AsyncIterable<TChunk>,
): Promise<TRes> {
  const id = ++_reqId;
  // 1. 发 req，等 init-ack
  const streamId = await new Promise<number>((resolve, reject) => { /* ... 同 stream() init */ });
  // 2. 消费生成器，发 stream-data
  for await (const val of chunks) {
    this.tx.send(CH, { kind: 'stream-data', streamId, value: val });
  }
  // 3. 流结束，等最终结果
  this.tx.send(CH, { kind: 'stream-end', streamId, done: true });
  return new Promise<TRes>((resolve, reject) => {
    const handler = (msg: Envelope) => {
      if (msg.kind === 'res' && msg.id === id) {
        this.tx.removeListener(CH, handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result as TRes);
      }
    };
    this.tx.on(CH, handler);
  });
}
```

### 1-d. Bidi-Stream — 待实现

```ts
// Server 端：incoming 用 StreamHandle，取消机制同 client-stream
server.onBidiStream<TReq, TChunkIn, TChunkOut>(
  'chat',
  async function* (params, incoming: StreamHandle<TChunkIn>) {
    for await (const msg of incoming) yield `echo: ${msg}`;
  },
);

// Client 端：传一个生成器（上行），收一个 AsyncIterable（下行）
const replies = client.bidiStream('chat', { room: 'general' }, async function* () {
  yield 'hello';
  yield 'world';
});
for await (const reply of replies) { /* echo: hello, echo: world */ }
```


## 第二层 API：RPC 层（procedure builder）

### 2-a. Unary — 已实现

```ts
const ping = procedure.input(z.object({ msg: z.string() })).resolve(...)
// client.ping({ msg: 'hi' }) → Promise<string>
```

### 2-b. Server-Stream — 已实现

```ts
const list = procedure.input(z.object({ ... })).stream(...)
// client.list({ prefix: 'a' }) → Promise<StreamHandle<unknown>>
```

### 2-c. Client-Stream — 待实现

```ts
const upload = procedure
  .input(z.object({ filename: z.string() }))
  .clientStream(z.string())              // chunk 类型 + Zod 校验
  .resolve(async ({ input, stream }) => {
    let count = 0;
    for await (const chunk of stream) {  // stream: StreamHandle<string>
      if (count >= 1000) {
        stream.cancel();  // 不再接收
        break;
      }
      count++;
    }
    return { inserted: count };
  });

// 调用端：第二个参数是生成器
async function* gen() { yield 'a'; yield 'b'; }
const res = await client.upload({ filename: 'x.log' }, gen());
// res: { inserted: 2 }
```

**Client 类型推断：**

```ts
type ClientRouter = {
  upload: (
    input: { filename: string },
    chunks: AsyncGenerator<string>,
  ) => Promise<{ inserted: number }>;
};
```

### 2-d. Bidi-Stream — 待实现

```ts
const chat = procedure
  .input(z.object({ room: z.string() }))
  .bidiStream(z.string(), z.string())    // <TChunkIn, TChunkOut>
  .resolve(async function* ({ input, stream }) {
    // stream: StreamHandle<string>
    for await (const msg of stream) yield `echo: ${msg}`;
  });

// 调用端：传生成器，收 StreamHandle
const replies = client.chat({ room: 'test' }, async function* () {
  yield 'hello';
});
for await (const r of replies) { /* echo: hello */ }
```


## 命名总表

| 模式 | req._stream | Server 注册 | Client 调用 |
|------|-------------|-------------|-------------|
| unary | `undefined` | `onInvoke` | `invoke` |
| server | `'server'` | `onServerStream` | `serverStream` |
| client | `'client'` | `onClientStream` | `clientStream` |
| bidi | `'bidi'` | `onBidiStream` | `bidiStream` |

## 协议线格式变更

```ts
type StreamMode = 'server' | 'client' | 'bidi';

interface Req {
  kind: 'req'; id: number; method: string; params: unknown;
  _stream?: StreamMode;  // undefined = unary
}
```
