// src/main/core/auto-compact-config.ts
// 🎯 自动压缩配置的**文件层**：$DIY_HOME/auto-compact.yaml 的读写。
//
// 分层同 core/context-config.ts：契约与归一在 shared/context/auto-compact.ts（纯函数、可单测），
// 本文件只做文件 I/O（existsSync → yaml.load → safeParse → 出声回落 → 原子写）。
//
// 为什么不放面板 localStorage（用户 2026-10-06 要"配置项"）：localStorage 是**有损**且
// serve 与 Electron 各持一份（见 pit.localstorage）；而"要不要自动压"会**改用户的会话历史**，
// 必须是真源、可版本管理、可手改。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as yaml from "js-yaml";
import {
    AutoCompactConfigSchema,
    DEFAULT_AUTO_COMPACT,
    normalizeAutoCompact,
    type AutoCompactConfig,
} from "../../shared/context/auto-compact";

export function autoCompactFile(home: string): string {
    return join(home, "auto-compact.yaml");
}

/** 读自动压缩配置；缺失 → 默认（notify）；坏 → 默认 + 出声 */
export function loadAutoCompact(home: string): AutoCompactConfig {
    const p = autoCompactFile(home);
    if (!existsSync(p)) return DEFAULT_AUTO_COMPACT;
    try {
        const raw = yaml.load(readFileSync(p, "utf-8"));
        const parsed = AutoCompactConfigSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn(
                `[auto-compact] ${p} 结构不符（${parsed.error.issues.map((i) => i.path.join(".")).join(",")}），用默认`,
            );
            return DEFAULT_AUTO_COMPACT;
        }
        return parsed.data;
    } catch (e) {
        console.warn(`[auto-compact] ${p} 解析失败，用默认:`, e);
        return DEFAULT_AUTO_COMPACT;
    }
}

/** 写自动压缩配置（原子：tmp → rename）。宽松归一后再写（不存坏数据）。 */
export function saveAutoCompact(home: string, cfg: unknown): AutoCompactConfig {
    const norm = normalizeAutoCompact(cfg);
    const p = autoCompactFile(home);
    mkdirSync(dirname(p), { recursive: true });
    const header =
        "# 自动压缩配置 —— 唯一真源（手改或经 UI 写回；下一轮真发生效）\n" +
        "# mode: off 不检测 / notify 检测并提示（默认）/ auto 检测到就压\n" +
        "# triggers: 三个都是**可判定的确定事实**（不是「划不划算」的预测）\n" +
        "#   systemContextChanged 系统上下文变了 → 前缀缓存必作废，此刻压缩零重建代价\n" +
        "#   cacheExpired         缓存已过期（距上次请求 > 生效 TTL）→ 冷启动，压缩是白赚\n" +
        "#   contextWindowOver    上下文窗口占用上限（0~1；0 = 关闭）\n" +
        "# policy: 自动压时用的策略（与手动面板同一棵决策树）\n" +
        "#   mode: reset 清零 / keep 保留；keep.scope: all 全留轮次 | recent 保留最近 N\n" +
        "#   content.kind: all 含工具链路（再配 toolResult）/ text 只留文本 / conclusion 只留结论\n" +
        "# 契约：pkgs.ts/diy-app/src/shared/context/auto-compact.ts 的 AutoCompactConfigSchema\n";
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, header + yaml.dump(norm, { indent: 2, noRefs: true }), "utf-8");
    renameSync(tmp, p);
    return norm;
}
