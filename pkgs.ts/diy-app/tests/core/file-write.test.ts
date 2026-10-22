// ##414：整文件写的唯一实现（core/file-write.ts）。
//
// 钉住的是**护栏与回执**，不是"能写文件"这件事本身：
//   · 路径护栏对 `../` 与 **symlink** 都拦得住（纯字符串前缀判断挡不住后者）
//   · 上限 / 目录 / 越界都**抛** FileWriteError（catch-and-return 会被画成 ✓，##353）
//   · BOM 保留、行尾原样（模型看不见 BOM / CR，不该被一次覆盖悄悄改掉）
//   · diff 摘要的计数是真值（`+N/-M` 直接进审计与模型回执）
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    FileWriteError,
    WRITE_MAX_BYTES,
    formatWriteResult,
    resolveWritePath,
    unifiedDiff,
    writeFileWhole,
} from "../../src/main/core/file-write";

let root = "";
let outside = "";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "write-root-"));
    outside = mkdtempSync(join(tmpdir(), "write-outside-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown): string => {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(FileWriteError);
        return (e as FileWriteError).code;
    }
    throw new Error("期望抛错，但没有抛");
};

describe("路径护栏", () => {
    it("`../` 越界 → fs/path-escape", () => {
        expect(codeOf(() => resolveWritePath(root, "../escape.txt"))).toBe("fs/path-escape");
    });

    it("symlink 指向 cwd 外 → fs/path-escape（字符串前缀判断档不住的形态）", () => {
        symlinkSync(outside, join(root, "link"));
        expect(codeOf(() => resolveWritePath(root, "link/x.txt"))).toBe("fs/path-escape");
    });

    it("cwd 内的普通相对路径照常解析", () => {
        // macOS 的 /var 是 /private/var 的 symlink —— 解析结果是 realpath，比较也用 realpath
        expect(resolveWritePath(root, "a/b.txt")).toBe(join(realpathSync(root), "a/b.txt"));
    });
});

describe("writeFileWhole", () => {
    it("新文件：自动建父目录，+N/-0，diff 是新文件头", () => {
        const r = writeFileWhole(root, "deep/dir/new.txt", "x\ny\nz\n");
        expect(r.isNew).toBe(true);
        expect(r.added).toBe(3);
        expect(r.removed).toBe(0);
        expect(readFileSync(join(root, "deep/dir/new.txt"), "utf-8")).toBe("x\ny\nz\n");
        expect(r.diff).toContain("+++ b/deep/dir/new.txt");
        expect(r.diff).toContain("@@ -0,0 +1,3 @@");
    });

    it("覆盖：diff 摘要形如 +3/-1，回执带 +N/-M", () => {
        writeFileSync(join(root, "f.txt"), "a\nb\n");
        const r = writeFileWhole(root, "f.txt", "a\nB\nc\nd\n");
        expect(r.isNew).toBe(false);
        expect(r.added).toBe(3);
        expect(r.removed).toBe(1);
        expect(formatWriteResult(r)).toContain("写入 f.txt（+3/-1 行");
        expect(r.diff).toContain("-b");
        expect(r.diff).toContain("+B");
    });

    it("内容超上限 → fs/content-too-large，文案含实际字节与上限", () => {
        const big = "a".repeat(WRITE_MAX_BYTES + 1);
        try {
            writeFileWhole(root, "big.txt", big);
            throw new Error("期望抛错");
        } catch (e) {
            expect(e).toBeInstanceOf(FileWriteError);
            expect((e as FileWriteError).code).toBe("fs/content-too-large");
            expect((e as Error).message).toContain(String(WRITE_MAX_BYTES + 1));
            expect((e as Error).message).toContain(String(WRITE_MAX_BYTES));
        }
    });

    it("目标是目录 → fs/is-directory", () => {
        mkdirSync(join(root, "dir"));
        expect(codeOf(() => writeFileWhole(root, "dir", "x"))).toBe("fs/is-directory");
        expect(codeOf(() => writeFileWhole(root, ".", "x"))).toBe("fs/is-directory");
    });

    it("原文件有 BOM、新内容没有 → 保留 BOM", () => {
        writeFileSync(join(root, "bom.txt"), "\uFEFFold\n");
        const r = writeFileWhole(root, "bom.txt", "new\n");
        expect(r.bomKept).toBe(true);
        expect(readFileSync(join(root, "bom.txt"), "utf-8")).toBe("\uFEFFnew\n");
    });

    it("行尾原样：CRLF 不被转成 LF，LF 也不被转成 CRLF", () => {
        const r = writeFileWhole(root, "crlf.txt", "a\r\nb\r\n");
        expect(r.isNew).toBe(true);
        expect(readFileSync(join(root, "crlf.txt"), "utf-8")).toBe("a\r\nb\r\n");
    });
});

describe("unifiedDiff", () => {
    it("新文件只列前 N 行 + 省略标记，added 仍是真值", () => {
        const content = Array.from({ length: 200 }, (_, i) => `line${i}`).join("\n") + "\n";
        const d = unifiedDiff(null, content, { path: "x.txt", maxNewFileLines: 20 });
        expect(d.added).toBe(200);
        expect(d.truncated).toBe(true);
        expect(d.text).toContain("+line0");
        expect(d.text).toContain("[省略 180 行（新文件共 200 行）]");
    });

    it("未变化 → 空 diff", () => {
        const d = unifiedDiff("a\nb\n", "a\nb\n");
        expect(d).toMatchObject({ added: 0, removed: 0, text: "", truncated: false });
    });

    it("大改动超 100 行 → 头尾截断 + 省略标记", () => {
        const before = Array.from({ length: 300 }, (_, i) => `old${i}`).join("\n");
        const after = Array.from({ length: 300 }, (_, i) => `new${i}`).join("\n");
        const d = unifiedDiff(before, after, { path: "big.txt" });
        expect(d.added).toBe(300);
        expect(d.removed).toBe(300);
        expect(d.truncated).toBe(true);
        expect(d.text).toMatch(/\.\.\. 省略 \d+ 行 \.\.\./);
    });
});
