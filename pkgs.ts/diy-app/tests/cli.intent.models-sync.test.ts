// tests/cli.intent.models-sync.test.ts
// ═══════════════════════════════════════════════════════════════
// ##385「模型目录应用内刷新」的**活体契约** —— 真实 Electron + 真实 RPC + 真实 DOM。
//
// 用户原话（2026-10-19）：「models.dev.json 更新需要定时更新最新数据，并提供手工更新的按钮，
// 可以直接在错误提示上提供」。
//
// 覆盖（对应 body §4 验收）：
//   1. `$DIY_HOME/data/models.dev.json` **候选生效**：手放一份改过的快照 → 应用读它（而非源树），
//      `doctor` 报**该绝对路径 + 来源**（§3.1「必须能说出读的是哪一份」）
//   2. 手工刷新的**三态**：有 diff（报数）/ 无 diff（已是最新）/ 失败（给原因 + 本地逐字不变）
//   3. UI 两个入口：模型页（常规入口）与模型不可用 bar（故障现场入口）上的按钮都真的可点
//
// 抓取源用 `DIY_MODELS_DEV_ORIGIN` 指向本地 fixture（`refreshModelsOnce` 支持本地路径源）：
// 这条路径与真发**同一个实现**，差别只在"原文从哪来" —— 不联网让用例确定、不碰生产数据根。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let originFile: string;

const provider = (id: string, npm: string, models: string[]) => ({
    id,
    name: id,
    npm,
    api: "https://example.com/v1",
    models: Object.fromEntries(models.map((m) => [m, { id: m, name: m }])),
});

/** 上游 A：一家 provider / 一个模型 */
const SNAP_A = { alpha: provider("alpha", "@ai-sdk/openai-compatible", ["m1"]) };
/** 上游 B：新增 gamma + 一个新模型（用来制造 diff） */
const SNAP_B = {
    alpha: provider("alpha", "@ai-sdk/openai-compatible", ["m1", "m2"]),
    gamma: provider("gamma", "@ai-sdk/openai", ["m3"]),
};
/** 手放到 $DIY_HOME/data 的「改过的快照」 */
const SNAP_HAND = { handmade: provider("handmade", "@ai-sdk/openai-compatible", ["hm1", "hm2"]) };

const dataSnapshot = () => join(fx.HOME, "data", "models.dev.json");
const writeOrigin = (v: unknown) => writeFileSync(originFile, JSON.stringify(v), "utf-8");
const writeDataSnapshot = (v: unknown) => {
    mkdirSync(join(fx.HOME, "data"), { recursive: true });
    writeFileSync(dataSnapshot(), JSON.stringify(v), "utf-8");
};

beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "t385-origin-"));
    originFile = join(dir, "upstream.json");
    writeOrigin(SNAP_A);
    const electron = await startElectronTest({
        DIY_MODELS_DEV_ORIGIN: originFile,
        // 启动刷新关掉：本文件的重点是手工路径（启动首跑的契约在 tests/core/models-startup-refresh.test.ts）
        DIY_MODELS_STARTUP_REFRESH: "0",
    });
    const HOME = electron.home;
    fx = { electron, HOME, sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }) };
    ui = await makeUiDriver(electron.cdpUrl, async () => {
        const r = await fx.sh.getJson("./diy.sh ui inspect");
        return ((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.tree as never;
    });
}, 120_000);

afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
});

const doctor = async () => {
    const r = await fx.sh.getJson("./diy.sh doctor");
    return (r as any).data?.data as { models: { path: string; source: string; providers: number; models: number } | null };
};

const syncModels = async () => {
    const r = await fx.sh.getJson("./diy.sh llmConfig syncModels");
    return (r as any).data as {
        ok: boolean;
        changed: boolean;
        path: string;
        providers: number;
        models: number;
        addedModels: number;
        removedModels: number;
        error: string | null;
    };
};

describe("##385 §3.1 数据文件候选：$DIY_HOME 优先 + 诊断报实际路径", () => {
    it("doctor 报出模型目录快照的绝对路径与来源（内置快照存在时绝不为空）", async () => {
        const d = await doctor();
        expect(d.models).not.toBe(null);
        expect(d.models!.path.endsWith("models.dev.json")).toBe(true);
        expect(["diy-home", "bundle", "source-tree"]).toContain(d.models!.source);
        expect(d.models!.providers).toBeGreaterThan(0);
    });

    it("手放改过的快照 → 应用读到它（源 diy-home，压过发行/源树）+ 路径就是那一份", async () => {
        writeDataSnapshot(SNAP_HAND);
        // 缓存是进程内的：doctor 每次调 activeSnapshot 现读（不经 model-registry 的 4MB 缓存）
        const d = await doctor();
        expect(d.models).toMatchObject({ path: dataSnapshot(), source: "diy-home", providers: 1, models: 2 });

        // 模型页的数据源（llmConfig.read）也必须看到手工那份（而不是内置快照的 199 家）
        const r = await fx.sh.getJson("./diy.sh llmConfig read");
        // llmConfig.read 的 RPC data **没有** {status,data} 壳（契约即 view 本体）
        const catalog = ((r as any).data?.catalog ?? []) as { id: string }[];
        expect(catalog.map((c) => c.id)).toEqual(["handmade"]);
    });
});

