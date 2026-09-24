// src/shared/context/wire.ts
// 🎯 模型 wire 的**编码语义**与版本（144：wire 版本由编码语义派生，不手工维护）。
//
// 为什么版本要从语义 hash 出来：手工改版本号必然忘记改（或改了没改语义）。这里
// WIRE_ENCODING 是「wire 长什么样」的唯一描述，改动它 → WIRE_VERSION 自动变 → 旧 runtime
// patch 与新编码不可比 → 触发 rebaseline（144 用例 18）。

import { canonical, sha256Hex } from "./hash";

/** wire 编码语义（**改这里就等于换 wire 版本**，投影侧会自动要求 rebaseline） */
export const WIRE_ENCODING = {
    /** 语义版本：结构性变更时手工 +1（与 hash 双保险，便于人读日志） */
    rev: 1,
    /** system 容器：每次请求全量文本 */
    system: "full-text",
    /** runtime 容器：路径级增量 patch + 必要时全量 snapshot */
    runtime: "path-patch",
    /** 渲染单元包裹格式 */
    unit: '<context path="{path}">\\n{content}\\n</context>',
    /** 单元分隔 */
    separator: "\\n\\n",
    /** hash 口径 */
    hash: "sha256(canonical-json)",
} as const;

/** 由编码语义派生的 wire 版本（8 位 hex，够人读也够区分） */
export const WIRE_VERSION: string = sha256Hex(canonical(WIRE_ENCODING)).slice(0, 8);
