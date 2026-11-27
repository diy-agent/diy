// server/config.ts —— diy2 的**运行配置唯一真源**：数据根 / 端口 / 环境 / 入口名 / 产物目录。
//
// 输入面只有一处：**入口的 argv**（声明在 src/cli/options.ts，zod + `.cliOption()`，
// 与 CLI 用的是同一个解析器 `@diy-agent/rpc/cli`）。本文件**不读**任何 `DIY2_*` 环境变量。
//
// 为什么不读环境（##dev-app 构建对齐的后续）：
//   · 环境变量谁都能改、看不见、还继承 —— 外层 shell / agent 里漏出来的 `DIY2_ENV=production`
//     会让一次 `./sha.sh lab` 去写生产数据根（实测现场：lab 找不到实例、数据写进真库）；
//   · 同一个参数有三种写法（`--port` / `DIY2_PORT` / `<home>/app.port` 记录），
//     「这次到底监听哪个端口」没有一处能答全；
//   · 变体（variant）曾同时兼任「运行空间」与「产物目录」，于是 dev 与 prod 的产物目录名不同，
//     `bin/diy2` 得先猜变体才能找到产物 —— 猜法一旦和 sha.sh 不一致就静默跑旧的。
//
// 现在的规矩：
//   · **mode**（production / development / test）由入口声明：生产入口 production，dev 入口
//     development，测试 test。不是参数，不来自环境（它描述「我是谁」，不是「用户要什么」）。
//   · **launch**（入口名，注册表自报）缺省由 mode 推（prod / lab / test），staging 显式给。
//   · **数据根 / 端口 / 名字 / 工具面**一律来自 argv（`--home` / `--port` / `--name` / `--tools`）。
//   · **产物目录固定** `<appRoot>/build/prod/{web,server,cli}`：一个包目录一份产物。
//     多份并存靠 worktree（每个 worktree 有自己的 build/），不靠 `<variant>/` 子目录。
//
// 环境变量仍然**出**（`DIY_MODEL_CONFIG` 是给 entity-runtime 的信号，下游库读它），但不**进**。
//
// 纯函数尽量多：端口裁决 / 数据根裁决 / 生产根判据都有单测（tests/config.test.ts），
// 因为这三条都是「错了不会报错，只会静默用错数据」的类型。

import { DEFAULT_BUDGET } from '@diy-agent/entity-runtime';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** 产物里的 app 标识（`/api/info` 自报、注册表 `app` 字段、探活判据共用一处） */
export const APP_ID = 'diy2';

/**
 * 生产缺省端口（全局命令 `diy2` 的「门牌」）。
 *
 * 只是**缺省**，不是身份：真正的端口永远看 `<home>/app.port` 或 `--port`。
 * 非生产不吃这个数（见 `resolvePort`），否则多 worktree 的 lab 实例会把生产门牌占住。
 */
export const PROD_DEFAULT_PORT = 5192;

/** 产物根目录名：一个包目录一份产物（`<appRoot>/build/prod/{web,server,cli}`） */
export const BUILD_DIR_NAME = 'prod';

export type Diy2Env = 'production' | 'development' | 'test';
/** 端口从哪来：显式 argv / `app.port` 记录（仅非生产） / 缺省 */
export type PortSource = 'cli' | 'recorded' | 'default';

