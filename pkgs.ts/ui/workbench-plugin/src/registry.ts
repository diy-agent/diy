/**
 * registry.ts —— 插件注册表的**模型**：若干份清单 → 可查询的内存结构。
 *
 * 为什么不是数据库表：注册表回答的是「**这次运行**加载了什么」，随进程生灭；
 * 而 `entities` 里的身份行回答的是「**曾经**引用过什么」。两者生命周期不同，
 * 混在一起就会让「卸载插件」变成「删历史引用」。
 *
 * 纯函数、不碰 IO：宿主负责「从哪读清单」（`package.json` / 目录扫描 / 内置数组），
 * 这里只负责「读到的对不对」。任何冲突在**加载时**抛，不是运行时白屏。
 */

import { PLUGIN_API_VERSION, PluginManifestSchema, type EntityTypeDecl, type PluginManifest } from './manifest.js';

/** 注册表里的一条插件 */
export interface PluginRecord {
    /** = 包名（含可选 scope），也是实体类型的命名空间 */
    id: string;
    version: string;
    apiVersion: number;
    entityTypes: EntityTypeDecl[];
    /** 原始（已校验）清单：宿主自己解释 contributes */
    manifest: PluginManifest;
}

/** 注册表里的一条实体类型（全名已拼好） */
export interface EntityTypeRecord {
    /** `<包名>/<局部名>`：`@acme/github/issue`、`x/issue` */
    type: string;
    pluginId: string;
    local: string;
    schemaVersion: number;
}

export interface PluginRegistry {
    /** 按 id 排序的全部插件（稳定顺序：宿主渲染菜单时不会跳） */
    plugins(): readonly PluginRecord[];
    plugin(id: string): PluginRecord | undefined;
    /** 按全名排序的全部实体类型 */
    entityTypes(): readonly EntityTypeRecord[];
    entityType(type: string): EntityTypeRecord | undefined;
    /** 某个实体类型归哪个插件（核心类型返回 undefined） */
    pluginOfType(type: string): PluginRecord | undefined;
}

function nameOf(raw: unknown): string {
    if (typeof raw === 'object' && raw !== null && 'name' in raw) {
        const name = (raw as { name?: unknown }).name;
        if (typeof name === 'string' && name !== '') return name;
    }
    return '(未命名清单)';
}

/**
 * 从若干份清单建立注册表。
 *
 * @throws Error 清单不合法 / apiVersion 不支持 / 插件 id 重复 / 实体类型重复
 */
export function createPluginRegistry(manifests: readonly unknown[]): PluginRegistry {
    const plugins = new Map<string, PluginRecord>();
    const types = new Map<string, EntityTypeRecord>();

    for (const raw of manifests) {
        const parsed = PluginManifestSchema.safeParse(raw);
        if (!parsed.success) {
            const detail = parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('；');
            throw new Error(`插件清单不合法（${nameOf(raw)}）：${detail}`);
        }

        const manifest = parsed.data;
        const id = manifest.name;

        if (manifest.diy.apiVersion !== PLUGIN_API_VERSION) {
            throw new Error(
                `插件 ${id}: diy.apiVersion ${manifest.diy.apiVersion} 不受支持（本宿主只认 ${PLUGIN_API_VERSION}）`,
            );
        }
        if (plugins.has(id)) {
            throw new Error(`插件 id 重复：${id}（同一个包被加载了两次？）`);
        }

        plugins.set(id, {
            id,
            version: manifest.version,
            apiVersion: manifest.diy.apiVersion,
            entityTypes: manifest.diy.entityTypes,
            manifest,
        });

        for (const decl of manifest.diy.entityTypes) {
            const type = `${id}/${decl.name}`;
            if (types.has(type)) {
                throw new Error(`实体类型重复：${type}`);
            }
            types.set(type, {
                type,
                pluginId: id,
                local: decl.name,
                schemaVersion: decl.schemaVersion,
            });
        }
    }

    const pluginList = [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
    const typeList = [...types.values()].sort((a, b) => a.type.localeCompare(b.type));

    return {
        plugins: () => pluginList,
        plugin: (id) => plugins.get(id),
        entityTypes: () => typeList,
        entityType: (type) => types.get(type),
        pluginOfType: (type) => {
            const record = types.get(type);
            return record === undefined ? undefined : plugins.get(record.pluginId);
        },
    };
}
