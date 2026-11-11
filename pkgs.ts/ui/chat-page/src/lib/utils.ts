// utils.ts —— shadcn CLI 的 `aliases.utils` 落点（它按社区标准形状认 `@/lib/utils`）。
//
// 真正的实现只有一个：`src/ui/cn.ts`（clsx + tailwind-merge）。这里只做重导出，
// 不复制实现 —— 免得两处 `cn` 行为漂移。
//
// 注意：本仓 tsconfig 是 NodeNext，相对 import 必须带 `.js` 后缀。

export { cn } from '../ui/cn.js';