/** 入口给的那几个参数（argv 解析后的形状；声明在 src/cli/options.ts） */
export interface ConfigOverrides {
    home?: string | undefined;
    port?: number | undefined;
    name?: string | undefined;
    launch?: string | undefined;
    /** 工具面：shell = 带 bash；files = 只读文件工具 */
    tools?: 'shell' | 'files' | undefined;
    /** 一轮的步数上限（`--max-steps`）；缺省 = 内核 200 */
    maxSteps?: number | undefined;
    /** 单条 bash 命令的超时（`--bash-timeout-ms`）；缺省 = 内核 300s */
    bashTimeoutMs?: number | undefined;
    // 压缩预算不再是运行参数：上限是全局常量（`DEFAULT_BUDGET`），
    // 手工压缩在 UI 上按「保留最近几轮」调（2026-11-25 对齐 diy1 的 keepRounds）。
    /** 显式放行生产数据根（只给 dev 入口用；生产入口不需要） */
    allowProdHome?: boolean | undefined;
    /** 显式 UI 产物目录（调试用；缺省 `<buildRoot>/web`，不存在 = 不提供静态） */
    webDir?: string | undefined;
    /** 显式 model.yaml（缺省：本数据根 > 本 launch 的仓库级数据根） */
    modelConfig?: string | undefined;
}

export interface Diy2Config {
    app: typeof APP_ID;
    /** 数据根（唯一写盘位置：diy2.db / app.port / 日志 / 设备级知识库） */
    home: string;
    /**
     * 设备根（`~/.diy2` = 生产数据根）：设备级知识库 `<设备根>/knowledge` 的位置。
     * 与 `home` **分开**：lab 实例的 home 是 `run/diy2/lab`，设备库仍是这一份。
     */
    deviceHome: string;
    /** 运行环境（production 之外的专属能力判据）—— 由入口声明，不是参数 */
    env: Diy2Env;
    /** 入口名（prod / lab / staging / test…）：注册表自报 + 数据根缺省的分层名 */
    launch: string;
    /** 首选端口；0 = 让内核分配 */
    port: number;
    portSource: PortSource;
    /** 端口记录（`<home>/app.port` 的内容）；无记录 / 坏内容 = null。**不是**存活证据 */
    recordedPort: number | null;
    /** 端口记录文件（`<home>/app.port`；监听成功后回写实际端口，**退出不删**） */
    portFile: string;
    /** sqlite 数据库文件 */
    dbPath: string;
    /** 本包根目录（`apps/diy2`，发布形态是 node_modules 下的包目录） */
    appRoot: string;
    /** 产物根（`<appRoot>/build/prod`；web / server / cli 都在它下面） */
    buildRoot: string;
    /** git worktree 根（不在仓库里 = null，例如 npm 安装的发布形态） */
    repoRoot: string | null;
    /** UI 产物目录；undefined = 不提供静态服务（开发期交给 vite） */
    webDir: string | undefined;
    /** model.yaml 路径（entity-runtime 通过 `DIY_MODEL_CONFIG` 读它） */
    modelConfigPath: string | undefined;
    /** 实例名（`--name`），多实例时人认得出的身份；缺省 null */
    name: string | null;
    /**
     * 手工压缩默认保留的轮数（**全局常量**，不来自 argv）。
     * 自动压缩不看它：判据是模型窗口水位（窗口 × 0.16 保留 / 窗口 − max(10%,16k) 触发）。
     */
    compact: { keepTurns: number };
    /** 工具面：shell = 带 bash；files = 只读文件工具（`--tools files`） */
    tools: 'shell' | 'files';
    /** 裁决过程中的「本该报却没报」的事（被拒的生产根等）：入口负责打出来 */
    notes: string[];
    /** 一轮的步数上限（`--max-steps`）；undefined = 用内核缺省（200） */
    maxSteps: number | undefined;
    /** 单条 bash 命令的超时（`--bash-timeout-ms`）；undefined = 用内核缺省（300s，与 diy1 同值） */
    bashTimeoutMs: number | undefined;
}

/** 真实家目录（**不读 `$HOME`**：测试 / 隔离实例会改写它，生产根判据不能跟着漂） */
export function realHomeDir(): string {
    try {
        return userInfo().homedir || homedir();
    } catch {
        return homedir();
    }
}

