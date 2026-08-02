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

## 开发模式快捷键

- F12 — 切换 DevTools
- Cmd+R — 刷新窗口
