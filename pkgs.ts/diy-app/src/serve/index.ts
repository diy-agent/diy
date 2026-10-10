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
import { setDefaultAutoSelectFamily } from "node:net";
import { setDefaultResultOrder } from "node:dns";
// 同 main/index.ts：本机 Happy Eyeballs 双栈竞态 ETIMEDOUT，关 autoSelectFamily（留痕）
setDefaultAutoSelectFamily(false);
console.log("[serve][net] 已关闭 Happy Eyeballs（同 main，本机双栈竞态致公网 HTTPS 超时）");
// 同 main/index.ts：本机无 IPv6 出口，钉死 v4 优先（否则 AAAA 排头必 ENETUNREACH）
setDefaultResultOrder("ipv4first");
console.log("[serve][net] 已钉死 IPv4 优先（同 main，本机无 IPv6 出口）");
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { WsTransport } from "@diy/rpc/ws";
import { bindApi, setRpcPort } from "../main/services/api-impl";
import { AppConfig } from "../main/core/app-config";
import { installDiagnostics } from "../main/services/diagnostics";
import { readRuntimeConfig } from "../runtime";
import { cliEntryForRepo, findRepoRoot, isProdDataHome, prodHomeAllowed } from "../main/core/instance-identity";

// 计算项目根目录：从 src/serve/index.ts 向上两级到 pkgs.ts/diy-app/
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 开发态入口自证（与 main/index.ts / diy.sh / electron-dev.mts 同一套判据）──
// **必须在此独立做** —— serve 不 import main/index.ts，那条自证不覆盖本进程。
// 外层 shell（agent 会话）常带 DIY_HOME=~/.diy、DIY_CLI=<全局 diy>、DIY_ENV=production；
// 若透传，serve 会操作生产数据根、并让模型去敲另一个 checkout 的 CLI。
// 找不到仓库根（打包部署目录）就不动：宁可缺、由 prompt-registry 走「未注入」告警。
const repoRoot = findRepoRoot(__dirname);
if (repoRoot) {
  // 数据根：未设置、或指向生产根（且未 DIY_ALLOW_PROD_HOME=1）→ 落本 checkout 的 build/home
  const inheritedHome = process.env["DIY_HOME"];
  if (!prodHomeAllowed() && (inheritedHome === undefined || isProdDataHome(inheritedHome))) {
    if (inheritedHome !== undefined) {
      console.warn(`[serve] 警告: 忽略继承的生产数据目录 DIY_HOME=${inheritedHome}, 改用 ${path.join(repoRoot, "build", "home")}`);
    }
    process.env["DIY_HOME"] = path.join(repoRoot, "build", "home");
  }
  // 环境：开发入口不该是 production（那会关掉 dev 专属能力）
  if (process.env["DIY_ENV"] === "production") {
    console.warn("[serve] 警告: 忽略继承的 DIY_ENV=production, 改用 development");
    process.env["DIY_ENV"] = "development";
  }
  // 入口：与数据根匹配
  process.env["DIY_CLI"] = cliEntryForRepo(repoRoot, process.env["DIY_HOME"]!);
}

// 运行配置由入口注入的环境变量装配（DIY_HOME / DIY_PORT）
const cfg = readRuntimeConfig();
// serve 是纯 Node 常驻进程，同样要防 EPIPE / 未捕获异常裸奔；日志独立落 serve.log
installDiagnostics(cfg.home, "serve");
const ROOT = path.resolve(__dirname, "..", "..");
const STATIC_DIR = path.resolve(ROOT, "build", process.env["DIY_VARIANT"] ?? "prod", "renderer");

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

// 端口优先级: --port flag > DIY_PORT（入口注入） > 兜底 18888
let port = cfg.port ?? 18888;
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
if (portIdx >= 0) {
  const p = parseInt(args[portIdx + 1] ?? String(port), 10);
  if (Number.isFinite(p)) port = p;
}

async function main() {
  if (!fs.existsSync(STATIC_DIR)) {
    console.error(`[diy/serve] 静态文件目录不存在: ${STATIC_DIR}`);
    console.error(`  请先构建 renderer: ./sha.sh build-renderer`);
    process.exit(1);
  }

  const appConfig = AppConfig.fromRuntime(cfg);

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
    bindApi(new WsTransport(ws));
  });

  // ── 启动 ──
  httpServer.listen(port, "127.0.0.1", () => {
    const home = appConfig.diyHome;
    // 取实际绑定端口（--port 0 时由系统分配），getAppInfo 回报的必须是真值
    const bound = httpServer.address();
    const realPort = typeof bound === "object" && bound ? bound.port : port;
    setRpcPort(realPort);
    console.log("═══════════════════════════════════════");
    console.log("  diy 管控台 — Web 模式");
    console.log("═══════════════════════════════════════");
    console.log(`  地址:     http://127.0.0.1:${realPort}`);
    console.log(`  Tailscale: http://<tailscale-host>:${realPort}`);
    console.log(`  PID:      ${process.pid}`);
    console.log(`  DIY_HOME: ${home}`);
    console.log(`  DIY_CLI:  ${process.env["DIY_CLI"] ?? "(未注入 → 提示词会告警)"}`);
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
