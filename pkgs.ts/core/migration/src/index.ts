// index.ts —— @diy-agent/migration 的公开出口
//
// 这个包只做一件事：**把数据库从旧结构带到新结构**，并且能回答「现在到哪一步了」。
//
// 它不认识 agent / store / 会话 —— 干活需要的能力由宿主通过 MigrationRuntime 传进来
// （建表、老房间搬家、折 bots 这些要 store 语义的，实现留在宿主）。所以：
//   entity-runtime → migration   （单向）
// 迁移文件永远不 import 宿主。

export { PLACEHOLDER_MODEL_KEY } from './model-key.js';
export {
    TOOL_OUTPUT_OFFLOAD_BYTES,
    offloadBytesOf,
    toolOutputsToOffload,
    type ToolOutputOffloadPlan,
} from './tool-output.js';
export { migrations, MIGRATION_STEPS } from './index-list.js';
export { checksumDrift, checksumOf, type ChecksumDrift } from './checksums.js';
export {
    migrationPlan,
    migrationVersion,
    missingMigrations,
    type MigrationPlanItem,
    type MigrationVersion,
} from './plan.js';
export { applyMigrations, appliedCount, type MigrationRunResult } from './run.js';
export type { Migration, MigrationRuntime, MigrationStepEvent, MigrationReporter } from './types.js';
