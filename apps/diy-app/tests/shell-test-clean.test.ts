// tests/shell-test-clean.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ShellTest 输出清洗的**确定性回归**（纯函数，无需 Electron）
//
// 背景（任务 223 定点复现）：PS1 marker 不以换行结尾 → 命令 stderr 会与前面的 prompt
// **落在同一行**：
//     "__ST_…__(0)__ Error: 未知模型 不存在的模型（可选：…）"
// 早期清洗用「整行过滤」，把含真实错误的整行一起丢掉 → stderr 变空 → 错误路径断言
// `expected '' to match /…/` 偶发红（~2%，retry 无效）。
//
// 这里用**构造输入**锁死行为，不依赖偶发复现（单个 intent 用例只命中错误路径一次，
// 靠它守回归会 98% 假绿）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { stripStderrNoise, stripStdoutNoise } from "./shell-test";

const MP = "__ST_TEST__";
const SENT = "__ST_TEST__DONE1";

describe("ShellTest 输出清洗", () => {
  it("stderr：marker 与真实输出**同行**时，只剥 marker、保住输出（核心回归）", () => {
    const raw = `${MP}(0)__ Error: 未知模型 不存在的模型（可选：见 diy agent local models）\n${MP}(1)__ \n${SENT}E\n`;
    const clean = stripStderrNoise(raw, MP, SENT);
    expect(clean).toBe("Error: 未知模型 不存在的模型（可选：见 diy agent local models）");
  });

  it("stderr：多行输出每行都带 marker 时，逐行剥离且顺序不变", () => {
    const raw = `${MP}(0)__ a\n${MP}(0)__ b\n${MP}(1)__ \n${SENT}E\n`;
    expect(stripStderrNoise(raw, MP, SENT)).toBe("a\nb");
  });

  it("stderr：纯 marker 行被清掉（不产生空行噪声）", () => {
    const raw = `${MP}(0)__ \n${MP}(1)__ \n${SENT}E\n`;
    expect(stripStderrNoise(raw, MP, SENT)).toBe("");
  });

  it("stderr：真实输出在 marker **之前**的同一行也保住", () => {
    const raw = `partial text ${MP}(0)__ \n${SENT}E\n`;
    expect(stripStderrNoise(raw, MP, SENT)).toBe("partial text");
  });

  it("stdout：剥掉带退出码的哨兵与 \\r，保留正文", () => {
    const raw = `{"ok":true}\r\n${SENT}:0\r\n`;
    expect(stripStdoutNoise(raw, SENT)).toBe('{"ok":true}');
  });

  it("stdout：多行 JSON 正文不被破坏", () => {
    const raw = `{\n  "a": 1\n}\n\n${SENT}:1\n`;
    expect(stripStdoutNoise(raw, SENT)).toBe('{\n  "a": 1\n}');
  });
});
