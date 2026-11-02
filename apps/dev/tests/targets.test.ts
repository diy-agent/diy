import { describe, expect, it } from "vitest";
import { TARGET_SPECS, commandOf, homeOf, resolveTargets } from "../targets.js";

const REPO = "/repo";

describe("目标清单", () => {
    it("id 唯一", () => {
        const ids = TARGET_SPECS.map((spec) => spec.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("覆盖判据要求的 app（diy-app / chat / web / remote-shell / minimal）", () => {
        const apps = new Set(TARGET_SPECS.map((spec) => spec.app));
        for (const app of ["diy-app", "diy-chat", "diy-web", "diy-remote-shell", "diy-minimal"]) {
            expect(apps.has(app)).toBe(true);
        }
    });

    it("web 两个入口端口不同（同格多实例）", () => {
        const web = TARGET_SPECS.filter((spec) => spec.app === "diy-web");
        expect(web.map((spec) => spec.port)).toEqual([8123, 8124]);
    });

    it("目录 / 数据根 / 命令补全成绝对路径", () => {
        const resolved = resolveTargets(REPO);
        const chat = resolved.list.find((target) => target.app === "diy-chat");
        expect(chat?.cwd).toBe("/repo/apps/chat");
        expect(chat?.homePath).toBe("/repo/build/lab/home");
        expect(chat?.commandLine).toBe("./sha.sh lab");
    });
});

describe("commandOf / homeOf", () => {
    it("命令 = ./sha.sh + 子命令", () => {
        const spec = TARGET_SPECS[0]!;
        expect(commandOf(spec)).toBe("./sha.sh lab");
    });

    it("缺省数据根按变体分根", () => {
        const spec = TARGET_SPECS[0]!;
        expect(homeOf(REPO, spec)).toBe("/repo/build/lab/home");
    });
});