/**
 * diy2 的生产数据根：`~/.diy2`（与 diy1 的 `~/.diy` 并列）。
 *
 * 2026-11-26 裁：原来是 `~/.diy/diy2` —— 家目录里看不出「这是谁的」，且与 diy1 的设备根
 * 上下级绞在一起（`DIY_HOME` 一变量两语义的孳生处之一）。现在 diy2 自己一级，设备库
 * （`<home>/knowledge`）跟着 home 走，`DIY_HOME` 也就只有「实例数据根」一种含义。
 *
 * 为什么是函数不是常量：`realHomeDir()` 每次现取（测试 / 隔离实例换 HOME 才生效）。
 */
export function prodHomeDir(): string {
    return join(realHomeDir(), '.diy2');
}

/** 路径归一（`..` / `./` / 尾斜杠 / 符号链接都能对上），用于「是不是同一个数据根」的判据 */
export function samePath(a: string, b: string): boolean {
    return resolve(a) === resolve(b);
}

/** 入口名缺省：生产 prod，测试 test，其余 lab（staging 显式给） */
export function defaultLaunch(mode: Diy2Env): string {
    if (mode === 'production') return 'prod';
    if (mode === 'test') return 'test';
    return 'lab';
}

/**
 * 「生产入口 + 非生产数据根」时的标签：取数据根目录名（`run/diy2/lab` → `lab`）。
 *
 * 为什么：`bin/diy2 web --home run/diy2/lab` 不带 `--launch` 时，按 env 缺省会叫 `prod` ——
 * 于是自报成了「开发/prod home=…/run/diy2/lab」，跟包级入口（`apps/diy2/sha.sh lab` 传
 * `--launch lab`）叫法不一，同一条命令的两种发起方式在注册表里成了两个标签。
 * 目录名不合法 / 是根目录 → 回落缺省，不硬凑。
 */
function sandboxLaunch(home: string): string | undefined {
    const name = basename(home);
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : undefined;
}

/**
 * 生产数据根：diy2 的 `~/.diy2`，外加**历史两个**（`~/.diy` 与 `~/.diy/diy2`）。
 * 判据只在这里一处；`resolveHome` 用它拦「dev 偷用生产根」，`describeConfig` 用它标「生产」。
 * 旧两个留着是有用的：迁移前遗留的目录仍算生产根，dev 入口不会去写脏它。
 */
export function isProdHome(home: string): boolean {
    const real = realHomeDir();
    return (
        samePath(home, prodHomeDir()) ||
        samePath(home, join(real, '.diy')) ||
        samePath(home, join(real, '.diy', 'diy2'))
    );
}

/** 是不是一个存在的文件 / 目录（不存在 / 没权限 / 路径怪 = false，不抛） */
async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

