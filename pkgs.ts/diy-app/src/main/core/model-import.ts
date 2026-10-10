// src/main/core/model-import.ts
// 🎯 环境变量 → provider 配置的**导入候选**（`llmConfig.scanEnv` / `llmConfig.importEnv` 的内核）。
//
// 用途：数据根是空的时候，用户手上明明已经有 `OPENCODE_API_KEY` 这类变量，却要把 provider
// 一家家手工加回来（还得自己记住变量名）。本模块把三方对一遍 ——
//   models.dev 声明的 `env`（snapshot 里每家 provider 的 env 数组）
//   ⊕ 本机 `process.env`（有值才算命中）
//   ⊕ 现有 `model.yaml`（已配置的 provider / 已用掉的密钥值）
// 给出「可一键导入」的清单。
//
// 三条不可破的约定：
//   1. **只列不写**：scan 不落盘；落盘只发生在显式 import 时（UI 点击 / CLI 命令）。
//   2. **不落明文**：账号 value 恒写成 `$VAR` 引用 —— env 已经是用户自己的密钥源，
//      再抄一份明文进 model.yaml 只是多一处副本（该文件常被备份/分享）。
//   3. **不覆盖已有**：provider 已配置、或该密钥值已被现有账号使用 → 一律标跳过。
//      「同一个 key 不用配两遍」是用户的硬要求，也是本模块存在的理由。

import type { Account, EnvImportCandidate, ModelConfigFile } from "../../shared/model-config";
import { loadModelConfig, saveModelConfig } from "./model-config";
import { expandEnvValue, snapshotProviders } from "./model-registry";

/** 现有配置里所有账号的展开值 → 归属（`<account>@<provider>`），用于「密钥已存在」判定 */
function existingKeyOwners(file: ModelConfigFile, env: NodeJS.ProcessEnv): Map<string, string> {
    const out = new Map<string, string>();
    const collect = (kind: "std" | "custom", key: string, accounts: Account[]): void => {
        accounts.forEach((a, i) => {
            const raw = a.data.value.trim();
            if (raw === "") return; // 空 = 还没填，不算已用
            const { value } = expandEnvValue(raw, env);
            if (value)
                out.set(
                    value,
                    `${a.name ?? String(i)}@${kind === "custom" ? `custom:${key}` : key}`,
                );
        });
    };
    for (const [key, cfg] of Object.entries(file.stdProviders)) collect("std", key, cfg.accounts);
    for (const [key, cfg] of Object.entries(file.customProviders))
        collect("custom", key, cfg.accounts);
    return out;
}

/**
 * 列出「可由环境变量导入」的 provider（含被跳过的及原因，UI/CLI 自行决定展示哪些）。
 * 一家 provider 只认**第一个命中的** env 变量（models.dev 的 env 是候选顺序，不是并列）。
 */
export function scanEnvCandidates(
    home: string,
    env: NodeJS.ProcessEnv = process.env,
): EnvImportCandidate[] {
    const file = loadModelConfig(home);
    const configured = new Set([
        ...Object.keys(file.stdProviders),
        ...Object.keys(file.customProviders),
    ]);
    const keyOwners = existingKeyOwners(file, env);
    // 候选间同源去重：多家 provider 声明同一个 env（opencode / opencode-go 都吃 OPENCODE_API_KEY）
    // 时，只有第一家算可导入，其余标「同源」——否则「全部导入」会写两个用同一把钥匙的 provider。
    const claimed = new Map<string, string>();
    const out: EnvImportCandidate[] = [];
    for (const [id, spec] of Object.entries(snapshotProviders())) {
        for (const envVar of spec.env ?? []) {
            const raw = env[envVar];
            if (raw === undefined || raw.trim() === "") continue;
            let status: EnvImportCandidate["status"] = "importable";
            let note: string | null = null;
            if (configured.has(id)) {
                status = "configured";
                note = "已配置（不覆盖现有账号）";
            } else if (keyOwners.has(raw)) {
                status = "duplicate";
                note = `密钥已被 ${keyOwners.get(raw)} 使用`;
            } else if (claimed.has(envVar)) {
                status = "duplicate";
                note = `与 ${claimed.get(envVar)} 同源（$${envVar}）`;
            } else {
                claimed.set(envVar, id);
            }
            out.push({
                provider: id,
                name: spec.name ?? null,
                envVar,
                models: Object.keys(spec.models ?? {}).length,
                status,
                note,
            });
            break; // 只认第一个命中的变量
        }
    }
    // 可导入的排前面（UI 一眼看到能干什么），其余按原顺序
    return out.sort(
        (a, b) => Number(b.status === "importable") - Number(a.status === "importable"),
    );
}

/**
 * 执行导入：把候选写成 `stdProviders[id]`（账号 value = `$VAR`）。
 * `providers` 为空/缺省 = 导入全部可导入项；显式指定时，被跳过的也在 `skipped` 里回报原因。
 */
export function importEnvProviders(
    home: string,
    providers?: string[],
    env: NodeJS.ProcessEnv = process.env,
): { imported: string[]; skipped: Array<{ provider: string; note: string }> } {
    const wanted = providers?.filter((p) => p.trim() !== "");
    const picked = scanEnvCandidates(home, env).filter(
        (c) => !wanted || wanted.length === 0 || wanted.includes(c.provider),
    );
    const file = loadModelConfig(home);
    const imported: string[] = [];
    const skipped: Array<{ provider: string; note: string }> = [];
    for (const c of picked) {
        if (c.status !== "importable") {
            skipped.push({ provider: c.provider, note: c.note ?? "已跳过" });
            continue;
        }
        file.stdProviders[c.provider] = {
            accounts: [{ type: "apiKey", data: { value: `$${c.envVar}` } }],
            filter: { include: [], exclude: [] },
        };
        imported.push(c.provider);
    }
    if (imported.length > 0) saveModelConfig(home, file);
    return { imported, skipped };
}
