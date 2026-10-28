// src/main/workflows/plugins.ts — 宿主注册的**插件**（五个槽位里本宿主用到的那几个）
//
// 依据 ##166 §14.7 / §13.2（**行业不写页面，只写形状翻译**；**引擎查不到的才写代码**）：
//
//     引擎能枚举的 → 配置（只选不写）        引擎查不到的 → 插件（代码）
//       参数类型全集 / 通用渲染器              读外部世界（CI 绿没绿）/ 写外部世界（合 PR）/ 译形状
//
// 本文件有两类插件，**性质不同、别混着读**：
//
//   · `render` 槽（##337）：形状翻译，**纯函数**（不碰 fs / 网络 / DOM）——
//       `patch` → diff · `records` → table · `text` → doc 的 `{ text }`；
//   · `guard` / `action` 槽（##341）：**触外部世界**——`ci_green` 真跑 `ci.command` 看退出码、
//       `pr_mergeable` 真查 / 真合 PR。它们是 `actor: 'system'` 节点的推进判据，
//       也就是用户要的那条「绿线」的唯一实现路径。
//
// ── 为什么外部世界的插件是**两段式**（本任务的一个关键取舍）────────────────────────────
// 内核的插件接口是**同步**的（`GuardPlugin = (ctx) => GuardResult`，见 `diy-flow/src/plugins.ts`），
// 而「跑一条命令」必然是异步的。若在插件里 `spawnSync`，跑 `./sha.sh check` 会把 Electron **主进程**
// 的整个事件循环堵上几十秒（GUI 假死、所有 RPC 排队）。
//
// 故事实**先取后用**：
//   1. 驱动方（`core/flow.ts::stepFlow`）先 `await collectFacts(ctx, deps)` —— 这里做异步 I/O，
//      把它包成同步插件能读的**事实表**（`{ command, code, output }`）；
//   2. 再把事实表交给 `createHostRegistry({ facts })`，内核求值时插件**只读表**（零 I/O）。
// 取不到事实（没预热就求值）⇒ 插件**抛**（`rule.no-downgrade`：宁可炸，也不静默当成「不通过」，
// 否则打错一个字就把工作流悄悄推成另一条路）。
//
// ── 注册表的两个入口 ──────────────────────────────────────────────────────────────
//   · `createRenderRegistry()` —— **只有 render 槽**（纯翻译）。单测（`flow-render.test.ts`）用它
//     钉「声明 renderer == 插件产物 renderer」这条自洽性；`core/flow.ts` 的产物链也只用它。
//   · `createHostRegistry(deps?)` —— render ⊕ guard/action（**完整宿主**）。任何真跑 `createRuntime`
//     的地方都必须用它（否则 dev 定义引用的 `pred:ci_green` 在组合期就报 `unknown-plugin`）。
//
// ⚠️ 「直吃 raw」（节点 `art.plugin` 留空）只有一种合法含义：**raw 本身已经是该 renderer 的 data**
//    （##337 review1 P2-A）—— 宿主不替它包一层，UI 拿到的 `payload` 就是 raw。纯文本 raw ≠ `doc` 的
//    `DocData`（`{ text }`），故文本类节点必须挂 `text` 插件包一层。
//
// ⚠️ 内核**从不调用** `render` 槽（`rg "resolve\('render'" pkgs.ts/diy-flow/src` 零命中）：
//    槽位与 `parseView` 校验是内核给的，**什么时候译、拿哪份 raw 去译是宿主的决定** ——
//    调用点唯一：`core/flow.ts` 的 `translateArtifact`（见那里的立场：无产物 ⇒ null，坏 ⇒ 抛）。

import { exec } from 'node:child_process';
import { createRegistry, type ActionResult, type GuardResult, type PluginContext, type PluginRegistry, type RenderPlugin, type View } from '@diy/flow';
// ⚠️ `ViewData<'…'>` 就是「这个 renderer 要吃的 data 形状」（真源 = `@diy/flow` 的 `view.ts`，##318）。
//    下面每个插件都用它给 payload 站岗：**插件产出**与**渲染器消费**因此由 `tsc` 对齐 ——
//    ##337 review1 P2-A 正是这条缝（声明 `doc`、却把裸文本当 `DocData`），当时没有任何一道机器判据管它。
import type { DiffData, DocData, TableData } from '@diy/flow';

