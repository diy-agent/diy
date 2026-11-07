/**
 * project.intent.test.ts — 【意图 · 契约/规则】"项目"这件事对用户意味着什么。
 *
 * 用户要的：加一个项目 ⇒ 系统给它一个号、建好它的数据目录、在仓库里留张名片（diy.yaml）；
 * 删一个项目 ⇒ 它的数据连同任务一起没了；删不存在的 ⇒ 不报错（幂等）；列表里能看到自己加过的。
 *
 * 执行方式：真 app + 长连 rpc（这些能力本来就走 renderer 入口 `diy.ui.project.*`）。
 * 旧写法每条断言一个 `./diy.sh` 子进程，这份文件 5 条要 ~5s；现在一次 app 启动 + 若干 rpc。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appRpc, type Rpc } from "../harness/rpc";

let rpc: Rpc;
let home: string;
let dispose: () => Promise<void>;

beforeAll(async () => {
    const app = await appRpc();
    rpc = app.rpc;
    home = app.electron.home;
    dispose = app.dispose;
}, 90_000);

afterAll(async () => {
    await dispose?.();
});

/** 本用例自己的项目：隔离 home 下的唯一路径，自建自删 */
async function createFresh(name: string): Promise<string> {
    const repo = join(home, `it-${name}`);
    mkdirSync(repo, { recursive: true });
    const r = (await rpc.diy.ui.project.create({ path: repo, label: name } as never)) as { id?: string } | { data?: { id?: string } };
    const id = (r as { id?: string }).id ?? (r as { data?: { id?: string } }).data?.id;
    if (!id) throw new Error(`建项目失败: ${JSON.stringify(r).slice(0, 300)}`);
    return String(id);
}

describe("项目：加一个、用它、删掉", () => {
    it("加一个项目会拿到编号，并建好它的数据目录", async () => {
        const id = await createFresh("a");
        expect(id).toMatch(/^\d+$/);
        expect(existsSync(join(home, "projects", id, "tasks"))).toBe(true);
        expect(existsSync(join(home, "projects", id, "meta.yaml"))).toBe(true);
        await rpc.diy.ui.project.remove({ id } as never);
    });

    it("加项目时会在它指向的仓库里留一张名片（diy.yaml 带 project 段）", async () => {
        const id = await createFresh("b");
        const repo = join(home, "it-b");
        const card = readFileSync(join(repo, "diy.yaml"), "utf-8");
        expect(card).toMatch(/project:/);
        writeFileSync(join(repo, "diy.yaml"), card); // 保留内容，说明这是系统写的
        await rpc.diy.ui.project.remove({ id } as never);
    });

    it("删掉项目会连带它的数据目录", async () => {
        const id = await createFresh("c");
        expect(existsSync(join(home, "projects", id))).toBe(true);
        await rpc.diy.ui.project.remove({ id } as never);
        expect(existsSync(join(home, "projects", id))).toBe(false);
    });

    it("删一个不存在的项目：不报错（幂等）", async () => {
        await expect(rpc.diy.ui.project.remove({ id: "99999" } as never)).resolves.toBeTruthy();
    });

    it("任务列表里能看到项目归属（有任务之后）", async () => {
        const id = await createFresh("d");
        await rpc.diy.task.create({ project: id, title: "归属检查" } as never);
        const list = (await rpc.diy.task.list({} as never)) as {
            projects?: { id: string }[];
            data?: { projects?: { id: string }[] };
        };
        const projects = list.projects ?? list.data?.projects ?? [];
        expect(projects.map((p) => String(p.id))).toContain(id);
        await rpc.diy.ui.project.remove({ id } as never);
    });
});
