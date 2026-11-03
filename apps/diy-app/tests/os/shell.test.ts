// tests/os/shell.test.ts
// 🎯 shell 命令拼装（R8）：pwsh 必须透传退出码；多行走 -EncodedCommand。

import { describe, expect, it } from "vitest";
import { buildInvocation } from "../../src/main/os/shell";
import type { ShellSpec } from "../../src/main/os";

const bash: ShellSpec = { kind: "bash", file: "/bin/bash", label: "bash", missing: false, tried: [] };
const pwsh: ShellSpec = { kind: "pwsh", file: "pwsh.exe", label: "pwsh", missing: false, tried: [] };

describe("buildInvocation", () => {
    it("bash：-c 原样传命令", () => {
        expect(buildInvocation(bash, "echo hi")).toEqual({ file: "/bin/bash", args: ["-c", "echo hi"] });
    });

    it("bash + 日志：exec 重定向（Git Bash 丢 Node 句柄的绕法）", () => {
        const inv = buildInvocation(bash, "echo hi", "C:\\tmp\\out.log");
        expect(inv.args[1]).toContain("exec >> 'C:/tmp/out.log' 2>&1;");
    });

    it("pwsh：UTF-8 前置 + `exit $LASTEXITCODE` 透传退出码", () => {
        const inv = buildInvocation(pwsh, "Get-ChildItem");
        expect(inv.file).toBe("pwsh.exe");
        expect(inv.args).toContain("-NoProfile");
        expect(inv.args).toContain("-NonInteractive");
        const script = inv.args[inv.args.length - 1]!;
        expect(script).toContain("OutputEncoding");
        expect(script).toContain("& { Get-ChildItem }");
        expect(script).toContain("exit $LASTEXITCODE");
    });

    it("pwsh 多行：改 -EncodedCommand（UTF-16LE base64）", () => {
        const inv = buildInvocation(pwsh, "echo a\necho b");
        const at = inv.args.indexOf("-EncodedCommand");
        expect(at).toBeGreaterThan(-1);
        const decoded = Buffer.from(inv.args[at + 1]!, "base64").toString("utf16le");
        expect(decoded).toContain("echo a\necho b");
        expect(decoded).toContain("exit $LASTEXITCODE");
    });

    it("pwsh + 日志：合并所有流并写 UTF-8（PS 5.1 的 *>> 默认 UTF-16）", () => {
        const inv = buildInvocation(pwsh, "Get-ChildItem", "C:\\tmp\\out.log");
        const script = inv.args[inv.args.length - 1]!;
        expect(script).toContain("Out-File");
        expect(script).toContain("-Encoding utf8");
        expect(script).toContain("'C:\\tmp\\out.log'");
    });
});