// ═══════════════════════════════════════════════════════════════
// render 槽：raw → 引擎通用渲染器（纯函数，不碰外部世界）
// ═══════════════════════════════════════════════════════════════

/** 把 raw 里「本该是字符串」的部分取出来（翻不了就抛，交给宿主 `callPlugin` 包成 `plugin-threw`） */
function asText(data: unknown, plugin: string): string {
    if (typeof data === 'string') return data;
    // `--file` 放进来的是 JSON 时，一段正文常写成 `"…"` 或 `{ "text": "…" }` —— 两种都认
    if (typeof data === 'object' && data !== null && !Array.isArray(data) && typeof (data as Record<string, unknown>)["text"] === 'string') {
        return (data as Record<string, string>)["text"]!;
    }
    throw new Error(`render 插件 ${plugin} 的 raw 应为字符串（或 { text: string }），实得 ${JSON.stringify(data)?.slice(0, 120)}`);
}

/**
 * `patch` —— raw 是 unified diff 文本 ⇒ `diff` 渲染器要吃的 `DiffData` = `{ lines }`（真源 = `@diy/flow` 的 `view.ts`：`ViewData<'diff'>`）。
 *
 * `DiffLine.text` **含或不含行首标记都行**（渲染器只按 `kind` 上色），故这里按首字符分类后**原样保留文本**：
 * 插件只补「加 / 删 / 上下文」这个语义，剥不剥标记是渲染器的事。
 */
const patch: RenderPlugin = (data): View => {
    const text = asText(data, 'patch');
    const lines = text.split('\n').map((line) => ({
        // 文件头 `--- a/x` / `+++ b/x`（以及 `diff --git` / `@@` / `\ No newline`）都算上下文：
        // 只有「单个 +/- 开头」才是增删行 —— 否则每份 diff 的头两行都会被上成红绿，一眼就错
        kind: line.startsWith('+++') || line.startsWith('---')
            ? ('context' as const)
            : line.startsWith('+')
              ? ('add' as const)
              : line.startsWith('-')
                ? ('del' as const)
                : ('context' as const),
        text: line,
    }));
    // 末尾换行会多切出一个空行；diff 里它没有语义，去掉（只在**最后一个**是空串时）
    if (lines.length > 1 && lines[lines.length - 1]!.text === '') lines.pop();
    const payload: DiffData = { lines };
    return { renderer: 'diff', payload };
};

/** 一行记录的取值：数组行原样当 cells；对象行按列序取值（缺列 ⇒ 空串，值一律 String —— table 只吃字符串） */
function cellsOf(row: unknown, columns: readonly string[] | undefined, plugin: string): string[] {
    if (Array.isArray(row)) return row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
    if (typeof row === 'object' && row !== null) {
        const obj = row as Record<string, unknown>;
        const keys = columns ?? Object.keys(obj);
        return keys.map((key) => (obj[key] === null || obj[key] === undefined ? '' : String(obj[key])));
    }
    if (typeof row === 'string' || typeof row === 'number' || typeof row === 'boolean') return [String(row)];
    throw new Error(`render 插件 ${plugin} 的行应为数组 / 对象 / 标量，实得 ${JSON.stringify(row)}`);
}

/**
 * `records` —— raw 是「若干条记录」的清单 ⇒ `table` 渲染器要吃的 `TableData` = `{ columns?, rows }`（真源 = `@diy/flow` 的 `view.ts`：`ViewData<'table'>`）。
 *
 * 认三种 raw（都不猜语义，只做形状收窄）：
 *   · `{ columns?, rows }` —— 显式列；
 *   · **裸数组** —— 只有 rows，列序取第一行的键序；
 *   · **纯文本**（##341 补）—— **一行一条**，每条一行 cell（列名缺省）。加这一支的理由：
 *     宿主 `dev.ts` 自己声明的 review 产物就是「评审结论清单（**一行一条**：结论 / 意见 / 依据）」，
 *     而节点执行器落进袋里的是 agent 的**结论文本** —— 老实现只吃前两种，纯文本 raw 会在
 *     「写前先试译」那一步被拒（`flow view` 报 `plugin-threw`），于是「评审这一步没有产物」。
 *     一行一条是本工作流自己声明的形状，补齐它不算「猜」。
 */
