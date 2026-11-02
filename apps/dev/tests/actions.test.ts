import { describe, expect, it } from "vitest";
import { cdpUrl, killPlan, launchEnv, logFileName, stripAnsi } from "../actions.js";
import type { InstanceRecordLite } from "../instances.js";
import { isBuildCommand, type LaunchSpec } from "../shared.js";

const launch = (patch: Partial<LaunchSpec> = {}): LaunchSpec => ({
    id: "lab",
    command: "./sha.sh lab",
    entries: [{ kind: "app" }],
    ...patch,
});

describe("launchEnv", () => {
    it("剔除继承的数据根类变量，注入 launch / 不抢焦点 / 开发环境", () => {
        const env = launchEnv(launch(), {
            PATH: "/bin",
            DIY_HOME: "/Users/ccc/.diy",
            DIY_ENV: "production",
            DIY_VARIANT: "prod",
            DIY_LAUNCH: "web-8123",
            DIY_INSTANCE_REGISTRY: "/tmp/reg",
        });
        expect(env["PATH"]).toBe("/bin");
        expect(env["DIY_HOME"]).toBeUndefined();
        expect(env["DIY_ENV"]).toBe("development");
        expect(env["DIY_NO_FOCUS"]).toBe("1");
        expect(env["DIY_LAUNCH"]).toBe("lab");
        // 注册表覆盖保留：测试 / 隔离场景要能看见自己拉起的实例
        expect(env["DIY_INSTANCE_REGISTRY"]).toBe("/tmp/reg");
    });

    it("app.yaml 写的 env（web 的 PORT）叠在上面", () => {
        const env = launchEnv(launch({ id: "web-8123", env: { PORT: "8123" } }), { PATH: "/bin" });
        expect(env["PORT"]).toBe("8123");
        expect(env["DIY_LAUNCH"]).toBe("web-8123");
    });
});

describe("killPlan", () => {
    const record = (parents: InstanceRecordLite["parents"]): InstanceRecordLite => ({
        pid: 100,
        app: "diy-chat",
        launch: "lab",
        worktree: "/repo",
        port: null,
        diyHome: "/h",
        variant: "lab",
        env: "development",
        argv: [],
        cwd: "",
        startedAt: "",
        updatedAt: "",
        parents,
    });

    it("记录里的进程一定在内", () => {
        expect(killPlan(record([]))).toEqual([100]);
    });

    it("启动器父进程（vite / tsx / sha.sh / electron-dev）一并收掉", () => {
        const plan = killPlan(
            record([
                { pid: 90, command: "node --import tsx scripts/electron-dev.mts" },
                { pid: 80, command: "/bin/zsh" },
            ]),
        );
        expect(plan).toContain(90);
        expect(plan).not.toContain(80);
    });

    it("没有记录 = 不杀任何东西", () => {
        expect(killPlan(null)).toEqual([]);
    });
});

describe("stripAnsi / cdpUrl / 日志名 / 命令白名单", () => {
    it("去掉颜色转义", () => {
        expect(stripAnsi("\u001b[32m✓\u001b[0m 通过")).toBe("✓ 通过");
    });

    it("CDP 地址按端口生成，没有端口 = null", () => {
        expect(cdpUrl(61692)).toBe("http://127.0.0.1:61692/json");
        expect(cdpUrl(null)).toBeNull();
        expect(cdpUrl(0)).toBeNull();
    });

    it("日志文件名不含路径分隔符 / NUL（一行一个 launch）", () => {
        expect(logFileName("/repo\u0000chat\u0000lab")).toBe("_repo--chat--lab.log");
        expect(logFileName("/wt/t502\u0000web\u0000web-8123")).toBe("_wt_t502--web--web-8123.log");
    });

    it("只认构建白名单", () => {
        for (const command of ["build", "check", "test", "sync", "build-pkgs", "clean"]) {
            expect(isBuildCommand(command)).toBe(true);
        }
        expect(isBuildCommand("rm -rf /")).toBe(false);
        expect(isBuildCommand(undefined)).toBe(false);
    });
});