describe("##385 §3.3/§3.4 手工刷新三态（RPC 与 UI 同一实现）", () => {
    it("有 diff → 写盘并报「新增 N / 下线 M」", async () => {
        // 当前 DIY_HOME 里是 SNAP_HAND；上游给 SNAP_B → 必然有 diff
        writeOrigin(SNAP_B);
        const r = await syncModels();
        expect(r.ok).toBe(true);
        expect(r.changed).toBe(true);
        expect(r.path).toBe(dataSnapshot());
        expect(r.providers).toBe(2);
        expect(r.models).toBe(3);
        expect(r.addedModels).toBeGreaterThan(0);
        expect(r.removedModels).toBeGreaterThan(0);
        // 落盘内容 = 过滤后的上游（不是从源树抄的）
        expect(Object.keys(JSON.parse(readFileSync(dataSnapshot(), "utf-8"))).sort()).toEqual(["alpha", "gamma"]);
    });

    it("无 diff → changed=false 且不写盘（内容与 mtime 都不动）", async () => {
        const before = { body: readFileSync(dataSnapshot(), "utf-8"), mtime: statSync(dataSnapshot()).mtimeMs };
        const r = await syncModels();
        expect(r.ok).toBe(true);
        expect(r.changed).toBe(false);
        expect(readFileSync(dataSnapshot(), "utf-8")).toBe(before.body);
        expect(statSync(dataSnapshot()).mtimeMs).toBe(before.mtime);
    });

    it("上游坏 → 报失败原因，本地快照逐字不变（fail-soft）", async () => {
        const before = { body: readFileSync(dataSnapshot(), "utf-8"), mtime: statSync(dataSnapshot()).mtimeMs };
        writeFileSync(originFile, "<html>502 Bad Gateway</html>", "utf-8");
        const r = await syncModels();
        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
        expect(readFileSync(dataSnapshot(), "utf-8")).toBe(before.body);
        expect(statSync(dataSnapshot()).mtimeMs).toBe(before.mtime);
        // 恢复上游，后面的 UI 用例继续用
        writeOrigin(SNAP_A);
    });

    it("模型页（常规入口）：按钮可点，三态文案就地可见（成功报数）", async () => {
        await fx.sh.getJson("./diy.sh ui page navigate settings");
        await ui.click("🤖 模型");
        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('[data-models-sync]')`),
            (v) => v,
            { label: "模型页刷新按钮出现", timeoutMs: 8000 },
        );
        // 上游已恢复为 SNAP_A，本地是 SNAP_B → 这次点击必有 diff，文案应报数
        await ui.clickSelector("[data-models-sync]");
        const text = await waitUntil(
            () =>
                ui.query<{ phase: string | null; text: string }>(`(() => {
                    const el = document.querySelector('[data-models-sync-status]');
                    return { phase: el ? el.getAttribute('data-models-sync-status') : null, text: el ? el.textContent : '' };
                })()`),
            (s) => s.phase === "ok" || s.phase === "error",
            { label: "按钮三态落到 ok/error", timeoutMs: 20000 },
        );
        expect(text.phase).toBe("ok");
        expect(text.text).toMatch(/已更新|已是最新/);
    });
});

describe("##385 §3.3 故障现场入口：模型不可用 bar 上的按钮", () => {
    it("真发因模型不可用失败 → bar 出现，且带「更新模型数据」按钮（可点、有状态）", async () => {
        // 造一条可复现的「模型不可用」：本地装配期就失败（模型 id 不在清单里）→ 不经网络
        const proj = await fx.sh.getJson(`./diy.sh ui project create ${fx.HOME}/bar-proj --label barP`);
        const pid = String((proj as any).data?.data?.id);
        const t = await fx.sh.getJson(`./diy.sh ui task create bar任务 ${pid}`);
        const uri = String((t as any).data?.data?.uri);
        // 非零退出是预期（模型不存在）；只关心它把通知推进了 main 的 ring
        await fx.sh.run(`./diy.sh agent local chat ${uri} 你好 --model no-such-model-t385`);

        await waitUntil(
            () => ui.query<boolean>(`!!document.querySelector('[data-model-unavailable-bar]')`),
            (v) => v,
            { label: "模型不可用 bar 出现", timeoutMs: 15000 },
        );
        expect(await ui.query<boolean>(`!!document.querySelector('[data-model-bar-sync]')`)).toBe(true);

        await ui.clickSelector("[data-model-bar-sync]");
        const phase = await waitUntil(
            () =>
                ui.query<string | null>(`(() => {
                    const el = document.querySelector('[data-model-bar-sync-status]');
                    return el ? el.getAttribute('data-model-bar-sync-status') : null;
                })()`),
            (p) => p === "ok" || p === "error",
            { label: "bar 上的刷新按钮给出三态", timeoutMs: 20000 },
        );
        expect(["ok", "error"]).toContain(phase);
        // 无论成功失败都必须**有话说**（不静默）
        const txt = await ui.query<string>(`document.querySelector('[data-model-bar-sync-status]').textContent`);
        expect(txt.length).toBeGreaterThan(0);
    });
});
