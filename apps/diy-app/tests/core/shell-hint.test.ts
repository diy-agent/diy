// tests/core/shell-hint.test.ts
// 「两种 shell 都没有」时的事实句（不是「去装 Git Bash」的劝告）。

import { describe, expect, it } from "vitest";
import { noShellHint } from "../../src/main/os/shell-hint";

describe("noShellHint", () => {
    it("说明 bash / PowerShell 都探测不到，并列出找过的位置", () => {
        const text = noShellHint([
            { kind: "bash", file: "bash.exe", label: "bash", missing: true, tried: ["C:\\Git\\bin\\bash.exe"] },
        ]);
        expect(text).toContain("bash 与 PowerShell");
        expect(text).toContain("C:\\Git\\bin\\bash.exe");
    });
});
