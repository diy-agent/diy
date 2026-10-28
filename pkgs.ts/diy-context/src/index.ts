// src/index.ts
// 🎯 包入口（barrel）：`import { ... } from "@diy/context"` 一次拿全。
// 只用一个模块时走子路径（`@diy/context/envelope`）—— 与 barrel 同一份代码，不另起真源。
export * from "./types";
export * from "./path";
export * from "./hash";
export * from "./wire";
export * from "./tree";
export * from "./wire-render";
export * from "./reducer";
export * from "./projection";
export * from "./delivery";
export * from "./envelope";
export * from "./schema/task-head";
export * from "./schema/schema-doc";
export * from "./schema/reqlog";
export * from "./schema/prompt-schema";
export * from "./format/invariant";
export * from "./format/cut-marker";
