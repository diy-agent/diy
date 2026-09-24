// tests/core/file-read.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 文件窗口读取（core/file-read）意图验证
//
// 覆盖 bug #156：read 工具截断文本 —— 旧实现 clip(s, 6000) 取头 3000 + 尾 3000，
// **中间丢弃**且无续读入口。本模块是新的唯一实现：行窗口 + 行/字节双限 + 续读提示。
//
// 无网络、无 LLM、无 Electron — 纯函数级验证
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readFileWindow,
  formatReadOutput,
  ReadWindowError,
  READ_MAX_BYTES,
} from "../../src/main/core/file-read";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "diy-file-read-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写一个 n 行的文件（第 i 行内容 = `L<i>`），返回绝对路径 */
function writeLines(name: string, n: number): string {
  const p = join(dir, name);
  writeFileSync(p, Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n") + "\n", "utf-8");
  return p;
}

describe("readFileWindow — 窗口语义", () => {
  it("小文件整读：不截断，totalLines 是真值", async () => {
    const p = writeLines("small.txt", 5);
    const w = await readFileWindow(p, p);
    expect(w.totalLines).toBe(5);
    expect(w.lines.map((l) => l.number)).toEqual([1, 2, 3, 4, 5]);
    expect(w.lines[0].text).toBe("L1");
    expect(w.truncatedByBytes).toBe(false);
  });

  it("limit 收窄：只返回前 N 行，但 totalLines 仍报全量（续读提示要用真值）", async () => {
    const p = writeLines("limit.txt", 100);
    const w = await readFileWindow(p, p, { limit: 10 });
    expect(w.lines.length).toBe(10);
    expect(w.totalLines).toBe(100); // 关键：扫完整个文件才有的真值
  });

  it("offset 跳行：行号是文件真实行号，不是窗口内序号", async () => {
    const p = writeLines("offset.txt", 100);
    const w = await readFileWindow(p, p, { offset: 51, limit: 10 });
    expect(w.lines.map((l) => l.number)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    expect(w.lines[0].text).toBe("L51");
  });

  it("offset 越界：报错且 reason 可分支", async () => {
    const p = writeLines("oor.txt", 10);
    await expect(readFileWindow(p, p, { offset: 99 })).rejects.toThrow(ReadWindowError);
    await expect(readFileWindow(p, p, { offset: 99 })).rejects.toThrow(/超出文件范围/);
  });

  it("空文件读 offset=1 不算越界（三家一致的特例）", async () => {
    const p = join(dir, "empty.txt");
    writeFileSync(p, "", "utf-8");
    const w = await readFileWindow(p, p);
    expect(w.totalLines).toBe(0);
    expect(w.lines).toEqual([]);
  });

  it("空文件读 offset=2 → 越界", async () => {
    const p = join(dir, "empty2.txt");
    writeFileSync(p, "", "utf-8");
    await expect(readFileWindow(p, p, { offset: 2 })).rejects.toThrow(/超出文件范围/);
  });
});

describe("readFileWindow — 截断策略", () => {
  it("字节上限：截断后仍报准确 totalLines（继续扫完数行）", async () => {
    // 每行 200 字符，1000 行 = 200KB，远超 50KB
    const p = join(dir, "big.txt");
    writeFileSync(p, Array.from({ length: 1000 }, (_, i) => `${i + 1}:${"x".repeat(195)}`).join("\n"), "utf-8");
    const w = await readFileWindow(p, p);
    expect(w.truncatedByBytes).toBe(true);
    expect(w.totalLines).toBe(1000); // 未因 break 而报小
    expect(w.lines.length).toBeGreaterThan(0);
    expect(w.lines.length).toBeLessThan(1000);
  });

  it("**不设单行字符数上限**：5000 字符的行原样返回（旧实现砍到 2000）", async () => {
    const p = join(dir, "longline.txt");
    const line = "y".repeat(5000);
    writeFileSync(p, `${line}\nshort\n`, "utf-8");
    const w = await readFileWindow(p, p);
    expect(w.lines[0].text).toBe(line); // 一行就是一条完整记录（jsonl 场景），不能被砍
    expect(w.lines[1].text).toBe("short");
  });

  it("超长 jsonl 行：一条记录完整可读（回归「单行不该限制」）", async () => {
    const p = join(dir, "log.jsonl");
    const rec = (i: number) => JSON.stringify({ i, payload: "p".repeat(3000) });
    writeFileSync(p, [rec(1), rec(2), rec(3)].join("\n") + "\n", "utf-8");
    const w = await readFileWindow(p, p);
    expect(w.lines.length).toBe(3);
    for (const l of w.lines) {
      expect(() => JSON.parse(l.text)).not.toThrow(); // 每行都是完整 JSON
    }
  });

  it("单行超过整份字节预算：只显示前一段，并标记 overflow（内存保护，非读者截断）", async () => {
    const p = join(dir, "huge-line.txt");
    writeFileSync(p, "z".repeat(READ_MAX_BYTES * 2) + "\n", "utf-8");
    const w = await readFileWindow(p, p);
    expect(w.lines.length).toBe(1);
    expect(w.lines[0].overflow).toBe(true);
    expect(w.lines[0].text.length).toBe(READ_MAX_BYTES); // 内存保护上限 = 字节预算
  });
});

describe("readFileWindow — 二进制拒绝", () => {
  it("含 NUL 的文件判定为二进制并报错", async () => {
    const p = join(dir, "bin.dat");
    writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await expect(readFileWindow(p, p)).rejects.toThrow(ReadWindowError);
    await expect(readFileWindow(p, p)).rejects.toThrow(/二进制/);
  });
});

describe("formatReadOutput — 续读提示", () => {
  it("未读完：给出下一段 offset", async () => {
    const p = writeLines("fmt1.txt", 100);
    const w = await readFileWindow(p, p, { limit: 10 });
    const out = formatReadOutput(w);
    expect(out).toContain("[已显示 1-10 行，共 100 行。续读：--offset 11]");
    expect(out).toContain("1: L1");
    expect(out).toContain("10: L10");
  });

  it("style=tool：续读提示写成工具参数 offset=N（不是 shell 的 --offset）", async () => {
    const p = writeLines("fmt-tool.txt", 100);
    const w = await readFileWindow(p, p, { limit: 10 });
    expect(formatReadOutput(w, { style: "tool" })).toContain("续读：offset=11");
    expect(formatReadOutput(w)).toContain("续读：--offset 11"); // 缺省 = cli
  });

  it("读完：报文件结束", async () => {
    const p = writeLines("fmt2.txt", 3);
    const out = formatReadOutput(await readFileWindow(p, p));
    expect(out).toContain("[文件结束，共 3 行]");
  });

  it("offset 续读：提示里的区间从 offset 起算", async () => {
    const p = writeLines("fmt3.txt", 100);
    const w = await readFileWindow(p, p, { offset: 50, limit: 10 });
    expect(formatReadOutput(w)).toContain("[已显示 50-59 行，共 100 行。续读：--offset 60]");
  });

  it("字节截断：提示里说明已达上限", async () => {
    const p = join(dir, "fmt4.txt");
    writeFileSync(p, Array.from({ length: 500 }, (_, i) => `${i + 1}:${"x".repeat(195)}`).join("\n"), "utf-8");
    const out = formatReadOutput(await readFileWindow(p, p));
    expect(out).toContain("已达 50KB 输出上限");
  });

  it("空文件：给出空文件提示", async () => {
    const p = join(dir, "fmt5.txt");
    writeFileSync(p, "", "utf-8");
    expect(formatReadOutput(await readFileWindow(p, p))).toContain("[文件为空]");
  });

  it("多字节超长行吃满预算：指向 bash 取片段（ASCII 行走不到，见上一条）", async () => {
    const p = join(dir, "fmt6.txt");
    // 中文 1 字符 3 字节：字符数 = 预算，字节数 = 3 倍预算 → 整行装不下
    writeFileSync(p, "中".repeat(READ_MAX_BYTES) + "\n", "utf-8");
    const out = formatReadOutput(await readFileWindow(p, p));
    expect(out).toContain("超过 50KB 输出上限");
    expect(out).toContain("sed -n '1p'");
  });

  it("overflow 行：提示里说明只显示了前一段", async () => {
    const p = join(dir, "fmt7.txt");
    writeFileSync(p, "z".repeat(READ_MAX_BYTES * 2) + "\n", "utf-8");
    const out = formatReadOutput(await readFileWindow(p, p));
    expect(out).toContain(`[注：有 1 行超过 50KB，仅显示前 50KB]`);
  });
});

describe("回归 #156 — 中段内容不再丢失", () => {
  it("旧 clip 丢弃的中间行，可经 offset 续读完整取回", async () => {
    const n = 433; // 对齐触发 bug 的 App.tsx 行数
    const p = writeLines("regress156.txt", n);
    const first = await readFileWindow(p, p, { limit: 74 });
    expect(first.lines.at(-1)!.number).toBe(74);

    // 旧实现：第 75-386 行被 slice(3000, -3000) 丢掉，且无入口取回
    const mid = await readFileWindow(p, p, { offset: 75, limit: 100 });
    expect(mid.lines[0].number).toBe(75);
    expect(mid.lines[0].text).toBe("L75");

    // 拼起来 = 全量，无空洞
    const all = [...first.lines, ...mid.lines];
    expect(all.map((l) => l.number)).toEqual(Array.from({ length: 174 }, (_, i) => i + 1));
  });
});
