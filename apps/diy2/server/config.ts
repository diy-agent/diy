// server/config.ts —— diy2 的**运行配置唯一真源**：数据根 / 端口 / 环境 / 变体 / 产物目录。
//
// 为什么要有这个文件（##dev-app 构建对齐）：
//   改造前端口散在 5 处（package.json 的 --port、scripts/dev.sh 的 5190/5191、vite 的 proxy、
//   server/index.ts 的 DIY2_PORT ?? 5191、bin/diy2 的 5192），没有任何一处能回答
//   「这次启动到底监听哪个端口、数据落在哪、我连的是谁」。改一个端口要改五处，且必然漏。
//   现在**只有这里**决定，其余（server / bin/diy2 / sha.sh / vite 配置）一律来问它。
//
// 口径（与仓库其它 app 是同一套裁决，只换前缀 —— diy2 全域 DIY2_*）：
//   · 数据根：`DIY2_HOME` > 变体缺省。**生产**（DIY2_ENV=production）缺省 `~/.diy/diy2`；
//     开发 / 测试缺省 `<appRoot>/build/<variant>/home`（本 worktree × 变体隔离，仓库惯例）。
//     非生产**拒绝**继承来的生产根（`DIY2_ALLOW_PROD_HOME=1` 才放行）—— 否则一次
//     `./sha.sh lab` 就把示例数据与演示房间写进真库。
//   · 端口：`--port` > `DIY2_PORT` > `<home>/app.port` 记录（仅非生产） > 缺省。
//     缺省**只有生产是 5192**；dev / test 缺省 `0` = 让内核分配随机空闲端口。
//     端口不承载身份（身份 = `GET /api/info` 自报的 home，见 bin/diy2 的探活），
//     固定端口在 dev 的副作用只有「多 worktree 互踢」与「撞生产」。
//     但**粘性**是另一回事：dev 跑过一次之后要还回同一个 URL（书签 / 已经开着的标签页 /
//     重启后的 SSE 重连都认这个端口），详见 `resolvePort` 的注释。
//     `app.port` 只记「上次监听成功的端口」，**不证明存活**（不删、不带 pid、崩溃也不更新）；
//     「现在有没有人在跑」一律靠探活（`/api/info` 的 home + 注册表 pid）。
//   · 环境：`DIY2_ENV` 三态；**无法识别 / 缺省一律按 production**（宁可少开能力，仓库口径）。
//   · 变体：只决定运行空间（数据根 + 产物目录），不是构建目标（lab / staging 与 prod 同码）。
//
// 纯函数尽量多：端口裁决 / 数据根裁决 / 生产根判据都有单测（tests/config.test.ts），
// 因为这三条都是「错了不会报错，只会静默用错数据」的类型。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 产物里的 app 标识（`/api/info` 自报、注册表 `app` 字段、探活判据共用一处） */
export const APP_ID = 'diy2';

/**
 * 生产缺省端口（全局命令 `diy2` 的「门牌」）。
 *
 * 只是**缺省**，不是身份：真正的端口永远看 `<home>/app.port` 或 `--port`。
 * dev / test 不吃这个数（见 `resolvePort`），否则多 worktree 的 lab 实例会把生产门牌占住。
 */
export const PROD_DEFAULT_PORT = 5192;

export type Diy2Env = 'production' | 'development' | 'test';
/** 端口从哪来：显式 cli / 显式 env / `app.port` 记录（仅非生产） / 缺省 */
export type PortSource = 'cli' | 'env' | 'recorded' | 'default';

export interface Diy2Config {
    app: typeof APP_ID;
    /** 数据根（唯一写盘位置：diy2.db / app.port / 日志） */
    home: string;
    /** 运行环境（production 之外的专属能力判据） */
    env: Diy2Env;
    /** 产物变体（prod|lab|staging|test…），只决定运行空间 */
    variant: string;
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
    /** git worktree 根（不在仓库里 = null，例如 npm 安装的发布形态） */
    repoRoot: string | null;
    /** UI 产物目录；undefined = 不提供静态服务（开发期交给 vite） */
    webDir: string | undefined;
    /** model.yaml 路径（entity-runtime 通过 `DIY_MODEL_CONFIG` 读它） */
    modelConfigPath: string | undefined;
    /** 启动入口名（lab / staging / prod…），只用于注册表自报 */
    launch: string | null;
    /** 实例名（`DIY2_NAME`），多实例时人认得出的身份；缺省 null */
    name: string | null;
    /** 压缩预算 */
    compact: { keepLast: number; maxChars: number };
    /** 工具面：shell = 带 bash；files = 只读文件工具（`DIY2_TOOLS=files`） */
    tools: 'shell' | 'files';
}

