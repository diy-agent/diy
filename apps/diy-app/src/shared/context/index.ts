// src/shared/context/index.ts
// 🎯 Context Tree 模块出口（144/148 垂直切片）。
//
// 用法（核心 API **不接收 Op**）：
//   const tree = createTree();
//   const r = applyFacts(tree, facts);          // facts 来自任意适配层
//   const { projection, cursor } = project(r.state, prevCursor);
//
// 树 / 投影 / 投递 / 信封已独立成 `@diy-agent/context`（##447）；本目录只剩观测、流量、请求视图与配置。

export * from "@diy-agent/context/types";
export * from "@diy-agent/context/path";
export * from "@diy-agent/context/hash";
export * from "@diy-agent/context/wire";
export * from "@diy-agent/context/tree";
export * from "@diy-agent/context/wire-render";
export * from "@diy-agent/context/reducer";
export * from "@diy-agent/context/projection";
export * from "./request";
export * from "@diy-agent/context/delivery";
export * from "./steps";
export * from "./match";
export * from "./config";
export * from "./stats";
export * from "@diy-agent/context/envelope";
export * from "@diy-agent/context/schema/reqlog";
export * from "./request-preflight";
