// services/context-providers.ts
// 🎯 diy-app 侧的上下文提供器（业务都在这里，`@diy-agent/context` 是空壳）。
//
// 由来（2026-11-05 用户裁）：「context 本质是一个业务无关的上下文树机制 … 拆成机制 + 提供器」。
// provider.ts（机制层）只认 `{ key, provide() }`；**谁需要 home / taskUri / 项目路径，由这里闭包捕获**。
//
// 为什么每个 provider 是工厂而不是对象：同一个 provider 在不同装配里带不同的 home / taskUri，
// 工厂让依赖显式出现在签名上（而不是从全局变量里偷），也便于单测直接喂假数据。

import { homedir } from "node:os";
import { join } from "node:path";
import { skillsOf } from "@diy-agent/skills";
import type { ContextProvider } from "@diy-agent/context";
import { describeSchema, type SchemaDoc } from "@diy-agent/context/schema/schema-doc";
import { AssembleGlobalsSchema } from "@diy-agent/context/schema/prompt-schema";
import { reqlogValue } from "@diy-agent/context/schema/reqlog";
import type { AssembleGlobals } from "@diy-agent/context/schema/prompt-schema";

import { resolveCwd } from "../core/cwd";
import { personaForTask } from "../core/persona";
import { getProjectPath } from "../core/project";
import { readRuntimeConfig } from "../../runtime";
import { LOG_DIR_REL, dayFile } from "../core/traffic-log";
import { buildFactsContext } from "./facts-context";
import { buildKbIndex } from "./facts-context";
import { buildDocsIndex, summarizeDocsIndex } from "./docs-index";
import { DELIVERED_SECTIONS, chainOf, projectIncludeResolver, renderSystemDsl, taskOf } from "./prompt-registry";

/**
 * 整棵树的**结构说明**（zod 派生，一次算好）。
 *
 * 为什么在 diy-app 侧而不是 `@diy-agent/context` 里：机制层不该知道 zod
 * （2026-11-05 用户裁：「对 context 来讲，zod 还是啥并不重要」）。
 * zod 仍是**这里的**真源（schema 改了 help 跟着变），只是由我们把派生结果交给机制层。
 */
const GLOBALS_DOC: SchemaDoc = describeSchema(AssembleGlobalsSchema);

/** 给一个 provider 挂上它的结构说明（从整棵树的 doc 里取自己那一节） */
function withHelp(provider: ContextProvider): ContextProvider {
    const help = GLOBALS_DOC[provider.key] as SchemaDoc | undefined;
    return help === undefined ? provider : { ...provider, help };
}

/** 装配输入：所有 provider 工厂的公共依赖（非 provider 的东西都在这） */
export interface ProviderDeps {
    readonly home: string;
    readonly projectId: string;
}

/** 一次装配内的上下文（taskUri / 草稿 / 房间 / 自量由调用方给） */
export interface AssembleOptions {
    readonly taskUri?: string;
    readonly skills?: Array<{ name: string; desc: string }>;
    readonly diyCli?: string;
    readonly drafts?: Record<string, string>;
    readonly room?: AssembleGlobals["room"] | null;
    readonly self?: AssembleGlobals["self"] | null;
}

/**
 * 一次装配内**共享**的读盘结果。
 *
 * 为什么要它：`task` 与 `persona` 都要读同一个任务文件，`cwd` 与 `chain` 都要解析 cwd。
 * 各读各的在毫秒级无所谓，但装配是**每轮**跑的，重复 IO 会累积。
 * ⚠ 缓存的是「源文件读出来的结果」，**不是「上次给了机制层什么」** —— 契约仍是每次给全量值。
 */
function sharedOf(home: string, projectId: string, opts: AssembleOptions) {
    const taskUri = opts.taskUri ?? "";
    let task: ReturnType<typeof taskOf> | undefined;
    let cwd: ReturnType<typeof resolveCwd> | undefined;
    let persona: ReturnType<typeof personaForTask> | undefined;
    return {
        taskUri,
        task: () => {
            if (task === undefined) task = taskUri === "" ? null : taskOf(home, taskUri);
            return task;
        },
        cwd: () => (cwd ??= resolveCwd(home, taskUri)),
        persona: () => (persona ??= personaForTask(home, taskUri)),
        resolve: () => projectIncludeResolver(home, projectId, opts.drafts),
    };
}

type Shared = ReturnType<typeof sharedOf>;

/** `persona` 节：当前人物名 + 行为指令 */
export function personaProvider(shared: Shared): ContextProvider {
    return {
        key: "persona",
        provide: () => {
            const p = shared.persona();
            return { name: p.name, instructions: p.instructions };
        },
    };
}

