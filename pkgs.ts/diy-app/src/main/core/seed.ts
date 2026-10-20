// src/main/core/seed.ts
// 🎯 空数据根的**初始种子**：lab 首次启动（或 `diy seed run`）时种入最小可用数据。
//
// 为什么需要：生产数据根 `~/.diy` 有完整的 model/persona/projects，而变体数据根
// `./build/<variant>/home` 是空的 —— 起预览后是空壳（无模型、无项目、无任务），
// 演示与验证都无从下手，每次手工重配一遍。
//
// 三条约束（与任务书一致）：
//   1. **幂等**：已存在的文件/项目一律不动、不覆盖（重复启动 = 无副作用）。
//   2. **只对 lab 自动跑**：prod 永不种（那是用户的真实数据）；test 也不自动
//      （测试 home 是 mkdtemp，自动种会污染断言）—— 需要时用 RPC/CLI 显式触发。
//   3. **不落明文密钥**：模型账号写 `$VAR` 引用；本机没有该变量时仍写引用（UI 标红提示，
//      用户可以点「导入」或自己填）—— 保证种子是**真实可用**的形状，而不是假 key。
//
// 模型面按用户规则**只认 opencode-go**，人物模型 = **缺省模型口径**（free 优先 → 退兜底，
// 真源 `src/shared/model-default.ts`）—— 本文件**不写死模型名**（写死过 `mimo-v2.6-flash`，
// 上游下架后种出来的环境开箱即坏）。
//
// **职责边界**（与 `./sha.sh sync-dev-home` 分工，别再混）：
//   seed = **示例 / 测试数据** —— 示例项目与任务、缺省人物、`$VAR` 占位凭据（形状真、值是假的）。
//   真配置 = `~/.diy` 的真账号 / 真人物 / 投递划分，由 `./sha.sh sync` 投影进 `build/<variant>/home`
//   （seed 遇到已同步的真 `model.yaml` / `personas.yaml` 一律不动 —— 现有幂等语义天然满足）。

import { existsSync, mkdirSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { join } from "node:path";
import { pickDefaultModel } from "../../shared/model-default";
import { BUILTIN_PERSONA_ID } from "../../shared/persona";
import { parseSeedFlag } from "../../runtime";
import type { SeedReport } from "../../shared/model-config";
import { isProdDataHome } from "./instance-identity";
import { loadModelConfig, saveModelConfig } from "./model-config";
import { snapshotProviders } from "./model-registry";
import { savePersonas } from "./persona";
import { createProject, listProjects } from "./project";
import { createTask, updateTask } from "./task";

/** 种子只配这一家 provider（用户规则：本地 agent 测试的模型只指 opencode-go） */
export const SEED_PROVIDER = "opencode-go";
/**
 * 一次性标记：自动种入**只跑一次**。
 * 为什么需要：种子原来按「缺则补」，于是用户在预览里删掉 opencode-go（正是为了看
 * 「环境变量导入」提示条）—— 一重启就被种回来，看起来像「删不掉」（实测踩过）。
 * 显式 `diy seed run` 不看这个标记：那是用户明确要求补缺项。
 */
export const SEED_MARKER = ".seed-done";

/** 种子 provider 的可用模型 id（models.dev 快照；provider 未收录 = 空表） */
export function seedProviderModelIds(): string[] {
    return Object.keys(snapshotProviders()[SEED_PROVIDER]?.models ?? {});
}

/**
 * 种子人物模型（限定名 `0@opencode-go/<缺省模型>`；account 段 0 = 首个无名字号）。
 * 口径 = free 优先 → 退兜底（真源 `src/shared/model-default.ts`，本文件不另抄一份字符串）；
 * 候选还会**按快照实有模型筛一遍** —— 目录里没有的模型种进去只会显示「模型不可用」。
 * `ids` 可注入（不传 = 读快照），便于单测钉住挑选语义。
 */
export function seedPersonaModel(ids: readonly string[] = seedProviderModelIds()): string {
    return `0@${SEED_PROVIDER}/${pickDefaultModel(ids)}`;
}

/**
 * 自动种入开关：`DIY_SEED=0/false/off` 关，`=1/true/on` 开（任何变体都开），
 * 缺省 = 仅 `DIY_VARIANT` 为 lab 时开。prod 与 test 缺省关。
 */
export function autoSeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const explicit = parseSeedFlag(env.DIY_SEED);
    if (explicit !== undefined) return explicit;
    const variant = (env.DIY_VARIANT ?? "prod").trim();
    return variant === "lab";
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
/**
 * seed 的可注入依赖（**仅测试注入用**，##402）。缺省 = 真实现。
 *
 * 为什么做成参数：测试要验「撞上生产数据根 → 一个字节都不写」这条护栏，但不能真的指向
 * `~/.diy`（写坏就是事故）。旧做法 `vi.mock("instance-identity")` 改的是全局模块表，
 * `isolate:false` 下会被别的文件先加载的实现静默顶掉 —— 注入后「用哪份判据」由调用点决定。
 */
export interface SeedDeps {
    isProdDataHome: (home: string) => boolean;
}

export function seedHome(
    home: string,
    env: NodeJS.ProcessEnv = process.env,
    opts: { autoOnly?: boolean; deps?: Partial<SeedDeps> } = {},
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
    // 「DIY_VARIANT=lab + DIY_HOME=~/.diy」这种显式组合 —— 那才是真会写坏生产数据的路径。
    const isProd = opts.deps?.isProdDataHome ?? isProdDataHome;
    if (isProd(home)) {
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

    // ── 2. personas.yaml：缺则建缺省人物，模型 = 缺省口径（free 优先 → 退兜底） ──
    const personaFile = join(home, "personas.yaml");
    if (!existsSync(personaFile)) {
        savePersonas(home, {
            default: BUILTIN_PERSONA_ID,
            personas: {
                [BUILTIN_PERSONA_ID]: {
                    name: "大副（预览）",
                    model: seedPersonaModel(),
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
    writeFileAtomic(marker, `${new Date().toISOString()}\n`);
    return report;
}
