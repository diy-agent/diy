# diy2 接 dockview + UI 框架评估（Astryx vs shadcn）

> 2026-11-13 · 基于 `exp/diy2-entity-chat` 当前代码
> 结论先行：**dockview 接在 main 区，用 `dockview-react`；UI 框架继续 shadcn/Base UI + M3 令牌，
> Astryx 保留为聊天 surface，不建议升级为全局 UI 框架。**

---

## 1. 现状（读代码得到的事实）

```
apps/diy2
  └ EntityChatApp（@diy-agent/entity-chat）
       ├ Sidebar（256/56px 折叠）
       └ main
           ├ RoomHeader（room 名 / 目录 / 模型 / 成员）
           ├ SurfaceTabs（assistant-ui / Astryx）
           └ SurfaceView
```

- 布局是普通 flex，没有分屏/标签；同一时刻只能看一个 room。
- 状态分两层：
  - `store.tsx`：room 列表 / 选中 / 模型（`useSyncExternalStore`）；
  - `conversations: Map<roomId, ConversationStore>`：**模块级缓存**，面板卸载不会丢会话。
- 两个 surface：`components/ChatPanel.tsx`（assistant-ui，53 行适配）与
  `surfaces/astryx/Surface.tsx`（175 行），都只依赖 chat-core 的 model。
- 样式：
  - 壳：Tailwind v4 + shadcn/Base UI，`@diy-agent/ui-design` 的 M3 令牌通过 `@theme inline` 映射；
  - Astryx：`astryx.css` + `theme-neutral`，surface 根节点加 `data-astryx-theme="neutral"` 做隔离。
- 构建实测（`vite build`）：JS **427 KB gzip**，CSS **59 KB gzip**（已经同时包含两套 UI）。

> 关键：**ConversationStore 已经是 room 级缓存**。这点对接 dockview 非常有利 —— 面板反复
> mount/unmount 不会重建会话，只需要重新订阅。

---

## 2. dockview 集成方案

### 2.1 第一步：只替换 main 区（推荐）

```
App
├ Sidebar（保持不动）
└ Workbench（DockviewReact）
    ├ 每个 room = 一个 panel（tab）
    ├ 每个 panel 内部：RoomHeader + SurfaceTabs + SurfaceView
    └ 可选：右/下 group 放模型信息、日志
```

- 选 room：sidebar 里 select 后 → `openRoom(roomId)`：
  - 已有 panel 就 `api.getPanel('room:'+id)?.api.setActive()`；
  - 没有就 `addPanel({ id: 'room:'+id, component: 'room', title: room.name, params: { roomId } })`。
- 关 panel ≠ 删 room；sidebar 的删除/归档逻辑保持独立。
- 同屏可开多个 room（对比两个任务的对话、拖成左右分屏）。

这一步就拿到 dockview 90% 的价值，改动面积小。

### 2.2 第二步：把侧栏/底部也纳入工作台

- 左侧 group：room 列表（等价现在 Sidebar）；
- 底部 group：运行日志 / 事件流 / 终端；
- 右侧 group：room 元信息、模型、成员。
- 侧栏是否放进 dockview 取决于是否要「拖动/折叠/隐藏」；不建议第一步就做，容易把简单问题复杂化。

### 2.3 Page（Eclipse 风格）

dockview 没有 page。按已验证的多实例方案：

- **Page = 一个 DockviewReact 实例 + 一个 `.page` 容器**；
- 切 Page = `display:none/''`，显示后 `dockview.layout(w,h)` 一次；
- 每个 Page 自己的一组打开 room、布局、活动 panel；
- 持久化：`{ pages: [{id,title,layout}], activePageId }`。
- 恢复时校验 `layout` 里的 panel id：room 已被删除就丢掉该 panel（见 2.4）。

Page 的语义可以定义成「工作区」：比如「项目 A」「项目 B」「临时对比」。

### 2.4 具体接入点（代码级）

1. **依赖**：`dockview-react@8.9.0`（不是 `dockview-core`）。
   - React 应用必须用 React 包，否则 panel 内容走 `createRoot` 会丢掉 `useStore` /
     `MentionBotsProvider` 的 context；
   - 8.x 的 npm 包漏发 CSS（`dist/styles/dockview.css` 不在 `files` 里）——要么用我们
     `ui-dockview-lab` 里从源码编的 CSS，要么 pin 6.6.1。
2. **面板组件**：
   ```tsx
   function RoomPanel({ api, params }: IDockviewPanelProps<{ roomId: string }>) {
     const room = roomOf(params.roomId);
     if (!room) return <Empty text="room 已被删除" />;
     return (
       <div className="flex h-full flex-col">
         <RoomHeader room={room} onAddMember={...} onPickModel={...} />
         <SurfaceTabs ... />
         <SurfaceView ... />
       </div>
     );
   }
   ```
   `RoomHeader` / `SurfaceTabs` 从 `App.tsx` 抽出来，App 只保留 Sidebar + Workbench。