const records: RenderPlugin = (data): View => {
    // 纯文本：一行一条（去尾随空行；空串 ⇒ 0 行 = 空表，不编造）
    if (typeof data === 'string') {
        const lines = data.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
        const payload: TableData = { rows: lines.map((line) => ({ cells: [line] })) };
        return { renderer: 'table', payload };
    }
    // 认两种结构化 raw：裸数组（= 只有 rows）/ 对象 `{ columns?, rows }`；别的当场拒（不猜、不降级）
    let rawRows: unknown[];
    let rawColumns: unknown;
    if (Array.isArray(data)) {
        rawRows = data;
    } else if (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)["rows"])) {
        rawRows = (data as Record<string, unknown>)["rows"] as unknown[];
        rawColumns = (data as Record<string, unknown>)["columns"];
    } else {
        throw new Error(`render 插件 records 的 raw 应为数组 / { columns?, rows } / 一行一条的文本，实得 ${JSON.stringify(data)?.slice(0, 120)}`);
    }
    const columns = Array.isArray(rawColumns) ? rawColumns.map((c: unknown) => String(c)) : undefined;
    const rows = rawRows.map((row) => ({ cells: cellsOf(row, columns, 'records') }));
    const payload: TableData = columns === undefined ? { rows } : { columns, rows };
    return { renderer: 'table', payload };
};

/**
 * `text` —— raw 是**一段纯文本**（CI 日志 / 正文 / 说明）⇒ `doc` 渲染器要吃的 `{ text: string }`。
 *
 * 为什么非有它不可（##337 review1 P2-A）：`doc` 的 data 是 `DocData` = `{ text }`（真源 =
 * `@diy/flow` 的 `view.ts`），**裸字符串不是它** —— 一句 `plugin` 留空就把裸文本当 `doc` 的 data，
 * UI 上只会显示「形状不符」，用户永远看不到 CI 输出。纯文本 → `{ text }` 这件事只有行业（= 这里）知道。
 *
 * 认两种 raw：裸字符串（管道进来的正文）与已经是 `{ text }` 的对象（幂等，便于二次加工）。
 */
const text: RenderPlugin = (data): View => {
    const payload: DocData = { text: asText(data, 'text') };
    return { renderer: 'doc', payload };
};

/**
 * 造一份**只含 render 槽**的注册表（每次调用都是新的：与内核 `createRegistry()` 同风格，不留共享可变态）。
 *
 * 加插件 = 在下面链一条 `.register('render', 名, 函数)` + 在定义的 `art.plugin` 里引用同一个名。
 * 名字一旦被实例数据引用就等于公开契约：**只增不改**（改名 = 老产物袋译不出来）。
 */
export function createRenderRegistry(): PluginRegistry {
    return createRegistry()
        .register('render', 'patch', patch)
        .register('render', 'records', records)
        .register('render', 'text', text);
}

// ═══════════════════════════════════════════════════════════════
// guard / action 槽：外部世界的「过没过 / 动不动手」（##341）
// ═══════════════════════════════════════════════════════════════

/** 一条命令的结果（`output` = stdout ⊕ stderr —— CI 日志要能整段看见，分两股反而丢信息） */
export interface CommandResult {
    readonly code: number;
    readonly output: string;
}

/** 事实（`pred:` / `action:` 求值的**输入**）：异步取、同步读（见文件头「两段式」） */
export interface CommandFact {
    readonly command: string;
    readonly code: number;
    readonly output: string;
    /** `action` 专属：真动手（合并）了没 —— 没动手时 `code` 是「查询命令」的退出码 */
    readonly applied?: boolean;
}

