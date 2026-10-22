// src/main/core/models-snapshot.ts
// 🎯 models.dev api.json → diy 快照的**纯函数层**：npm 白名单过滤 + 结构自洽校验 + 前后对比。
//
// 一处定义、两处消费：
//   · 构建期 `scripts/gen-models-dev.mts`（##107 / ##266 手工同步）—— 产物随发行分发；
//   · 运行期 `core/models-sync.ts`（本轮 ##385）—— 应用内刷新写 `$DIY_HOME/data/`。
//
// 为什么要抽出这一层（而不是脚本与运行期各写一份）：**过滤口径分叉 = 静默丢 provider**
// （两份白名单有一份忘了加新 npm 包，运行时刷出来的快照就少一家）。校验同理 ——
// 写进用户数据根之前必须过同一道门（##385 §3.4：抓下来的快照必须过结构校验才准落盘）。
//
// 纯函数：不碰 fs / 网络 / Date，输入即事实 —— 单测可穷举边界（tests/core/models-snapshot.test.ts）。
import type { SpecProvider } from "../../shared/model-config";

/** 支持的 ai-sdk 包面（唯一真源；运行时 `shared/models.ts::NPM_FACE` 与之对齐） */
export const MODELS_DEV_NPM_ALLOW: readonly string[] = ["@ai-sdk/openai-compatible", "@ai-sdk/openai"];

/** 快照校验失败（上游结构变了 / 抓到了半截 JSON）—— 调用方必须**保留旧文件** */
export class ModelsSnapshotInvalidError extends Error {
    readonly code = "llm/models-snapshot-invalid";
}

export interface SnapshotBuild {
    /** 白名单过滤后的快照（与上游 provider map 同构；`JSON.stringify` 即可落盘） */
    snapshot: Record<string, SpecProvider>;
    /** provider 数 */
    providers: number;
    /** 模型总数 */
    models: number;
}

/** 抛结构错误（**唯一 throw 点**；code 固定在该异常类上，扫描器不认自定义类，故此处走逃生口） */
function invalid(message: string): never {
    // error-code-ok: code 由 ModelsSnapshotInvalidError 固定为 llm/models-snapshot-invalid
    throw new ModelsSnapshotInvalidError(message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 上游原文 → diy 快照（白名单 ⊕ 结构校验）。
 *
 * 校验的判据（都是「真出现了会静默丢数据」的形状）：
 *   · 顶层必须是非空 provider map（不是数组 / null / 空对象）；
 *   · 白名单内的每条必须有 `id` 字符串与 `models` 对象；`api` / `name` / `env` **可缺省**
 *     （models.dev 的真实数据里 `openai` 就没有 `api` —— 校验比真实数据严格等于「永远刷不进去」），
 *     但**给了就必须是对的类型**（否则运行时 registry 会在半途炸在某个 provider 上，
 *     用户看到的是「模型页整个空」）；
 *   · 过滤后至少剩一家（上游整体改版 → 宁可报错保留旧快照，也别把目录清空）。
 *
 * 非白名单 provider 的内容不校验（我们根本不用它们），但顶层形状仍校验 —— 否则可能是
 * 上游错误页 / 半截 JSON 被 `JSON.parse` 成了别的东西。
 */
export function buildModelsSnapshot(raw: unknown): SnapshotBuild {
    if (!isPlainObject(raw)) {
        invalid("上游不是 provider 映射（期望 JSON object）");
    }
    const entries = Object.entries(raw);
    if (entries.length === 0) {
        invalid("上游 provider 映射为空");
    }
    const snapshot: Record<string, SpecProvider> = {};
    let models = 0;
    for (const [key, value] of entries) {
        if (!isPlainObject(value)) {
            invalid(`provider "${key}" 不是对象`);
        }
        const npm = value["npm"];
        if (typeof npm !== "string" || !MODELS_DEV_NPM_ALLOW.includes(npm)) continue; // 不在白名单 = 有意丢弃
        const modelsMap = value["models"];
        if (!isPlainObject(modelsMap)) {
            invalid(`provider "${key}" 缺 models 对象`);
        }
        const provider = value as unknown as SpecProvider;
        if (typeof provider.id !== "string") {
            invalid(`provider "${key}" 缺 id`);
        }
        // 可选字段：缺省合法（`openai` 就没有 api），给了就必须是对的类型
        if (provider.api !== undefined && typeof provider.api !== "string") {
            invalid(`provider "${key}" 的 api 不是字符串`);
        }
        if (provider.name !== undefined && typeof provider.name !== "string") {
            invalid(`provider "${key}" 的 name 不是字符串`);
        }
        if (provider.env !== undefined && !Array.isArray(provider.env)) {
            invalid(`provider "${key}" 的 env 不是数组`);
        }
        models += Object.keys(modelsMap).length;
        snapshot[key] = provider;
    }
    const providers = Object.keys(snapshot).length;
    if (providers === 0) {
        invalid(
            `白名单（${MODELS_DEV_NPM_ALLOW.join(" / ")}）过滤后一家 provider 都不剩`,
        );
    }
    return { snapshot, providers, models };
}

/** 快照计数（读已有文件时用；不做白名单过滤 —— 文件已经是产物） */
export function snapshotCounts(snapshot: Record<string, SpecProvider>): { providers: number; models: number } {
    let models = 0;
    for (const p of Object.values(snapshot)) models += Object.keys(p.models ?? {}).length;
    return { providers: Object.keys(snapshot).length, models };
}

/** 模型级键（`provider/model`）：报「新增 N / 下线 M」时按模型算，人看的是模型，不是 provider */
function modelKeys(snapshot: Record<string, SpecProvider>): Set<string> {
    const keys = new Set<string>();
    for (const [pid, p] of Object.entries(snapshot)) {
        for (const mid of Object.keys(p.models ?? {})) keys.add(`${pid}/${mid}`);
    }
    return keys;
}

export interface SnapshotDiff {
    /** 内容是否变化（逐字比较；价目/元数据变动也算 —— 那正是要刷新的东西） */
    changed: boolean;
    addedProviders: string[];
    removedProviders: string[];
    /** 新增 / 下线的模型数（按 `provider/model` 键集合算） */
    addedModels: number;
    removedModels: number;
}

/** 旧快照 → 新快照的差异（无旧快照 = 全算新增） */
export function diffSnapshot(prev: Record<string, SpecProvider> | null, next: Record<string, SpecProvider>): SnapshotDiff {
    const prevIds = prev ? Object.keys(prev) : [];
    const nextIds = Object.keys(next);
    const prevSet = new Set(prevIds);
    const nextSet = new Set(nextIds);
    const prevModels = prev ? modelKeys(prev) : new Set<string>();
    const nextModels = modelKeys(next);
    let addedModels = 0;
    for (const k of nextModels) if (!prevModels.has(k)) addedModels++;
    let removedModels = 0;
    for (const k of prevModels) if (!nextModels.has(k)) removedModels++;
    return {
        // 逐字比较：上游改个价、改个 context 上限都算变化（这正是刷新要落盘的理由）。
        // 副作用：上游仅**键顺序**变动也会判 changed 并重写盘 —— 无害（内容等价、只 mtime 会动），
        // 刻意不做规范化排序（那要整份重建对象，4MB 数据的性价比不划算）。
        changed: prev === null || JSON.stringify(prev) !== JSON.stringify(next),
        addedProviders: nextIds.filter((id) => !prevSet.has(id)),
        removedProviders: prevIds.filter((id) => !nextSet.has(id)),
        addedModels,
        removedModels,
    };
}
