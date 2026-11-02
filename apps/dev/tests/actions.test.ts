import { describe, expect, it } from "vitest";
import { cdpUrl, killPlan, launchEnv, stripAnsi } from "../actions.js";
import { resolveTargets } from "../targets.js";
import type { InstanceRecordLite } from "../instances.js";
import { isBuildCommand } from "../shared.js";

const target = (id: string) => resolveTargets("/repo").list.find((item) => item.id === id)!;

describe("launchEnv", () => {
    it("剔除继承的数据根类变量，并带上不抢焦点 / 开发环境标记", () => {
        const env = launchEnv(target("chat-lab"), {
            PATH: "/bin",
            DIY_HOME: "/Users/ccc/.diy",
            DIY_ENV: "production",
            DIY_VARIANT: "prod",
            DIY_INSTANCE_REGISTRY: "/tmp/reg",
        });
        expect(env["PATH"]).toBe("/bin");
        expect(env["DIY_HOME"]).toBeUndefined();
        expect(env["DIY_ENV"]).toBe("development");
        expect(env["DIY_VARIANT"]).toBe("lab");
        expect(env["DIY_NO_FOCUS"]).toBe("1");
        // 注册表覆盖保留：测试 / 隔离场景要能看见自己拉起的实例
        expect(env["DIY_INSTANCE_REGISTRY"]).toBe("/tmp/reg");
    });

    it("目标自带的 env（web 的 PORT）叠在上面", () => {
        const env = launchEnv(target("web-8123"), { PATH: "/bin" });
        expect(env["PORT"]).toBe("8123");
    });
});

describe("killPlan", () => {
    const record = (parents: InstanceRecordLite["parents"]): InstanceRecordLite => ({
        pid: 100,
        app: "diy-app",
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

describe("stripAnsi / cdpUrl / 命令白名单", () => {
    it("去掉颜色转义", () => {
        expect(stripAnsi("\u001b[32m✓\u001b[0m 通过")).toBe("✓ 通过");
    });

    it("CDP 地址按端口生成，没有端口 = null", () => {
        expect(cdpUrl(61692)).toBe("http://127.0.0.1:61692/json");
        expect(cdpUrl(null)).toBeNull();
        expect(cdpUrl(0)).toBeNull();
    });

    it("只认构建白名单", () => {
        for (const command of ["build", "check", "test", "sync", "build-pkgs", "clean"]) {
            expect(isBuildCommand(command)).toBe(true);
        }
        expect(isBuildCommand("rm -rf /")).toBe(false);
        expect(isBuildCommand(undefined)).toBe(false);
    });
});