/** 宿主注入给插件的外部世界能力（真实现缺省；单测 / 意图测试可换替身 ⇒ 「不真出网」可证） */
export interface HostPluginDeps {
    /** 命令类插件的**工作目录**；缺省 = 进程 cwd（= 应用包根）。`flow run --cwd` 可覆盖 */
    readonly cwd?: string;
    /**
     * 跑一条 shell 命令。**必须异步**：预热期跑的命令（`./sha.sh check` 这种）可以跑几十秒，
     * 同步版会把 Electron 主进程的事件循环整个堵住（GUI 假死 + 所有 RPC 排队）——
     * 那正是「两段式」要避免的事（见文件头）。
     */
    readonly runCommand?: (command: string, cwd: string) => Promise<CommandResult>;
    /** 真合并 PR 的动作（`apply: true` 时才走）；缺省 = `gh pr merge --squash --delete-branch` */
    readonly mergePr?: (cwd: string) => Promise<CommandResult>;
    /** **预热好的事实表**（键 = 插件名），同步插件只读它 —— 缺失即抛（见文件头） */
    readonly facts?: Readonly<Record<string, unknown>>;
}

/** 缺省的命令执行器：真跑（cwd = 工作目录；超时收口 —— 卡死的命令不能拖住整轮） */
function execCommand(command: string, cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
        exec(
            command,
            { cwd, timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf-8' },
            (err, stdout, stderr) => {
                const output = `${stdout ?? ''}${stderr ?? ''}`;
                if (!err) return resolve({ code: 0, output });
                // `exec` 的 err.code 是退出码（number）或系统错误串（如 'ETIMEDOUT'）
                const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1;
                resolve({ code, output: `${output}${output === '' ? '' : '\n'}[宿主] ${err.message}` });
            },
        );
    });
}

/** 取本节点分组的 L2 参数袋（`ctx.params[节点 id]`；内核已校验 + 已合并缺省 + 冻结） */
function bagOf(ctx: PluginContext): Record<string, unknown> {
    const bag = ctx.params[ctx.node.id];
    return typeof bag === 'object' && bag !== null ? (bag as Record<string, unknown>) : {};
}

/** 从事实表里取一条事实：**没有就抛**（没预热就求值是编排 bug，不许静默当成「不通过」） */
function factOf<T>(deps: HostPluginDeps, name: string): T {
    const fact = deps.facts?.[name];
    if (fact === undefined) {
        throw new Error(
            `插件 ${name} 的事实没有预热：pred:/action: 的求值必须先 await collectFacts（见 workflows/plugins.ts 头注）——` +
                `直接 createRuntime(...).step() 会让主进程同步阻塞`,
        );
    }
    return fact as T;
}

/** 本节点上的命令字符串（缺省值由定义给；这里再兜一道，免得空串进 shell） */
function commandOf(ctx: PluginContext, key: string, fallback: string): string {
    const raw = bagOf(ctx)[key];
    const command = typeof raw === 'string' && raw.trim() !== '' ? raw : fallback;
    return command;
}

/**
 * `pred:ci_green` —— **读**外部世界：跑本节点的 `ci.command`，退出码 0 即绿。
 *
 * 判据只看**退出码**（命令说什么算绿，是工作流作者写在 `ci.command` 里的事）。
 * 不绿时把输出尾部带进 `reason`（审计 / UI 上要看得见「为什么没绿」）。
 */
const ciGreen: (deps: HostPluginDeps) => (ctx: PluginContext) => GuardResult = (deps) => (_ctx) => {
    const fact = factOf<CommandFact>(deps, 'ci_green');
    if (fact.code === 0) return { pass: true };
    const tail = fact.output.trim().split('\n').slice(-8).join('\n');
    return { pass: false, reason: `CI 未绿（${fact.command}，退出码 ${fact.code}）：\n${tail}` };
};

