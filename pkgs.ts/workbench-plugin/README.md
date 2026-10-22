# @diy-agent/workbench-plugin

工作台插件的**契约包**：只放形状，不放实现。

```
./manifest  插件清单（plugin.json）的 schema
./panel     档 2 控制面板描述符的 schema
./spec      插件服务端的方法契约 + definePlugin
```

宿主（[diy-video/workbench](https://github.com/diy-agent/diy-video)）负责扫描、加载、
渲染、调用与信任模型；插件作者 import 这里的 schema/types，就能写出宿主认得的插件。

## 清单（plugin.json）

```json
{
    "id": "film",
    "name": "Film 生成器",
    "version": "0.1.0",
    "apiVersion": 1,
    "engines": { "workbench": ">=0.1.0" },
    "contributes": {
        "views": [
            {
                "id": "live",
                "title": "场景台 · 实时",
                "group": "影片",
                "kind": "iframe",
                "url": "/film/live.html",
                "route": "film-live",
                "panel": { "method": "panel.stage" }
            }
        ]
    }
}
```

- 清单是**纯数据**：只贡献视图，宿主不执行清单里的任何东西。
- `apiVersion` 不被宿主支持 → 整份拒绝（不静默降级）。
- 路由缺省 `<plugin>-<view id>`；与内置页/别的插件冲突时由宿主报告。

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
