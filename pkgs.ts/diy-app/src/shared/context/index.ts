// src/shared/context/index.ts
// 🎯 Context Tree 模块出口（144/148 垂直切片）。
//
// 用法（核心 API **不接收 Op**）：
//   const tree = createTree();
//   const r = applyFacts(tree, facts);          // facts 来自任意适配层
//   const { projection, cursor } = project(r.state, prevCursor);
//
// 旧事件流的接入在 legacy-adapter（108 后换成 EventRecord 适配器，其余不动）。

export * from "./types";
export * from "./path";
export * from "./hash";
export * from "./wire";
export * from "./tree";
export * from "./render";
export * from "./reducer";
export * from "./projection";
export * from "./legacy-adapter";