/**
 * `action:pr_mergeable` —— **查**（可合并吗）+ 按开关**合**（真动手）。
 *
 * 默认**只查不合**：查询命令（`merge.command`，缺省 `gh pr view …`）退出码 0 且输出里含
 * `MERGEABLE` 即「可合并」；`merge.apply = true` 才真跑 `gh pr merge --squash --delete-branch`。
 * 为什么默认不合：这条链路直接对着**真实仓库**，一个默认值就替人合掉 PR 是不可接受的
 * ——「真合并」必须是一次显式选择（L2 旋钮，用户可改值）。
 */
const prMergeable: (deps: HostPluginDeps) => (ctx: PluginContext) => ActionResult = (deps) => (_ctx) => {
    const fact = factOf<CommandFact>(deps, 'pr_mergeable');
    const mergeable = fact.code === 0 && /\bMERGEABLE\b/.test(fact.output);
    if (!mergeable) return { ok: false, ref: fact.output.trim().split('\n').slice(-3).join(' ') || `退出码 ${fact.code}` };
    return fact.applied === true
        ? { ok: true, ref: `已合并（${fact.command}）` }
        : { ok: true, ref: `可合并（${fact.command}）` };
};

/**
 * 造一份**完整宿主注册表**（render ⊕ guard/action）。任何真跑 `createRuntime` 的地方都用它
 * （`core/flow.ts` 的 `REGISTRY` 与 `stepFlow`）—— 少注册一个名字，组合期就 `unknown-plugin`。
 */
export function createHostRegistry(deps: HostPluginDeps = {}): PluginRegistry {
    return createRenderRegistry()
        .register('guard', 'ci_green', ciGreen(deps))
        .register('action', 'pr_mergeable', prMergeable(deps));
}

// ═══════════════════════════════════════════════════════════════
// 事实预热：异步 I/O 在这里做完，同步插件只读表（见文件头「两段式」）
// ═══════════════════════════════════════════════════════════════

/** 一条预热好的事实（`PluginContext` 也带上：旁路落产物要知道是哪个节点） */
export interface PreparedFact {
    readonly name: string;
    readonly ctx: PluginContext;
    readonly fact: CommandFact;
}

/**
 * 按**当前节点 guard 里引用的插件名**逐条取事实（真跑命令）。`action:` 的 `apply` 语义也在这里落地
 * （读本节点参数、必要时真合并）—— 因为「动手」是异步的，而插件求值是同步的。
 *
 * 返回 `[]` = 这个节点没有需要外部世界的事实（纯 `prompt:` 节点 / 空 guard）。
 */
export async function collectFacts(ctx: PluginContext, deps: HostPluginDeps = {}): Promise<PreparedFact[]> {
    const cwd = deps.cwd ?? process.cwd();
    const run = deps.runCommand ?? execCommand;
    const out: PreparedFact[] = [];
    for (const raw of ctx.node.guard) {
        const at = raw.indexOf(':');
        const prefix = at > 0 ? raw.slice(0, at) : '';
        const name = at > 0 ? raw.slice(at + 1) : '';
        if (prefix === 'pred' && name === 'ci_green') {
            const command = commandOf(ctx, 'command', '(未声明 command)');
            const r = await run(command, cwd);
            out.push({ name, ctx, fact: { command, code: r.code, output: r.output } });
            continue;
        }
        if (prefix === 'action' && name === 'pr_mergeable') {
            const command = commandOf(ctx, 'command', 'gh pr view --json mergeable,state -q .mergeable');
            const r = await run(command, cwd);
            const mergeable = r.code === 0 && /\bMERGEABLE\b/.test(r.output);
            const apply = bagOf(ctx)["apply"] === true;
            if (mergeable && apply) {
                const merge = deps.mergePr ?? ((c: string) => execCommand('gh pr merge --squash --delete-branch', c));
                const applied = await merge(cwd);
                out.push({ name, ctx, fact: { command: `${command} → 合并`, code: applied.code, output: `${r.output}${applied.output}`, applied: applied.code === 0 } });
                continue;
            }
            out.push({ name, ctx, fact: { command, code: r.code, output: r.output } });
            continue;
        }
        // 别的名字归别人管：内核在组合期就会报未注册（这里不重复判、也不替它猜）
    }
    return out;
}