/** 真实家目录（**不读 `$HOME`**：测试 / 隔离实例会改写它，生产根判据不能跟着漂） */
export function realHomeDir(): string {
    try {
        return userInfo().homedir || homedir();
    } catch {
        return homedir();
    }
}

/** 路径归一（`..` / `./` / 尾斜杠 / 符号链接都能对上），用于「是不是同一个数据根」的判据 */
export function samePath(a: string, b: string): boolean {
    return resolve(a) === resolve(b);
}

/**
 * 环境裁决：只认三态，**其余一律 production**。
 * 理由：DIY2_ENV 是「dev 专属能力」的判据，认错方向（把生产当 dev）会多开能力；
 * 反过来（dev 当生产）只是少开，且会被启动日志里的变体名点出来。
 */
export function parseEnv(raw: string | undefined): Diy2Env {
    const value = raw?.trim().toLowerCase();
    if (value === 'development' || value === 'dev') return 'development';
    if (value === 'test') return 'test';
    return 'production';
}

/** 变体缺省：生产 prod，其余 lab（`lab` / `staging` / `preview` 由调用方显式给） */
export function defaultVariant(env: Diy2Env): string {
    return env === 'production' ? 'prod' : 'lab';
}

/**
 * 生产数据根（**两个**：仓库级 `~/.diy` 与 diy2 自己的 `~/.diy/diy2`）。
 * 判据在这里只有一处；`resolveHome` 用它拦「dev 偷用生产根」。
 */
export function isProdHome(home: string): boolean {
    const real = realHomeDir();
    return samePath(home, join(real, '.diy')) || samePath(home, join(real, '.diy', 'diy2'));
}

