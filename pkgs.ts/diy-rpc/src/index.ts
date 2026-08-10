// src/index.ts — @diy/rpc 根入口：加载 zod 扩展副作用 + 全量 re-export 平台无关核
// 浏览器安全（core 纯 TS + zod，无 node/electron 依赖）。具体绑定见子路径
// @diy/rpc/http、@diy/rpc/ws、@diy/rpc/electron、@diy/rpc/cli。
import './core/_cli-meta';
export * from './core';