/** `diy` 节：CLI 入口 + 数据根（进程身份，整个会话不变） */
export function diyProvider(home: string, opts: AssembleOptions): ContextProvider {
    return {
        key: "diy",
        provide: () => ({
            cli: opts.diyCli ?? readRuntimeConfig().cli ?? "diy（未注入 DIY_CLI，勿照抄）",
            home,
        }),
    };
}

/** `project` 节：项目路径（只在切项目时变） */
export function projectProvider(projectId: string): ContextProvider {
    return { key: "project", provide: () => ({ path: getProjectPath(projectId) ?? "" }) };
}

/** `task` 节：任务头字段 + body + 目录（**读侧显式给头**，确认任务不必去 cat 文件） */
export function taskProvider(home: string, shared: Shared): ContextProvider {
    return {
        key: "task",
        provide: () => {
            const t = shared.task();
            return {
                uri: shared.taskUri,
                title: t?.title ?? "",
                state: t?.state ?? "",
                parent: t?.parent ?? "",
                created: t?.created ?? "",
                updated: t?.updated ?? "",
                change_type: t?.change_type ?? "",
                module: t?.module ?? "",
                priority: t?.priority ?? "",
                persona: t?.persona ?? "",
                body: t?.body ?? "",
                dir: shared.taskUri ? join(home, shared.taskUri) : "",
            };
        },
    };
}

/** `cwd` 节：工作目录与回退说明 */
export function cwdProvider(shared: Shared): ContextProvider {
    return {
        key: "cwd",
        provide: () => {
            const c = shared.cwd();
            return {
                path: c.cwd,
                note: c.note,
                isFallback: c.isFallback,
                isTaskDir: c.isTaskDir,
                isAppDir: c.isAppDir,
            };
        },
    };
}

/** `chain` 节：AGENTS.md 链（只在目录/文件改动时变） */
export function chainProvider(home: string, shared: Shared): ContextProvider {
    return {
        key: "chain",
        provide: () => {
            const c = shared.cwd();
            return chainOf(home, c.cwd, shared.taskUri, c.isAppDir);
        },
    };
}

/** `skills` 节：技能清单（调用方给的，缺省空数组） */
/**
 * 技能清单 —— 从 `.agents/skills`（业界共享规范）现扫。
 *
 * 为什么不再吃 `opts.skills`（2026-11-07）：那个参数**从来没人传过**（`rg 'skills' api-impl.ts` 无结果），
 * 于是 `?? []` 永远得到空数组 —— 本机 22 个技能一个都没进过 system。
 * 改成真扫之后，`skills` 节点才第一次有内容。
 */
export function skillsProvider(shared: Shared): ContextProvider {
    return {
        key: "skills",
        help: SKILLS_HELP,
        provide: () => skillsOf({ cwd: shared.cwd().cwd, globalRoot: join(homedir(), ".agents") }),
    };
}

/** 结构说明（与 `@diy-agent/skills` 的 provider 同一份；这里手抄是为了不传 `cwd` 也能建 provider） */
const SKILLS_HELP: SchemaDoc = {
    type: "array",
    desc: "技能清单（空则整节跳过）",
    items: {
        name: { type: "string", desc: "技能名" },
        desc: { type: "string", desc: "说明（含触发词）" },
        path: { type: "string", desc: "SKILL.md 路径（要看全文就 read 它）" },
    },
};

/**
 * 模版节（`identity` / `rules` / `guard`）：**渲染出来的整节文本**，不是值。
 *
 * 真发要的不只是 `persona` 的值，而是 identity.md 渲染出的「你是 … 人物是「X」」+
 * 人物行为指令；rules.md 是行为规范；_guard.md 是保命契约。不在这里渲染，真发就一样不投
 * （209 review P0-1 实测：真发 system 里 persona/身份/<rules>/<guard> 全 false）。
 *
 * 渲染变量用 `core`（不含本节）—— identity.md 只引用 persona，不引用自己。
 */
export function sectionProvider(key: "identity" | "rules" | "guard", core: () => Record<string, unknown>, shared: Shared): ContextProvider {
    return {
        key,
        provide: () => {
            const relpath = DELIVERED_SECTIONS[key];
            const resolve = shared.resolve();
            // 必须走 resolver 取本节正文（草稿 > 项目覆盖 > 内置）：把内置当默认值传进去
            // 等于「项目里改过的 identity/rules 不进真发」—— 正是划分规则当年踩的坑。
            const hit = resolve(`./${relpath}`);
            if (!hit) {
                throw new Error(`缺少模版节：${relpath}`, { cause: { code: "context/missing-section" } });
            }
            return renderSystemDsl({ globals: core(), templates: { [relpath]: hit.source }, entry: relpath, resolve });
        },
    };
}

