// src/main/core/model-config.ts
// 🎯 provider 配置的文件层：$DIY_HOME/model.yaml（配置）+ providers.custom.yaml（spec）读写。
// 契约在 shared/model-config.ts；本文件只做文件 I/O。解析失败 fail-fast（save 侧同理）——
// 配置文件是用户显式编辑的，静默降级只会让"改了没反应"。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as yaml from "js-yaml";
import {
    CustomSpecsFileSchema,
    ModelConfigFileSchema,
    type CustomSpecsFile,
    type ModelConfigFile,
} from "../../shared/model-config";

export function modelConfigFile(home: string): string {
    return join(home, "model.yaml");
}

export function customSpecsFile(home: string): string {
    return join(home, "providers.custom.yaml");
}

/** 原子写（tmp → rename）：结构非法直接抛，写侧不允许存下坏数据 */
function saveYaml(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, yaml.dump(data, { indent: 2, noRefs: true }), "utf-8");
    renameSync(tmp, path);
}

/** 读 model.yaml；不存在 = 空配置（默认无任何 provider） */
export function loadModelConfig(home: string): ModelConfigFile {
    const p = modelConfigFile(home);
    if (!existsSync(p)) return { stdProviders: {}, customProviders: {} };
    const raw = yaml.load(readFileSync(p, "utf-8")) ?? {};
    const parsed = ModelConfigFileSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(
            `model.yaml 结构非法: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
    }
    return parsed.data;
}

export function saveModelConfig(home: string, file: ModelConfigFile): void {
    saveYaml(modelConfigFile(home), ModelConfigFileSchema.parse(file));
}

/** 读 providers.custom.yaml；不存在 = 空 */
export function loadCustomSpecs(home: string): CustomSpecsFile {
    const p = customSpecsFile(home);
    if (!existsSync(p)) return {};
    const raw = yaml.load(readFileSync(p, "utf-8")) ?? {};
    const parsed = CustomSpecsFileSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(
            `providers.custom.yaml 结构非法: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
    }
    return parsed.data;
}

export function saveCustomSpecs(home: string, file: CustomSpecsFile): void {
    saveYaml(customSpecsFile(home), CustomSpecsFileSchema.parse(file));
}
