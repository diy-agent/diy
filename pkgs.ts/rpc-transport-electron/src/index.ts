/**
 * @diy/rpc-transport-electron — Electron Transport 实现
 *
 * 提供 createMainTransport / createRendererTransport 两个工厂函数，
 * 分别用于 Electron 主进程和 preload/renderer 进程。
 *
 * 依赖：@diy/rpc（Transport 类型）+ electron
 */

export { createMainTransport, createRendererTransport } from './electron/index';
