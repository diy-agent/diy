// index.ts — apps/chat 的装配（##505）：只存插件清单，业务全在 @diy-agent/bot。
// 落盘 vs 内存由 `createBotChat({ persist })` 决定。
// 2026-11-07 改：**缺省落盘**（原先缺省内存）—— S1 的验收标准是「重启后历史还在」，
// 而内存缺省下关掉窗口就丢历史，等于每个会话只能活一次。
// 需要纯内存（测试/演示）就显式 `DIY_CHAT_PERSIST=0`。

import * as botConfigPageMain from "@diy-agent/bot-config-page";
import * as chatPageMain from "@diy-agent/chat-page/main";
import * as modelConfigPageMain from "@diy-agent/model-config-page";
import type { PluginEntry } from "@diy-agent/workbench";
import { asToolSet, createAgentHost, createFileBotStore, modelChoices, systemOf, workspaceOf, type BotStore } from "@diy-agent/bot";
import { agentsChain } from "@diy-agent/agents-chain";
import { kbRootOf, scanKb } from "@diy-agent/kb";
import { skillsOf } from "@diy-agent/skills";
import { TrafficStore } from "@diy-agent/traffic";
import { homedir } from "node:os";
import { collectSelfInfo, judgeSelfKill } from "@diy-agent/tools";
import { os } from "@diy-agent/os";
import { RunRegistry, makeJobTool } from "@diy-agent/jobs/node";
import { buildTools, detectShells, makeShellTool, shellToolName } from "@diy-agent/tools";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TITLE } from "./title.js";

const TRAFFIC = new Map<string, TrafficStore>();

/** 每个数据根一个 TrafficStore（同 `home` 重复进来必须拿到同一个实例，否则订阅与窗口各持一份） */
function trafficFor(home: string): TrafficStore {
    const hit = TRAFFIC.get(home);
    if (hit !== undefined) return hit;
    const store = new TrafficStore({ persist: true, dir: join(home, "log", "network") });
    TRAFFIC.set(home, store);
    return store;
}

const SHELLS = detectShells(); // 本机 shell 能力（探测一次；shell 路径不会变）
// 后台 run 表：一个数据根一张（进程内）。**不传 notifier = silent**（只落账不通知）——
// bot 目前没有「下一轮唤醒」通道，模型靠 `job wait` 同步等（##515 3b 口径）。
const REGISTRIES = new Map<string, RunRegistry>();
function registryFor(home: string): RunRegistry {
    const hit = REGISTRIES.get(home);
    if (hit) return hit;
    const reg = new RunRegistry({ rootDir: join(home, "log", "job", "runs"), shells: detectShells });
    REGISTRIES.set(home, reg);
    return reg;
}

export interface Assembly {
    readonly title: string;
    readonly plugins: readonly PluginEntry[];
}

export interface AssemblyOptions {
    readonly sessions?: unknown;
    readonly home?: string;
    /** 聊天宿主与「Bot 配置」页**共用同一个**（不传则按 home 建，##505 bug 二修） */
    readonly botStore?: BotStore;
    readonly title?: string;
}

/** 按注入构造装配清单（纯装配：宿主自己是懒的） */
export function createAssembly(options: AssemblyOptions = {}): Assembly {
    const home = options.home ?? process.env["DIY_HOME"];
    // ##505 bug 二修：落盘入口也只建一个 store（之前两页各建，文件模式同样中招）
    const botStore = options.botStore ?? (home ? createFileBotStore({ home, sessionsDir: join(home, "sessions", "chat") }) : undefined);
    return {
        title: options.title ?? TITLE,
        plugins: [
            { id: "chat-page", type: "module", data: { module: chatPageMain }, config: chatConfig(home, options.sessions, botStore) },
            {
                id: "model-config-page",
                type: "module",
                data: { module: modelConfigPageMain },
                config: homeConfig(home),
            },
            {
                id: "bot-config-page",
                type: "module",
                data: { module: botConfigPageMain },
                config: botConfig(home, botStore),
            },
        ],
    };
}

export const ASSEMBLY: Assembly = createAssembly();
/** 显式注入优先；否则数据根缺席（纯库 import / 单测）⇒ 不注入，插件退回单会话假回复。 */
function chatConfig(home: string | undefined, sessions: unknown, botStore: BotStore | undefined): unknown {
    if (sessions !== undefined) return { sessions };
    if (home === undefined || home === "") return {};
    return {
        // ##519：宿主**只剩一个**（Agent 聚合，内存态 + 快照）；旧的 createBotChat 分支已删。
        // 页面（chat-page）不用改 —— 它只认 BotChatHost 契约，新宿主是适配器。
        sessions: createAgentHost({
            home,
            // 流量（##534）：diy2 之前是黑箱 —— `~/.diy2/log/network/` 只有 models.dev 一条，
            // LLM 请求一条没记。落盘 +wi 内存窗口都开，才能既查历史又给未来的 `tail -f` 用。
            traffic: trafficFor(home),
            botStore: botStore ?? createFileBotStore({ home, sessionsDir: join(home, "sessions", "chat") }),
            // 与旧宿主同一口径（展开已配置账号的三段式）
            models: () => modelChoices(home),
            // 工具能力：与旧宿主同一份 buildTools（cwd = bot 工作目录、自杀护栏同源）
            toolsFor: (bot) => botToolsFor(home, bot.id).tools,
            // system 段（##530）：AGENTS.md 链 + 知识库 + 技能，建 agent 时算一次
            systemFor: (bot) => systemForBot(home, bot.id, bot.instructions ?? ""),
        }),
    };
}

