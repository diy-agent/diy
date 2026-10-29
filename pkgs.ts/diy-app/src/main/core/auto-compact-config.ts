// src/main/core/auto-compact-config.ts
// 🎯 自动压缩配置的文件层：$DIY_HOME/auto-compact.yaml 的读写。
//
// ##442 最大精简后的配置面只有两项：
//   · `history.limit.summary.mode`: model | self（压缩后怎么承接被压段）
//   · `policy.modeData.toolResult`（工具结果呈现；与历史选择无关）
//
// 触发线 / 保留量都是派生量，**不再有配置**：
//   触发线 = W − max(10%W, 16k)；保留量 = W × 0.16。

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import * as yaml from "js-yaml";
import {
    AutoCompactConfigSchema,
    DEFAULT_AUTO_COMPACT,
    autoCompactIssuesFromZod,
    normalizeAutoCompact,
    type AutoCompactConfig,
    type AutoCompactIssue,
} from "@diy/compaction/compact-config";

export function autoCompactFile(home: string): string {
    return join(home, "auto-compact.yaml");
}

export interface AutoCompactLoadResult {
    config: AutoCompactConfig;
    /** 出声条目：文件坏 / 必填键缺 / 值被归一 */
    issues: AutoCompactIssue[];
}

/** 旧调用点的兼容参数（不再使用：触发线是派生量，没有可折算的旧 token 阈值） */
export interface AutoCompactLoadOptions {
    windowLimitTokens?: number | null;
}

export function loadAutoCompactDetailed(home: string, _opts?: AutoCompactLoadOptions): AutoCompactLoadResult {
    const p = autoCompactFile(home);
    if (!existsSync(p)) return { config: DEFAULT_AUTO_COMPACT, issues: [] };
    let raw: unknown;
    try {
        raw = yaml.load(readFileSync(p, "utf-8"));
    } catch (e) {
        const message = `YAML 解析失败（${e instanceof Error ? e.message : String(e)}）；整份回落缺省`;
        console.warn(`[auto-compact] ${p} ${message}`);
        return { config: DEFAULT_AUTO_COMPACT, issues: [{ path: "", message }] };
    }
    const parsed = AutoCompactConfigSchema.safeParse(raw);
    const issues: AutoCompactIssue[] = [];
    const config = normalizeAutoCompact(raw, issues);
    if (!parsed.success) {
        issues.unshift(...autoCompactIssuesFromZod(parsed.error, config));
        console.warn(
            `[auto-compact] ${p} 结构不符（${parsed.error.issues.map((i) => i.path.join(".") || "（根）").join("，")}），` +
                `已逐键回落缺省（详见 UI 压缩 tab 的出声）`,
        );
    }
    return { config, issues };
}

/** 读自动压缩配置（只要配置本身；要「为什么」用 `loadAutoCompactDetailed`） */
export function loadAutoCompact(home: string, opts?: AutoCompactLoadOptions): AutoCompactConfig {
    return loadAutoCompactDetailed(home, opts).config;
}

/** 原始全文（含注释）—— 供 UI「原始配置」只读视图 */
export function readAutoCompactText(home: string): string {
    const p = autoCompactFile(home);
    try {
        return existsSync(p) ? readFileSync(p, "utf-8") : "";
    } catch (e) {
        console.warn(`[auto-compact] ${p} 读取失败:`, e);
        return "";
    }
}

/** 写自动压缩配置（原子：tmp → rename）。宽松归一后再写。 */
export function saveAutoCompact(home: string, cfg: unknown, _opts?: AutoCompactLoadOptions): AutoCompactConfig {
    const norm = normalizeAutoCompact(cfg);
    const p = autoCompactFile(home);
    mkdirSync(dirname(p), { recursive: true });
    const header =
        "# 自动压缩配置 —— 唯一真源（手改或经 UI 写回；下一轮真发生效）\n" +
        "#\n" +
        "# ##442 最大精简：没有 mode / 没有 triggers / 没有 token 上限。\n" +
        "#   触发线 = W − max(10%W, 16k)（W = 当前模型窗口；未知 ⇒ 不压）\n" +
        "#   保留量 = W × 0.16（128k→20k / 256k→41k / 1M→160k）\n" +
        "#   切点   = 从尾往前装够保留量后，往前挪到最近的 user 消息\n" +
        "#   压完仍超触发线 ⇒ 不压；手动压缩无视两条不压判据，至少丢一步。\n" +
        "#\n" +
        "# history.limit.summary.mode:\n" +
        "#   model = 压缩时先让模型读被压段，产出摘要\n" +
        "#   self  = 不生成摘要，只给 llm 原文路径，让模型自己查\n" +
        "#\n" +
        "# policy.modeData.toolResult: 工具结果呈现（asis / headtail / callpath），与历史选择无关\n" +
        "# 契约：pkgs.ts/diy-app/src/shared/context/auto-compact.ts\n";
    writeFileAtomic(p, header + yaml.dump(norm, { indent: 2, noRefs: true }));
    return norm;
}
