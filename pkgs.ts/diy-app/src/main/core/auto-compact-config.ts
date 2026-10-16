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
import { validateKeepStages, type KeepIssue, type KeepStage } from "../../shared/context/compact-keep";

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
        // 读侧也走宽松归一：单位迁移（旧比例 → token 默认）等**只在归一里做一次**，
        // 否则手改的旧配置文件会绕过迁移，被当成 token 阈值。
        return normalizeAutoCompact(parsed.data);
    } catch (e) {
        console.warn(`[auto-compact] ${p} 解析失败，用默认:`, e);
        return DEFAULT_AUTO_COMPACT;
    }
}

/**
 * 读自动压缩配置的**原始全文**（`$DIY_HOME/auto-compact.yaml`，含注释）—— 供 UI「原始配置」
 * 只读视图（用户 2026-10-07：「我希望 app 能尽量有显示原始数据的能力」）。缺失 → 空串。
 */
export function readAutoCompactText(home: string): string {
    const p = autoCompactFile(home);
    try {
        return existsSync(p) ? readFileSync(p, "utf-8") : "";
    } catch (e) {
        console.warn(`[auto-compact] ${p} 读取失败:`, e);
        return "";
    }
}

/**
 * 解析 plan 文本（YAML 或 JSON）→ 待校验的原始值。
 *
 * 接受两种写法（都是人/agent 自然会写出来的）：**级列表数组**，或 `{ keep: [...] }`
 * （后者可直接从 `auto-compact.yaml` 里粘一段过来，零改写）。形状是否合法由 `validateKeepStages` 判 ——
 * 这里只负责「把文本变成值」，不做任何猜测性修复（猜错了就是静默丢上下文）。
 */
export function parseKeepText(text: string): unknown {
    const src = text.trim();
    if (src === "") throw new Error("plan 文本为空（要给级列表数组，或 `{ keep: [...] }`）");
    let v: unknown;
    try {
        v = yaml.load(src);
    } catch (e) {
        throw new Error(`plan 文本解析失败（YAML/JSON）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (v === null || typeof v !== "object") throw new Error("plan 文本不是级列表（应为数组，或 `{ keep: [...] }`）");
    if (Array.isArray(v)) return v;
    const keep = (v as Record<string, unknown>)["keep"];
    if (keep === undefined) throw new Error("plan 文本既不是数组、也没有 `keep` 字段");
    return keep;
}

/**
 * 写 `history.keep[]`（**校验后才落地**）—— `compact plan set` 与 UI 级列表编辑器的**唯一写入口**。
 * 非法 ⇒ 抛错且**不改文件**：写好 plan 就是决定「哪些历史发给模型」，静默写坏等于静默丢上下文。
 * （读侧是另一回事：坏 `keep` 只丢 `history`、回落缺省管道，见 normalizeHistory —— 两面都硬就是自锁。）
 */
export function saveKeepConfig(home: string, rawKeep: unknown): { keep: KeepStage[]; issues: KeepIssue[] } {
    const { stages, issues } = validateKeepStages(rawKeep);
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
        throw new Error(`plan 非法，已拒绝写入（配置未改动）：\n${errors.map((e) => `· ${e.message}`).join("\n")}`);
    }
    if (stages.length === 0) {
        throw new Error("keep 不能是空级列表（要清零请把预算 `policy.modeData.budgetBytes` 设为 0）");
    }
    // ⚠️ 必须**保留 history 的其余字段**（`allowAgentWrite` 等）：整包换成 `{ keep }` 会顺手把闸关掉
    // —— 那意味着「agent 写一次 set 就自动失去写权限」，闸等于一次性；##362 M3a 实测复现过。
    const cur = loadAutoCompact(home);
    saveAutoCompact(home, { ...cur, history: { ...(cur.history ?? {}), keep: stages } });
    return { keep: stages, issues };
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
        "#   contextWindowOver    上下文窗口占用上限（**token 数**，= 该会话最后一步实测用量；0 = 关闭）\n" +
        "# policy: 压缩策略（自动与手动**同一套**）。\n" +
        "#   mode: budget 目标式预算（现役；只有这一种算法）\n" +
        "#   modeData: **只属于该 mode** 的私有参数（换 mode 就换一整包；与 mode 同级的 summary 才是所有算法共有）\n" +
        "#     · budget：budgetBytes 历史字节上限（0=清零）· toolResult 工具结果呈现\n" +
        "#         toolResult.render: asis 原样 / headtail 头尾裁剪（私有参数在 renderData）/ callpath 只留调用\n" +
        "# history: 历史装配管道（##344 M2 起可从配置改；缺省 = 代码里的缺省管道）\n" +
    "#   allowAgentWrite: 允许本地 agent 经 compact_plan 工具改写 plan（缺省 false = 只读；##362 M3a）\n" +
    "#     agent 写闸只管 agent —— CLI `compact plan set` / UI 编辑器是用户自己的操作，不受它约束\n" +
        "#   keep[]: 级列表，**从上往下**生效（先声明的先挑）；形状 `{ type, must?, limit?, clip?, data }`\n" +
        "#     type: ladder 纵向阶梯（缺省兜底）/ role 某角色全部 / recent 最近 N 条 / steps 最近 N 步\n" +
        "#     must: true = 必保（不占预算）；limit: 最多几个单元（call+result=1）\n" +
        "#     clip: full 不裁 / path 只留调用+路径 / { type: headtail, data: { head, tail, maxLineChars, maxKeepBytes } }\n" +
        "#     data: 各取法私有参数（role: { role } · recent: { n, role? } · steps: { n }）\n" +
        "#   预算(**0 = 清零**，含 must 级) 在 policy.modeData.budgetBytes；校验/读写走 `diy ... compact plan`\n" +
        "# 契约：pkgs.ts/diy-app/src/shared/context/auto-compact.ts 的 AutoCompactConfigSchema\n";
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, header + yaml.dump(norm, { indent: 2, noRefs: true }), "utf-8");
    renameSync(tmp, p);
    return norm;
}