/**
 * 一个 bot 的 system 段（##530）。
 *
 * 为什么在宿主算而不是 `@diy-agent/bot` 里算：`home` / `workspace` 是宿主概念，
 * bot 包不该知道 diy 的目录约定（沿用 `systemOf` 的「providers 由调用方给」那条边界）。
 *
 * ⚠ 只有 `chain` / `kb` / `skills` 三个 + 必需的 `diy` / `cwd`：
 * context 包的 schema 对这几个是必填的，少一个 `assembleFromProviders` 就抛。
 */
function systemForBot(home: string, botId: string, instructions: string): string {
    const workspace = workspaceOf(home, botId);
    return systemOf({
        instructions,
        providers: [
            { key: "diy", provide: () => ({ cli: "", home }) },
            {
                key: "cwd",
                provide: () => ({ path: workspace, note: "", isFallback: false, isTaskDir: false, isAppDir: false }),
            },
            { key: "chain", provide: () => agentsChain({ appHome: join(home, "__no_app__"), cwd: workspace }) },
            {
                key: "kb",
                provide: () => {
                    const byPath = new Map<string, { path: string; desc: string; sections: number; scope: string }>();
                    for (const { dir, scope } of [
                        { dir: join(home, "knowledge"), scope: "global" },
                        { dir: kbRootOf(workspace), scope: "project" },
                    ]) {
                        for (const e of scanKb(dir).entries) {
                            byPath.set(e.path, { path: e.path, desc: e.desc, sections: e.sections, scope });
                        }
                    }
                    return byPath.size === 0 ? undefined : { entries: [...byPath.values()] };
                },
            },
            { key: "skills", provide: () => skillsOf({ cwd: workspace, globalRoot: join(homedir(), ".agents") }) },
        ] as never,
    });
}

/**
 * 给一个 bot 造工具集（##514 第 5 步 / ##515 第 2 步）：cwd = bot 自己的工作目录（只影响相对路径，
 * **不限制权限**）；shell 工具（bash / pwsh）与 diy-app **同一份内核**，本层只注入 cwd ——
 * 不给 `background`（job 账本归 diy-app，第 3 步再评估）也不给审计（bot 没有 `agent-bash.jsonl`）。
 * `buildTools` 返回 ai-sdk 的 `ToolSet`；bot 只取 `execute`（结构化类型）⇒ 断言而不逐字段重包。
 */
export function botToolsFor(home: string, botId: string): { cwd: string; tools: ReturnType<typeof asToolSet> } {
    const cwd = workspaceOf(home, botId);
    mkdirSync(cwd, { recursive: true });
    const registry = registryFor(home);
    // 自杀护栏（2026-11-05 恢复）：判据归宿主 —— 只有这里知道「哪个数据根是生产」。
    // 拦住「这条命令会不会把宿主自己干掉」，具体判据见 @diy-agent/tools/shell/guard。
    const guardSelf = (command: string) => {
        const self = collectSelfInfo(home, (pid) => os.hopSync(pid));
        if (self === null) return undefined; // 采样失败 ⇒ 放行（护栏不能阻断正常开发）
        // 「谁是我家人」按 **DIY_HOME** 判 —— 只有环境变量能把「生产实例」
        // 和「agent 自建的 dev/测试实例」分开（路径/命令行都分不开）。
        const homeOf = (pid: number): string | undefined => {
            const envs = os.environmentsOf([pid]);
            return envs?.get(pid)?.["DIY_HOME"];
        };
        const verdict = judgeSelfKill(command, self, homeOf);
        return verdict.blocked ? { block: true as const, reason: verdict.reason } : undefined;
    };
    const shell = SHELLS.map((spec) => [
        shellToolName(spec),
        makeShellTool(spec, {
            cwd,
            limits: { bashTimeoutMs: 0 },
            beforeRun: guardSelf,
            // `background: true` → 立刻返回 id（##515 3b）。缺省不设超时；显式正数才带 deadline。
            background: async ({ command, timeoutMs, toolCallId }) => {
                const run = await registry.spawn({
                    command,
                    cwd,
                    ...(toolCallId ? { title: toolCallId } : {}),
                    ...(timeoutMs > 0 ? { deadlineMs: timeoutMs } : {}),
                });
                if (run.state === "failed") throw new Error(`[后台启动失败] ${run.error ?? "未知原因"}（工作目录：${cwd}）`);
                return [
                    `[已转后台] ${run.id}（pid ${run.pid}）`,
                    `输出：${run.logPath}`,
                    "查状态用 job status，取输出用 job output；长任务别干等，回来用 job wait / job output 取增量。",
                ].join("\n");
            },
        }),
    ]);
    const job = makeJobTool({ registry, scopeLabel: "本 bot" });
    return { cwd, tools: asToolSet({ ...buildTools({ cwd, extraTools: Object.fromEntries(shell) }), job }) };
}

/** Bot 配置页：注入了 store 就共用（内存入口），否则按数据根建文件实现（落盘入口）。 */
function botConfig(home: string | undefined, store: BotStore | undefined): unknown {
    if (store !== undefined) return home === undefined || home === "" ? { store } : { home, store };
    return homeConfig(home);
}

/** 配置页只认数据根（`$DIY_HOME`）；缺席时页面方法会明确报错，不猜路径。 */
function homeConfig(home: string | undefined): unknown {
    return home === undefined || home === "" ? {} : { home };
}
