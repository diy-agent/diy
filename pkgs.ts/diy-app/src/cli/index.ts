#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { RawClient, RpcServer, createMemTransportPair } from "@diy/rpc";
import { CliApp } from "@diy/rpc/cli";
import { connectHttp2Rpc } from "@diy/rpc-transport";
import { apiDef } from "../main/services/api-def";
import { bindApi } from "../main/services/api-impl";

const isProduction = fileURLToPath(import.meta.url).includes("/out/cli/");

function resolveHome(): string {
  const envHome = process.env["DIY_HOME"];
  if (envHome) return envHome;
  if (process.argv.includes("--temp")) {
    return join(tmpdir(), "diy-dev", "diy_home");
  }
  return join(homedir(), ".diy");
}

function readPort(): number | null {
  const portPath = join(resolveHome(), "app.port");
  if (!existsSync(portPath)) return null;
  try {
    const port = parseInt(readFileSync(portPath, "utf-8").trim(), 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);

  let transport: RawClient;
  let http2Tx: { close(): void } | null = null;

  const port = readPort();
  if (port !== null) {
    try {
      const tx = await connectHttp2Rpc(port);
      http2Tx = tx;
      transport = new RawClient(tx);
    } catch {
      transport = createLocalClient();
    }
  } else {
    transport = createLocalClient();
  }

  await new CliApp({
    name: "diy-app",
    version: "0.1.0",
    description: "diy 管控台 CLI",
    router: apiDef,
    transport,
    groups: {
      task: "任务管理",
      subject: "Subject 管理",
      ui: "GUI 控制",
      agent: "Agent 对话",
      llmProxy: "LLM 代理",
      ref: "源码镜像",
      log: "日志",
    },
  }).parse(argv);

  // 清理：关闭 RPC 连接，允许进程正常退出
  transport.dispose();
  http2Tx?.close();
  process.exit(0);
}

function createLocalClient(): RawClient {
  const { serverTx, clientTx } = createMemTransportPair();
  bindApi(serverTx);
  return new RawClient(clientTx);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (isProduction) {
    console.error(msg);
  } else {
    console.error(`致命错误: ${msg}`);
    if (e instanceof Error && e.stack) {
      console.error(e.stack.split("\n").slice(1, 4).join("\n"));
    }
  }
  process.exit(1);
});
