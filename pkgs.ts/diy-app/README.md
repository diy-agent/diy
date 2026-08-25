# diy-app

Vite 8 + Electron + shadcn/ui 桌面应用模板。

## 技术栈

- Vite 8 (Rolldown) — 三配置架构：ESM main / CJS preload / 浏览器 renderer
- Electron 33 — contextIsolation + contextBridge
- React 19 + shadcn/ui (base-ui) + Tailwind CSS 4

## 使用

```bash
npm install
npm run dev      # 开发模式（renderer dev server + watch main/preload + electron）
npm run build    # 生产构建
npm start        # 运行生产构建
npm run clean    # 清理 out/
```

## CLI 入口

两个入口只注入环境变量，业务侧由 `src/runtime.ts readRuntimeConfig()` 统一读取（详见 `AGENTS.md` 环境变量契约）：

```bash
./diy.sh task list                    # worktree 开发（tsx 跑源码，数据根 ./build/home）
bin/diy task list                     # 发布后（node 跑 out/cli/index.js，数据根 ~/.diy）
```

发布前先 `npm run build:cli` 生成 `out/cli/index.js`（生成 `bin/diy` 处自动 symlink 到 PATH 即可）。

## 开发模式快捷键

- F12 — 切换 DevTools
- Cmd+R — 刷新窗口