/** 从某个目录向上找本包根（`package.json` 的 name 命中）—— 产物里也找得到 */
export function findAppRoot(start: string): string | undefined {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
        const manifest = join(dir, 'package.json');
        if (existsSync(manifest)) {
            try {
                const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
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
export function findRepoRoot(start: string): string | undefined {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, 'diy.yaml')) && existsSync(join(dir, 'apps'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
    return undefined;
}

/**
 * 数据根裁决：显式 `DIY2_HOME` > 变体缺省。
 *
 * 非生产下继承到**生产根** → 拒绝并回落变体缺省（浏览器里点错一个房间就写脏真库）。
 * 返回 `rejected` 供调用方打警告：静默纠正在这种事上是坏文明。
 */
export function resolveHome(opts: {
    env: Diy2Env;
    variant: string;
    appRoot: string;
    inherited?: string | undefined;
    allowProdHome?: boolean;
}): { home: string; rejected: string | null } {
    const fallback = join(opts.appRoot, 'build', opts.variant, 'home');
    const inherited = opts.inherited?.trim();
    if (inherited === undefined || inherited === '') return { home: fallback, rejected: null };
    if (opts.env !== 'production' && isProdHome(inherited) && opts.allowProdHome !== true) {
        return { home: fallback, rejected: inherited };
    }
    return { home: resolve(inherited), rejected: null };
}

/**
 * 端口裁决：`--port` > `DIY2_PORT` > `app.port` 记录（仅非生产） > 缺省。
 *
 * 唯一特殊规则：**非生产不沿用记录里的 5192**（`PROD_DEFAULT_PORT`）。旧版的
 * `app.port` 里留着一堆 5192，dev 照单沿用就把生产门牌占住了 —— 与仓库 ##328 同一现场。
 *
 * `app.port` 的语义就一句话：**上次监听成功的端口，退出不删**。好处是「Ctrl-C 再起」与
 * 「改 server 代码自动重启（exit 75）」都还回同一个 URL —— 否则每次都换内核随机端口，
 * 书签 / 已开的标签页 / HMR 重连全指到旧地址。
 *
 * 但它**不是活体证据**：里面的数只说明「曾经用这个端口起过」。进程崩了（SIGKILL / OOM /
 * 断电）它不会变，端口释放后也可能被别人的实例占住。「现在有没有人在跑」一律靠探活
 * （`GET /api/info` 自报的 home + 注册表 pid），不要从“文件在不在 / 内容是什么”推存活。
 *
 * 生产**不把记录当监听端口**：生产的门牌固定 5192（外部工具 / launchd / 文档都认这个地址），
 * 不该让一次 `--port 5300` 把地址永久钉住。记录仍会被 `alreadyRunning` 当**探活候选**
 * （见 index.ts）—— 所以「生产正跑在 5300」这件事照样能被第二次 `diy2` 发现并复用。
 */
export function resolvePort(opts: {
    env: Diy2Env;
    cliPort?: number | undefined;
    envPort?: number | undefined;
    recordedPort?: number | null;
}): { port: number; source: PortSource } {
    if (opts.cliPort !== undefined) return { port: opts.cliPort, source: 'cli' };
    // 非生产**连环境变量里的 5192 也不吃**：外层 shell / agent 常从运行中的生产实例里继承
    // 这个值（实测：dev 会话里 `DIY2_PORT=5192` 是宿主进程导出的），照单全收就是
    // 「lab 去抢生产门牌」→ EADDRINUSE 崩溃或更糟：静默连到别人的实例。
    // 真要在 dev 用 5192 请显式 `--port 5192`（cli 永远最高优先）。
    if (opts.envPort !== undefined && !(opts.env !== 'production' && opts.envPort === PROD_DEFAULT_PORT)) {
        return { port: opts.envPort, source: 'env' };
    }
    // 记录只说明「上次用过」，所以只在本环境愿意沿用它时才当端口（生产固定门牌，不沿用）。
    const recorded = opts.recordedPort ?? null;
    if (opts.env !== 'production' && recorded !== null && recorded !== PROD_DEFAULT_PORT) {
        return { port: recorded, source: 'recorded' };
    }
    return { port: opts.env === 'production' ? PROD_DEFAULT_PORT : 0, source: 'default' };
}

/** 读 `<home>/app.port`（**记录**，不是存活证据）；不存在 / 坏内容 / 非法端口 → null */
export function readPortFile(file: string): number | null {
    try {
        const port = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
        return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    } catch {
        return null;
    }
}

/**
 * 写 `<home>/app.port`（监听成功后调用；0 = 内核给的端口也能落）。
 *
 * **退出不删**是它存在的理由：这个数就是下次启动要还回去的 URL。
 * 别再给它加“删除入口” —— 删了就是每次都换内核随机端口（书签失效）；
 * 也别拿它的存在当存活证据 —— 那是探活的活。
 */
export function writePortFile(file: string, port: number): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${port}\n`, 'utf8');
}

function intFromEnv(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number.parseInt(raw, 10);
    // 0 是合法值（内核分配）；负数 / 非数 / 超范围当没给
    if (!Number.isInteger(value) || value < 0 || value > 65535) return undefined;
    return value;
}

/** 产物目录：`<appRoot>/build/<variant>/{web,server}` */
export function buildDirOf(appRoot: string, variant: string): string {
    return join(appRoot, 'build', variant);
}

/**
 * 组装运行配置（**唯一入口**：server / bin/diy2 / dev.ts 都从这拿）。
 *
 * @param opts.moduleDir 调用方所在目录（用来向上找 appRoot / repoRoot）；发布形态给 bin 目录即可
 */
export function resolveConfig(opts?: {
    moduleDir?: string;
    env?: NodeJS.ProcessEnv;
    cliPort?: number | undefined;
}): Diy2Config {
    const env = opts?.env ?? process.env;
    const moduleDir = opts?.moduleDir ?? process.cwd();
    const appRoot = findAppRoot(moduleDir) ?? findAppRoot(join(moduleDir, '..')) ?? resolve(moduleDir);
    const repoRoot = findRepoRoot(appRoot) ?? null;

    const mode = parseEnv(env['DIY2_ENV']);
    const variant = (env['DIY2_VARIANT']?.trim() ?? '') || defaultVariant(mode);
    const allowProdHome = env['DIY2_ALLOW_PROD_HOME'] === '1';
    const { home } = resolveHome({ env: mode, variant, appRoot, inherited: env['DIY2_HOME'], allowProdHome });

    const portFile = join(home, 'app.port');
    const recordedPort = readPortFile(portFile);
    const { port, source } = resolvePort({
        env: mode,
        cliPort: opts?.cliPort,
        envPort: intFromEnv(env['DIY2_PORT']),
        recordedPort,
    });

    const rawWebDir = env['DIY2_WEB_DIR']?.trim();
    const variantWebDir = join(buildDirOf(appRoot, variant), 'web');
    const webDir =
        rawWebDir !== undefined && rawWebDir !== ''
            ? resolve(rawWebDir)
            : existsSync(variantWebDir)
              ? variantWebDir
              : undefined;

    const rawModelConfig = env['DIY2_MODEL_CONFIG']?.trim();
    // model.yaml 三档：显式 DIY2_MODEL_CONFIG > 本数据根 > **本变体的仓库级数据根**
    // （`<repo>/build/<variant>/home/model.yaml`，根目录 `./sha.sh sync` 把真配置投影到那里）。
    // 最后一档是为了「一份真配置，多个 app 共用」：diy-app 的 lab 与 diy2 的 lab 用同一个变体，
    // 不该各自拷一份含 API key 的文件（也不该让 diy2 去占 diy-app 的 app.port）。
    const variantHomeConfig = repoRoot === null ? undefined : join(repoRoot, 'build', variant, 'home', 'model.yaml');
    const modelConfigPath =
        rawModelConfig !== undefined && rawModelConfig !== ''
            ? resolve(rawModelConfig)
            : existsSync(join(home, 'model.yaml'))
              ? join(home, 'model.yaml')
              : variantHomeConfig !== undefined && existsSync(variantHomeConfig)
                ? variantHomeConfig
                : undefined;

    return {
        app: APP_ID,
        home,
        env: mode,
        variant,
        port,
        portSource: source,
        recordedPort,
        portFile,
        dbPath: join(home, 'diy2.db'),
        appRoot,
        repoRoot,
        webDir,
        modelConfigPath,
        launch: env['DIY2_LAUNCH']?.trim() || null,
        name: env['DIY2_NAME']?.trim() || null,
        compact: {
            keepLast: Number.parseInt(env['DIY2_COMPACT_KEEP'] ?? '12', 10) || 12,
            maxChars: Number.parseInt(env['DIY2_COMPACT_CHARS'] ?? '24000', 10) || 24000,
        },
        tools: env['DIY2_TOOLS'] === 'files' ? 'files' : 'shell',
    };
}

/**
 * 数据根里没有 model.yaml 时的提示（不是错误：entity-runtime 会回落到 `~/.diy/model.yaml`）。
 * 非得说出来，是因为「隔离了数据根却没隔离配置」是同一类事故里最难自己发现的一种
 * （lab 的实验会用生产 key，而人以为在沙箱里）。
 */
export function modelConfigHint(config: Diy2Config): string | null {
    if (config.modelConfigPath !== undefined) return null;
    const candidates = [join(config.home, 'model.yaml')];
    if (config.repoRoot !== null) candidates.push(join(config.repoRoot, 'build', config.variant, 'home', 'model.yaml'));
    return (
        `[diy2] 没有找到 model.yaml（${candidates.join(' / ')}）` +
        ' → 模型配置回落到 ~/.diy/model.yaml（根目录 `./sha.sh sync` 会把真配置投影到变体数据根；' +
        'DIY2_MODEL_CONFIG 可显式指定）'
    );
}

/** 启动时的一行自报（诊断「我连的是谁 / 数据在哪」的唯一线索） */
export function describeConfig(config: Diy2Config, actualPort?: number): string {
    const where = config.env === 'production' ? '生产' : config.env === 'test' ? '测试' : '开发';
    // 实际监听端口可能不等于 config.port（0 = 内核分配、粘性端口被占后漂移）：
    // 自报以**实际**为准，否则这行日志在「到底连哪个端口」这件事上说谎。
    const shown = actualPort ?? config.port;
    return (
        `[diy2] ${where}/${config.variant} home=${config.home} db=${config.dbPath} ` +
        `port=${shown === 0 ? '0(内核分配)' : shown}(${config.portSource})`
    );
}
