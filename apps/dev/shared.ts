// shared.ts — 主进程与 renderer 共用的**纯类型**（两端各打包一次，运行时没有模块依赖）。
//
// ##502 第二轮的四层模型：worktree → app → launch → entries。
//   · 静态清单 = `git worktree list` × `apps/*/app.yaml`（**不读注册表**）
//   · 动态状态 = `~/.diy-instances/*.json`，按 `(worktree, app, launch)` 对回静态清单
//
// 表单形状只在这里定义一次：主进程按它回，renderer 按它画。

/** app.yaml 里的一个入口（静态声明，不是运行时探测） */
export interface EntrySpec {
    readonly kind: "app" | "web";
    readonly title?: string;
    /** kind=web 时的默认地址（配置端口；实际端口可能被冲突挤走） */
    readonly url?: string;
}

/** app.yaml 里的一条启动命令 */
export interface LaunchSpec {
    readonly id: string;
    readonly title?: string;
    /** 在 app 目录下执行，如 `./sha.sh lab` */
    readonly command: string;
    /** 额外环境变量（如 web 的 PORT） */
    readonly env?: Readonly<Record<string, string>>;
    /**
     * 数据根（相对 worktree 根）；缺省 `build/lab/home`（apps/* 的 sha.sh 同一口径）。
     * 实例 URI 的 nodeId 从 `<worktree>/<home>/instance-id` 读。
     */
    readonly home?: string;
    readonly entries: readonly EntrySpec[];
}

/** 一个 app（= 一个 `apps/<name>/app.yaml`） */
export interface AppSpec {
    /** app 名（缺省 = 目录名）；注册表里的 `app` 允许写作 `name` 或 `diy-<name>` */
    readonly name: string;
    readonly title: string;
    /** app 目录绝对路径 */
    readonly dir: string;
    readonly launches: readonly LaunchSpec[];
}

/** `git worktree list` 的一行 */
export interface WorktreeInfo {
    readonly path: string;
    /** 分支短名；detached HEAD = null */
    readonly branch: string | null;
}

/** 一个入口此刻的样子 */
export interface EntryStatus extends EntrySpec {
    /** 可点的地址（web 且运行时已知实际端口 ⇒ 用实际端口） */
    readonly href: string | null;
    /** 配置里写的地址；与实际不一致时 UI 两个都显示 */
    readonly configuredUrl: string | null;
    /** 实际端口 ≠ 配置端口 */
    readonly portMismatch: boolean;
}

/** 运行时事实（来自注册表 + 进程表） */
export interface LaunchRuntime {
    readonly pid: number;
    readonly port: number | null;
    readonly startedAt: string;
    /** 已运行毫秒 */
    readonly uptimeMs: number;
    /** 常驻内存字节数；取不到 = null */
    readonly memBytes: number | null;
    readonly cmdline: string;
    readonly cwd: string;
    readonly diyHome: string;
}

export interface LaunchStatus {
    /** `(worktree, app, launch)` 的稳定 key（UI 选中 / 定位用） */
    readonly key: string;
    readonly worktree: string;
    /** worktree 的展示形式（路径 + 分支，右侧面板用） */
    readonly worktreeLabel: string;
    /** worktree 路径的展示形式（左侧树只放这一行） */
    readonly worktreePath: string;
    readonly branch: string | null;
    readonly app: string;
    readonly appTitle: string;
    readonly launch: string;
    readonly launchTitle: string;
    readonly command: string;
    /** app.yaml 里声明的 env（详情页「环境变量」） */
    readonly env: Readonly<Record<string, string>>;
    /** app 目录（命令在这儿执行；路径打开也用它） */
    readonly appDir: string;
    /** app.yaml 路径（详情页可打开） */
    readonly yamlPath: string;
    /** 数据根（绝对路径；app.yaml 的 home 相对 worktree 解析） */
    readonly home: string;
    /** 数据根的 instance-id；从未启动过 = null */
    readonly nodeId: string | null;
    /** `diy://<nodeId>/<app>.<launch>`；nodeId 缺席 = null */
    readonly uri: string | null;
    /** 该 worktree 是否构建过（存在 `build/`）；未构建 = 条目标灰 + 给「构建」按钮 */
    readonly built: boolean;
    readonly running: boolean;
    /** 已拉起但还没写注册表（构建 / 启动中） */
    readonly starting: boolean;
    readonly entries: readonly EntryStatus[];
    readonly runtime: LaunchRuntime | null;
}

export interface DevSnapshot {
    readonly repoRoot: string;
    /** 仓库名（主 worktree 目录名），左侧树第一层 */
    readonly repoName: string;
    /** 主 worktree 的分支（第一个 worktree；detached = null） */
    readonly repoBranch: string | null;
    readonly registryDir: string;
    readonly worktreeCount: number;
    readonly appCount: number;
    readonly runningCount: number;
    /** 解析 app.yaml 时遇到的问题（坏 YAML / 缺字段），显示在顶部提示里 */
    readonly problems: readonly string[];
    readonly launches: readonly LaunchStatus[];
}

/** 构建 / 检查命令的输出会话（单条：同一时刻只跑一个） */
export interface CommandSession {
    readonly id: number;
    readonly key: string;
    readonly command: string;
    readonly commandLine: string;
    readonly running: boolean;
    readonly startedAt: string;
    readonly lines: readonly string[];
}

/** 主进程方法名（renderer 与主进程各写一遍字符串 = 迟早拼错；统一放这里） */
export const DEV_METHODS = {
    snapshot: "snapshot",
    start: "start",
    stop: "stop",
    focus: "focus",
    open: "open",
    run: "run",
    session: "session",
    clearSession: "clearSession",
    revealCdp: "revealCdp",
} as const;

/** 允许在 app 目录里执行的命令（白名单：拒绝任意命令注入） */
export const BUILD_COMMANDS = ["build", "check", "test", "sync", "build-pkgs", "clean"] as const;
export type BuildCommand = (typeof BUILD_COMMANDS)[number];

export function isBuildCommand(value: unknown): value is BuildCommand {
    return typeof value === "string" && (BUILD_COMMANDS as readonly string[]).includes(value);
}

/** 路径打开方式 */
export type OpenMode = "finder" | "editor" | "terminal";
export function isOpenMode(value: unknown): value is OpenMode {
    return value === "finder" || value === "editor" || value === "terminal";
}

/** 一个 launch 的三元组身份（跨 IPC 传它，别传下标） */
export interface LaunchRef {
    readonly worktree: string;
    readonly app: string;
    readonly launch: string;
}
