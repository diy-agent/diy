/**
 * fast.cli-surface.test.ts — CLI 用法范例 + 「api 树 ↔ 已注册方法」一致性自检
 *
 * 为什么要有这条：CLI 是纯客户端，它算出来的 rpcName 必须与 app 进程里
 * `service.bind()` 注册的全名**逐字相同**，否则运行时才炸 `Unknown method`（##463/#467
 * 的两次回归都是这个）。而 tsc / 单测都看不见这层配对。
 *
 * 这里用**真实的 apiDef + 真实 handler 装配 + 进程内传输**跑 CLI，
 * 既当用法范例（下面每个 it 都是一种正常用法），又能提前抓出「api 树里有、服务端没绑」
 * 或「前缀算错」的问题。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelClientBinding, ChannelServerBinding, createMemTransportPair } from "@diy-agent/rpc";
import { CliApp } from "@diy-agent/rpc/cli";
import { bindAppHandlers } from "../src/main/services/api-impl";
import { apiDef } from "../src/main/services/api-def";
import { globalOptions } from "../src/cli/global-options";

// ── 环境：每次一个临时 DIY_HOME（task list 等会读 state） ──
let home: string;
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cli-surface-"));
    process.env["DIY_HOME"] = home;
});
afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

/** CliApp 的 `exit` 契约是「不返回」：用哨兵异常接管，测试里就能拿到退出码。 */
class CliExit extends Error {
    constructor(public readonly code: number) {
        super(`cli exit ${code}`);
    }
}

type RunResult = { code: number; out: string[]; err: string[]; text: string };

/** 跑一条 `diy ...`：与 apps/diy-app/src/cli/index.ts 的入口配置完全一致（含 rpcPrefix）。 */
async function run(argv: string[], client: ChannelClientBinding): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    try {
        await new CliApp({
            name: "diy",
            version: "0.0.0-test",
            router: apiDef.diy,
            rpcPrefix: "diy.",
            globalOptions,
            transport: client,
            cwd: process.cwd(),
            out: (line) => void out.push(line),
            err: (line) => void err.push(line),
            exit: (c: number): never => {
                code = c;
                throw new CliExit(c);
            },
        }).parse(argv);
    } catch (e) {
        if (!(e instanceof CliExit)) throw e;
    }
    return { code, out, err, text: out.join("\n") };
}

async function withCli(fn: (run: (argv: string[]) => Promise<RunResult>) => Promise<void>): Promise<void> {
    const { serverTx, clientTx } = createMemTransportPair();
    const server = new ChannelServerBinding(serverTx);
    bindAppHandlers(server);
    const client = new ChannelClientBinding(clientTx);
    try {
        await fn((argv) => run(argv, client));
    } finally {
        client.dispose();
    }
}

describe("CLI 用法范例", () => {
    it("`diy --help` 列出顶层命令（app / task / doctor …）", async () => {
        await withCli(async (run) => {
            const r = await run(["--help"]);
            expect(r.code).toBe(0);
            expect(r.text).toContain("app");
            expect(r.text).toContain("task");
            expect(r.text).toContain("doctor");
        });
    });

    it("`diy app info` 走真实 RPC，输出可解析的 JSON", async () => {
        await withCli(async (run) => {
            const r = await run(["app", "info"]);
            expect(r.code).toBe(0);
            const info = JSON.parse(r.text) as { pid: number; port: number; env: string };
            expect(info.pid).toBe(process.pid);
            expect(typeof info.port).toBe("number");
        });
    });

    it("`diy app info --json` 包一层 {ok, data}（脚本消费用）", async () => {
        await withCli(async (run) => {
            const r = await run(["app", "info", "--json"]);
            expect(r.code).toBe(0);
            const envelope = JSON.parse(r.text) as { ok: boolean; data: { pid: number } };
            expect(envelope.ok).toBe(true);
            expect(envelope.data.pid).toBe(process.pid);
        });
    });

    it("`diy task list` 是带命名空间的子命令组（task → list）", async () => {
        await withCli(async (run) => {
            const r = await run(["task", "list"]);
            expect(r.code).toBe(0);
            expect(r.text.length).toBeGreaterThan(0);
        });
    });

    it("`diy task show --help` 显示该命令自身用法，不执行", async () => {
        await withCli(async (run) => {
            const r = await run(["task", "show", "--help"]);
            expect(r.code).toBe(0);
            expect(r.text).toContain("Usage: diy task show");
        });
    });

    it("`diy --version` 打印版本", async () => {
        await withCli(async (run) => {
            const r = await run(["--version"]);
            expect(r.code).toBe(0);
            expect(r.text).toBe("0.0.0-test");
        });
    });

    it("未知子命令 → 退出码 2 + 拼写建议（用法错误与运行错误分开）", async () => {
        await withCli(async (run) => {
            const r = await run(["task", "lst"]);
            expect(r.code).toBe(2);
            expect(r.err.join("\n")).toContain("Unknown command");
        });
    });
});

/**
 * 核心自检：**api 树里的每条方法，服务端都真的注册了同名方法**。
 *
 * 覆盖的正是那两个回归的形态：
 *   - CLI 侧 rpcName 少一层前缀（`task.list` vs `diy.task.list`）→ 这里对不上
 *   - apiDef 登记了 meta 但忘了 `bindXxx`（`diy.app.info` 那次）→ 这里对不上
 */
describe("api 树 ↔ 服务端注册一致性", () => {
    /** 递归收集叶子 procedure 的相对路径（apiDef.diy 下，如 `task.list`）。 */
    function collectLeaves(router: unknown, prefix = ""): { path: string; name?: string }[] {
        const out: { path: string; name?: string }[] = [];
        if (!router || typeof router !== "object") return out;
        for (const [key, val] of Object.entries(router as Record<string, unknown>)) {
            if (!val || typeof val !== "object") continue;
            const p = val as { _type?: string; _streamMode?: string; children?: unknown; name?: string };
            if (p._type !== "procedure") continue;
            const path = prefix ? `${prefix}.${key}` : key;
            if (p._streamMode === "group") out.push(...collectLeaves(p.children, path));
            else out.push({ path, name: p.name });
        }
        return out;
    }

    /**
     * 这些前缀的方法**故意不在 main 进程注册**：`diy.ui.*` 由 main 的 rpc-port 全量转发给
     * renderer（在 main 里再挂会与转发冲突），CLI 调它们时同样经转发出去。
     * 新增这类转发域 = 这里加一行，别把它当成「漏绑」。
     */
    const FORWARDED_PREFIXES = ["ui."];

    it("每条 leaf 的 CLI 路由名都命中了已注册方法", async () => {
        const { serverTx } = createMemTransportPair();
        const server = new ChannelServerBinding(serverTx);
        bindAppHandlers(server);
        const registered = new Set(server.listRegistered());

        const leaves = collectLeaves(apiDef.diy);
        expect(leaves.length).toBeGreaterThan(50); // 树没被拆坏

        const missing = leaves
            // 转发域由 renderer 绑，不在本进程
            .filter((l) => !FORWARDED_PREFIXES.some((p) => l.path.startsWith(p)))
            // CLI 侧算法：rpcPrefix + 相对路径（def.name 已无人回写）
            .filter((l) => !registered.has(`diy.${l.path}`))
            .map((l) => l.path);
        expect(missing).toEqual([]);
    });

    it("没有 procedure 依赖 def.name 兜底（bindNames 退役后它应为空）", async () => {
        const leaves = collectLeaves(apiDef.diy);
        const named = leaves.filter((l) => l.name !== undefined).map((l) => `${l.path} (name=${l.name})`);
        expect(named).toEqual([]);
    });
});
