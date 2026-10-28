// src/shared/context/index.ts
// 🎯 Context Tree 模块出口（144/148 垂直切片）。
//
// 用法（核心 API **不接收 Op**）：
//   const tree = createTree();
//   const r = applyFacts(tree, facts);          // facts 来自任意适配层
//   const { projection, cursor } = project(r.state, prevCursor);
//
// 树 / 投影 / 投递 / 信封已独立成 `@diy/context`（##447）；本目录只剩观测、流量、请求视图与配置。

export * from "@diy/context/types";
export * from "@diy/context/path";
export * from "@diy/context/hash";
export * from "@diy/context/wire";
export * from "@diy/context/tree";
export * from "@diy/context/wire-render";
export * from "@diy/context/reducer";
export * from "@diy/context/projection";
export * from "./request";
export * from "@diy/context/delivery";
export * from "./steps";
export * from "./match";
export * from "./config";
export * from "./stats";
export * from "@diy/context/envelope";
export * from "@diy/context/schema/reqlog";
export * from "./request-preflight";
