// shared.ts — 主进程与 renderer 共用的**纯类型**（两端各打包一次，运行时没有模块依赖）。
//
// 表单形状只在这里定义一次：主进程按它回，renderer 按它画。加字段先改这里，两边都得跟着变。

/** 一个可启动目标（先写死，见 targets.ts） */
export interface TargetInfo {
    readonly id: string;
    /** 左侧分组名（`DIY-APP` / `APPS/WEB`…） */
    readonly group: string;
    /** 条目显示名（`lab` / `:8123`） */
    readonly name: string;
    /** 实例注册表里的 app 短名 */
    readonly app: string;
    readonly variant: string;
    /** 工作目录（绝对路径） */
    readonly cwd: string;
    /** 数据根（绝对路径） */
    readonly home: string;
    /** 数据根的展示形式（仓库内相对路径 / `~` 缩写） */
    readonly homeDisplay: string;
    /** 启动命令（人读，如 `./sha.sh lab`） */
    readonly command: string;
    /** 监听端口（web 两个入口有；其余无） */
    readonly port?: number;
}

/** 运行时事实（来自注册表 + 进程表） */
export interface TargetRuntime {
    readonly pid: number;
    readonly port: number | null;
    readonly startedAt: string;
    /** 已运行毫秒 */
    readonly uptimeMs: number;
    /** 常驻内存字节数；取不到 = null */
    readonly memBytes: number | null;
    readonly cmdline: string;
    readonly cwd: string;
    readonly env: string;
}

export interface TargetStatus extends TargetInfo {
    readonly running: boolean;
    /** 已拉起但还没写注册表（构建 / 启动中） */
    readonly starting: boolean;
    readonly runtime: TargetRuntime | null;
    /** `diy://<nodeId>/<app>.<variant>`（nodeId 来自数据根的 instance-id） */
    readonly uri: string;
}

export interface DevSnapshot {
    readonly repoRoot: string;
    readonly registryDir: string;
    readonly runningCount: number;
    readonly entries: readonly TargetStatus[];
}

/** 构建 / 检查命令的输出会话（单条：同一时刻只跑一个） */
export interface CommandSession {
    readonly id: number;
    readonly targetId: string;
    readonly command: string;
    /** 例如 `./sha.sh check` */
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
