/**
 * serve/index.ts — 无 Electron 的 Web 服务入口
 *
 * 启动流程:
 *   1. 解析 --port 参数（默认 18889）
 *   2. 创建 AppConfig
 *   3. 创建 HTTP 服务器 + WebSocket 服务器
 *   4. 绑定到 127.0.0.1
 *
 * 浏览器通过 `http://127.0.0.1:<port>` 访问。
 * Tailscale 用户通过 `http://<tailscale-host>:<port>` 访问。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { WsTransport } from "@diy/rpc-transport";
import { RawServer, RpcServer } from "@diy/rpc";
import { api } from "../main/services/api";
import { AppConfig } from "../main/core/app-config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STATIC_DIR = path.resolve(ROOT, "out/renderer");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

let port = 18888;
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
if (portIdx >= 0) {
  port = parseInt(args[portIdx + 1] ?? String(port), 10);
  if (!Number.isFinite(port)) port = 18888;
}

async function main() {
  if (!fs.existsSync(STATIC_DIR)) {
    console.error(`[diy/serve] 静态文件目录不存在: ${STATIC_DIR}`);
    console.error(`  请先构建 renderer: npm run build:renderer`);
    process.exit(1);
  }

  const appConfig = AppConfig.default();

  // 读取构建好的 index.html，注入 WebSocket bootstrap
  const indexHtml = fs.readFileSync(path.join(STATIC_DIR, "index.html"), "utf-8");
  const servedHtml = indexHtml.replace("</body>", createBootstrap() + "\n</body>");

  // ── HTTP 服务器（静态文件 + SPA fallback） ──
  const httpServer = http.createServer((req, res) => {
    let url = req.url ?? "/";
    // Strip query string
    const qIdx = url.indexOf("?");
    if (qIdx >= 0) url = url.slice(0, qIdx);

    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(servedHtml);
      return;
    }

    const filePath = path.normalize(path.join(STATIC_DIR, url));
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback: all unknown routes serve index.html
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(servedHtml);
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(fs.readFileSync(filePath));
  });

  // ── WebSocket 服务器（RPC 传输） ──
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    const transport = new WsTransport(ws);
    const rpcServer = new RpcServer({ router: api, transport: new WsTransport(ws) });
  });

  // ── 启动 ──
  httpServer.listen(port, "127.0.0.1", () => {
    const home = appConfig.diyHome;
    console.log("═══════════════════════════════════════");
    console.log("  diy 管控台 — Web 模式");
    console.log("═══════════════════════════════════════");
    console.log(`  地址:     http://127.0.0.1:${port}`);
    console.log(`  Tailscale: http://<tailscale-host>:${port}`);
    console.log(`  PID:      ${process.pid}`);
    console.log(`  DIY_HOME: ${home}`);
    console.log("───────────────────────────────────────");
  });
}

function createBootstrap(): string {
  return `<script>
(function(){var ws=new WebSocket('ws://127.0.0.1:${port}');
var q=[];var r=0;
ws.addEventListener('open',function(){r=1;for(var i=0;i<q.length;i++)ws.send(JSON.stringify(q[i]))});
window.transport={send:function(m){r?ws.send(JSON.stringify(m)):q.push(m)},
on:function(h){var cb=function(e){h(JSON.parse(e.data))};ws.addEventListener('message',cb);return function(){ws.removeEventListener('message',cb)}},
onClose:function(cb){ws.addEventListener('close',cb);return function(){ws.removeEventListener('close',cb)}}};
var _u=new Set();
ws.addEventListener('message',function(e){var m=JSON.parse(e.data);if(m.type==='notify'&&m.method==='ui:command')_u.forEach(function(c){c(m.params)})});
window.diy={onUiCommand:function(cb){_u.add(cb);return function(){_u.delete(cb)}}};
})();
</script>`;
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[diy/serve] 启动失败: ${msg}`);
  process.exit(1);
});
