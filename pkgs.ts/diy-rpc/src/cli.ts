// cli.ts — CLI 子入口（Node-only，不进浏览器编译）
// 从 @diy/rpc/cli 导入；主入口 @diy/rpc 不导出这些符号，浏览器安全

import './rpc/cli-rpc/meta'; // 复用 meta 副作用 import
export { CliApp, createCli } from './rpc/cli-rpc/index';
export type { CliConfig, CliOptionMeta, CliArgMeta } from './rpc/cli-rpc/index';