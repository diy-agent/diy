#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Client, Server, createHandler, CliApp, createMemTransportPair } from "@diy/rpc";
import { connectHttp2Rpc } from "@diy/rpc-transport";
import { api } from "../main/services/api";

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

  let transport: Client;

  const port = readPort();
  if (port !== null) {
    try {
      const tx = await connectHttp2Rpc(port);
      transport = new Client(tx);
    } catch {
      transport = createLocalClient();
    }
  } else {
    transport = createLocalClient();
  }

  await new CliApp({
    name: "diy2",
    version: "0.1.0",
    description: "diy 管控台 CLI",
    router: api,
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
}

function createLocalClient(): Client {
  const { serverTx, clientTx } = createMemTransportPair();
  const server = new Server(serverTx);
  createHandler({ router: api, transport: server, ctx: {} });
  return new Client(clientTx);
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
