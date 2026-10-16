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
//   8. 终态与收尾：终端节点（无 next 出边）报 `next.terminal`（结构事实）；`finish` **宣布**收尾置 `done`
//      （只许在终端节点上）—— `done` 只来自这里（内核 step 的终态分支在 prompt: guard 下走不到），
//      收尾同样要留重建材料（`path.jsonl` 的 `finish` 记录），审计删掉不影响它
//   9. URI 闸门：`projects/<pid>/tasks/<tid>` 之外一律拒（读侧 single point）—— 别想读到数据根之外
//  10. 产物与视图下发（##337，`flow artifact put` / `flow view`）：节点产物 raw 放袋
//      （`flow/artifacts/<节点 id>.json`，下标 = 驻留 `seq` − 1）→ render 插件翻成 `{ renderer, payload }`；
//      **声明（`art`）、数据（袋）、代码（插件）三层各归各位**：`view` 的 renderer 必须与 `art.renderer`
//      一致；`art.plugin` 留空的**唯一**合法含义 =「raw 本身已经是该 renderer 的 data」（纯文本 raw ≠
//      `doc` 的 data ⇒ 文本类节点挂 `text` 插件包成 `{ text }`，否则 UI 上只剩「形状不符」）；
//      袋里缺项 = 无产物（`view: null`，正常态）、**袋坏 = 亮错**（无 vs 坏不是一回事）；多次驻留各取各的；
//      **产物不是领域态** —— 不进 `state.json`、不产生 `path.jsonl` 增量、删了不影响 `advance` / `show` / 对账；
//      坏袋也**不拖垮领域读**：`flow show` 照常出整页（`view: null` + `viewError` 亮错），
//      只有**产物专读**的 `flow view` 仍亮错（##337 review1 P2-B）
//  11. ##341 起定义升级为 **7 节点**（`clarify→design→implement⇄review→ci→approve(human)→merge`）+
//      **驱动**命令（`flow step` 系统推 / `flow run` 驱动环）；驱动那两条的用例在
//      `tests/cli.intent.flow-run.test.ts`。本文件里钉着旧形状的断言按新形状更新
//      （入口 implement→clarify、折线多 clarify/design 两跳、参数多一组 `merge.*`）—— **每例意图不变**。
//
// 每个用例自建 project / task，自删；共享的只有隔离 Electron 基础设施。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

/**
 * 从入口逐跳走到目标节点（##341 起入口是 `clarify`：折线上要先过 clarify / design）。
 * 传一串节点 id，按序 `advance`。
 */
async function advanceTo(uri: string, ...nodes: string[]): Promise<void> {
    for (const node of nodes) {
        const r = await fx.sh.run(`./diy.sh flow advance ${uri} --to ${node}`);
        expect(r.code, `到 ${node} 的推进应成功：${r.stdout}${r.stderr}`).toBe(0);
    }
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
        // ##341：入口 = clarify，7 节点（6 节点形状 + 1 个人工审批点）、7 条边
        expect(workflows[0]).toMatchObject({ name: "开发工作流", entry: "clarify", nodes: 7, edges: 7 });
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
            entry: "clarify",
            entered: false,
            position: null,
            node: null,
            done: false,
            bounces: 0,
        });
        expect(v["params"]).toEqual({
            review: { reviewers: 3, maxBounces: 2 },
            ci: { command: "./sha.sh check" },
            merge: { command: "gh pr view --json mergeable,state -q .mergeable", apply: false },
        });
        expect(v["next"]).toEqual({ mode: "entry", pending: [], edges: [], terminal: false });
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

    it("重复 start：**尚未进入**的实例会被重写（换配置窗口）；已进入则拒", async () => {
        const uri = await freshTask("start-again");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=2'`);
        const again = (await fx.sh.getJson(`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=4'`)).data as Record<string, unknown>;
        expect(again["entered"]).toBe(false);
        expect((again["params"] as Record<string, Record<string, unknown>>)["review"]?.["reviewers"]).toBe(4);
        // 重建材料留两条 config（重建取最后一份）⇒ 对账仍同形
        const ops = readFileSync(flowFile(uri, "path.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l)["op"]);
        expect(ops).toEqual(["config", "config"]);
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect((shown["params"] as Record<string, Record<string, unknown>>)["review"]?.["reviewers"]).toBe(4);

        // 已进入：换工作流 / 换配置 = 另起一次运行 ⇒ 拒（要重来只能清 flow/ 目录）
        await advanceTo(uri, "clarify");
        const late = await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        expect(late.code).not.toBe(0);
        expect(`${late.stdout}\n${late.stderr}`).toMatch(/已进入工作流/);
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

        // 入口 = clarify（##341 起）
        const entry = await fx.sh.getJson(`./diy.sh flow advance ${uri} --to clarify`);
        const v0 = entry.data as Record<string, unknown>;
        expect(v0).toMatchObject({ entered: true, position: "clarify", done: false, bounces: 0 });
        expect((v0["node"] as Record<string, unknown>)["hint"]).toContain("把需求澄清到没有歧义");
        // 谁该动作 + 可走的边（「卡在哪条边」的数据源）
        expect(v0["next"]).toEqual({
            mode: "actor",
            pending: ["prompt:requirement_clear"],
            edges: [{ to: "design", toName: "设计", kind: "next", when: null }],
            terminal: false, // 还有 next 出边 ⇒ 不是终端
        });

        // 跳步：no-edge
        const jump = await fx.sh.run(`./diy.sh flow advance ${uri} --to ci`);
        expect(jump.code).not.toBe(0);
        expect(`${jump.stdout}\n${jump.stderr}`).toMatch(/不许跳步/);

        // 一路推进到 review：hint 里的 `${reviewers}` 由内核插值成 2
        const r = await fx.sh.getJson(`./diy.sh flow advance ${uri} --to design`);
        expect((r.data as Record<string, unknown>)["position"]).toBe("design");
        await advanceTo(uri, "implement");
        const r1 = await fx.sh.getJson(`./diy.sh flow advance ${uri} --to review --ref turnId=t1`);
        const v1 = r1.data as Record<string, unknown>;
        expect(v1["position"]).toBe("review");
        expect((v1["node"] as Record<string, unknown>)["hint"]).toContain("按 2 人评审");
        expect((v1["next"] as Record<string, unknown>)["edges"]).toEqual([
            { to: "implement", toName: "开发", kind: "bounce", when: null },
            { to: "ci", toName: "CI", kind: "next", when: null },
        ]);
        // 折线 = 领域事实（node/seq/kind + 宿主 ref），次序看数组下标
        const traj = v1["trajectory"] as Array<Record<string, unknown>>;
        expect(traj.map((t) => `${t["node"]}#${t["seq"]}/${t["kind"]}`)).toEqual([
            "clarify#1/next",
            "design#1/next",
            "implement#1/next",
            "review#1/next",
        ]);
        expect(traj[3]?.["ref"]).toMatchObject({ taskUri: uri, turnId: "t1" });
        // `show` 与 `advance` 的回执形状同源（同一份视图）
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(shown["position"]).toBe("review");
        expect(shown["trajectory"]).toEqual(traj);
    });

    it("bounce 走 bounce 边（目标节点再驻留 seq=2）；走 next 边拒；未进入拒", async () => {
        const uri = await freshTask("bounce");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        // 未进入就打回：无从打回（目标取**入口节点** —— 打在别的节点上会先撞
        // 「首次推进只能进入入口」那条闸，测不到「未进入」这一支）
        const early = await fx.sh.run(`./diy.sh flow bounce ${uri} --to clarify`);
        expect(early.code).not.toBe(0);
        expect(`${early.stdout}\n${early.stderr}`).toMatch(/尚未进入工作流/);

        await advanceTo(uri, "clarify", "design", "implement", "review");

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
            "clarify#1/next",
            "design#1/next",
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
        expect(g["values"]).toEqual({
            review: { reviewers: 4, maxBounces: 2 },
            ci: { command: "./sha.sh check" },
            merge: { command: "gh pr view --json mergeable,state -q .mergeable", apply: false },
        });
        // schema / defaults 来自定义（供表单 / 文档渲染）
        expect((g["schema"] as Array<Record<string, unknown>>).map((s) => s["path"])).toEqual([
            "review.reviewers",
            "review.maxBounces",
            "ci.command",
            "merge.command",
            "merge.apply",
        ]);
        expect((g["defaults"] as Record<string, unknown>)["review"]).toEqual({ reviewers: 1, maxBounces: 2 });

        // 尚未进入：可以改配置（换配置 = 另起一次运行，那个窗口在这里）
        const set = (await fx.sh.getJson(`./diy.sh flow params set ${uri} --param 'review.reviewers=5'`)).data as Record<string, unknown>;
        expect((set["params"] as Record<string, Record<string, unknown>>)["review"]).toMatchObject({ reviewers: 5 });
        expect(JSON.parse(readFileSync(flowFile(uri, "state.json"), "utf-8")).params.review.reviewers).toBe(5);

        // 进入之后：拒（内核同一立场）
        await advanceTo(uri, "clarify");
        const late = await fx.sh.run(`./diy.sh flow params set ${uri} --param 'review.reviewers=1'`);
        expect(late.code).not.toBe(0);
        expect(`${late.stdout}\n${late.stderr}`).toMatch(/参数值不可改/);
    });
});

