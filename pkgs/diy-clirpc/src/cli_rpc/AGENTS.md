# cli_rpc — CLI-as-API over ConnectRPC

## 定位

CLI 命令为一等 API。`diy subcmd arg --opt` = RPC 调用语义。
基于标准 ConnectRPC 协议，传输层=HTTP（Unix socket / TCP），不自定义帧协议。

## 核心思路

### CLI 不知道 RPC 模式

终端用户敲命令时，不知道自己有没有 stdin 可传，也不知道服务端是不是流。
**解法：**

```
有 stdin → 调 duplexStream（服务端兼容流/非流输出）
无 stdin → 调 serverStream（服务端兼容流/非流输出）
```

```
终端:   diy task list
           ↓
    CLI gateway（永远发 duplexStream）
           ↓
    路由层: 查表 argv=["task","list"] → unary handler
           ↓
    "CONTROL 读完调函数，忽略后续 stdin，发回结果帧"
```

### 两种入口并存

| 入口 | 知道模式？ | 走的 RPC |
|------|-----------|----------|
| 终端 shell | 不知道 | **一律 duplexStream** |
| 生成代码（TS / Python stub） | 知道 | 准确的 unary/serverStream/clientStream/duplexStream |

四种 RPC 方法全部保留，为生成代码提供精确类型约束。

## 分层架构

```
┌─────────────────────────────────────────┐
│   Cyclopts 业务层（命令定义 + 函数签名）    │
│   def task_list() -> str                │  ← unary
│   def log_tail() -> AsyncGenerator[...]  │  ← serverStream
│   def parse(stdin) -> str               │  ← clientStream
│   def chat(stdin) -> AsyncGenerator[...] │  ← duplexStream
├─────────────────────────────────────────┤
│   CycloptsRouter（从函数签名推断流模式）    │
│   argv → 查表 → 匹配 handler → 按模式执行  │
│   签名反射: 返回值/入参类型决定流模式        │
├─────────────────────────────────────────┤
│   CliRpcServicer（4 个 RPC 方法实现）     │
│   unary / serverStream / clientStream    │
│   / duplexStream                         │
├─────────────────────────────────────────┤
│   connect-py ASGI app（HTTP 绑定）       │
│   ConnectClient / ConnectASGIApplication │
├─────────────────────────────────────────┤
│   HTTP + Unix socket (uvicorn)           │
└─────────────────────────────────────────┘
```

## Protobuf 协议

```protobuf
syntax = "proto3";
package clirpc;

enum Channel {
  CHANNEL_STDIN   = 0;
  CHANNEL_STDOUT  = 1;
  CHANNEL_STDERR  = 2;
  CHANNEL_CONTROL = 3;
}

message RawFrame {
  Channel channel = 1;
  bytes   data    = 2;
}

message RawRequest {
  repeated string argv = 1;
}

message RawResponse {
  int32 exit_code = 1;
  bytes stdout = 2;
  bytes stderr = 3;
}

service CliRpcService {
  rpc unary(RawRequest) returns (RawResponse);
  rpc serverStream(RawRequest) returns (stream RawFrame);
  rpc clientStream(stream RawFrame) returns (RawResponse);
  rpc duplexStream(stream RawFrame) returns (stream RawFrame);
}
```

## 四种 RPC 模式

| 模式 | 输入 | 输出 | 场景 | 命令携带 |
|------|------|------|------|----------|
| unary | `RawRequest` | `RawResponse` | `diy task list` | `request.argv` |
| serverStream | `RawRequest` | `stream RawFrame` | `diy log tail` | `request.argv` |
| clientStream | `stream RawFrame` | `RawResponse` | `diy parse < file` | 首帧 CONTROL + `{"argv":[...]}` |
| duplexStream | `stream RawFrame` | `stream RawFrame` | `diy chat` | 首帧 CONTROL + `{"argv":[...]}` |

### clientStream / duplexStream 首帧约束

- 首帧必须为 `CHANNEL_CONTROL`
- data = UTF-8 JSON，固定结构：`{"argv": ["diy", "subcmd"]}`
- 首帧之后 `CHANNEL_STDIN` 才算业务输入
- 服务端校验：首帧非 CONTROL → 终止 RPC 返回错误

## 客户端 API

```python
@dataclass
class StreamChunk:
    channel: str   # stdin / stdout / stderr / control
    data: bytes

@dataclass
class UnaryResponse:
    code: int
    stdout: bytes
    stderr: bytes
    headers: Dict[str, str]
    trailers: Dict[str, str]

class CliRpc:
    # 通用 CLI 入口 — 始终走 duplexStream
    async def stream(self, *argv: str,
                     stdin: AsyncGenerator[bytes] | None = None,
                     metadata: dict | None = None) -> AsyncIterator[StreamChunk]: ...

    # unary 便捷封装 — 等一次完整返回
    async def unary(self, *argv: str,
                    metadata: dict | None = None) -> UnaryResponse: ...

    async def close(self): ...
```

## 当前状态

- ✅ protobuf 协议（buf 生成代码，不需要 protoc）
- ✅ 服务端 serverStream/duplexStream handler 正确处理 stdin
- ✅ 客户端 stream() 按 stdin 有无自动选择 RPC 方法
- ✅ chat 命令真实回声 stdin
- ✅ count-bytes 命令统计 stdin
- ✅ CONTROL 帧传递 exit_code
- ✅ all-modes demo + 集成测试通过
- ✅ buf 生成工具链修复
