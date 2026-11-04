/**
 * dev-paths.test.ts — 目录真源与一次性搬迁
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devRoot, ensureRegistryDir, legacyRegistryDir, migrateLegacyRegistry, registryDir } from "../src/index.js";

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dev-paths-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("registryDir", () => {
    it("缺省 = <devRoot>/apps；DIY_INSTANCE_REGISTRY 优先；DIY_DEV_HOME 改根", () => {
        expect(registryDir({})).toMatch(/\/\.diy\/dev\/apps$/);
        expect(registryDir({ DIY_INSTANCE_REGISTRY: "/tmp/reg" })).toBe("/tmp/reg");
        expect(registryDir({ DIY_DEV_HOME: "/tmp/devhome" })).toBe("/tmp/devhome/apps");
        expect(devRoot({ DIY_DEV_HOME: "  " })).toMatch(/\/\.diy\/dev$/);
    });

    it("ensureRegistryDir 建目录（幂等）", () => {
        const env = { DIY_DEV_HOME: dir };
        expect(ensureRegistryDir(env)).toBe(join(dir, "apps"));
        expect(() => ensureRegistryDir(env)).not.toThrow();
    });
});

describe("migrateLegacyRegistry", () => {
    it("本机没有旧目录时是空操作（幂等）", () => {
        const result = migrateLegacyRegistry({ DIY_DEV_HOME: dir });
        expect(result.moved).toBe(0);
        expect(result.from).toBe(legacyRegistryDir());
        expect(result.to).toBe(join(dir, "apps"));
        expect(migrateLegacyRegistry({ DIY_DEV_HOME: dir }).moved).toBe(0);
    });
});
