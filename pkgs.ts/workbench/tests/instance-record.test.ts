import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordPath, registryDir, removeSelfRecord, writeSelfRecord } from "../src/instance-record.js";

const dirs: string[] = [];
function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "wb-inst-"));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("writeSelfRecord", () => {
    it("写出 `<pid>.json`，字段与 diy-app 的注册表同一份形状", () => {
        const dir = scratch();
        const file = writeSelfRecord({
            app: "diy-chat",
            diyHome: "/h",
            variant: "lab",
            env: "development",
            dir,
            now: () => "2026-11-02T12:00:00.000+0800",
            parents: () => [{ pid: 1, command: "bash ./sha.sh lab" }],
        });
        expect(file).toBe(recordPath(dir, process.pid));
        const record = JSON.parse(readFileSync(file, "utf-8"));
        expect(record).toMatchObject({
            pid: process.pid,
            app: "diy-chat",
            port: null,
            pingPort: null,
            diyHome: "/h",
            variant: "lab",
            env: "development",
            parents: [{ pid: 1, command: "bash ./sha.sh lab" }],
        });
        expect(typeof record.startedAt).toBe("string");
        expect(record.argv[0]).toBe(process.argv[0]);
    });

    it("removeSelfRecord 删除自己的条目；重复删不抛", () => {
        const dir = scratch();
        writeSelfRecord({ app: "diy-dev", diyHome: "/h", variant: "lab", env: "development", dir, parents: () => [] });
        expect(readdirSync(dir)).toHaveLength(1);
        removeSelfRecord(dir);
        expect(readdirSync(dir)).toHaveLength(0);
        expect(() => removeSelfRecord(dir)).not.toThrow();
    });
});

describe("registryDir", () => {
    it("DIY_INSTANCE_REGISTRY 覆盖；空串 = 缺省", () => {
        expect(registryDir({ DIY_INSTANCE_REGISTRY: "/tmp/reg" })).toBe("/tmp/reg");
        expect(registryDir({ DIY_INSTANCE_REGISTRY: "  " })).toMatch(/\.diy-instances$/);
    });
});