/** `facts` 节：事实库投影（**没有库就整节缺席**；读失败降级为缺席而不是抛） */
export function factsProvider(home: string, projectId: string, shared: Shared): ContextProvider {
    return {
        key: "facts",
        provide: () => {
            const c = shared.cwd();
            const repoRoot = getProjectPath(projectId);
            // 相对化在这里做而不是在 facts-context 里：`root` 的语义（证据/paths 按仓库根解析）
            // 归内核；装配层只负责「我现在在哪」。
            const relCwd =
                repoRoot === undefined || !c.cwd.startsWith(`${repoRoot}/`) ? undefined : c.cwd.slice(repoRoot.length + 1);
            return buildFactsContext({ home, taskUri: shared.taskUri, ...(relCwd === undefined ? {} : { paths: [relCwd] }) }) ?? undefined;
        },
    };
}

/** `kb` 节：知识库索引（AGENTS.md 里「按需」的条目迁进 facts 后，agent 靠它知道库里有什么） */
export function kbProvider(): ContextProvider {
    return { key: "kb", provide: () => buildKbIndex() ?? undefined };
}

/** `docs` 节：仓库文档索引摘要（真源是仓库文件树；任务不在仓库里 ⇒ 整节缺席） */
export function docsProvider(projectId: string): ContextProvider {
    return {
        key: "docs",
        provide: () => {
            const repoRoot = getProjectPath(projectId);
            if (repoRoot === undefined) return undefined;
            return summarizeDocsIndex(buildDocsIndex({ root: repoRoot })) ?? undefined;
        },
    };
}

/** `room` 节：房间上下文（**只在有房间时出现** —— 缺这个键 = 单人任务逐字不变） */
export function roomProvider(opts: AssembleOptions): ContextProvider {
    return { key: "room", provide: () => opts.room };
}

/** `self` 节：自量（窗口占用 / 上一步消耗 / 本轮累计；**一条数都给不出时整节缺席**） */
export function selfProvider(opts: AssembleOptions): ContextProvider {
    return { key: "self", provide: () => opts.self };
}

/** `reqlog` 节：真发请求的流量日志位置（稳定信息进变量树，模型才能自查上一步发了什么） */
export function reqlogProvider(home: string): ContextProvider {
    return { key: "reqlog", provide: () => reqlogValue({ home, dirRel: LOG_DIR_REL, fileName: dayFile() }) };
}

/**
 * 标准装配：diy-app 用的全套 13 个 provider。
 *
 * ⚠ 顺序有意义：`identity` / `rules` / `guard` 的渲染变量来自 `core()`，
 * 而 `core()` 读的是前 7 个 provider 的值 —— 所以它们必须排在那 7 个之后（这里靠 core 闭包
 * 惰性求值，顺序其实不影响，但保持「先值后节」的阅读顺序）。
 */
export function standardProviders(deps: ProviderDeps, opts: AssembleOptions = {}): ContextProvider[] {
    const shared = sharedOf(deps.home, deps.projectId, opts);
    /** 模版节的渲染变量：不含三个 section 本身 */
    const core = (): Record<string, unknown> => {
        const t = shared.task();
        const c = shared.cwd();
        const p = shared.persona();
        return {
            persona: { name: p.name, instructions: p.instructions },
            diy: { cli: opts.diyCli ?? readRuntimeConfig().cli ?? "diy（未注入 DIY_CLI，勿照抄）", home: deps.home },
            project: { path: getProjectPath(deps.projectId) ?? "" },
            task: {
                uri: shared.taskUri,
                title: t?.title ?? "",
                state: t?.state ?? "",
                parent: t?.parent ?? "",
                created: t?.created ?? "",
                updated: t?.updated ?? "",
                change_type: t?.change_type ?? "",
                module: t?.module ?? "",
                priority: t?.priority ?? "",
                persona: t?.persona ?? "",
                body: t?.body ?? "",
                dir: shared.taskUri ? join(deps.home, shared.taskUri) : "",
            },
            cwd: { path: c.cwd, note: c.note, isFallback: c.isFallback, isTaskDir: c.isTaskDir, isAppDir: c.isAppDir },
            chain: chainOf(deps.home, c.cwd, shared.taskUri, c.isAppDir),
            skills: opts.skills ?? [],
        };
    };
    return [
        personaProvider(shared),
        diyProvider(deps.home, opts),
        projectProvider(deps.projectId),
        taskProvider(deps.home, shared),
        cwdProvider(shared),
        chainProvider(deps.home, shared),
        skillsProvider(shared),
        sectionProvider("identity", core, shared),
        sectionProvider("rules", core, shared),
        sectionProvider("guard", core, shared),
        factsProvider(deps.home, deps.projectId, shared),
        kbProvider(),
        docsProvider(deps.projectId),
        roomProvider(opts),
        selfProvider(opts),
        reqlogProvider(deps.home),
    ].map(withHelp);
}
