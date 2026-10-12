// src/main/core/seed.ts
// 🎯 空数据根的**初始种子**：preview/lab 首次启动（或 `diy seed run`）时种入最小可用数据。
//
// 为什么需要：生产数据根 `~/.diy` 有完整的 model/persona/projects，而变体数据根
// `./build/<variant>/home` 是空的 —— 起预览后是空壳（无模型、无项目、无任务），
// 演示与验证都无从下手，每次手工重配一遍。
//
// 三条约束（与任务书一致）：
//   1. **幂等**：已存在的文件/项目一律不动、不覆盖（重复启动 = 无副作用）。
//   2. **只对 preview/lab 自动跑**：prod 永不种（那是用户的真实数据）；test 也不自动
//      （测试 home 是 mkdtemp，自动种会污染断言）—— 需要时用 RPC/CLI 显式触发。
//   3. **不落明文密钥**：模型账号写 `$VAR` 引用；本机没有该变量时仍写引用（UI 标红提示，
//      用户可以点「导入」或自己填）—— 保证种子是**真实可用**的形状，而不是假 key。
//
// 模型面按用户规则**只认 opencode-go**，人物模型 = `mimo-v2.6-flash`（允许清单内最便宜）。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_PERSONA_ID } from "../../shared/persona";
import { parseSeedFlag } from "../../runtime";
import type { SeedReport } from "../../shared/model-config";
import { isProdDataHome } from "./instance-identity";
import { loadModelConfig, saveModelConfig } from "./model-config";
import { snapshotProviders } from "./model-registry";
import { savePersonas } from "./persona";
import { createProject, listProjects } from "./project";
import { createTask, updateTask } from "./task";

/** 种子只配这一家 provider（用户规则：测试用人物模型只指 opencode-go 的 mimo-v2.6-flash） */
export const SEED_PROVIDER = "opencode-go";
/**
 * 一次性标记：自动种入**只跑一次**。
 * 为什么需要：种子原来按「缺则补」，于是用户在预览里删掉 opencode-go（正是为了看
 * 「环境变量导入」提示条）—— 一重启就被种回来，看起来像「删不掉」（实测踩过）。
 * 显式 `diy seed run` 不看这个标记：那是用户明确要求补缺项。
 */
export const SEED_MARKER = ".seed-done";

/** 种子人物模型（须在允许清单内：mimo-v2.6-flash / deepseek-v4.1-flash） */
export const SEED_MODEL = "mimo-v2.6-flash";
/** 人物模型限定名（account 段 0 = 首个无名字号） */
export const SEED_PERSONA_MODEL = `0@${SEED_PROVIDER}/${SEED_MODEL}`;

/**
 * 自动种入开关：`DIY_SEED=0/false/off` 关，`=1/true/on` 开（任何变体都开），
 * 缺省 = 仅 `DIY_VARIANT` 为 preview / lab 时开。prod 与 test 缺省关。
 */
export function autoSeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const explicit = parseSeedFlag(env.DIY_SEED);
    if (explicit !== undefined) return explicit;
    const variant = (env.DIY_VARIANT ?? "prod").trim();
    return variant === "preview" || variant === "lab";
}

/** 种子的示例任务（覆盖列表/详情要看到的多态：active / done / 父子层级） */
const SEED_TASKS: Array<{ title: string; body: string; state: string; parent?: number }> = [
    {
        title: "示例：跑通第一次对话",
        body: "这是一条种子任务（state=active）。\n\n在右侧选中一个人物模型，发一条消息试试。\n",
        state: "active",
    },
    {
        title: "示例：已完成的任务长什么样",
        body: "这是一条种子任务（state=done）。\n\n用来验证列表里的状态圆点与筛选用。\n",
        state: "done",
    },
    {
        title: "子任务：看看父子层级",
        body: "这是一条子任务（parent = 上面那条 active 的任务）。\n\n用来验证任务树的缩进与折叠。\n",
        state: "pending",
        parent: 0,
    },
];