3. **选中联动**：
   - sidebar → `openRoom`；
   - `api.onDidActivePanelChange` → `actions.select(roomId)`（用一个 ref 防循环）。
4. **标题/状态**：
   - 自定义 tab renderer：room 名 + primary bot 颜色点 + running 指示；
   - 关面板时如果 `state.running`，给确认或保留后台运行（会话本来就在 model 层跑）。
5. **持久化**：
   ```ts
   localStorage['diy2:pages'] = JSON.stringify({ pages, activePageId });
   ```
   恢复后遍历 `layout.panels`，只重建仍存在的 room；不存在的 panel 跳过。
6. **主题**：
   - 自定义 `DockviewTheme { className: 'dockview-theme-diy2' }`；
   - 把 `--dv-*` 映射到现有 M3/shadcn 变量（`--background` / `--border` / `--accent`…），
     **不要**同时套 dockview 内置 abyss/dark；
   - Astryx 只在自己的 surface 里用 `data-astryx-theme` 作用域，不参与 dockview 外壳。

### 2.5 工作量

| 步骤 | 估计 |
|---|---|
| 抽 `RoomHeader` / `SurfaceTabs` + `Workbench` + tab renderer | 0.5–1 天 |
| room↔panel 同步、关闭策略、布局持久化 | 0.5–1 天 |
| Page（多实例）+ 恢复校验 | 0.5 天 |
| 主题映射 + 细节（拖拽、tab 溢出、快捷键） | 0.5–1 天 |

---

## 3. Astryx + dockview vs shadcn + dockview

### 3.1 现状不是二选一

本分支已经是「shadcn 壳 + Astryx surface」并存：Astryx 通过 `data-astryx-theme` 限定在聊天面板内，
没有污染外壳。这个事实很重要：**评估的是「谁当全局 UI 框架」，不是「谁能在项目里存在」**。

### 3.2 对比

| 维度 | shadcn/Base UI + M3 | Astryx |
|---|---|---|
| 视觉真源 | 已有 M3 令牌（`@diy-agent/ui-design`）+ Tailwind `@theme` 映射 | 自带 theme（neutral 等）+ StyleX 令牌；要全局用就得替换 M3 |
| 组件覆盖 | atoms + 生态；表格/虚拟滚动仍需 TanStack | 150+，含 Chat / Tree / Table / CommandPalette / AppShell |
| 与 dockview 的关系 | 只提供 atoms，不和布局抢职责 | 自带 AppShell / SideNav / TopNav，和 dockview 的 shell 职责重叠 |
| 构建 | Tailwind v4，无额外插件 | 消费预构建 CSS 不需要插件；但 CSS 体积大，StyleX 生态较新 |
| 密度/工作台观感 | Tailwind 任意控制，适合密集 IDE | 设计系统意见强，density 有档位但定制要跟它的 token 走 |
| LLM/单人可维护 | 语料最多、写法最统一 | 0.7.15 beta，训练语料少；CLI 文档能补一部分 |
| 风险 | 源码分发、无锁定；Base UI/Radix 社区标准 | beta + 单一厂商 + StyleX 长期不确定 |
| 现有投入 | 已生成 M3 令牌、shadcn 壳、设计文档 | 仅一个 surface（175 行） |

> 参考：`docs/plans/2026-11-10-ui-framework-eval.md` 的结论也是
> 「Radix/Base UI + Tailwind + M3 令牌 + Dockview POC」。

### 3.3 打分（针对「整体 UI 框架」，权重按本项目）

| 维度 | 权重 | shadcn | Astryx |
|---|---|---|---|
| 与现有 M3 视觉一致 | 25% | 5 | 2 |
| 组件/生态 | 20% | 4 | 4.5 |
| LLM/单人可维护 | 20% | 5 | 3 |
| 构建/包体 | 15% | 4.5 | 3 |
| 与 dockview 的职责边界 | 10% | 5 | 3 |
| 长期风险 | 10% | 4.5 | 3 |
| **加权** | | **4.68** | **3.05** |

### 3.4 结论

1. **全局 UI 框架：shadcn/Base UI + M3 + Tailwind。** dockview 只做布局，视觉由 M3 令牌统管。
2. **Astryx 保留为 surface / 设计参考**：它的 Chat 组件族确实好用（175 行就能对齐 assistant-ui
   的功能），但把它升级成全局框架的代价是重做令牌体系 + 接受 beta/StyleX 风险，收益不匹配。
3. 如果未来决定整体换成 Astryx 的设计语言（而不是 M3），再考虑让 Astryx 接管外壳；
   那时 dockview 的 `--dv-*` 映射目标从 M3 换成 Astryx 令牌，工作量就是一份 CSS 映射。

### 3.5 一句话

**dockview 和 UI 框架正交**：dockview 管布局，M3/shadcn 管外观，Astryx 管聊天 surface。
当前这套组合（shadcn 壳 + M3 + dockview + Astryx surface）比「Astryx 全局 + dockview」更稳、
更省、风险更低。