describe("flow 存储对账", () => {
    it("state.json 与 path.jsonl 不一致 ⇒ 亮错（不静默择一）；审计流删掉不影响运行", async () => {
        const uri = await freshTask("store");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement", "review");
        const okLines = readFileSync(flowFile(uri, "path.jsonl"), "utf-8").trim().split("\n");
        expect(okLines.length).toBe(5); // config + 四次 advance

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

        await advanceTo(uri, "clarify", "design", "implement", "review");
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

describe("flow 终态与收尾", () => {
    it("终端节点：next.terminal 亮（结构事实）、advance/bounce 都无路；finish 宣布收尾后 done 才亮", async () => {
        const uri = await freshTask("terminal");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev --param 'review.reviewers=2'`);
        await advanceTo(uri, "clarify", "design", "implement");
        // 非终端节点：还有 next 出边 ⇒ terminal 为假
        const atImplement = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect((atImplement["next"] as Record<string, unknown>)["terminal"]).toBe(false);

        // ##341 起的终端节点是 merge（ci → approve(human) → merge 都是 next 边）
        await advanceTo(uri, "review", "ci", "approve", "merge");
        const ci = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        const next = ci["next"] as Record<string, unknown>;
        // 结构事实：没有 next 出边 ⇒ terminal；而 done 还没亮（`merge` 的 guard 是 action:，要系统去求值）
        expect(ci["position"]).toBe("merge");
        expect(next["terminal"]).toBe(true);
        expect(next["edges"]).toEqual([]);
        expect(ci["done"]).toBe(false);

        // 走到头之后：位置变更怎么都不行（no-edge / 不许跳步）
        for (const cmd of [`./diy.sh flow advance ${uri} --to implement`, `./diy.sh flow bounce ${uri} --to implement`]) {
            const r = await fx.sh.run(cmd);
            expect(r.code, `$ ${cmd} 应失败`).not.toBe(0);
            expect(`${r.stdout}\n${r.stderr}`).toMatch(/不许跳步|不存在从/);
        }

        // 收尾：置 done + 落权威快照 + 留重建材料（path.jsonl 的 finish 记录）
        const fin = (await fx.sh.getJson(`./diy.sh flow finish ${uri}`)).data as Record<string, unknown>;
        expect(fin["done"]).toBe(true);
        expect((fin["next"] as Record<string, unknown>)["terminal"]).toBe(true);
        expect(JSON.parse(readFileSync(flowFile(uri, "state.json"), "utf-8")).done).toBe(true);
        const recs = readFileSync(flowFile(uri, "path.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        expect(recs[recs.length - 1]["op"]).toBe("finish");

        // 审计是 cache：删掉之后 done 照样在（权威 = state.json）；对账也过（重建侧同样重建得出 done）
        rmSync(flowFile(uri, "events.jsonl"));
        const after = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(after["done"]).toBe(true);
        expect(after["auditSkipped"]).toBe(0);
        // 参数值不受收尾影响（收尾不是另起一次运行）
        expect((after["params"] as Record<string, Record<string, unknown>>)["review"]?.["reviewers"]).toBe(2);

        // 重复收尾：拒（已收尾）
        const twice = await fx.sh.run(`./diy.sh flow finish ${uri}`);
        expect(twice.code).not.toBe(0);
        expect(`${twice.stdout}\n${twice.stderr}`).toMatch(/已收尾/);
        // 已收尾后再想推进：还是无路（终端节点没有出边）
        const afterFinish = await fx.sh.run(`./diy.sh flow advance ${uri} --to implement`);
        expect(afterFinish.code).not.toBe(0);
    });

    it("finish 拒绝：尚未进入 / 非终端节点（还有 next 出边）—— 失败不留 half-state", async () => {
        const uri = await freshTask("terminal-bad");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        const early = await fx.sh.run(`./diy.sh flow finish ${uri}`);
        expect(early.code).not.toBe(0);
        expect(`${early.stdout}\n${early.stderr}`).toMatch(/尚未进入/);

        await advanceTo(uri, "clarify", "design", "implement");
        const mid = await fx.sh.run(`./diy.sh flow finish ${uri}`);
        expect(mid.code).not.toBe(0);
        expect(`${mid.stdout}\n${mid.stderr}`).toMatch(/还有 next 出边/);
        // 拒 = 什么都不写（done 没被置位，path.jsonl 没有 finish 记录）
        expect(JSON.parse(readFileSync(flowFile(uri, "state.json"), "utf-8")).done).toBeUndefined();
        expect(readFileSync(flowFile(uri, "path.jsonl"), "utf-8")).not.toContain("finish");
    });
});

describe("flow URI 闸门", () => {
    it("非形状 URI 一律拒（读侧 single point）—— 数据根之外的伪实例读不到", async () => {
        // 在数据根**之上**造一个伪实例：形状闸门若缺位，show / advance 就会读到它（= review 探针 probe-t319-uri.mts）
        const evilUri = `../flow-evil-${process.pid}`;
        const evilDir = join(fx.HOME, "..", `flow-evil-${process.pid}`);
        mkdirSync(join(evilDir, "flow"), { recursive: true });
        writeFileSync(join(evilDir, "flow", "instance.json"), JSON.stringify({ workflowId: "dev", params: {} }));
        writeFileSync(join(evilDir, "flow", "state.json"), JSON.stringify({ position: null, path: [], params: {} }));
        writeFileSync(join(evilDir, "flow", "path.jsonl"), `${JSON.stringify({ op: "config", params: {} })}\n`);
        try {
            const cases = [
                `./diy.sh flow show ${evilUri}`,
                `./diy.sh flow params get ${evilUri}`,
                `./diy.sh flow advance ${evilUri} --to implement`,
                `./diy.sh flow bounce ${evilUri} --to implement`,
                `./diy.sh flow finish ${evilUri}`,
                `./diy.sh flow start ${evilUri} --workflow dev`,
            ];
            for (const cmd of cases) {
                const r = await fx.sh.run(cmd);
                expect(r.code, `$ ${cmd} 应失败`).not.toBe(0);
                expect(`${r.stdout}\n${r.stderr}`).toMatch(/形状应为 projects|任务不存在/);
                // 不能是「读到了、只是内容不对」
                expect(`${r.stdout}\n${r.stderr}`).not.toContain(evilDir);
            }
        } finally {
            rmSync(evilDir, { recursive: true, force: true });
        }
    });
});

describe("flow 产物与视图下发（art + render 插件）", () => {
    it("放 raw → view 的 renderer 与声明一致（插件翻译）；`doc` 的 payload 必须是 `{ text }`（不是裸字符串）", async () => {
        const uri = await freshTask("artifact");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement");

        // 还没放产物：声明在（art）、结果是 null —— **缺项不是错**（产物不是领域态，本就不必存在）
        const empty = (await fx.sh.getJson(`./diy.sh flow view ${uri}`)).data as Record<string, unknown>;
        expect(empty).toMatchObject({ uri, node: "implement", nodeName: "开发", seq: 1, plugin: "patch", view: null });
        expect(empty["art"]).toMatchObject({ renderer: "diff", plugin: "patch" });
        expect(empty["bag"]).toBe(join(fx.HOME, uri, "flow", "artifacts", "implement.json"));

        // 一段 unified diff（**非 JSON ⇒ 原样当字符串**交给插件）：头两行 `---`/`+++` 不算增删
        const diffFile = join(fx.HOME, "t337-step.diff");
        writeFileSync(diffFile, "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n context\n-旧\n+新\n", "utf-8");
        const put = (await fx.sh.getJson(`./diy.sh flow artifact put ${uri} --node implement --file ${diffFile}`)).data as Record<string, unknown>;
        expect(put).toMatchObject({ node: "implement", seq: 1, plugin: "patch" });
        expect(put["view"]).toEqual({
            renderer: "diff", // **与 art.renderer 一致**（宿主另有一道校验：不一致当场报错）
            payload: {
                lines: [
                    { kind: "context", text: "--- a/x.ts" },
                    { kind: "context", text: "+++ b/x.ts" },
                    { kind: "context", text: "@@ -1 +1 @@" },
                    { kind: "context", text: " context" },
                    { kind: "del", text: "-旧" },
                    { kind: "add", text: "+新" },
                ],
            },
        });
        // 袋的形状：JSON 数组，下标 = 驻留 seq − 1；放的是 raw 本身
        expect(JSON.parse(readFileSync(join(fx.HOME, uri, "flow", "artifacts", "implement.json"), "utf-8"))).toEqual([
            "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n context\n-旧\n+新\n",
        ]);
        // `show` 也带上当前节点当前驻留的 art / view（同一份链，不两处实现）
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(shown["position"]).toBe("implement");
        expect(shown["view"]).toEqual(put["view"]);

        // ci 节点：raw 是**纯文本**，而 `doc` 渲染器吃的是 `{ text: string }`（**裸字符串不是它**）
        // ⇒ 必须过 `text` 插件包一层。少了这一步，UI 上的 CI 产物只剩「形状不符」，用户看不到 CI 输出
        // （##337 review1 P2-A；UI 侧的渲染断言归 ##320）
        await fx.sh.run(`./diy.sh flow advance ${uri} --to review`);
        await fx.sh.run(`./diy.sh flow advance ${uri} --to ci`);
        const ciFile = join(fx.HOME, "t337-ci.txt");
        writeFileSync(ciFile, "./sha.sh check\nEXIT=0\n", "utf-8");
        // `-` = 读 stdin（管道；内容在**调用方进程**读，见 _cli-meta.readFile）
        const ciPut = (await fx.sh.getJson(`cat ${ciFile} | ./diy.sh flow artifact put ${uri} --node ci --file -`)).data as Record<string, unknown>;
        expect(ciPut["art"]).toMatchObject({ renderer: "doc", plugin: "text" });
        expect(ciPut).toMatchObject({ node: "ci", seq: 1, plugin: "text" });
        const ciView = ciPut["view"] as Record<string, unknown>;
        expect(ciView["renderer"]).toBe("doc");
        // `doc` 的 data（`DocData`）= `{ text: string }`：**不是**裸字符串（这正是 P2-A 卡住的那条缝）
        expect(ciView["payload"]).toEqual({ text: "./sha.sh check\nEXIT=0\n" });
        expect(typeof ciView["payload"]).toBe("object"); // 裸字符串就是 P2-A 那个 bug
    });

    it("多次驻留各取各的：打回后第 2 次驻留的产物 ≠ 第 1 次；缺项为 null", async () => {
        const uri = await freshTask("artifact-seq");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement");
        const f1 = join(fx.HOME, "t337-review1.json");
        writeFileSync(f1, JSON.stringify({ columns: ["项", "结论"], rows: [["落点", "P0 未落"]] }), "utf-8");
        await fx.sh.run(`./diy.sh flow advance ${uri} --to review`);
        await fx.sh.getJson(`./diy.sh flow artifact put ${uri} --node review --file ${f1}`);

        // 打回 → implement#2 → 再回 review（review#2）
        await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement`);
        await fx.sh.run(`./diy.sh flow advance ${uri} --to review`);
        // 第 2 次驻留还没放产物：**缺项 ⇒ view null**（只认「那一次」的产物，不会拿第 1 次的顶上）
        const hole = (await fx.sh.getJson(`./diy.sh flow view ${uri} --node review --seq 2`)).data as Record<string, unknown>;
        expect(hole["seq"]).toBe(2);
        expect(hole["view"]).toBeNull();
        // `--seq` 缺省 = 该节点**最后一次**驻留（人在的就是那一次）
        expect(((await fx.sh.getJson(`./diy.sh flow view ${uri} --node review`)).data as Record<string, unknown>)["seq"]).toBe(2);

        const f2 = join(fx.HOME, "t337-review2.json");
        // 裸数组（= 只有 rows，列序取该行的键序 —— 上面那份给了 columns，这份没给）
        writeFileSync(f2, JSON.stringify([{ 项: "落点", 结论: "已补" }]), "utf-8");
        const put2 = (await fx.sh.getJson(`./diy.sh flow artifact put ${uri} --node review --file ${f2}`)).data as Record<string, unknown>;
        expect(put2["seq"]).toBe(2);
        expect(put2["view"]).toEqual({ renderer: "table", payload: { rows: [{ cells: ["落点", "已补"] }] } });

        // 第 1 次驻留那份**不动**（各取各的；回填更早的驻留也走 --seq）
        const first = (await fx.sh.getJson(`./diy.sh flow view ${uri} --node review --seq 1`)).data as Record<string, unknown>;
        expect(first["view"]).toEqual({
            renderer: "table",
            payload: { columns: ["项", "结论"], rows: [{ cells: ["落点", "P0 未落"] }] },
        });
        expect(JSON.parse(readFileSync(join(fx.HOME, uri, "flow", "artifacts", "review.json"), "utf-8")).length).toBe(2);
    });

    it("拒：袋坏（亮错，不静默当「没产物」）· 内容空 · 未知节点 · 没驻留过 / seq 越界 · 非形状 URI", async () => {
        const uri = await freshTask("artifact-bad");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement");
        const good = join(fx.HOME, "t337-good.txt");
        writeFileSync(good, "一段文本", "utf-8");
        const wrongShape = join(fx.HOME, "t337-wrong.json");
        writeFileSync(wrongShape, JSON.stringify({ rows: [["表格不是 diff 文本"]] }), "utf-8");

        const cases: Array<[string, RegExp]> = [
            // `--node` 必填
            [`./diy.sh flow artifact put ${uri} --file ${good}`, /node/],
            // 未知节点：报错要把本工作流的节点列出来（别让人猜）
            [`./diy.sh flow artifact put ${uri} --node nope --file ${good}`, /未知节点/],
            // 还没驻留过的节点：产物属于某一次驻留
            [`./diy.sh flow artifact put ${uri} --node review --file ${good}`, /还没驻留过/],
            [`./diy.sh flow view ${uri} --node review`, /还没驻留过/],
            // seq 越界（implement 只驻留过 1 次）
            [`./diy.sh flow artifact put ${uri} --node implement --seq 3 --file ${good}`, /只驻留过 1 次/],
            [`./diy.sh flow view ${uri} --node implement --seq 0`, /不存在/],
            // 空内容：不写空产物
            [`./diy.sh flow artifact put ${uri} --node implement --file /dev/null`, /内容为空/],
            // 插件译不出来的 raw（implement 挂的是 patch，只吃文本）⇒ **写之前**就拒
            [`./diy.sh flow artifact put ${uri} --node implement --file ${wrongShape}`, /应为字符串/],
            // 非形状 URI：形状闸门在**读实例之前**（single point）
            [`./diy.sh flow view ../evil-337`, /形状应为 projects/],
        ];
        for (const [cmd, re] of cases) {
            const r = await fx.sh.run(cmd);
            expect(r.code, `$ ${cmd} 应失败`).not.toBe(0);
            expect(`${r.stdout}\n${r.stderr}`).toMatch(re);
        }
        // 拒 = 一个字节都不写（连 diff 这种「译不出来」的 raw 也拒在写之前：implement 挂的是 patch 插件）
        expect(existsSync(join(fx.HOME, uri, "flow", "artifacts", "implement.json"))).toBe(false);

        // 袋坏：**产物专读**（`flow view`）亮错并指出路径与出路（删掉它不影响推进），不静默当「没产物」。
        // `flow show`（领域读）**不抛** —— 立场见下一节「坏袋不拖垮领域读」（##337 review1 P2-B）
        await fx.sh.getJson(`./diy.sh flow artifact put ${uri} --node implement --file ${good}`);
        const bag = join(fx.HOME, uri, "flow", "artifacts", "implement.json");
        writeFileSync(bag, "{ 半截 JSON", "utf-8");
        const badView = await fx.sh.run(`./diy.sh flow view ${uri} --node implement`);
        expect(badView.code).not.toBe(0);
        expect(`${badView.stdout}\n${badView.stderr}`).toContain(bag);
        expect(`${badView.stdout}\n${badView.stderr}`).toMatch(/产物袋不是合法 JSON/);
        // 袋不是数组同样亮错
        writeFileSync(bag, JSON.stringify({ raw: "对象不是袋" }), "utf-8");
        const notArray = await fx.sh.run(`./diy.sh flow view ${uri} --node implement`);
        expect(notArray.code).not.toBe(0);
        expect(`${notArray.stdout}\n${notArray.stderr}`).toMatch(/应为 JSON 数组/);
    });
});

describe("flow 产物坏袋不拖垮领域读（##337 review1 P2-B）", () => {
    it("坏袋 ⇒ `show` 照常出整页（view:null + viewError 亮错、带路径与出路）；`flow view` 仍亮错", async () => {
        const uri = await freshTask("artifact-bagerror");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement");
        const good = join(fx.HOME, "t337-bage-left.diff");
        writeFileSync(good, "-旧\n+新\n", "utf-8");
        await fx.sh.getJson(`./diy.sh flow artifact put ${uri} --node implement --file ${good}`);
        const bag = join(fx.HOME, uri, "flow", "artifacts", "implement.json");

        // 先证「不坏时 show 的产物路是好的」（后面不是本来就空）
        const ok = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(ok["viewError"]).toBeNull();
        expect((ok["view"] as Record<string, unknown>)["renderer"]).toBe("diff");

        // 袋坏 —— **产物不是领域态**：此刻 state.json / path.jsonl 一个字节没动
        writeFileSync(bag, "{ 半截 JSON", "utf-8");
        const shown = await fx.sh.getJson(`./diy.sh flow show ${uri}`);
        const view = shown.data as Record<string, unknown>;
        expect(view["position"]).toBe("implement"); // 领域事实照常
        expect(view["next"]).toBeDefined(); // 出边照常
        expect((view["trajectory"] as unknown[]).at(-1)).toMatchObject({ node: "implement", seq: 1 });
        expect(view["art"]).toMatchObject({ renderer: "diff" }); // 声明照常（它来自定义，不来自袋）
        expect(view["view"]).toBeNull();
        // 错误位：把话说清（袋的路径 + 出路），不静默降级成「没产物」
        const err = String(view["viewError"]);
        expect(err).toContain(bag);
        expect(err).toMatch(/产物袋不是合法 JSON/);
        expect(err).toMatch(/删掉/); // 出路
        // 「无」与「坏」分得清：viewError 非空 = 坏；都 null 才是「没放产物」
        expect(view["viewError"]).not.toBeNull();

        // 产物专读仍**亮错**（人在查产物时必须知道是坏的）
        const strict = await fx.sh.run(`./diy.sh flow view ${uri} --node implement`);
        expect(strict.code).not.toBe(0);
        expect(`${strict.stdout}\n${strict.stderr}`).toContain(bag);
        expect(`${strict.stdout}\n${strict.stderr}`).toMatch(/产物袋不是合法 JSON/);

        // 袋不是数组同样是「坏」：`show` 还是不失败，只在 viewError 里说
        writeFileSync(bag, JSON.stringify({ raw: "对象不是袋" }), "utf-8");
        const notArray = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(String(notArray["viewError"])).toMatch(/应为 JSON 数组/);
        expect(notArray["view"]).toBeNull();
        expect((await fx.sh.run(`./diy.sh flow view ${uri} --node implement`)).code).not.toBe(0);

        // 领域推进不受牵连；换个节点（袋不存在）⇒ viewError 回到 null（错只属于那个坏袋 —— `show`
        // 只看**当前节点**那一份）
        const adv = (await fx.sh.getJson(`./diy.sh flow advance ${uri} --to review`)).data as Record<string, unknown>;
        expect(adv["position"]).toBe("review");
        expect(adv["view"]).toBeNull();
        expect(adv["viewError"]).toBeNull();
    });
});

describe("flow 产物不是领域态", () => {
    it("放产物不动 state.json / path.jsonl；删掉袋不影响 advance / show / 对账", async () => {
        const uri = await freshTask("artifact-nostate");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement");
        const stateBefore = readFileSync(flowFile(uri, "state.json"), "utf-8");
        const pathBefore = readFileSync(flowFile(uri, "path.jsonl"), "utf-8");

        const f = join(fx.HOME, "t337-nostate.diff");
        writeFileSync(f, "-旧\n+新\n", "utf-8");
        await fx.sh.getJson(`./diy.sh flow artifact put ${uri} --node implement --file ${f}`);
        // 产物**不进**领域态、**不产生**重建材料（`rule.domain-first`：领域态只有 position/path/params/done）
        expect(readFileSync(flowFile(uri, "state.json"), "utf-8")).toBe(stateBefore);
        expect(readFileSync(flowFile(uri, "path.jsonl"), "utf-8")).toBe(pathBefore);
        expect(existsSync(join(fx.HOME, uri, "flow", "artifacts", "implement.json"))).toBe(true);

        // 删掉整个产物袋 ⇒ 推进 / 看实例 / 对账照常（只是那一步没图可看）
        rmSync(join(fx.HOME, uri, "flow", "artifacts"), { recursive: true, force: true });
        const adv = (await fx.sh.getJson(`./diy.sh flow advance ${uri} --to review`)).data as Record<string, unknown>;
        expect(adv["position"]).toBe("review");
        expect(adv["view"]).toBeNull();
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(shown["position"]).toBe("review");
        expect(shown["view"]).toBeNull();
        expect(shown["art"]).toMatchObject({ renderer: "table" });
        // 对账仍在跑（把 path.jsonl 少写一条 ⇒ 还是亮错，与产物无关）
        const lines = readFileSync(flowFile(uri, "path.jsonl"), "utf-8").trim().split("\n");
        writeFileSync(flowFile(uri, "path.jsonl"), `${lines[0]}\n`, "utf-8");
        const diverged = await fx.sh.run(`./diy.sh flow show ${uri}`);
        expect(diverged.code).not.toBe(0);
        expect(`${diverged.stdout}\n${diverged.stderr}`).toMatch(/不一致/);
    });
});

// ═══════════════════════════════════════════════════════════════
// 讨论线程（##342）：打回意见与讨论的**一等载体**
//
// 需求（用户原话）：打回反复争论的消息的载体要**可见、留痕**。
// 契约（本段即判据）：
//   1. **意见正文一等落盘**：`flow bounce --opinion` 把正文写进讨论流 `flow/threads.jsonl`
//      （append-only、一行一条 JSON）；`--note` 照旧只进审计（不回退）。
//   2. **锚点 = 真打回边**：`{from,to,seq}`（`seq` = **落点那次驻留**）—— 一次 bounce 恰创生一次驻留
//      ⇒ 三元组唯一；**同节点二次打回不串台**（##320 P1-1 的教训）。
//   3. **旁注**（`rule.core-log`）：不进 `state.json`、不进 `path.jsonl`、**删掉不影响**推进 / 对账 / 折线；
//      坏了只亮错误位（`flow show` 的 `threadError` + `flow thread list` 的 `skipped`）。
//   4. **不造数据**：`flow thread post` 的锚点必须在折线上确是那条打回，假锚点拒。
//   5. **三出口**：(a) 撤销打回 = 现有合法边（dev 定义 `implement --next--> review`，不动内核）
//      (b) `--type resolved` (c) `--type escalate`（最后一条状态发言决定线程状态）。
// ═══════════════════════════════════════════════════════════════

/** 讨论发言的命令行（正文走**文件**：意见是多行的，shell 引用容易出错，与 `--file` 同一约定） */
function threadPostCmd(uri: string, thread: string, text: string, type = "note", author = "cli"): string {
    const file = join(fx.HOME, `thread-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(file, text, "utf-8");
    return `./diy.sh flow thread post ${uri} --thread '${thread}' --text ${file} --type ${type} --author '${author}'`;
}

/** 一条线程里所有发言的正文（判据看内容，不看「有没有元素」） */
function postsText(thread: Record<string, unknown>): string {
    return ((thread["posts"] as Array<Record<string, unknown>>) ?? []).map((p) => String(p["text"])).join("\n");
}

/** `flow thread list` 的线程表 */
async function listThreads(uri: string, extra = ""): Promise<{ threads: Array<Record<string, unknown>>; skipped: number; error: string | null; file: string }> {
    const r = await fx.sh.getJson(`./diy.sh flow thread list ${uri} ${extra}`.trim());
    const d = r.data as Record<string, unknown>;
    return {
        threads: (d["threads"] as Array<Record<string, unknown>>) ?? [],
        skipped: Number(d["skipped"] ?? 0),
        error: (d["error"] as string | null) ?? null,
        file: String(d["file"] ?? ""),
    };
}

describe("flow 讨论线程（##342）", () => {
    it("打回带 --opinion ⇒ 意见正文一等落盘、锚点 = 那次打回；讨论是旁注（不进领域态）", async () => {
        const uri = await freshTask("thread");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement", "review");
        const opinion = join(fx.HOME, "opinion.txt");
        writeFileSync(opinion, "P0：边界条件没覆盖\nP1：错误信息没说清", "utf-8");
        const bounced = await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement --note '审计后缀' --opinion ${opinion} --author '评审 agent'`);
        expect(bounced.code, bounced.stderr).toBe(0);

        // 讨论流：一行一条 JSON（append-only）；锚点 = 这次打回的**落点驻留**（implement#2）
        const lines = readFileSync(flowFile(uri, "threads.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ author: "评审 agent", type: "note", anchor: { from: "review", to: "implement", seq: 2 } });
        expect(lines[0]["text"]).toContain("边界条件没覆盖");
        // `--note` 照旧只进审计（不回退）
        expect(readFileSync(flowFile(uri, "events.jsonl"), "utf-8")).toContain("审计后缀");
        // **旁注**：不进领域态（`rule.domain-first`）—— state.json / path.jsonl 里一个字都没有
        expect(readFileSync(flowFile(uri, "state.json"), "utf-8")).not.toContain("边界条件");
        expect(readFileSync(flowFile(uri, "path.jsonl"), "utf-8")).not.toContain("边界条件");

        // 读口：`flow thread list` 看得见它，锚点对得上折线（源 = review#1、落点 = implement#2、折线上第 5 条）
        const t = await listThreads(uri);
        expect(t.threads.map((x) => x["id"])).toEqual(["review->implement#2"]);
        expect(t.threads[0]).toMatchObject({
            fromName: "Review",
            toName: "开发",
            fromSeq: 1,
            real: true,
            at: 4,
            status: "open",
        });
        expect(postsText(t.threads[0]!)).toContain("边界条件没覆盖");
        expect(t.skipped).toBe(0);
        expect(t.error).toBeNull();
        expect(t.file).toBe(flowFile(uri, "threads.jsonl"));

        // `flow show`（领域读）照常，并给出讨论流的错误位（没出错 ⇒ null）与文件路径
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(shown["position"]).toBe("implement");
        expect(shown["threadError"]).toBeNull();
        expect((shown["files"] as Record<string, unknown>)["threads"]).toBe(flowFile(uri, "threads.jsonl"));

        // 锚点形状闸门：写法不对 / 不存在的线程 ⇒ 拒（不静默给空）
        const badShape = await fx.sh.run(`./diy.sh flow thread list ${uri} --thread 'nonsense'`);
        expect(badShape.code).not.toBe(0);
        expect(`${badShape.stdout}${badShape.stderr}`).toMatch(/线程写法应为/);
        const missing = await fx.sh.run(`./diy.sh flow thread list ${uri} --thread 'review->implement#9'`);
        expect(missing.code).not.toBe(0);
        expect(`${missing.stdout}${missing.stderr}`).toMatch(/没有这条打回线程/);
    });

    /**
     * ##342 review1 P2-1：**空正文一律拒**，且 CLI 这条路要**拒在领域态变更之前**。
     *
     * 判据两半：① 命令失败（说得出「正文为空」）；② 折线/位置/打回次数**一个字节没动**
     * （否则就是「打回落了盘、命令却报错」的半截成功）。闸门与驱动环那条共用 `flow-store.ts::requirePostText`。
     */
    it("空意见一律拒：`--opinion` 空 ⇒ 命令失败，且领域态**没被改**（不留半截状态）", async () => {
        const uri = await freshTask("thread-empty");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement", "review");
        const blank = join(fx.HOME, "opinion-blank.txt");
        writeFileSync(blank, "   \n\t\n", "utf-8");
        const r = await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement --opinion ${blank}`);
        expect(r.code).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(/正文为空/);
        // 领域态没动：位置仍在 review、一次打回都没记、讨论流根本没被创建
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(shown["position"]).toBe("review");
        expect(shown["bounces"]).toBe(0);
        expect((shown["trajectory"] as unknown[]).length).toBe(4);
        expect(existsSync(flowFile(uri, "threads.jsonl"))).toBe(false);
    });

    it("同一节点二次打回：两条线程各带各的意见（不同 seq，不串台）；往老线程发言不新建线程", async () => {
        const uri = await freshTask("thread-twice");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement", "review");
        const one = join(fx.HOME, "opinion-one.txt");
        writeFileSync(one, "ONE：第一轮打回", "utf-8");
        await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement --opinion ${one}`);
        // 出口 (a) **撤销打回**：implement → review 是**现有合法 next 边**（dev 定义里就有）——
        // 不改内核语义、不加新命令，位置回到评审（review#2），折线留痕
        const back = (await fx.sh.getJson(`./diy.sh flow advance ${uri} --to review`)).data as Record<string, unknown>;
        expect(back["position"], "撤销打回走的是现有合法边（implement --next--> review）").toBe("review");
        const two = join(fx.HOME, "opinion-two.txt");
        writeFileSync(two, "TWO：第二轮打回", "utf-8");
        await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement --opinion ${two}`);

        const t = await listThreads(uri);
        expect(t.threads.map((x) => x["id"])).toEqual(["review->implement#2", "review->implement#3"]);
        // 各带各的正文 —— 正是 ##320 P1-1 的教训（逐驻留键必须带 `seq`）
        expect(postsText(t.threads[0]!)).toContain("ONE");
        expect(postsText(t.threads[1]!)).toContain("TWO");
        expect(postsText(t.threads[0]!)).not.toContain("TWO");
        // 源驻留序号也各是各的：第一次是 review#1、第二次是 review#2
        expect([t.threads[0]!["fromSeq"], t.threads[1]!["fromSeq"]]).toEqual([1, 2]);

        // 单条过滤 = 「对该锚点开过滤窗口」（一个节点都不多）
        const only = await listThreads(uri, `--thread 'review->implement#2'`);
        expect(only.threads.map((x) => x["id"])).toEqual(["review->implement#2"]);

        // 往**老**线程发言：挂回同一条锚点（不新建线程、不动领域态）
        const post = await fx.sh.run(threadPostCmd(uri, "review->implement#2", "开发：已按 ONE 改完，回评审"));
        expect(post.code, post.stderr).toBe(0);
        const after = await listThreads(uri);
        expect(after.threads.map((x) => x["id"])).toEqual(["review->implement#2", "review->implement#3"]);
        expect(postsText(after.threads[0]!)).toContain("已按 ONE 改完");
        expect(after.threads[1]!["posts"]).toHaveLength(1);
        // 位置没动（讨论是旁注：发言不产生位置变更）
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(shown["position"]).toBe("implement");
    });

    it("不造数据：假锚点（折线上没这条打回 / 那次驻留不是打回）一律拒", async () => {
        const uri = await freshTask("thread-fake");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement", "review");
        const file = join(fx.HOME, "fake.txt");
        writeFileSync(file, "凭空造一条线程", "utf-8");
        const cmd = (thread: string) => `./diy.sh flow thread post ${uri} --thread '${thread}' --text ${file}`;

        // ① 折线上压根没有 implement#2（还没打回过）⇒ 拒
        const missing = await fx.sh.run(cmd("review->implement#2"));
        expect(missing.code).not.toBe(0);
        expect(`${missing.stdout}${missing.stderr}`).toMatch(/折线上没有|还没有打回/);
        // ② 那次驻留是**推进**进来的（review#1 是 next）⇒ 拒：线程只挂在打回上
        const notBounce = await fx.sh.run(cmd("implement->review#1"));
        expect(notBounce.code).not.toBe(0);
        expect(`${notBounce.stdout}${notBounce.stderr}`).toMatch(/是\*\*推进\*\*进来的|不是打回/);
        // ③ 源节点对不上（implement#1 是被 design 推进进来的）⇒ 拒
        const wrongFrom = await fx.sh.run(cmd("review->implement#1"));
        expect(wrongFrom.code).not.toBe(0);
        // 一次都没写进去
        expect(existsSync(flowFile(uri, "threads.jsonl"))).toBe(false);

        // 真打回之后同一条命令就通了（判据是折线，不是文件名）
        await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement`);
        const ok = await fx.sh.run(cmd("review->implement#2"));
        expect(ok.code, ok.stderr).toBe(0);
        // 空正文另拒（不写空发言）
        const empty = join(fx.HOME, "empty.txt");
        writeFileSync(empty, "   \n", "utf-8");
        const blank = await fx.sh.run(`./diy.sh flow thread post ${uri} --thread 'review->implement#2' --text ${empty}`);
        expect(blank.code).not.toBe(0);
        expect(`${blank.stdout}${blank.stderr}`).toMatch(/正文为空/);
    });

    it("三出口的讨论侧：resolved / escalate 都是状态发言（最后一条说了算）—— 位置不动", async () => {
        const uri = await freshTask("thread-exit");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement", "review");
        const op = join(fx.HOME, "exit-opinion.txt");
        writeFileSync(op, "打回：边界条件没覆盖", "utf-8");
        await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement --opinion ${op} --author '评审 agent'`);
        const key = "review->implement#2";

        // (b) 开发被说服 ⇒ 线程 resolved（位置不动）
        const pre = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect((await listThreads(uri)).threads[0]!["status"]).toBe("open");
        const resolved = await fx.sh.run(threadPostCmd(uri, key, "已解决：开发补齐了边界条件", "resolved", "开发 agent"));
        expect(resolved.code, resolved.stderr).toBe(0);
        expect((await listThreads(uri)).threads[0]!["status"]).toBe("resolved");
        const afterResolved = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(afterResolved["position"]).toBe(pre["position"]);
        expect(afterResolved["trajectory"]).toEqual(pre["trajectory"]); // 发言不产生驻留

        // (c) 争不出结果 ⇒ 升级人裁决（一条 `actor: human` 的发言）
        const escalated = await fx.sh.run(threadPostCmd(uri, key, "争不出结果：交人裁决", "escalate", "human"));
        expect(escalated.code, escalated.stderr).toBe(0);
        const t = await listThreads(uri);
        expect(t.threads[0]!["status"]).toBe("escalated");
        const posts = t.threads[0]!["posts"] as Array<Record<string, unknown>>;
        expect(posts.map((p) => p["type"])).toEqual(["note", "resolved", "escalate"]);
        expect(posts.map((p) => p["author"])).toEqual(["评审 agent", "开发 agent", "human"]);
    });

    it("删掉讨论流 ⇒ 折线 / 推进 / 对账照常；坏行只亮错误位（旁注可丢，rule.core-log）", async () => {
        const uri = await freshTask("thread-drop");
        await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
        await advanceTo(uri, "clarify", "design", "implement", "review");
        const op = join(fx.HOME, "drop-opinion.txt");
        writeFileSync(op, "ONLY：这条意见删流后就没了", "utf-8");
        await fx.sh.run(`./diy.sh flow bounce ${uri} --to implement --opinion ${op}`);

        // ① 删掉整个讨论流：领域态照常、对账照常、还能继续推进；线程结构仍在（从折线推，不靠文件）
        rmSync(flowFile(uri, "threads.jsonl"));
        const shown = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(shown["position"]).toBe("implement");
        expect(shown["threadError"]).toBeNull();
        expect((shown["trajectory"] as unknown[]).length).toBe(5);
        const listed = await listThreads(uri);
        expect(listed.threads.map((x) => x["id"])).toEqual(["review->implement#2"]);
        expect(listed.threads[0]!["real"]).toBe(true);
        expect(listed.threads[0]!["posts"]).toHaveLength(0); // 意见没了 = 只丢了留痕，没丢事实
        expect(listed.skipped).toBe(0);
        expect(listed.error).toBeNull();
        const adv = await fx.sh.run(`./diy.sh flow advance ${uri} --to review`);
        expect(adv.code, adv.stderr).toBe(0);

        // ② 坏行（半截 JSON + 形状不符）：只报数、只亮错误位，**不炸领域读**
        const good = JSON.stringify({ id: "x", at: "2026-01-01T00:00:00.000Z", author: "cli", type: "note", anchor: { from: "review", to: "implement", seq: 2 }, text: "好行" });
        writeFileSync(flowFile(uri, "threads.jsonl"), `${good}\n{"id": "半截\n{"id":"y","at":"z","author":"cli","type":"nope","anchor":{"from":"review","to":"implement","seq":2},"text":"类型不认识"}\n`, "utf-8");
        const bad = (await fx.sh.getJson(`./diy.sh flow show ${uri}`)).data as Record<string, unknown>;
        expect(bad["threadError"]).toBeTruthy();
        expect(String(bad["threadError"])).toContain("2 行读不出");
        const listedBad = await listThreads(uri);
        expect(listedBad.skipped).toBe(2);
        expect(postsText(listedBad.threads[0]!)).toContain("好行");
        // 旁注坏了不许拖垮推进（对账 / 位置变更都照常）
        const adv2 = await fx.sh.run(`./diy.sh flow advance ${uri} --to ci`);
        expect(adv2.code, adv2.stderr).toBe(0);
    });
});
