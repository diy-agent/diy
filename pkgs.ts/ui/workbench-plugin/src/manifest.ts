/**
 * manifest.ts — 插件清单（plugin.json）的**契约**
 *
 * 清单是纯数据：插件用它声明「我贡献哪些视图」，宿主据此生成导航与主区。
 * 宿主不执行清单里的任何东西（要跑代码 → 另给 server 模块，见 spec.ts）。
 *
 * 宿主实现参考：diy-video/workbench/server/plugins.ts
 */

import { z } from 'zod';

/** 当前清单 API 版本：宿主不支持就整份拒绝加载（不静默降级） */
export const PLUGIN_API_VERSION = 1;

/** 视图贡献：iframe（同源路径）或 builtin（复用宿主页面） */
export const PluginViewSchema = z.object({
    /** 插件内唯一 */
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'view id 只能小写字母/数字/-/._'),
    title: z.string().min(1),
    /** 侧栏分组名；缺省 = 插件名 */
    group: z.string().optional(),
    kind: z.enum(['iframe', 'builtin']).default('iframe'),
    /** iframe：同源绝对路径（如 /film/live.html） */
    url: z.string().optional(),
    /** builtin：宿主页面注册名 */
    page: z.string().optional(),
    /** hash 路由段；缺省 `<plugin>-<view id>`。不许含 "/" */
    route: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .optional(),
    /** 档 2 控制面板：宿主 invoke 这个插件方法拿描述符，渲染在视图旁边 */
    panel: z.object({ method: z.string().min(1) }).optional(),
    description: z.string().optional(),
});

export const PluginManifestSchema = z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, '插件 id 只能小写字母/数字/-，且字母开头'),
    name: z.string().min(1),
    version: z.string().default('0.0.0'),
    apiVersion: z.number().int().default(PLUGIN_API_VERSION),
    engines: z.object({ workbench: z.string().optional() }).default({}),
    description: z.string().optional(),
    contributes: z.object({ views: z.array(PluginViewSchema).default([]) }).default({ views: [] }),
});

export type PluginManifest = z.output<typeof PluginManifestSchema>;
export type PluginManifestView = z.output<typeof PluginViewSchema>;
