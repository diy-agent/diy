// tests/core/debug-info.test.ts — 「复制调试信息」的正文（纯函数）
//
// 这段文本是给**另一个 agent**看的接口（不是给人读的散文）：三段缺一不可 ——
// CDP attach 命令（每次启动变，抄旧的是错的）、app（哪个实例）、page（人现在在哪）。
// 判据钉在这里，组件只管取数。
import { describe, expect, it } from "vitest";
import { cdpAttachCommand, debugInfoText } from "../../src/renderer_solid/lib/debug-info";

const app = {
    cdp: "ws://127.0.0.1:52213/devtools/browser/abc",
    env: "development",
    diyHome: "/tmp/diy-desktop-test-xyz",
    port: 18888,
    pid: 4321,
    branch: "fix/t351-panels",
    repoDisplay: "…/t351-panels",
    userData: "/tmp/diy-desktop-test-xyz/electron_user_data",
};

const page = {
    active: "task-run:projects/4/tasks/351",
    tabs: [{ key: "task-run:projects/4/tasks/351" }, { key: "traffic" }],
    selectedUri: "projects/4/tasks/351",
};

describe("debugInfoText：cdp / app / page 三段", () => {
    it("三段的标题都在；关键值逐项可查", () => {
        const t = debugInfoText(app, page);
        expect(t).toContain("## CDP（驱动真实窗口）");
        expect(t).toContain("## app");
        expect(t).toContain("## page");
        expect(t).toContain(`playwright-cli attach --cdp=${app.cdp}`);
        expect(t).toContain(`diyHome: ${app.diyHome}`);
        expect(t).toContain(`port: ${app.port}`);
        expect(t).toContain(`pid: ${app.pid}`);
        expect(t).toContain(`branch: ${app.branch}`);
        expect(t).toContain(`active: ${page.active}`);
        expect(t).toContain(`selectedTask: ${page.selectedUri}`);
        expect(t).toContain("task-run:projects/4/tasks/351, traffic");
    });

    it("CDP 未启用（空串）：给出可读的「为什么没有」，不编造 ws 地址", () => {
        const t = debugInfoText({ ...app, cdp: "" }, page);
        expect(t).not.toContain("playwright-cli attach");
        expect(t).toContain("未启用");
        expect(cdpAttachCommand("")).toContain("未启用");
        expect(cdpAttachCommand(undefined)).toContain("未启用");
    });

    it("空值降级：无 tab / 无选中任务 / 无分支，都写占位符而不是空白或 undefined", () => {
        const t = debugInfoText(
            { ...app, branch: "", repoDisplay: undefined },
            { active: "", tabs: [], selectedUri: null },
        );
        expect(t).toContain("branch: —（非 git 仓库）");
        expect(t).toContain("repo: —");
        expect(t).toContain("active: —");
        expect(t).toContain("selectedTask: —");
        expect(t).toContain("tabs: —");
        expect(t).not.toContain("undefined");
    });
});
