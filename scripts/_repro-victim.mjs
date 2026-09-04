// scripts/_repro-victim.mjs
// 复现用「受害者」Electron 主进程 —— 不依赖构建产物，纯粹暴露机制。
//
// 三个观测面：
//   1. HTTP 探针（/ping）    —— 事件循环活着才有响应
//   2. 文件心跳（HB 每 100ms 追加一行）—— 事件循环被阻塞则停摆，可无屏幕量化
//   3. 持续写 stderr         —— 编排脚本关掉管道读端后，下一次写即抛 EPIPE
//
// 环境变量：
//   PROBE_PORT / HB=<心跳文件> / GUARD=1 / LOG=<异常落盘路径>

import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.PROBE_PORT);
const HB = process.env.HB || "";
const GUARD = process.env.GUARD === "1";
const LOG = process.env.LOG || "";

if (GUARD) {
  // ① 管道断线不再升级成未捕获异常
  process.stdout?.on("error", () => {});
  process.stderr?.on("error", () => {});
  // ② 自己接管异常。注意 Electron 默认处理器的守卫是
  //    process.listenerCount("uncaughtException") > 1 —— 注册即抑制官方弹框。
  process.on("uncaughtException", (err) => {
    try {
      appendFileSync(LOG, `[GUARD-HANDLED] code=${err?.code ?? "?"} ${err?.message}\n`, "utf-8");
    } catch {
      /* 日志失败不能拖垮流程 */
    }
  });
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ alive: true, at: Date.now() }));
});

/** 心跳：同步追加，事件循环一旦阻塞就停摆 */
function beat(tag = "") {
  if (!HB) return;
  try {
    appendFileSync(HB, `${Date.now()}${tag ? " " + tag : ""}\n`, "utf-8");
  } catch {
    /* ignore */
  }
}

app.whenReady().then(() => {
  server.listen(PORT, "127.0.0.1");
  beat("ready");

  setInterval(() => beat(), 100);
  // 持续写 stderr：读端被关掉后，紧接着的某一次写就会抛 EPIPE
  if (process.env.STDERR_WRITE !== "0") {
    setInterval(() => console.error("[victim] heartbeat to stderr"), 200);
  }

  // 场景 C：不依赖 EPIPE，直接抛一个普通未捕获异常 —— 单独验证第②层防护
  if (process.env.THROW === "1") {
    setTimeout(() => {
      throw new Error("PLAIN-THROW-5678 普通未捕获异常");
    }, 2500);
  }

  new BrowserWindow({ width: 240, height: 120, show: false });
});

app.on("window-all-closed", () => {
  /* 不退出，模拟常驻 */
});
