# @diy-agent/workbench-plugin

插件的**契约与注册表模型**：形状 + 纯函数，不碰宿主、不碰 IO。

```
./manifest  清单（package.json + diy 段）的 schema
./registry  若干份清单 → 内存注册表（插件 / 实体类型查询）
./panel     档 2 控制面板描述符的 schema
./spec      插件服务端的方法契约 + definePlugin
```

宿主负责：**从哪读清单**、渲染、调用、信任模型、插件数据目录。
插件作者 import 这里的 schema/types，就能写出宿主认得的插件。

## 清单：`package.json` + `diy` 段

**身份 = 包名**（`name`）。旧形状（独立 `plugin.json` + 短 `id` + 顶层 `apiVersion`）
已废弃 —— 它装不下 `@scope/name`，而且让「插件是谁」有两个来源。

```json
{
    "name": "@acme/github",
    "version": "1.0.0",
    "diy": {
        "apiVersion": 1,
        "entityTypes": [{ "name": "issue", "schemaVersion": 1 }],
        "engines": { "workbench": ">=0.1.0" }
    },
    "contributes": {
        "views": [{ "id": "issues", "title": "议题", "kind": "iframe", "url": "/github/issues.html" }]
    }
}
```

三段分工：

| 段 | 谁定义 | 注册表 |
| --- | --- | --- |
| `name` / `version` | npm（分发与身份） | 读 |
| `diy` | 本契约（apiVersion / entityTypes / engines） | **校验** |
| `contributes` | 宿主自解释（页面、视图、菜单…） | **只透传** |

- `diy.apiVersion` 不被宿主支持 → 整份拒绝（不静默降级）。
- `entityTypes[].name` 是**局部名**（`^[a-z][a-z0-9_-]*$`），全名由宿主拼成
  `<包名>/<局部名>`：`@acme/github/issue`、`x/issue`。
- 想用 iframe/builtin 视图形状的宿主可以拿 `PluginViewSchema` 校验 `contributes.views`；
  注册表不解析它。

## 注册表（`./registry`）

```ts
import { createPluginRegistry } from '@diy-agent/workbench-plugin/registry';

const registry = createPluginRegistry([pkg1, pkg2]); // 解析后的 package.json 对象
registry.plugins();                 // 按 id 排序
registry.plugin('@acme/github');
registry.entityTypes();             // 全名已拼好，按 type 排序
registry.entityType('@acme/github/issue');
registry.pluginOfType('@acme/github/issue');  // core 类型返回 undefined
```

**不是数据库表**：注册表回答「这次运行加载了什么」，随进程生灭；`entities` 里的身份行
回答「曾经引用过什么」。加载冲突（插件 id 重复、同一插件内实体类型重复、apiVersion 不支持）
在**加载时**抛，不是运行时白屏。

## 服务端（server.ts）

```ts
import { definePlugin, type PanelDescriptor } from '@diy-agent/workbench-plugin';

export default definePlugin({
    id: 'film',
    name: 'Film 生成器',
    version: '0.1.0',
    rpc: {
        export: {
            desc: '导出一条成片（流式）',
            input: z.object({ dataRoot: z.string().optional() }),
            output: ExportChunk,
            stream: (input, ctx) => runExport(input, ctx.signal),
        },
        'panel.stage': {
            desc: '档 2 面板描述符',
            input: z.object({}),
            output: PanelDescriptorSchema,
            handler: async () => panel(),
        },
    },
});
```

宿主在调用前后都按这里的 schema 校验。

## 档 2 面板

面板是**声明式数据**（`PanelDescriptor`）：宿主渲染块、把动作回调插件方法或宿主核心能力。
块类型：`info` / `text` / `button` / `select` / `progress` / `log`；
动作作用域：`plugin`（本插件方法）/ `core`（宿主白名单能力）。

## 信任模型

清单默认不执行代码；服务端模块只被**宿主信任来源**加载（仓库内插件），
用户目录里的插件默认只有清单贡献。进程外插件将来产出同样的形状即可。
