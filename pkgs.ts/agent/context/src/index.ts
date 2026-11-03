// src/index.ts
// 🎯 包入口（barrel）：`import { ... } from "@diy-agent/context"` 一次拿全。
// 只用一个模块时走子路径（`@diy-agent/context/envelope`）—— 与 barrel 同一份代码，不另起真源。
export * from "./types.js";
export * from "./path.js";
export * from "./hash.js";
export * from "./wire.js";
export * from "./tree.js";
export * from "./wire-render.js";
export * from "./reducer.js";
export * from "./projection.js";
export * from "./delivery.js";
export * from "./envelope.js";
export * from "./schema/task-head.js";
export * from "./schema/schema-doc.js";
export * from "./schema/reqlog.js";
export * from "./schema/prompt-schema.js";
export * from "./format/invariant.js";
export * from "./format/cut-marker.js";
