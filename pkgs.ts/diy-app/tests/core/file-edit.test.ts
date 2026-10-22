// tests/core/file-edit.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 edit 工具内核（core/file-edit）意图验证（##415）
//
// 契约（任务 body）：
//   · 批量 edits[]、逐条**顺序**应用
//   · oldText 默认必须唯一；replaceAll 才允许多处
//   · 精确失败 → 字符归一重试，且结果里**如实说明**用了归一
//   · 同文件并发串行（不丢更新）
//   · 返回 unified patch；越界路径 fs/path-escape
//
// 无网络、无 LLM、无 Electron — 纯函数 + 临时目录
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyEdits,
  describeEditResult,
  EditError,
  editFile,
  generateUnifiedPatch,
  normalizeForFuzzyMatch,
  resolveEditablePath,
  withFileEditQueue,
} from "../../src/main/core/file-edit";
import { writeFileAtomic } from "../../src/main/core/atomic-write";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "diy-file-edit-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 断言抛的是带指定 code 的 EditError */
function expectCode(fn: () => unknown, code: string): EditError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EditError);
    expect((e as EditError).code).toBe(code);
    return e as EditError;
  }
  throw new Error(`应当抛出 ${code}，但没有抛`);
}

const SRC = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");

describe("applyEdits — 匹配语义", () => {
  it("唯一命中：精确替换", () => {
    const r = applyEdits(SRC, [{ oldText: "const b = 2;", newText: "const b = 22;" }]);
    expect(r.content).toContain("const b = 22;");
    expect(r.content).toContain("const a = 1;");
    expect(r.notes).toEqual([{ index: 0, usedNormalized: false, replaced: 1 }]);
  });

  it("找不到：fs/no-match", () => {
    const e = expectCode(() => applyEdits(SRC, [{ oldText: "const z = 9;", newText: "x" }]), "fs/no-match");
    expect(e.message).toContain("edits[0]");
  });

  it("多处命中且未开 replaceAll：fs/ambiguous-match，消息里给出现次数", () => {
    const src = "foo\nbar\nfoo\n";
    const e = expectCode(() => applyEdits(src, [{ oldText: "foo", newText: "baz" }]), "fs/ambiguous-match");
    expect(e.message).toContain("2 次");
  });

  it("replaceAll: true 才替换全部", () => {
    const src = "foo\nbar\nfoo\n";
    const r = applyEdits(src, [{ oldText: "foo", newText: "baz", replaceAll: true }]);
    expect(r.content).toBe("baz\nbar\nbaz\n");
    expect(r.notes[0].replaced).toBe(2);
  });

  it("逐条顺序应用：后一条基于前一条的结果匹配", () => {
    const r = applyEdits("alpha\nbeta\n", [
      { oldText: "alpha", newText: "gamma" },
      { oldText: "gamma\nbeta", newText: "gamma\ndelta" },
    ]);
    expect(r.content).toBe("gamma\ndelta\n");
    // 反证：第二条若对原文匹配则应失败
    expectCode(
      () =>
        applyEdits("alpha\nbeta\n", [
          { oldText: "alpha", newText: "gamma" },
          { oldText: "beta\nalpha", newText: "x" },
        ]),
      "fs/no-match",
    );
  });

  it("空 edits / 空 oldText：明确报错，不静默成功", () => {
    expectCode(() => applyEdits(SRC, []), "fs/empty-edits");
    expectCode(() => applyEdits(SRC, [{ oldText: "", newText: "x" }]), "fs/empty-old-text");
  });
});

describe("applyEdits — 归一匹配", () => {
  it("行尾空白 + 全角标点：归一命中并如实说明", () => {
    const src = "const msg = '你好，世界';   \nconst n = 1;\n";
    const r = applyEdits(src, [{ oldText: "const msg = '你好,世界';", newText: "const msg = 'hello';" }]);
    expect(r.content).toBe("const msg = 'hello';\nconst n = 1;\n");
    expect(r.notes[0].usedNormalized).toBe(true);
  });

  it("弯引号 / 特殊空格归一", () => {
    const src = "const s = \u201Chello\u201D;\n";
    const r = applyEdits(src, [{ oldText: 'const s = "hello";', newText: "const s = 1;" }]);
    expect(r.content).toBe("const s = 1;\n");
    expect(r.notes[0].usedNormalized).toBe(true);
  });

  it("归一命中时**只重写被命中的行**，其余行逐字保留（含行尾空白）", () => {
    const src = "keep me   \nconst a = （1）;\nkeep2\t\n";
    const r = applyEdits(src, [{ oldText: "const a = (1);", newText: "const a = 2;" }]);
    expect(r.content).toBe("keep me   \nconst a = 2;\nkeep2\t\n");
    expect(r.notes[0].usedNormalized).toBe(true);
  });

  it("归一后仍不唯一：fs/ambiguous-match", () => {
    const src = "a  \nb\na \nb\n";
    expectCode(() => applyEdits(src, [{ oldText: "a\nb", newText: "x" }]), "fs/ambiguous-match");
  });

  it("normalizeForFuzzyMatch 不改行数", () => {
    const src = "a　\n\n\u201Cb\u201D\u00A0\n";
    expect(normalizeForFuzzyMatch(src).split("\n").length).toBe(src.split("\n").length);
  });
});

