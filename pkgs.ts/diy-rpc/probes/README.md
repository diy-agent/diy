# RPC HTTP/2 取消生命周期复现

这些是**独立 probe，不属于 Vitest 正式测试**。它们用于复现任务 185 R12/R13 报告的 HTTP/2 request-side 半开问题；修复完成后应重新运行并期待 `PASS`。

## 环境

```bash
cd pkgs.ts/diy-rpc
npx tsx probes/http-remote-terminal-resources.ts
```

要求 Node 24、工作区依赖已安装。脚本直接导入当前 `src/`，不会读取 `out/` 或编译产物。

## 复现机制

脚本创建真实 `HttpServerBinding + node:http2 + HttpClientBinding`：

1. 注册 `clientStream collect` handler，收到请求后**立即返回**，不等待输入。
2. 注册 `bidi` handler，生成器**立即结束**。
3. 客户端上传 iterable 的每次 `next()` 延迟 1000ms，模拟远端已终态时仍有在途上传读取，并让“立即快照”稳定落在 request-side 尚未收束的窗口。
4. 调用完成/输出流结束后，读取 `HttpClientBinding.activeStreams` 和 request stream 状态。
5. 远端终态后等待 500ms，不调用 `dispose()`；最后才在 `finally` 中 dispose，避免测试进程遗留连接。

## 修复前/当前缺陷预期

当前未修复代码的关键观察点是**立即快照**，通常类似：

```text
[client-stream] immediately: {
  activeStreams: 1,
  closed: false,
  destroyed: false,
  readableEnded: true,
  writableEnded: false | true
}
[bidi] immediately: {
  activeStreams: 1,
  closed: false,
  destroyed: false,
  readableEnded: true,
  writableEnded: false | true
}
```

`writableEnded` 的瞬时值受 Node HTTP/2 调度影响，不能单独作为判据；稳定判据是远端终态刚落定时 `activeStreams=1` 且 `closed=false`，而不是先由 RPC 终态主动收束。当前脚本等待 500ms 后输出最终快照；若该版本在此期间自然 close，最终 `activeStreams` 可能变为 0，但仍说明 request-side 收束依赖底层后续事件，不是终态路径主动完成。

`activeStreams` 只在底层 stream `close` 时删除；`remoteSettled/remoteEnded` 当前只阻止继续发送数据，却没有在终态路径显式收束 request-side。`http-remote-terminal-events.ts` 进一步用事件和手动 `stream.end()` 做对照。修复后的强判据应是：终态处理后主动收束，不依赖随机 close；正式回归应用可控屏障而不是固定 sleep。

## 还要验证的 drain 分支

`HttpClientBinding` 的上传循环在 `stream.write()` 返回 `false` 时进入 `await onceDrain(stream)`。当前 helper 只监听 `drain`。应另加受控背压 probe，安排：

```text
write() 返回 false
→ 服务端先返回 result/end 或 stream close/error
→ 不再产生 drain
```

期望：上传协程被终态/close/error 唤醒，调用 `upstream.return()`，request stream 收束，`activeStreams` 归零；不能永久停在 `onceDrain()`。

## DeepSeek 复核步骤

1. 在 `fix/rpc-cancel` worktree 执行上面的命令，不要先调用 `client.dispose()`，否则会掩盖半开流。
2. 记录两组快照：远端结果/输出刚落定后，以及再等待 500ms 后。
3. 重点看：
   - `activeStreams` 是否从 1 变为 0；
   - `closed` / `destroyed` 是否变为 `true`；
   - `writableEnded` 是否变为 `true`；
   - 是否只能靠最后的 `dispose()` 才 close。
4. 修复后期望：两条场景均输出 `activeStreams: 0`、`closed: true`、`writableEnded: true`，摘要为：

```text
[summary] { clientStream: true, bidi: true }
PASS: request-side HTTP/2 streams converged
```

5. 再运行正式回归：

```bash
npx vitest run
./sha.sh check
```

不要把 probe 放入 `test/**/*.test.ts`，也不要把 probe 的访问私有字段改成正式公共 API；它的目的只是让资源生命周期和跨传输差异可重复观察。

## 修复后执行记录（2026-09-30）

修复实现：`HttpClientBinding._settleStream` —— 三处终态点（clientStream finally、bidi 早错、bidi queue.onSettle）同步 `activeStreams.delete(stream)` + `stream.close(NGHTTP2_CANCEL)`，不依赖后续 HTTP/2 close 事件。实测（Node v24.19.0）：

```text
[client-stream] immediately: { activeStreams: 0, closed: true, destroyed: false, readableEnded: true, writableEnded: true }
[bidi]         immediately: { activeStreams: 0, closed: true, destroyed: true,  readableEnded: true, writableEnded: true }
[summary] { clientStream: true, bidi: true }
PASS: request-side HTTP/2 streams converged
```

**测量修正（取流时机 bug）**：原脚本在 `await` 调用之后才从 `activeStreams` 取流引用。终态同步收束会把流移出集合，此时 `[...activeStreams][0]` 为 `undefined`，`closed` 恒为 `undefined`，判据 `activeStreams===0 && closed===true` 在任何「同步移出」实现下都永不可满足。流在调用同步段注册（`clientStream` L163 / `bidiStream` L226），故引用改在 `await` 前捕获；判据语义不变（仍验证同一根调用创建的流在终态返回时已主动关闭并移出追踪集合）。

**drain 分支已覆盖**：`onceDrain` 已同时监听 `drain/close/error`（终态唤醒）；正式回归 `test/http-resource.test.ts` 含背压用例（write=false → 远端终态 → 流收敛 + 上游 return）。

反向验证：将 `_settleStream` 退化为仅 `stream.end()` → probe 立即快照回到 `activeStreams: 1, closed: false` → `[summary] { clientStream: false, bidi: false }` FAIL；恢复后 PASS。
