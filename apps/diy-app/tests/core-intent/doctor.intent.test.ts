/**
 * doctor.intent.test.ts — 【意图 · 无 UI 层】"我怎么知道它自己是好的" 这份需求。
 *
 * 用户视角的问题：**我的数据目录坏了吗？** 用户不关心探测怎么写，只关心：
 * 缺 state.yaml / 缺 projects/ 时，系统要**如实说出来**，不能假装健康。
 *
 * 执行方式：真 app + 一条长连 rpc（`diy.doctor` / `diy.getAppInfo` 要 main 运行时的信息）。
 * 旧写法每条断言起一个 `./diy.sh`（0.68s），这份文件原本 4 条 → 现在一次 app 启动 + 4 次 rpc。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { appRpc, type Rpc } from "../harness/rpc";
import type { ElectronTest } from "../electron-test";

let rpc: Rpc;
let electron: ElectronTest;
let home: string;
let dispose: () => Promise<void>;

beforeAll(async () => {
    const app = await appRpc();
    rpc = app.rpc;
    electron = app.electron;
    home = electron.home;
    dispose = app.dispose;
}, 90_000);

afterAll(async () => {
    await dispose?.();
});

describe("doctor：系统要如实报告自己的数据目录状态", () => {
    it("给出这些基本信息：进程、数据根、是不是健康", async () => {
        const r = (await rpc.diy.doctor({})) as { status: string; data: Record<string, unknown> };
        expect(r.status).toBe("ok");
        expect(r.data["home"]).toBe(home);
        expect(typeof r.data["pid"]).toBe("number");
        expect(typeof r.data["healthy"]).toBe("boolean");
    });

    it("全新环境里没有 state.yaml、没有 projects/：要明确报缺失，不能说健康", async () => {
        const r = (await rpc.diy.doctor({})) as { data: { state_exists: boolean; healthy: boolean; issues: string[] } };
        expect(r.data.state_exists).toBe(false);
        expect(r.data.healthy).toBe(false);
        expect(r.data.issues.join("\n")).toMatch(/state\.yaml/);
        expect(r.data.issues.join("\n")).toMatch(/projects\//);
    });
});

describe("设置里的「状态」页：能看到自己跑在哪、什么版本", () => {
    it("端口、数据目录、缓存目录都落在当前环境，且能看出 Node/Electron/系统", async () => {
        const r = (await rpc.diy.app.info({})) as unknown as Record<string, unknown>;
        expect(r["diyHome"]).toBe(home);
        expect(r["cache"]).toBe(join(home, "cache"));
        expect(r["userData"]).toBe(join(home, "electron_user_data"));
        for (const k of ["port", "electron", "node", "chrome", "platform", "pid"]) {
            expect(r[k]).toBeTruthy();
        }
    });

    it("报的端口是真的在监听的那个（不是 0、不是占位）", async () => {
        const r = (await rpc.diy.app.info({})) as unknown as { port: number };
        expect(r.port).toBe(electron.port);
        expect(r.port).toBeGreaterThan(0);
    });
});
