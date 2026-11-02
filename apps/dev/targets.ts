// targets.ts — 可启动清单：**先写死**（不做动态扫描）。
//
// 判据（##502）：列出 diy-app / apps/chat / apps/web / apps/remote-shell / apps/minimal
// 及各自的 lab；web 还有端口的 8123 / 8124。
//
// 每条 = 一条「怎么起它」的事实：目录 + `./sha.sh` 子命令 + 变体 + 数据根 + 注册表里的 app 短名。
// 将来要动态发现（扫 apps/*/sha.sh）时，只要产出同样的 Target 形状即可，其余代码不用动。

import { join } from "node:path";

/** 清单里的一条（路径在解析时补全，见 resolveTargets） */
export interface TargetSpec {
    readonly id: string;
    readonly group: string;
    readonly name: string;
    /** 相对仓库根 */
    readonly dir: string;
    /** 实例注册表里的 app 短名 */
    readonly app: string;
    readonly variant: string;
    /** `./sha.sh` 的子命令与参数 */
    readonly args: readonly string[];
    /** 额外环境变量（如 web 的 PORT） */
    readonly env?: Readonly<Record<string, string>>;
    /** 监听端口（web 两个入口） */
    readonly port?: number;
    /** 数据根（相对仓库根）；缺省 `build/<variant>/home` */
    readonly home?: string;
}

export const TARGET_SPECS: readonly TargetSpec[] = [
    {
        id: "diy-app-lab",
        group: "DIY-APP",
        name: "lab",
        dir: "pkgs.ts/diy-app",
        app: "diy-app",
        variant: "lab",
        args: ["lab"],
    },
    {
        id: "chat-lab",
        group: "APPS/CHAT",
        name: "lab",
        dir: "apps/chat",
        app: "diy-chat",
        variant: "lab",
        args: ["lab"],
    },
    {
        id: "web-8123",
        group: "APPS/WEB",
        name: ":8123",
        dir: "apps/web",
        app: "diy-web",
        variant: "lab",
        args: ["lab"],
        // apps/web 的 sha.sh 读的是 PORT（不是 --port 参数）
        env: { PORT: "8123" },
        port: 8123,
    },
    {
        id: "web-8124",
        group: "APPS/WEB",
        name: ":8124",
        dir: "apps/web",
        app: "diy-web",
        variant: "lab",
        args: ["lab"],
        env: { PORT: "8124" },
        port: 8124,
    },
    {
        id: "remote-shell-lab",
        group: "APPS/REMOTE-SHELL",
        name: "lab",
        dir: "apps/remote-shell",
        app: "diy-remote-shell",
        variant: "lab",
        args: ["lab"],
    },
    {
        id: "minimal-lab",
        group: "APPS/MINIMAL",
        name: "lab",
        dir: "apps/minimal",
        app: "diy-minimal",
        variant: "lab",
        args: ["lab"],
    },
];

/** 清单里的启动命令（人读） */
export function commandOf(spec: TargetSpec): string {
    return `./sha.sh ${spec.args.join(" ")}`;
}

/** 数据根绝对路径 */
export function homeOf(repoRoot: string, spec: TargetSpec): string {
    return join(repoRoot, spec.home ?? join("build", spec.variant, "home"));
}

/** 把相对目录补全成绝对路径 */
export interface ResolvedTargets {
    readonly repoRoot: string;
    readonly list: readonly ResolvedTarget[];
}

export interface ResolvedTarget extends TargetSpec {
    readonly cwd: string;
    readonly homePath: string;
    readonly commandLine: string;
}

export function resolveTargets(repoRoot: string, specs: readonly TargetSpec[] = TARGET_SPECS): ResolvedTargets {
    return {
        repoRoot,
        list: specs.map((spec) => ({
            ...spec,
            cwd: join(repoRoot, spec.dir),
            homePath: homeOf(repoRoot, spec),
            commandLine: commandOf(spec),
        })),
    };
}
