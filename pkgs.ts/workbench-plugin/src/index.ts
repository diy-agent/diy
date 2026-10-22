/**
 * @diy-agent/workbench-plugin — 工作台插件的**契约包**
 *
 * 只放形状，不放实现：
 *   - ./manifest  插件清单（plugin.json）的 schema
 *   - ./panel     档 2 控制面板描述符的 schema
 *   - ./spec      插件服务端的方法契约 + definePlugin
 *
 * 宿主（diy-video/workbench）负责：扫描、加载、渲染、调用、信任模型。
 * 插件作者只需 import 这里的 schema/types，就能写出宿主认得的插件。
 */

export * from './manifest.js';
export * from './panel.js';
export * from './spec.js';
