# @diy-agent/rpc — RPC 协议内核

> 全仓契约见**仓库根 `AGENTS.md`**。npm 发布名 `@diy-agent/rpc`（发布流程见根 `tool.publish`）。

## find — 包内定位

- `find.entry` — `src/index.ts` 根入口（副作用加载 `core/_cli-meta` 的 zod 补丁，再全量 re-export `core`）；子路径入口见 `package.json` 的 `exports`：`./http` `./ws` `./electron` `./cli`
- `find.core` — `src/core/` 平台无关核：`rpc.ts`（声明式 RPC + `router()` / `createHandler()` / `createClient()`）· `meta.ts`（过程元数据 + zod 桥）· `server-binding.ts` / `channel-client-binding.ts` / `channel-server-binding.ts`（绑定层）· `typed-client.ts` · `mem.ts`（内存传输对）· `error.ts` · `types.ts`（`Envelope` 信封）
- `find.transport` — `src/transport/` 传输实现：`http/` · `ws/`（`ws` 包只在这里用到）· `electron/`
- `find.cli` — `src/cli/` CLI 桥：`_parser.ts` 在**调用方**进程读 stdin / `*-file` 选项（handler 跑在被调的 app 进程，fd 0 与 cwd 都不是调用方的）
- `find.publish` — 发布形态：`tsconfig.build.json`（NodeNext + emit 到 `dist/`）· 分发脚本 `../../scripts/npm-publish.mjs`

## rule — 硬约束

- `rule.esm-ext` — 源码内相对 import/export **必须带 `.js` 扩展名**（指向 `.ts`）：发布构建是 `module: NodeNext`，要求显式扩展名；vite/vitest 会把它映回 `.ts`
- `rule.browser` — `core/` 与 `./http`、`./electron` 子路径必须浏览器安全（跑 `./sha.sh check-browser` 验证，见 `tsconfig.browser.json`）；`ws` 只在 `./ws` 子路径用到，别把 Node 特有 API 带进 core
- `rule.publish` — 发布**只走** `./sha.sh publish`（= `tsc -p tsconfig.build.json` + `scripts/npm-publish.mjs`，后者在 `dist/` 生成发行版 package.json 再 `npm publish dist`）。仓内 `package.json` 的 `main`/`exports` 恒指 `src/*.ts` 且留 `private:true`（防手滑护栏）—— **发行 exports 由仓内 exports 推导**，新增子路径入口自动带上，别在脚本里另写一份清单
