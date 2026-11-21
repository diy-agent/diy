/**
 * manifest.ts —— 插件清单的**契约**：`package.json` + `diy` 段。
 *
 * 身份只有一个：**包名**（`name`）。旧形状（独立 `plugin.json` + 短 `id` + 顶层 `apiVersion`）
 * 已废弃 —— 它装不下 `@scope/name`，而且让「插件是谁」有两个来源。
 *
 * 三段分工：
 *   name / version   npm 的事实（分发与身份）
 *   diy              **宿主关心的事实**：apiVersion / entityTypes / engines
 *   contributes      **宿主自解释**的贡献点（页面、视图、菜单…）：注册表只透传，不校验形状
 *
 * 清单是纯数据：宿主不执行清单里的任何东西（要跑代码 → 另给 server 模块，见 spec.ts）。
 */

import { z } from 'zod';

/** 当前清单 API 版本：宿主不支持就整份拒绝（不静默降级） */
export const PLUGIN_API_VERSION = 1;

/**
 * 实体类型的**局部名**：不带 `.` `/` `@`。
 * 全名由宿主拼成 `<包名>/<局部名>`（`@acme/github/issue`、`x/issue`），所以这里只写 `issue`。
 */
export const EntityTypeDeclSchema = z.object({
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/, '实体类型名只能小写字母开头，含字母/数字/下划线/连字符'),
    /** 该类型的字段形状版本（插件自己的迁移用；与清单 apiVersion 无关） */
    schemaVersion: z.number().int().positive().default(1),
    description: z.string().optional(),
});

/** `diy` 段：宿主启动时真正要读的事实 */
export const PluginDiySchema = z.object({
    apiVersion: z.number().int().default(PLUGIN_API_VERSION),
    /** 本插件贡献的实体类型（局部名）；不贡献实体的插件留空 */
    entityTypes: z.array(EntityTypeDeclSchema).default([]),
    engines: z.object({ workbench: z.string().optional() }).default({}),
});

export const PluginManifestSchema = z.object({
    /** npm 包名（含可选 scope）= 插件身份；发布后不改 */
    name: z.string().min(1, '插件身份 = 包名，不能为空'),
    version: z.string().default('0.0.0'),
    diy: PluginDiySchema.default({ apiVersion: PLUGIN_API_VERSION, entityTypes: [], engines: {} }),
    /**
     * 宿主自解释的贡献点。注册表**只透传**（`z.unknown()`），
     * 具体形状由宿主定义（dock 用 pages/views；iframe 宿主可用下面的 PluginViewSchema）。
     */
    contributes: z.unknown().optional(),
});

export type PluginManifest = z.output<typeof PluginManifestSchema>;
export type EntityTypeDecl = z.output<typeof EntityTypeDeclSchema>;

// ── 宿主可选的 contributes 形状（不是契约的一部分）────────────────────
//
// 保留给「iframe / builtin 视图」这种宿主：想用就自己拿它校验 contributes.views，
// 注册表不解析、也不要求任何插件采用。

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

export type PluginManifestView = z.output<typeof PluginViewSchema>;
