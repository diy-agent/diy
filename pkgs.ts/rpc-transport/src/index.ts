/**
 * @diy/rpc-transport — Transport 实现聚合包
 *
 * 提供 WebSocket / HTTP/2 等传输实现。
 * 未来 stdio 等传输也放在此包的不同目录下。
 *
 * 依赖：@diy/rpc（Transport 类型）
 */

export { WsTransport } from './websocket/index';
export { Http2Transport, createHttp2RpcServer, connectHttp2Rpc } from './http2/index';