describe("generateUnifiedPatch — patch 形状", () => {
  it("单点修改：---/+++/@@ 头 + -/+ 行", () => {
    const before = "a\nb\nc\nd\ne\n";
    const after = "a\nb\nC\nd\ne\n";
    const patch = generateUnifiedPatch("src/x.ts", before, after);
    const lines = patch.split("\n");
    expect(lines[0]).toBe("--- a/src/x.ts");
    expect(lines[1]).toBe("+++ b/src/x.ts");
    expect(lines[2]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(patch).toContain("-c");
    expect(patch).toContain("+C");
    expect(patch).toContain(" b");
  });

  it("无变化返回空串", () => {
    expect(generateUnifiedPatch("x", "same\n", "same\n")).toBe("");
  });

  it("远端修改分成两个 hunk", () => {
    const before = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n") + "\n";
    const afterLines = before.split("\n");
    afterLines[1] = "X1";
    afterLines[17] = "X17";
    const patch = generateUnifiedPatch("f", before, afterLines.join("\n"));
    expect(patch.match(/^@@ /gm)?.length).toBe(2);
  });
});

describe("resolveEditablePath — 路径护栏", () => {
  it("cwd 内路径放行", () => {
    expect(resolveEditablePath(dir, "a/b.txt")).toBe(join(dir, "a/b.txt"));
  });

  it("越界路径 fs/path-escape", () => {
    expectCode(() => resolveEditablePath(dir, "../outside.txt"), "fs/path-escape");
    expectCode(() => resolveEditablePath(dir, "/etc/passwd"), "fs/path-escape");
  });
});

describe("withFileEditQueue — 同文件并发串行", () => {
  it("两次并发 edit 都生效（不丢更新）", async () => {
    const p = join(dir, "queue.txt");
    writeFileSync(p, "a\nb\nc\n", "utf-8");

    const doEdit = (oldText: string, newText: string): Promise<void> =>
      withFileEditQueue(p, () => {
        const r = editFile(p, "queue.txt", [{ oldText, newText }], writeFileAtomic);
        expect(r.patch).not.toBe("");
      });

    await Promise.all([doEdit("a", "A"), doEdit("c", "C")]);
    expect(readFileSync(p, "utf-8")).toBe("A\nb\nC\n");
  });

  it("前一条失败不阻塞后一条", async () => {
    const p = join(dir, "queue2.txt");
    writeFileSync(p, "a\n", "utf-8");
    const bad = withFileEditQueue(p, () => {
      throw new EditError("fs/no-match", "boom");
    });
    const good = withFileEditQueue(p, () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
  });
});

describe("editFile — 行尾 / BOM 保真", () => {
  it("CRLF 文件：匹配在 LF 视图，写回仍 CRLF", () => {
    const p = join(dir, "crlf.txt");
    writeFileSync(p, "a\r\nb\r\nc\r\n", "utf-8");
    const r = editFile(p, "crlf.txt", [{ oldText: "b", newText: "B" }], writeFileAtomic);
    expect(r.ending).toBe("\r\n");
    expect(readFileSync(p, "utf-8")).toBe("a\r\nB\r\nc\r\n");
  });

  it("BOM 保留", () => {
    const p = join(dir, "bom.txt");
    writeFileSync(p, "\uFEFFx = 1;\n", "utf-8");
    editFile(p, "bom.txt", [{ oldText: "x = 1", newText: "x = 2" }], writeFileAtomic);
    expect(readFileSync(p, "utf-8")).toBe("\uFEFFx = 2;\n");
  });

  it("无改动时不写盘（mtime 不变）", () => {
    const p = join(dir, "same.txt");
    writeFileSync(p, "x\n", "utf-8");
    let writes = 0;
    const r = editFile(p, "same.txt", [{ oldText: "x", newText: "x" }], () => {
      writes++;
    });
    expect(writes).toBe(0);
    expect(r.patch).toBe("");
  });

  it("describeEditResult 如实说明归一", () => {
    const p = join(dir, "note.txt");
    writeFileSync(p, "const a = （1）;  \n", "utf-8");
    const r = editFile(p, "note.txt", [{ oldText: "const a = (1);", newText: "const a = 2;" }], writeFileAtomic);
    const text = describeEditResult("note.txt", r);
    expect(text).toContain("字符归一匹配");
    expect(text).toContain("edits[0]");
  });
});
