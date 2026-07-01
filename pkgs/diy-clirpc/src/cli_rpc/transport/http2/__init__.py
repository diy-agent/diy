"""http2 — 纯 HTTP/2 RPC 实现（基于 h2 库，真实 HTTP/2 h2c）"""
# 延迟导入避免不必要的依赖链


def make_http2_app(*a, **kw):
    from cli_rpc.transport.http2._server import make_http2_app as _f

    return _f(*a, **kw)


def H2RpcClient(*a, **kw):
    from cli_rpc.transport.http2._client import H2RpcClient as _f

    return _f(*a, **kw)


__all__ = ["make_http2_app", "H2RpcClient"]
