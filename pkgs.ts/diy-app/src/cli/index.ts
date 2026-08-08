#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { ChannelRawClient, createMemTransportPair, type RawClient } from "@diy/rpc";
import { HttpRawClient } from "@diy/rpc/http";
import { CliApp } from "@diy/rpc/cli";
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

  const port = readPort();
  if (port !== null) {
    const remote = new HttpRawClient(`http://127.0.0.1:${port}`);
    try {
      await remote.ready(); // 探测端口可达性，失败回退本地
      transport = remote;
    } catch {
      remote.dispose();
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
    cliRootPath: ["diy.app", "!diy.ui"], // diy.app 摊平（task list）；diy.ui 保留命名空间（ui status）
    groups: {
      task: "任务",
      subject: "主题",
      agent: "Agent",
      llmProxy: "LLM 代理",
      ref: "镜像引用",
      ui: "界面",
    },
  }).parse(argv);

  // 清理：关闭 RPC 连接，允许进程正常退出
  transport.dispose();
  process.exit(0);
}

function createLocalClient(): ChannelRawClient {
  const { serverTx, clientTx } = createMemTransportPair();
  bindApi(serverTx);
  return new ChannelRawClient(clientTx);
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
