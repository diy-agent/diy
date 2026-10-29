#!/usr/bin/env node
// src/cli/index.ts — diy-dev CLI 入口
//
// 机制：本地进程内 RPC（mem transport + ChannelServerBinding）——handler 与 CLI 同进程，
// 零网络零 Electron。仅进程内信封协议保证 CliApp 复用与 diy-app 相同的命令解析
// （zod schema + cliArg/cliOption → help/usage/did-you-mean）。
//
// 职责:
//   1. readRuntimeConfig(): 读 DIY_HOME（镜像根 $DIY_HOME/ref）
//   2. bindRefHandlers(): 把 ref 各命令实现注册到本地 ServerBinding
//   3. CliApp.parse(): 解析 argv 并调用对应 handler
//

import { CliApp } from "@diy/rpc/cli";
import { ChannelClientBinding, ChannelServerBinding, createMemTransportPair } from "@diy/rpc";
import { readRuntimeConfig } from "../runtime";
import { refApi } from "../ref/api";
import { bindRefHandlers } from "../ref/impl";

async function main(): Promise<void> {
    const cfg = readRuntimeConfig();
    const argv = process.argv.slice(2);

    // 本地进程内 RPC：server 侧注册 handler，client 侧给 CliApp
    const { serverTx, clientTx } = createMemTransportPair();
    const binding = new ChannelServerBinding(serverTx);
    bindRefHandlers(binding, { home: cfg.home, cwd: process.cwd() });
    const transport = new ChannelClientBinding(clientTx);

    await new CliApp({
        name: "dev",
        version: "0.1.0",
        router: refApi,
        transport,
    }).parse(argv);
}

main().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`致命错误: ${msg}`);
    process.exit(1);
});
