// tests/cli.intent.agent-local.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 agent.local —— 本地自定义 agent（ai-sdk 块协议）意图验证
//
// 块协议 G 的需求定义：
//   1. Op 流即 JSONL：start/delta/patch/stop 四类行，wire = 存储 = 渲染输入
//   2. history 重放返回完整 Op 日志；clear 清日志；cancel 无在途返回 false
//   3. 真实对话（zen/go + OPENCODE_ZEN_API_KEY）：turn/user/text 块 + usage
//   4. 工具链路：tool 块带 args/output/status（toolCallId = 块 id）
//
// 无网络部分恒跑；**真实 LLM 用例默认不跑**（需 DIY_LLM_E2E=1 + key）：
//   · 依赖外部模型 → 放默认套件里必然非确定（实测：模型偶尔不回 text delta，断言假红）
//   · 一次全量会打真实请求、耗时 2~3 分钟
// 联调：DIY_LLM_E2E=1 npx vitest run tests/cli.intent.agent-local.test.ts
//
// 真发用例**指定 `mimo-v2.6-flash`**（全表最便宜的带工具能力模型，见仓库根 AGENTS.md
// 「本地 agent 测试用什么模型」）：这些用例只验协议链路，与模型强弱无关，
// 用默认的 gpt-5.6-luna（output 0.28 → 1.20 $/1M，贵 4 倍）纯属浪费。
// exceptions：responses 面那条**必须**用 gpt-5.6-luna —— 它测的就是"responses-only
// 模型不能打到 chat 面"，换模型就测不到那个 api 面。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

// 真实 LLM 用例：默认关闭（见文件头）。缺 key 时即使开了开关也跳过。
const RUN_LLM = process.env.DIY_LLM_E2E === "1" && !!process.env.OPENCODE_ZEN_API_KEY;

interface ElectronFixture {
    sh: ShellTest;
    HOME: string;
    electron: ElectronTest;
}

let fx: ElectronFixture;

beforeAll(async () => {
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({
            cwd: join(__dirname, "..", "..", ".."),
            env: { HOME, DIY_HOME: HOME },
        }),
    };
});

afterAll(async () => {
    await fx?.electron?.stop();
});

