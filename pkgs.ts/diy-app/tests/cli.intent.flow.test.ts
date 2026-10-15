// tests/cli.intent.flow.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 flow 域 CLI 意图测试 —— 工作流实例与 task 绑定（##319）
//
// 需求定义（本文件即契约；内核行为由 pkgs.ts/diy-flow/tests 覆盖，这里覆盖**宿主接入**）：
//   1. 定义清单：`flow list` 列出注册表里的工作流；`--instances` 扫盘列出已绑定实例
//   2. 建实例：绑定工作流 + 参数值走**内核唯一闸门**（校验 + 合并缺省）+ 落**尚未进入**的初始态；
//      失败的 start 不留实例；不动任务 frontmatter、不写 state.yaml
//   3. 推进/打回：首次必须进**入口节点**；不许跳步；`advance` 只走 next 边、`bounce` 只走 bounce 边；
//      打回 = 目标节点再驻留一次（`seq` 递增，不新建节点）
//   4. 看实例：当前节点 + 插值后的 hint + 折线 + 出边 + 参数值（`params get` 的权威是 flow/state.json）
//   5. 改参数值：**只在尚未进入时**合法（换配置 = 另起一次运行）
//   6. 存储：`flow/` 四份文件；**state.json 是唯一权威**，`path.jsonl` 重建必须与它**同形**，
//      不一致 ⇒ 亮错（绝不静默择一）；`events.jsonl` 是审计，删掉不影响运行
//   7. 提示词装配：hint 经内核插值 + 既有 prompt-registry 渲染成节（「取得到」，不注入系统提示词）
//
// 每个用例自建 project / task，自删；共享的只有隔离 Electron 基础设施。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

interface ElectronFixture {
    sh: ShellTest;
    HOME: string;
    electron: ElectronTest;
}

let fx: ElectronFixture;

beforeAll(async () => {
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = { electron, HOME, sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }) };
});

afterAll(async () => {
    await fx?.electron?.stop();
});