/**
 * 种入最小可用数据。幂等：已存在的部分跳过（见文件头三条约束）。
 * `env` 可注入（测试用假环境，不去读真实 process.env）。
 *
 * @param opts.autoOnly 启动路径用：只认「首次初始化」—— 见过 SEED_MARKER 就整体跳过，
 *        不补缺项（否则用户删掉的 provider 会被一次次种回来）。显式 `diy seed run`
 *        省略此参数 = 缺则补。
 */
export function seedHome(
    home: string,
    env: NodeJS.ProcessEnv = process.env,
    opts: { autoOnly?: boolean } = {},
): SeedReport {
    const report: SeedReport = {
        home,
        model: "exists",
        persona: "exists",
        project: null,
        tasks: [],
        skipped: null,
    };
    // 硬护栏（与 dev 入口的「拒绝继承生产 DIY_HOME」是两道独立的门，但判据同源：
    // instance-identity::isProdDataHome）：变体开关只保证 prod **不自动**种，挡不住
    // 「DIY_VARIANT=preview + DIY_HOME=~/.diy」这种显式组合 —— 那才是真会写坏生产数据的路径。
    if (isProdDataHome(home)) {
        report.skipped = `生产数据根永不种入：${home}`;
        return report;
    }
    // 自动种入只跑一次（见 SEED_MARKER）：已初始化过的数据根，缺什么都**不补** ——
    // 用户删掉的东西必须留得住。
    const marker = join(home, SEED_MARKER);
    if (opts.autoOnly && existsSync(marker)) {
        report.skipped = "已初始化过（自动种入只跑一次；补缺项用 `diy seed run`）";
        return report;
    }

    // ── 1. model.yaml：缺则补 opencode-go（值写 `$VAR` 引用） ──
    const cfg = loadModelConfig(home);
    if (!cfg.stdProviders[SEED_PROVIDER]) {
        const spec = snapshotProviders()[SEED_PROVIDER];
        // 优先用命中的环境变量名；没有则用 spec 声明的第一个（写引用 → UI 标红提示，形状仍完整）
        const hit = (spec?.env ?? []).find((v) => (env[v] ?? "").trim() !== "");
        const envVar = hit ?? spec?.env?.[0] ?? "OPENCODE_API_KEY";
        cfg.stdProviders[SEED_PROVIDER] = {
            accounts: [{ type: "apiKey", data: { value: `$${envVar}` } }],
            filter: { include: [], exclude: [] },
        };
        saveModelConfig(home, cfg);
        report.model = hit ? "imported" : "placeholder";
    }

    // ── 2. personas.yaml：缺则建缺省人物，模型 = 0@opencode-go/mimo-v2.6-flash ──
    const personaFile = join(home, "personas.yaml");
    if (!existsSync(personaFile)) {
        savePersonas(home, {
            default: BUILTIN_PERSONA_ID,
            personas: {
                [BUILTIN_PERSONA_ID]: {
                    name: "大副（预览）",
                    model: SEED_PERSONA_MODEL,
                    reasoningEffort: "default",
                    instructions: "",
                },
            },
        });
        report.persona = "written";
    }

    // ── 3. 示例项目 + 任务：已有任何项目就不动（不往用户数据里塞东西） ──
    if (listProjects().length === 0) {
        const sampleDir = join(home, "sample-project");
        mkdirSync(sampleDir, { recursive: true });
        const project = createProject(sampleDir, {
            label: "示例项目",
            desc: "预览环境的种子项目（可删）",
        });
        report.project = project;
        const created: string[] = [];
        SEED_TASKS.forEach((t) => {
            const parent = t.parent === undefined ? undefined : created[t.parent];
            const uri = createTask({ title: t.title, project, body: t.body, parent });
            updateTask(uri, { state: t.state });
            created.push(uri);
        });
        report.tasks = created;
    }

    mkdirSync(home, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`, "utf-8");
    return report;
}