async function setup(taskTitle: string): Promise<string> {
    const repo = `${fx.HOME}/local-${Date.now()}`;
    const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label 本地实验`);
    const pid = String(
        ((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "",
    );
    await fx.sh.run(`./diy.sh task create ${taskTitle} ${pid}`);
    return `projects/${pid}/tasks/1`;
}

/** keyOf 文件名带 sha 后缀（防 a/b 与 a:b 碰撞）；find（允许缺）/path（必存在）/has 分离 */
function findOpsFile(taskUri: string): string | undefined {
    const dir = join(fx.HOME, "local");
    const prefix = taskUri.replace(/[^\w.-]+/g, "_");
    return existsSync(dir)
        ? readdirSync(dir).find((f) => f.startsWith(`${prefix}-`) && f.endsWith(".ops.jsonl"))
        : undefined;
}
function opsPath(taskUri: string): string {
    const hit = findOpsFile(taskUri);
    if (!hit) throw new Error(`未找到 ops 日志：${taskUri}`);
    return join(fx.HOME, "local", hit!);
}
function hasOpsFile(taskUri: string): boolean {
    return findOpsFile(taskUri) !== undefined;
}

// ─── 插话（steer）：对话中插嘴 ───────────────────────
//
// 需求：生成中也能追加发言，两种时机（插入到下一步 / 插入到下一次对话后），
// 且**必须持久化**（进程重启、切 Electron/serve 模式后队列仍在）——
// 插话是"已提交但模型还没看见的用户输入"，丢了就是用户白打。
// 存储与聊天草稿同文件（任务目录 .diy/drafts.yaml 的 steers），生命周期随任务删除。

/** 取 CLI JSON 的 data 字段（getJson 返回 Record<string, unknown>，这里按用例收窄） */
async function cliData<T>(cmd: string): Promise<T> {
  const r = await fx.sh.getJson(cmd);
  return r.data as T;
}

interface SteerRow {
  id: string;
  mode: string;
  text: string;
}

describe("agent.local — 插话 steer（无网络）", () => {
  it("add 入队 → list 可见 → cancel 取消", async () => {
    const uri = await setup("插话任务");
    const add = await cliData<SteerRow[]>(`./diy.sh agent local steer add ${uri} "插到下一步" --mode step`);
    expect(add).toHaveLength(1);
    expect(add[0]).toMatchObject({ mode: "step", text: "插到下一步" });

    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list.map((i) => i.text)).toEqual(["插到下一步"]);

    const after = await cliData<SteerRow[]>(`./diy.sh agent local steer cancel ${uri} ${list[0]!.id}`);
    expect(after).toEqual([]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("id 形如 steer/N（实体/序号）：CLI 里能直接手敲，不必复制粘贴随机串", async () => {
    const uri = await setup("id 格式");
    const a = await cliData<SteerRow[]>(`./diy.sh agent local steer add ${uri} "第一条"`);
    const b = await cliData<SteerRow[]>(`./diy.sh agent local steer add ${uri} "第二条" --mode turn`);
    expect(a[0]!.id).toBe("steer/1");
    expect(b[1]!.id).toBe("steer/2");
    // 用这个 id 取消（id 会进 shell，含 "/" 也没问题：它只做字符串匹配，不当路径解析）
    const after = await cliData<SteerRow[]>(`./diy.sh agent local steer cancel ${uri} steer/1`);
    expect(after.map((i) => i.id)).toEqual(["steer/2"]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("不传 --mode 缺省 step（最常用的那个）；不静默接受非法值", async () => {
    const uri = await setup("缺省模式");
    const r = await cliData<SteerRow[]>(`./diy.sh agent local steer add ${uri} "没说时机"`);
    expect(r[0]).toMatchObject({ mode: "step" });
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("两种模式各自记住（step / turn 并存，FIFO 顺序即提交顺序）", async () => {
    const uri = await setup("两种插话");
    await fx.sh.getJson(`./diy.sh agent local steer add ${uri} "第一步插话" --mode step`);
    await fx.sh.getJson(`./diy.sh agent local steer add ${uri} "下一轮插话" --mode turn`);
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list.map((i) => [i.mode, i.text])).toEqual([
      ["step", "第一步插话"],
      ["turn", "下一轮插话"],
    ]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("取消不存在的 id 幂等（重复点 ✕ 不该报错）", async () => {
    const uri = await setup("幂等取消");
    const r = await cliData<SteerRow[]>(`./diy.sh agent local steer cancel ${uri} nope`);
    expect(r).toEqual([]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("空内容被拒（不落空插话：投进去只会污染提示词）", async () => {
    const uri = await setup("空插话");
    const r = await fx.sh.run(`./diy.sh agent local steer add ${uri} "   " --mode step`);
    expect(r.code).not.toBe(0);
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list).toEqual([]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("非法 mode 被契约拒绝（不许静默当成 step）", async () => {
    const uri = await setup("非法模式");
    const r = await fx.sh.run(`./diy.sh agent local steer add ${uri} "内容" --mode next`);
    expect(r.code).not.toBe(0);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("落盘在任务目录 .diy/drafts.yaml（与聊天草稿同文件，可被 CLI 直接观察）", async () => {
    const uri = await setup("落盘检查");
    await fx.sh.getJson(`./diy.sh agent local steer add ${uri} "持久化的话" --mode turn`);
    const fp = join(fx.HOME, uri, ".diy", "drafts.yaml");
    expect(existsSync(fp)).toBe(true);
    const raw = readFileSync(fp, "utf-8");
    expect(raw).toContain("steers");
    expect(raw).toContain("持久化的话");
    // 取消后队列空、字段也空 → 文件删除（不留空壳）
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    await fx.sh.getJson(`./diy.sh agent local steer cancel ${uri} ${list[0]!.id}`);
    expect(existsSync(fp)).toBe(false);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("与聊天草稿同文件互不干扰（清草稿不动插话）", async () => {
    const uri = await setup("共存检查");
    await fx.sh.getJson(`./diy.sh agent local steer add ${uri} "排队的插话" --mode step`);
    await fx.sh.getJson(`./diy.sh task drafts set ${uri} --agent_input "打到一半的草稿"`);
    // 清空草稿字段：插话队列必须还在（"清空输入框" ≠ "放弃排队中的插话"）
    await fx.sh.getJson(`./diy.sh task drafts clear ${uri}`);
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list.map((i) => i.text)).toEqual(["排队的插话"]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });
});

describe("agent.local — 控制面（无网络）", () => {
    it("models 列出 zen/go 子集", async () => {
        const r = await fx.sh.getJson(`./diy.sh agent local models`);
        const list = r.data as Array<{ id: string }>;
        expect(list.some((m) => m.id === "mimo-v2.6-flash")).toBe(true);
    });

    it("history 空会话 = 空数组；cancel 无在途 = false", async () => {
        const uri = await setup("控制面任务");
        const h = await fx.sh.getJson(`./diy.sh agent local history ${uri}`);
        expect(h.data).toEqual([]);
        const c = await fx.sh.getJson(`./diy.sh agent local cancel ${uri}`);
        expect(c.data).toEqual({ cancelled: false });
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    it("clear 幂等删除（不存在也可清）", async () => {
        const uri = await setup("清理任务");
        const c = await fx.sh.getJson(`./diy.sh agent local clear ${uri}`);
        expect(c.data).toEqual({ cleared: true });
        expect(hasOpsFile(uri)).toBe(false);
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });
});

describe("agent.local — 真实对话（zen/go 缺省模型 gpt-5.6-luna）", () => {
    it.skipIf(!RUN_LLM)(
        "纯文本轮：Op 流四动词齐全 + usage + 落盘重放一致",
        async () => {
            const uri = await setup("纯文本任务");
            const r = await fx.sh.run(
                `./diy.sh agent local chat ${uri} "只用两个字回答：你好" --model mimo-v2.6-flash`,
                180_000,
            );
            if (r.code !== 0) throw new Error(`cli exit=${r.code}\n${r.stderr}`);
            const lines = r.stdout.split("\n").filter((l) => l.trim().startsWith('{"op"'));
            expect(lines.length).toBeGreaterThan(3);
            const ops = lines.map((l) => JSON.parse(l));
            // 结构断言：turn 起、user 块在、text 块有内容、turn 收、usage 回填
            expect(ops[0]).toMatchObject({ op: "start", kind: "turn" });
            expect(
                ops.some((o) => o.op === "start" && o.kind === "text" && o.meta?.role === "user"),
            ).toBe(true);
            expect(
                ops.some(
                    (o) =>
                        o.op === "delta" &&
                        typeof o.fields?.content === "string" &&
                        o.fields.content,
                ),
            ).toBe(true);
            expect(ops.at(-1)).toMatchObject({ op: "stop" });
            expect(ops.some((o) => o.op === "patch" && o.fields?.usage)).toBe(true);
            // 存储 = 传输：jsonl 与流一致
            const fileOps = readFileSync(opsPath(uri), "utf-8")
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l));
            expect(fileOps.length).toBe(ops.length);
            const h = await fx.sh.getJson(`./diy.sh agent local history ${uri}`);
            expect((h.data as unknown[]).length).toBe(ops.length);
            // LLM 侧日志含 user 与 assistant
            const llm = readFileSync(opsPath(uri).replace(".ops.", ".llm."), "utf-8")
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l));
            expect(llm.some((m) => m.role === "assistant" || m.role === "tool")).toBe(true);
            await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
        },
        200_000,
    );

    it.skipIf(!RUN_LLM)(
        "responses 面模型（gpt-5.6-luna）可用：不再 503，Op 流与 usage 正常",
        async () => {
            // 需求（projects/4/tasks/145）：responses-only 模型打到 /chat/completions 一律 503
            // 「Endpoint is unavailable」；按 api 面分派后必须能正常出文本。
            const uri = await setup("responses 面任务");
            const r = await fx.sh.run(
                `./diy.sh agent local chat ${uri} "只用两个字回答：你好" --model gpt-5.6-luna`,
                180_000,
            );
            if (r.code !== 0) throw new Error(`cli exit=${r.code}\n${r.stderr}`);
            const ops = r.stdout
                .split("\n")
                .filter((l) => l.trim().startsWith('{"op"'))
                .map((l) => JSON.parse(l));
            // 失败形态是 turn 里挂一个 error 块（source=llm）—— 它就是本 bug 的指纹
            expect(ops.some((o) => o.op === "start" && o.kind === "error")).toBe(false);
            expect(
                ops.some(
                    (o) => o.op === "delta" && typeof o.fields?.content === "string" && o.fields.content,
                ),
            ).toBe(true);
            expect(ops.some((o) => o.op === "patch" && o.fields?.usage)).toBe(true);
            await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
        },
        200_000,
    );

    it.skipIf(!RUN_LLM)(
        "工具轮：tool 块 args/output/status 完整（toolCallId=块 id）",
        async () => {
            const uri = await setup("工具任务");
            const r = await fx.sh.run(
                `./diy.sh agent local chat ${uri} "用 bash 执行 echo hello-local，然后用一句话告诉我输出" --model mimo-v2.6-flash`,
                240_000,
            );
            if (r.code !== 0) throw new Error(`cli exit=${r.code}\n${r.stderr}`);
            const ops = r.stdout
                .split("\n")
                .filter((l) => l.trim().startsWith('{"op"'))
                .map((l) => JSON.parse(l));
            const toolStart = ops.find((o) => o.op === "start" && o.kind === "tool");
            expect(toolStart, "应有 tool 块").toBeTruthy();
            const id = toolStart.id;
            expect(
                ops.some(
                    (o) =>
                        o.op === "patch" &&
                        o.id === id &&
                        o.fields?.status === "running" &&
                        o.fields?.args?.command?.includes?.("echo hello-local"),
                ),
            ).toBe(true);
            expect(
                ops.some(
                    (o) =>
                        o.op === "delta" &&
                        o.id === id &&
                        String(o.fields?.output).includes("hello-local"),
                ),
            ).toBe(true);
            expect(
                ops.some((o) => o.op === "patch" && o.id === id && o.fields?.status === "done"),
            ).toBe(true);
            // llm 日志含工具链路（assistant tool-call + tool result）
            const llm = readFileSync(opsPath(uri).replace(".ops.", ".llm."), "utf-8")
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l));
            const flat = JSON.stringify(llm);
            expect(flat.includes("tool-call") || flat.includes("tool-result")).toBe(true);
            await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
        },
        260_000,
    );
});
