/**
 * @diy-agent/workbench-plugin — 插件契约 + 注册表模型
 *
 * 形状与模型，不碰宿主：
 *   - ./manifest  清单（`package.json` + `diy` 段）的 schema
 *   - ./registry  若干份清单 → 内存注册表（插件 / 实体类型查询，纯函数）
 *   - ./panel     档 2 控制面板描述符的 schema
 *   - ./spec      插件服务端的方法契约 + definePlugin
 *
 * 宿主负责：从哪读清单、渲染、调用、信任模型、插件数据目录。
 * 注册表**不是数据库表**：它只描述「这次运行加载了什么」。
 */

export * from './manifest.js';
export * from './registry.js';
export * from './panel.js';
export * from './spec.js';