async function isDir(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/** 从某个目录向上找本包根（`package.json` 的 name 命中）—— 产物里也找得到 */
export async function findAppRoot(start: string): Promise<string | undefined> {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
        const manifest = join(dir, 'package.json');
        if (await isFile(manifest)) {
            try {
                const pkg = JSON.parse(await readFile(manifest, 'utf8')) as { name?: string };
                if (pkg.name === '@diy-agent/app-diy2') return dir;
            } catch {
                /* 半截 / 坏 JSON：继续往上，不当致命错误 */
            }
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
    return undefined;
}

/** 从某个目录向上找 git worktree 根（`diy.yaml` + `apps/` 是仓库的心跳；发布形态没有） */
export async function findRepoRoot(start: string): Promise<string | undefined> {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
        if ((await isFile(join(dir, 'diy.yaml'))) && (await isDir(join(dir, 'apps')))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
    return undefined;
}

/** 产物根：`<appRoot>/build/prod`（**固定**，不跟 launch 走 —— 变体目录已废） */
export function buildRootOf(appRoot: string): string {
    return join(appRoot, 'build', BUILD_DIR_NAME);
}

/** UI 产物目录（`<buildRoot>/web`；是否存在由调用方判断） */
export function webDirOf(appRoot: string): string {
    return join(buildRootOf(appRoot), 'web');
}

/** 服务端产物入口（`<buildRoot>/server/index.mjs`；`bin/diy2` / sha.sh 的 start 都认这个） */
export function serverEntryOf(appRoot: string): string {
    return join(buildRootOf(appRoot), 'server', 'index.mjs');
}

/** CLI 产物入口（`<buildRoot>/cli/index.mjs`） */
export function cliEntryOf(appRoot: string): string {
    return join(buildRootOf(appRoot), 'cli', 'index.mjs');
}

/**
 * 数据根裁决：显式 `--home` 优先；生产缺省 `~/.diy2`；**非生产没给直接抛错**。
 *
 * 为什么不再按 launch 推导（2026-11-23 裁）：那条回落把数据根放进 `<appRoot>/build/<launch>/home`，
 * 也就是**产物树**里 —— `sha.sh clean` = `rm -rf ./build`，一次自愈就把库删了（真发生过）。
 * 现在路径只在入口脚本算（`run/diy2/<label>`），server 只认显式值。
 *
 * 非生产下拿到**生产根** → 拒绝并抛错（浏览器里点错一个房间就写脏真库；不静默纠正）。
 */
export function resolveHome(opts: {
    mode: Diy2Env;
    explicit?: string | undefined;
    allowProdHome?: boolean | undefined;
}): { home: string } {
    const explicit = opts.explicit?.trim();
    if (explicit === undefined || explicit === '') {
        if (opts.mode === 'production') return { home: prodHomeDir() };
        throw new Error(
            '非生产实例必须显式给数据根：--home <dir>（或 DIY2_HOME=<dir>）' +
                ' —— 生产入口缺省 ~/.diy2，非生产不再按 launch 推导路径',
            { cause: { code: 'config/home-required' } },
        );
    }
    if (opts.mode !== 'production' && isProdHome(explicit) && opts.allowProdHome !== true) {
        throw new Error(`拒绝非生产入口使用生产数据根 ${explicit}` + '（确要如此：--home 加 --allow-prod-home）', {
            cause: { code: 'config/prod-home-refused' },
        });
    }
    return { home: resolve(explicit) };
}

/**
 * 端口裁决：`--port` > `app.port` 记录（仅非生产） > 缺省（生产 5192，其余 0）。
 *
 * 唯一特殊规则：**非生产不沿用记录里的 5192**（`PROD_DEFAULT_PORT`）。旧数据根里的
 * `app.port` 留着一堆 5192，dev 照单沿用就把生产门牌占住了 —— 与仓库 ##328 同一现场。
 *
 * `app.port` 的语义就一句话：**上次监听成功的端口，退出不删**。好处是「Ctrl-C 再起」与
 * 「改 server 代码自动重启（exit 75）」都还回同一个 URL —— 否则每次都换内核随机端口，
 * 书签 / 已开的标签页 / HMR 重连全指到旧地址。
 *
 * 但它**不是活体证据**：里面的数只说明「曾经用这个端口起过」。进程崩了（SIGKILL / OOM /
 * 断电）它不会变，端口释放后也可能被别人的实例占住。「现在有没有人在跑」一律靠探活
 * （`GET /api/info` 自报的 home + 注册表 pid），不要从"文件在不在 / 内容是什么"推存活。
 *
 * 生产**不把记录当监听端口**：生产的门牌固定 5192（外部工具 / launchd / 文档都认这个地址），
 * 不该让一次 `--port 5300` 把地址永久钉住。记录仍会被 `alreadyRunning` 当**探活候选**
 * （见 index.ts）—— 所以「生产正跑在 5300」这件事照样能被第二次 `diy2` 发现并复用。
 */
export function resolvePort(opts: { mode: Diy2Env; cliPort?: number | undefined; recordedPort?: number | null }): {
    port: number;
    source: PortSource;
} {
    if (opts.cliPort !== undefined) return { port: opts.cliPort, source: 'cli' };
    // 记录只说明「上次用过」，所以只在本环境愿意沿用它时才当端口（生产固定门牌，不沿用）。
    const recorded = opts.recordedPort ?? null;
    if (opts.mode !== 'production' && recorded !== null && recorded !== PROD_DEFAULT_PORT) {
        return { port: recorded, source: 'recorded' };
    }
    return { port: opts.mode === 'production' ? PROD_DEFAULT_PORT : 0, source: 'default' };
}

/** 读 `<home>/app.port`（**记录**，不是存活证据）；不存在 / 坏内容 / 非法端口 → null */
export async function readPortFile(file: string): Promise<number | null> {
    try {
        const port = Number.parseInt((await readFile(file, 'utf8')).trim(), 10);
        return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    } catch {
        return null;
    }
}

/**
 * 写 `<home>/app.port`（监听成功后调用；0 = 内核给的端口也能落）。
 *
 * **退出不删**是它存在的理由：这个数就是下次启动要还回去的 URL。
 * 别再给它加"删除入口" —— 删了就是每次都换内核随机端口（书签失效）；
 * 也别拿它的存在当存活证据 —— 那是探活的活。
 */
export async function writePortFile(file: string, port: number): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${port}\n`, 'utf8');
}

/** 组装运行配置（**唯一入口**：server / dev / bin 的 CLI 产物都从这拿）。
 *
 * 异步：内部要探 `package.json` / `diy.yaml` / `app.port` / `model.yaml` / UI 产物目录，
 * 这些读操作一律走 `fs/promises`（##408 sync-io 护栏；启动期「没有并发」不是留同步 IO 的理由 ——
 * 全仓口径统一才不会有人照着抄一个进去）。
 */
export async function resolveConfig(opts?: {
    /** 调用方所在目录（用来向上找 appRoot / repoRoot）；发布形态给 bin 目录即可 */
    moduleDir?: string;
    /** 入口声明的环境（生产入口 production，dev 入口 development，测试 test） */
    mode?: Diy2Env;
    /** argv 解析后的参数（声明在 src/cli/options.ts） */
    overrides?: ConfigOverrides;
}): Promise<Diy2Config> {
    const mode: Diy2Env = opts?.mode ?? 'production';
    const overrides = opts?.overrides ?? {};
    const moduleDir = opts?.moduleDir ?? process.cwd();
    const appRoot = (await findAppRoot(moduleDir)) ?? (await findAppRoot(join(moduleDir, '..'))) ?? resolve(moduleDir);
    const repoRoot = (await findRepoRoot(appRoot)) ?? null;

    const notes: string[] = [];
    const { home } = resolveHome({
        mode,
        explicit: overrides.home,
        allowProdHome: overrides.allowProdHome,
    });
    // 标签在 home **之后**定：生产入口配沙箱数据根时，标签就取那个目录名（见 sandboxLaunch）。
    const launch =
        overrides.launch?.trim() ||
        (mode === 'production' && !isProdHome(home) ? sandboxLaunch(home) : undefined) ||
        defaultLaunch(mode);

    const portFile = join(home, 'app.port');
    const recordedPort = await readPortFile(portFile);
    const { port, source } = resolvePort({ mode, cliPort: overrides.port, recordedPort });

    const buildRoot = buildRootOf(appRoot);
    const defaultWebDir = join(buildRoot, 'web');
    const explicitWebDir = overrides.webDir?.trim();
    const webDir =
        explicitWebDir !== undefined && explicitWebDir !== ''
            ? resolve(explicitWebDir)
            : (await isDir(defaultWebDir))
              ? defaultWebDir
              : undefined;

    // model.yaml：显式 `--model-config` > 本数据根 > **生产数据根才有的一档**（`~/.diy/model.yaml`）。
    // 最后那档按 home 位置判定（父目录就是生产根），不是按 mode 标签 —— 测试实例换到 run/
    // 之后天然拿不到它，不可能「隔离了 sqlite 却仍用生产 key」。
    const explicitModelConfig = overrides.modelConfig?.trim();
    let modelConfigPath: string | undefined;
    if (explicitModelConfig !== undefined && explicitModelConfig !== '') {
        modelConfigPath = resolve(explicitModelConfig);
    } else if (await isFile(join(home, 'model.yaml'))) {
        modelConfigPath = join(home, 'model.yaml');
    } else {
        // 生产根**下面**的数据根（`~/.diy2/<实例>`）回落生产根的配置；`run/diy2/lab` 这类沙箱
        // 不回落 —— 「隔离了 sqlite 却仍用生产 key」是假隔离（见 modelConfigHint）。
        const prodConfig = join(prodHomeDir(), 'model.yaml');
        if (samePath(dirname(home), prodHomeDir()) && (await isFile(prodConfig))) {
            modelConfigPath = prodConfig;
        }
    }

    return {
        app: APP_ID,
        home,
        deviceHome: prodHomeDir(),
        env: mode,
        launch,
        port,
        portSource: source,
        recordedPort,
        portFile,
        dbPath: join(home, 'diy2.db'),
        appRoot,
        buildRoot,
        repoRoot,
        webDir,
        modelConfigPath,
        name: overrides.name?.trim() || null,
        compact: { ...DEFAULT_BUDGET },
        tools: overrides.tools === 'files' ? 'files' : 'shell',
        notes,
        // 没给 = 用内核缺省；正数才覆盖（0 步 = 每轮直接掐停，不是想要的语义，故下限 1）
        maxSteps: overrides.maxSteps,
        // 同上：不写就用内核缺省（300s）；显式正整数才覆盖（0 在这里没有"不限"的语义）
        bashTimeoutMs: overrides.bashTimeoutMs,
    };
}

/**
 * 数据根里没有 model.yaml 时的提示。测试实例**不会**回落 `~/.diy/model.yaml`（那是假隔离），
 * 所以这里给出**可复制**的填充命令（只给脚本名没用：无参调用只扫已存在的数据根，
 * 空目录会被它跳过）；生产数据根自带一档（见 resolveConfig）。
 */
export function modelConfigHint(config: Diy2Config): string | null {
    if (config.modelConfigPath !== undefined) return null;
    const file = join(config.home, 'model.yaml');
    // 不带 `[diy2]` 前缀（同 describeConfig：前缀由日志装配统一给）
    return (
        `数据根里没有 model.yaml（${file}）` +
        ` → 模型会报缺 key；填充：./scripts/seed-run-home.sh ${config.home}（在仓库根跑），` +
        '或 --model-config 显式指定'
    );
}

/** 启动时的一行自报（诊断「我连的是谁 / 数据在哪」的唯一线索） */
export function describeConfig(config: Diy2Config, actualPort?: number): string {
    // 「生产」由**数据根**判定，不由入口声明的 env 判定：`bin/diy2 web --home run/diy2/lab`
    // 是生产入口 + 沙箱数据，按 env 说会打出「生产/lab home=…/run/…」——自相矛盾的一行日志，
    // 而人正是靠这一行确认「我连的是哪个库」。
    const where = isProdHome(config.home) ? '生产' : config.env === 'test' ? '测试' : '开发';
    // 实际监听端口可能不等于 config.port（0 = 内核分配、粘性端口被占后漂移）：
    // 自报以**实际**为准，否则这行日志在「到底连哪个端口」这件事上说谎。
    const shown = actualPort ?? config.port;
    // 不带 `[diy2]` 前缀：终端那层前缀由日志装配（./log 的 source = `diy2:<模块>`）统一给，
    // 调用点只交正文。抄两遍会打出 `[diy2:boot] [diy2] 生产/prod …`。
    return (
        `${where}/${config.launch} home=${config.home} db=${config.dbPath} ` +
        `port=${shown === 0 ? '0(内核分配)' : shown}(${config.portSource})`
    );
}
