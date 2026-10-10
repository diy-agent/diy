// tests/core/model-import.test.ts
// 🎯 环境变量 → provider 导入候选的契约（核心：只列不写、不落明文、不覆盖已有）。
// 真实 snapshot（models.dev 产物）参与扫描 —— 不做假数据；env 用注入的假环境，不读 process.env。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelConfig } from "../../src/main/core/model-config";
import { importEnvProviders, scanEnvCandidates } from "../../src/main/core/model-import";

const ENV = { OPENCODE_API_KEY: "sk-test-opencode" };

describe("scanEnvCandidates", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "diy-model-import-"));
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it("命中 env 的 provider 出候选；同源的第二家标 duplicate（不重复配同一把钥匙）", () => {
        const c = scanEnvCandidates(home, ENV);
        const go = c.find((x) => x.provider === "opencode-go")!;
        const zen = c.find((x) => x.provider === "opencode")!;
        expect(go.status).toBe("importable");
        expect(go.envVar).toBe("OPENCODE_API_KEY");
        expect(zen.status).toBe("duplicate");
        expect(zen.note).toContain("同源");
    });

    it("provider 已配置 → configured（不覆盖用户账号）", () => {
        writeFileSync(
            join(home, "model.yaml"),
            "stdProviders:\n  opencode-go:\n    accounts:\n      - type: apiKey\n        data:\n          value: sk-mine\n",
        );
        const go = scanEnvCandidates(home, ENV).find((x) => x.provider === "opencode-go")!;
        expect(go.status).toBe("configured");
    });

    it("该密钥值已被别的账号用掉 → duplicate", () => {
        writeFileSync(
            join(home, "model.yaml"),
            "stdProviders:\n  opencode-go:\n    accounts:\n      - type: apiKey\n        name: work\n        data:\n          value: $OPENCODE_API_KEY\n",
        );
        // opencode-go 这次是 configured；用 custom 场景验证 duplicate：先去掉已配置的那家
        writeFileSync(
            join(home, "model.yaml"),
            "stdProviders: {}\ncustomProviders:\n  goat:\n    accounts:\n      - type: apiKey\n        data:\n          value: $OPENCODE_API_KEY\n",
        );
        const go = scanEnvCandidates(home, ENV).find((x) => x.provider === "opencode-go")!;
        expect(go.status).toBe("duplicate");
        expect(go.note).toContain("0@custom:goat");
    });

    it("env 没有该变量 → 不出候选（不凭空造 provider）", () => {
        expect(scanEnvCandidates(home, {})).toHaveLength(0);
    });
});

describe("importEnvProviders", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "diy-model-import-"));
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it("写入 $VAR 引用（不落明文），且只导 importable", () => {
        const r = importEnvProviders(home, undefined, ENV);
        expect(r.imported).toEqual(["opencode-go"]);
        expect(r.skipped.map((s) => s.provider)).toContain("opencode");
        const cfg = loadModelConfig(home);
        expect(cfg.stdProviders["opencode-go"]!.accounts[0]!.data.value).toBe("$OPENCODE_API_KEY");
        // 明文绝不出现在文件里
        expect(JSON.stringify(cfg)).not.toContain("sk-test-opencode");
    });

    it("幂等：再导一次跳过（configured）", () => {
        importEnvProviders(home, undefined, ENV);
        const again = importEnvProviders(home, undefined, ENV);
        expect(again.imported).toEqual([]);
        expect(again.skipped.find((s) => s.provider === "opencode-go")!.note).toContain("已配置");
    });

    it("显式指定 provider：被跳过的也回报原因", () => {
        const r = importEnvProviders(home, ["opencode"], ENV);
        expect(r.imported).toEqual([]);
        expect(r.skipped).toHaveLength(1);
    });
});
