// 远程可见性（##479）：本实例 /ping 起得来、答得对、改名不动 id、发现链对接到本机注册表。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteService } from "../../src/main/services/remote";
import { registryDir, removeRecord, writeRecord } from "../../src/main/core/instance-registry";

const dirs: string[] = [];
const services: RemoteService[] = [];
const selfRecords: string[] = [];

function tempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "diy-remote-svc-"));
    dirs.push(dir);
    return dir;
}

async function startService(home: string): Promise<RemoteService> {
    const svc = new RemoteService();
    services.push(svc);
    await svc.start({ home, app: "@diy-agent/app-chat", variant: "test", version: "0.1.0", broadcast: false });
    return svc;
}

afterEach(async () => {
    while (services.length > 0) await services.pop()!.stop();
    while (selfRecords.length > 0) removeRecord(selfRecords.pop()!, process.pid);
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("RemoteService", () => {
    it("start 生成并落盘 instance-id；self / ping 自洽", async () => {
        const home = tempHome();
        const svc = await startService(home);
        const self = svc.self();

        expect(self.id).toMatch(/^diy-[0-9a-f]{8}$/);
        expect(self.variant).toBe("test");
        // ##484：app 取短名（@diy-agent/app-chat → diy-chat），地址里那段就是它
        expect(self.app).toBe("diy-chat");
        expect(self.address).toMatch(/^[^@]+@[^/]+\/diy-chat\.test$/); // 单实例 ⇒ 不带端口
        expect(self.host).toBe("127.0.0.1"); // 无鉴权 ⇒ 缺省只绑回环
        expect(readFileSync(join(home, "instance-id"), "utf-8").trim()).toBe(self.id);

        const r = await svc.ping(self.endpoint);
        expect(r.ok).toBe(true);
        expect(r.info?.id).toBe(self.id);
        expect(r.info?.displayName).toBe(self.displayName);
        expect(r.info?.app).toBe("diy-chat"); // 判据 1：/ping 带 app
    });

    it("重启后 id 不变（hostname 改名也不影响）", async () => {
        const home = tempHome();
        const first = await startService(home);
        const id = first.self().id;
        await first.stop();

        const second = await startService(home);
        expect(second.self().id).toBe(id);
    });

    it("rename 只改显示名：id 不变，/ping 立刻答新名字", async () => {
        const home = tempHome();
        const svc = await startService(home);
        const before = svc.self();

        const renamed = svc.rename("c-mac 的 lab 实例");
        expect(renamed.id).toBe(before.id);
        expect(renamed.displayName).toBe("c-mac 的 lab 实例");
        // 显示名含空白 / 中文：地址拼不出来时退回 user@host，绝不抛（横条 / CLI 都要有东西可显示）
        expect(renamed.address).toContain("@");
        expect(renamed.address).not.toContain("/diy-chat");

        const r = await svc.ping(`http://127.0.0.1:${before.port}`);
        expect(r.info?.displayName).toBe("c-mac 的 lab 实例");
        expect(readFileSync(join(home, "instance-name"), "utf-8").trim()).toBe("c-mac 的 lab 实例");
        // 名字里带保留字符（`/`）时地址退回 `user@host` —— 绝不因为一个怪名字把服务弄崩
        expect(svc.rename("c/mac").address).not.toContain("/diy-chat");
    });

    it("discover 把本机实例列出来（local 路走注册表 pingPort），不自动连接", async () => {
        const home = tempHome();
        // 生产中这条记录由 main 启动时写（writeSelfRecord），单测里手动摆一条 ——
        // setSelfPingPort 是「读-改-写」，没有记录就什么都不做（不凭空造条目）
        writeRecord(registryDir(), {
            pid: process.pid,
            port: null,
            pingPort: null,
            diyHome: home,
            variant: "test",
            env: "test",
            argv: [],
            cwd: home,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            parents: [],
        });
        selfRecords.push(registryDir());
        const svc = await startService(home);
        const self = svc.self();

        const result = await svc.discover({ sources: ["local"], mdnsTimeoutMs: 50 });
        const mine = result.rows.find((r) => r.id === self.id);
        expect(mine).toBeDefined();
        expect(mine?.sources).toEqual(["local"]);
        expect(result.text).toContain("发现到的 diy 实例：");
        expect(result.text).toContain("(local)");
    });

    it("ping 不通返回 ok:false（不抛）", async () => {
        const svc = await startService(tempHome());
        const r = await svc.ping("http://127.0.0.1:1", 200);
        expect(r.ok).toBe(false);
        expect(r.error).not.toBeNull();
    });
});