/** 新建「项目 + 一条任务」并返回任务 URI（每个用例一个，互不干扰） */
async function freshTask(name: string): Promise<string> {
    const repo = `${fx.HOME}/flow-${name}`;
    const res = await fx.sh.getJson(`./diy.sh project create ${repo}`);
    const pid = String(((res.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id);
    await fx.sh.run(`./diy.sh task create 工作流任务 ${pid}`);
    return `projects/${pid}/tasks/1`;
}

/** `flow/` 下的文件路径（存储布局是契约的一部分，用例直接按路径核对） */
function flowFile(uri: string, name: string): string {
    return join(fx.HOME, uri, "flow", name);
}

const FLOW_FILES = ["instance.json", "state.json", "path.jsonl", "events.jsonl"];

describe("flow list", () => {
    it("列出注册表里的定义；--instances 扫盘列出已绑定实例", async () => {
        const r = await fx.sh.getJson(`./diy.sh flow list`);
        const workflows = (r.data as Record<string, unknown>)["workflows"] as Array<Record<string, unknown>>;
        expect(workflows.map((w) => w["id"])).toEqual(["dev"]);
        expect(workflows[0]).toMatchObject({ name: "开发工作流", entry: "implement", nodes: 3, edges: 3 });
        // --instances 缺省不出现（缺省只列定义，扫盘是显式请求）
        expect((r.data as Record<string, unknown>)["instances"]).toBeUndefined();

        const uri = await freshTask("list");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        const withInstances = await fx.sh.getJson(`./diy.sh flow list --instances`);
        const instances = (withInstances.data as Record<string, unknown>)["instances"] as Array<Record<string, unknown>>;
        expect(instances.some((i) => i["uri"] === uri && i["workflowId"] === "dev" && i["position"] === null)).toBe(true);
    });
});

describe("flow start", () => {
    it("建实例：绑定 + 参数过内核闸门（校验 + 合并缺省）+ 落尚未进入的初始态", async () => {
        const uri = await freshTask("start");
        const before = readFileSync(join(fx.HOME, uri, "AGENTS.md"), "utf-8");
        const r = await fx.sh.getJson(`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=3'`);
        const v = r.data as Record<string, unknown>;
        expect(v).toMatchObject({
            uri,
            workflowId: "dev",
            workflowName: "开发工作流",
            entry: "implement",
            entered: false,
            position: null,
            node: null,
            done: false,
            bounces: 0,
        });
        expect(v["params"]).toEqual({ review: { reviewers: 3, maxBounces: 2 }, ci: { command: "./sha.sh check" } });
        expect(v["next"]).toEqual({ mode: "entry", pending: [], edges: [] });
        // 四份文件（存储布局是契约）；权威快照里就有参数值
        for (const f of FLOW_FILES) expect(existsSync(flowFile(uri, f)), `缺 ${f}`).toBe(true);
        expect(JSON.parse(readFileSync(flowFile(uri, "state.json"), "utf-8"))).toEqual({
            position: null,
            path: [],
            params: v["params"],
        });
        // 绑定：哪个工作流 + 任务关联
        expect(JSON.parse(readFileSync(flowFile(uri, "instance.json"), "utf-8"))).toMatchObject({
            workflowId: "dev",
            ref: { taskUri: uri },
        });
        // 不动任务 frontmatter；不进 state.yaml（那是运行中应用独占写入的）
        expect(readFileSync(join(fx.HOME, uri, "AGENTS.md"), "utf-8")).toBe(before);
        if (existsSync(join(fx.HOME, "state.yaml"))) {
            expect(readFileSync(join(fx.HOME, "state.yaml"), "utf-8")).not.toContain(uri);
        }
    });

    it("拒绝：未知工作流 / 缺 --workflow / 未知参数 / 值越过内核上界（失败不留实例）", async () => {
        const uri = await freshTask("start-bad");
        const cases: Array<[string, RegExp]> = [
            [`./diy.sh flow start ${uri} --workflow nope`, /未知工作流/],
            [`./diy.sh flow start ${uri}`, /缺 --workflow/],
            [`./diy.sh flow start ${uri} --workflow dev --param 'review.nope=1'`, /未知参数/],
            [`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=x'`, /应为数字/],
            // 值语义（上下界）的唯一闸门是内核 createRuntime —— 宿主的错话得是内核那句
            [`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=99'`, /大于上界 5/],
        ];
        for (const [cmd, re] of cases) {
            const r = await fx.sh.run(cmd);
            expect(r.code, `$ ${cmd} 应失败`).not.toBe(0);
            expect(`${r.stdout}\n${r.stderr}`).toMatch(re);
        }
        expect(existsSync(flowFile(uri, "instance.json"))).toBe(false);
        expect(existsSync(flowFile(uri, "state.json"))).toBe(false);
    });
});

describe("flow advance / bounce", () => {
    it("首次必须进入口；不许跳步；推进后当前节点 / 插值 hint / 出边 / 折线都对得上", async () => {
        const uri = await freshTask("advance");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=2'`);

        // 首次进非入口：内核 invalid-entry
        const bad = await fx.sh.run(`./diy.sh flow advance ${uri} --to review`);
        expect(bad.code).not.toBe(0);
        expect(`${bad.stdout}\n${bad.stderr}`).toMatch(/首次推进只能进入入口节点/);

        const entry = await fx.sh.getJson(`./diy.sh flow advance ${uri} --to implement`);
        const v0 = entry.data as Record<string, unknown>;
        expect(v0).toMatchObject({ entered: true, position: "implement", done: false, bounces: 0 });
        expect((v0["node"] as Record<string, unknown>)["hint"]).toBe("在 worktree 里改完、自测过再宣布提交 Review。");
        // 谁该动作 + 可走的边（「卡在哪条边」的数据源）
        expect(v0["next"]).toEqual({
            mode: "actor",
            pending: ["prompt:dev_done"],
            edges: [{ to: "review", toName: "Review", kind: "next", when: null }],
        });

        // 跳步：no-edge
        const jump = await fx.sh.run(`./diy.sh flow advance ${uri} --to ci`);
        expect(jump.code).not.toBe(0);
        expect(`${jump.stdout}\n${jump.stderr}`).toMatch(/不许跳步/);

        // 推进到 review：hint 里的 `${reviewers}` 由内核插值成 2
        const r = await fx.sh.getJson(`./diy.sh flow advance ${uri} --to review --ref turnId=t1`);
        const v1 = r.data as Record<string, unknown>;
        expect(v1["position"]).toBe("review");
        expect((v1["node"] as Record<string, unknown>)["hint"]).toContain("按 2 人评审");
        expect((v1["next"] as Record<string, unknown>)["edges"]).toEqual([
            { to: "implement", toName: "开发", kind: "bounce", when: null },
            { to: "ci", toName: "CI", kind: "next", when: null },
        ]);
        // 折线 = 领域事实（node/seq/kind + 宿主 ref），次序看数组下标
        const traj = v1["trajectory"] as Array<Record<string, unknown>>;
        expect(traj.map((t) => `${t["node"]}#${t["seq"]}/${t["kind"]}`)).toEqual(["implement#1/next", "review#1/next"]);
        expect(traj[1]?.["ref"]).toMatchObject({ taskUri: uri, turnId: "t1" });
        // `show` 与 `advance` 的回执形状同源（同一份视图）
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(shown["position"]).toBe("review");
        expect(shown["trajectory"]).toEqual(traj);
    });

    it("bounce 走 bounce 边（目标节点再驻留 seq=2）；走 next 边拒；未进入拒", async () => {
        const uri = await freshTask("bounce");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        // 未进入就打回：无从打回
        const early = await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement`);
        expect(early.code).not.toBe(0);
        expect(`${early.stdout}\n${early.stderr}`).toMatch(/尚未进入工作流/);

        await fx.sh.run(`./diy.sh flow advance ${uri} --to implement`);
        await fx.sh.run(`./diy.sh flow advance ${uri} --to review`);

        // review → ci 是 next 边，只能用 advance
        const wrong = await fx.sh.run(`./diy.sh flow bounce ${uri} --to ci`);
        expect(wrong.code).not.toBe(0);
        expect(`${wrong.stdout}\n${wrong.stderr}`).toMatch(/是 next 边/);
        // advance 也不许拿它当打回的反面：review → implement 是 bounce 边
        const wrong2 = await fx.sh.run(`./diy.sh flow advance ${uri} --to implement`);
        expect(wrong2.code).not.toBe(0);
        expect(`${wrong2.stdout}\n${wrong2.stderr}`).toMatch(/是 bounce 边/);

        const r = await fx.sh.getJson(`./diy.sh flow bounce ${uri} --to implement --note 'P0 未落点'`);
        const v = r.data as Record<string, unknown>;
        expect(v["position"]).toBe("implement");
        expect(v["bounces"]).toBe(1);
        const traj = v["trajectory"] as Array<Record<string, unknown>>;
        // 打回**不新建节点**：目标节点再驻留一次（seq 递增）
        expect(traj.map((t) => `${t["node"]}#${t["seq"]}/${t["kind"]}`)).toEqual([
            "implement#1/next",
            "review#1/next",
            "implement#2/bounce",
        ]);
        // 备注只进审计（领域态不含人类文本）
        const audit = readFileSync(flowFile(uri, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        expect(audit.some((a) => typeof a.content === "string" && a.content.includes("P0 未落点"))).toBe(true);
        expect(readFileSync(flowFile(uri, "state.json"), "utf-8")).not.toContain("P0 未落点");
    });
});

describe("flow params", () => {
    it("get 以 state.json 为权威；set 只在尚未进入时合法", async () => {
        const uri = await freshTask("params");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=4'`);

        const g = (await fx.sh.getJson(`./diy.sh flow params get ${uri}`)).data as Record<string, unknown>;
        expect(g["authority"]).toBe(flowFile(uri, "state.json"));
        expect(g["entered"]).toBe(false);
        expect(g["values"]).toEqual({ review: { reviewers: 4, maxBounces: 2 }, ci: { command: "./sha.sh check" } });
        // schema / defaults 来自定义（供表单 / 文档渲染）
        expect((g["schema"] as Array<Record<string, unknown>>).map((s) => s["path"])).toEqual([
            "review.reviewers",
            "review.maxBounces",
            "ci.command",
        ]);
        expect((g["defaults"] as Record<string, unknown>)["review"]).toEqual({ reviewers: 1, maxBounces: 2 });

        // 尚未进入：可以改配置（换配置 = 另起一次运行，那个窗口在这里）
        const set = (await fx.sh.getJson(`./diy.sh flow params set ${uri} --param 'review.reviewers=5'`)).data as Record<string, unknown>;
        expect((set["params"] as Record<string, Record<string, unknown>>)["review"]).toMatchObject({ reviewers: 5 });
        expect(JSON.parse(readFileSync(flowFile(uri, "state.json"), "utf-8")).params.review.reviewers).toBe(5);

        // 进入之后：拒（内核同一立场）
        await fx.sh.run(`./diy.sh flow advance ${uri} --to implement`);
        const late = await fx.sh.run(`./diy.sh flow params set ${uri} --param 'review.reviewers=1'`);
        expect(late.code).not.toBe(0);
        expect(`${late.stdout}\n${late.stderr}`).toMatch(/参数值不可改/);
    });
});

describe("flow 存储对账", () => {
    it("state.json 与 path.jsonl 不一致 ⇒ 亮错（不静默择一）；审计流删掉不影响运行", async () => {
        const uri = await freshTask("store");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await fx.sh.run(`./diy.sh flow advance ${uri} --to implement`);
        await fx.sh.run(`./diy.sh flow advance ${uri} --to review`);
        const okLines = readFileSync(flowFile(uri, "path.jsonl"), "utf-8").trim().split("\n");
        expect(okLines.length).toBe(3); // config + 两次 advance

        // 审计流是 cache 性质：删掉之后照样跑（且 run 里没有「审计缺失」的噪声判定）
        rmSync(flowFile(uri, "events.jsonl"));
        const afterDelete = await fx.sh.getJson(`./diy.sh flow show ${uri}`);
        expect((afterDelete.data as Record<string, unknown>)["auditSkipped"]).toBe(0);
        await fx.sh.run(`./diy.sh flow advance ${uri} --to ci`);
        expect(existsSync(flowFile(uri, "events.jsonl"))).toBe(true);

        // 增量里少一条（模拟两份分歧）⇒ 亮错
        writeFileSync(flowFile(uri, "path.jsonl"), `${okLines[0]}\n${okLines[1]}\n`, "utf-8");
        const diverged = await fx.sh.run(`./diy.sh flow show ${uri}`);
        expect(diverged.code).not.toBe(0);
        expect(`${diverged.stdout}\n${diverged.stderr}`).toMatch(/不一致/);
        // 亮错时不许「按某一份继续跑」
        const blocked = await fx.sh.run(`./diy.sh flow advance ${uri} --to implement`);
        expect(blocked.code).not.toBe(0);
    });
});

describe("flow prompt", () => {
    it("按当前节点装配：hint 内核插值 + 既有 registry 渲染成节", async () => {
        const uri = await freshTask("prompt");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=2'`);
        // 尚未进入：没有「当前节点」，装配不出来（响亮报错，不给半截）
        const none = await fx.sh.run(`./diy.sh flow prompt ${uri}`);
        expect(none.code).not.toBe(0);
        expect(`${none.stdout}\n${none.stderr}`).toMatch(/尚未进入/);

        await fx.sh.run(`./diy.sh flow advance ${uri} --to implement`);
        await fx.sh.run(`./diy.sh flow advance ${uri} --to review`);
        const r = (await fx.sh.getJson(`./diy.sh flow prompt ${uri}`)).data as Record<string, unknown>;
        expect(r["nodeId"]).toBe("review");
        expect(r["hint"]).toContain("按 2 人评审");
        // 装配结果 = prompt-registry 用 flow_node_hint 模版渲染的节（不是宿主自己拼的字符串）
        expect(r["prompt"]).toContain('<flow_node workflow="dev" node="review" node_name="Review" actor="agent" position="review">');
        expect(r["prompt"]).toContain("按 2 人评审");
        expect(r["prompt"]).toContain("</flow_node>");
        expect(r["bytes"]).toBe(Buffer.byteLength(String(r["prompt"]), "utf-8"));
    });
});
