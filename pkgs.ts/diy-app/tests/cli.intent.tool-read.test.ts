// tests/cli.intent.tool-read.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 tool read CLI 意图测试 — 行窗口读取（bug #156）
//
// 验收目标：CLI 侧的 read 必须是**可续读的行窗口**，而不是旧 clip 的
// 「取头尾、丢中间」。断言分三层：
//   1. 输出契约：行号 / 续读提示 / 结束提示的文案
//   2. 续读可达：offset 能取回窗口外（旧实现永久丢失）的行
//   3. 与内置 read 工具同源：同一 core/file-read 实现（单元测试另见 tests/core/file-read.test.ts）
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

const REPO_ROOT = join(__dirname, "..", "..", "..");

let sh: ShellTest;
let HOME: string;
let electron: ElectronTest;
/** 项目目录（相对路径用例的 cwd） */
let projDir: string;
let pid: string;

beforeAll(async () => {
  electron = await startElectronTest();
  HOME = electron.home;
  sh = new ShellTest({ cwd: REPO_ROOT, env: { HOME, DIY_HOME: HOME } });

  projDir = join(HOME, "t-tool-read");
  mkdirSync(projDir, { recursive: true });
  const res = await sh.getJson(`./diy.sh project create ${projDir}`);
  pid = String((res.data as any)?.data?.id);

  // 夹具：小文件 / 大文件（超 50KB 字节上限）
  writeFileSync(join(projDir, "small.txt"), "alpha\nbeta\ngamma\n", "utf-8");
  writeFileSync(
    join(projDir, "big.txt"),
    Array.from({ length: 500 }, (_, i) => `row-${i + 1}-${"x".repeat(150)}`).join("\n") + "\n",
    "utf-8",
  );
}, 120_000);

afterAll(async () => {
  if (pid) await sh?.run(`./diy.sh project remove ${pid}`);
  sh?.close();
  await electron?.stop();
});

describe("tool read — 输出契约", () => {
  it("小文件整读：带行号 + 文件结束提示", async () => {
    const r = await sh.diy2("tool", "read", join(projDir, "small.txt"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1: alpha");
    expect(r.stdout).toContain("2: beta");
    expect(r.stdout).toContain("3: gamma");
    expect(r.stdout).toContain("[文件结束，共 3 行]");
  });

  it("limit 收窄：给出 --offset 续读入口（旧 clip 没有这个出口）", async () => {
    const r = await sh.diy2("tool", "read", join(projDir, "small.txt"), "--limit", "2");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1: alpha");
    expect(r.stdout).toContain("2: beta");
    expect(r.stdout).not.toContain("3: gamma");
    expect(r.stdout).toContain("[已显示 1-2 行，共 3 行。续读：--offset 3]");
  });

  it("offset 续读：行号是文件真实行号，接上上一段", async () => {
    const r = await sh.diy2("tool", "read", join(projDir, "small.txt"), "--offset", "3");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("3: gamma");
    expect(r.stdout).toContain("[文件结束，共 3 行]");
  });

  it("字节上限：超 50KB 时截断但仍报准确总行数", async () => {
    const r = await sh.diy2("tool", "read", join(projDir, "big.txt"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已达 50KB 输出上限");
    expect(r.stdout).toContain("共 500 行"); // 真值：没有被 break 截小
  });
});

describe("tool read — 续读可达（回归 #156）", () => {
  it("旧 clip 丢弃的中段，可经 --offset 完整取回", async () => {
    // bug 现场文件：433 行，旧实现丢第 75-386 行且无入口取回
    const appTsx = join(REPO_ROOT, "pkgs.ts/diy-app/src/renderer_solid/App.tsx");

    const head = await sh.diy2("tool", "read", appTsx, "--limit", "74");
    expect(head.code).toBe(0);
    expect(head.stdout).toContain("74: ");
    expect(head.stdout).toMatch(/续读：--offset 75/);

    // 旧实现下这一行落在被丢弃的区间里，取不回来
    const mid = await sh.diy2("tool", "read", appTsx, "--offset", "75", "--limit", "10");
    expect(mid.code).toBe(0);
    expect(mid.stdout).toContain("75: ");
    expect(mid.stdout).toContain("84: ");
  });
});

describe("tool read — 错误路径", () => {
  it("offset 越界：exit 1 + 明确文案（不静默返回空）", async () => {
    const r = await sh.diy2("tool", "read", join(projDir, "small.txt"), "--offset", "99");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/超出文件范围/);
  });

  it("不存在的文件：exit 1，且报出完整路径", async () => {
    const r = await sh.diy2("tool", "read", join(projDir, "nope.txt"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/文件不存在/);
    expect(r.stderr).toContain(join(projDir, "nope.txt"));
  });

  it("目录：明确拒绝并指路（不做隐式列目录）", async () => {
    const r = await sh.diy2("tool", "read", projDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/是目录/);
  });
});

describe("tool read — 相对路径基准 = 敲命令的 shell", () => {
  // 通用工具不该被绑在任务上：相对路径按**调用方进程**的 cwd 解析。
  // 这条链上有个坑：handler 跑在 app 进程（Electron main），它的 cwd 是应用目录。
  // 所以解析必须发生在 CLI 侧的 parser 里（api-def 的 resolvePath 注解），
  // 否则 `cd <dir> && diy tool read small.txt` 会去应用目录找文件。
  it("cd 到别处后相对路径仍可读（不依赖 app 进程 cwd）", async () => {
    const r = await sh.run(`(cd ${projDir} && ${REPO_ROOT}/diy.sh tool read small.txt)`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1: alpha");
    expect(r.stdout).toContain("[文件结束，共 3 行]");
  });

  it("相对路径的解析基准是 shell cwd：同一命令换目录读到的就是另一份文件", async () => {
    writeFileSync(join(HOME, "small.txt"), "elsewhere\n", "utf-8");
    const inProj = await sh.run(`(cd ${projDir} && ${REPO_ROOT}/diy.sh tool read small.txt)`);
    const inHome = await sh.run(`(cd ${HOME} && ${REPO_ROOT}/diy.sh tool read small.txt)`);
    expect(inProj.stdout).toContain("1: alpha");
    expect(inHome.stdout).toContain("1: elsewhere");
  });
});
