// @diy-agent/ui-shadcn —— shadcn（base-nova 风格 / Base UI 原语）组件层的**唯一出口**。
//
// 为什么是一个独立包而不是各 UI 包自带一份（2026-11-23 用户裁）：
//   · 重复真的发生过 —— entity-chat 的 assistant-ui 分支曾自带 6 个同名组件（369 行），
//     与后来落盘的 22 个重叠 6 个；同一份 button.tsx 两处存放，改一处就漂一处。
//   · 消费者不止一家 —— entity-chat（对话/弹窗/表单）与 diy2 的工作台（菜单/tab/resizer）
//     都要用；若住在 entity-chat 里，工作台得为一个 Button 依赖「实体对话」包，方向反了。
//   · 加包成本≈0 —— ui 包都是 `main: src/index.ts` 源码直出，由 app 的 vite 编译。
//
// 源码来自 shadcn registry 的 `base-nova` 风格（见 components.json 与包内 README 的更新办法）。
// 纯展示：不碰 store / RPC / 业务词表，props 进 DOM 出。

export * from './lib/cn';

export * from './components/ui/alert';
export * from './components/ui/avatar';
export * from './components/ui/badge';
export * from './components/ui/bubble';
export * from './components/ui/button';
export * from './components/ui/card';
export * from './components/ui/checkbox';
export * from './components/ui/collapsible';
export * from './components/ui/dialog';
export * from './components/ui/dropdown-menu';
export * from './components/ui/input';
export * from './components/ui/input-group';
export * from './components/ui/label';
export * from './components/ui/message';
export * from './components/ui/message-scroller';
export * from './components/ui/popover';
export * from './components/ui/radio-group';
export * from './components/ui/scroll-area';
export * from './components/ui/select';
export * from './components/ui/separator';
export * from './components/ui/sheet';
export * from './components/ui/skeleton';
export * from './components/ui/switch';
export * from './components/ui/tabs';
export * from './components/ui/textarea';
export * from './components/ui/tooltip';
