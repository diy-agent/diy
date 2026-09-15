// tests/core/drafts.test.ts
// 🎯 半编辑草稿（.diy/drafts.yaml）读写意图测试
//    数据在 /tmp/diy-desktop-test-xxx/（setup.ts 隔离），不碰生产 ~/.diy/

import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome, taskDir, taskSystemDir } from "../../src/main/core/state";
import {
  DRAFTS_KIND,
  DRAFTS_VERSION,
  clearDrafts,
  draftsFilePath,
  readDrafts,
  writeDrafts,
} from "../../src/main/core/drafts";

const URI = "projects/901/tasks/1";

/** 建一个任务目录（只需目录存在，草稿单独于 AGENTS.md） */
function mkTask(): void {
  mkdirSync(taskDir(URI), { recursive: true });
}

/** 直接读写文件，模拟外部写入 / 损坏场景 */
function writeRaw(content: string): void {
  mkdirSync(taskSystemDir(URI), { recursive: true });
  writeFileSync(draftsFilePath(URI), content, "utf-8");
}

beforeEach(() => {
  // 每个用例从干净任务目录开始（teardown 交给临时目录整体回收）
  mkTask();
  rmSync(draftsFilePath(URI), { force: true });
});

describe("drafts 读写", () => {
  it("无文件时读回 null（不抛错）", () => {
    expect(readDrafts(URI)).toBeNull();
  });

  it("写入后可读回，且带 kind/version/task/saved meta", () => {
    writeDrafts(URI, { title: "半编辑标题" }, "2026-09-13T00:00:00.000Z");
    const d = readDrafts(URI)!;
    expect(d.kind).toBe(DRAFTS_KIND);
    expect(d.version).toBe(DRAFTS_VERSION);
    expect(d.task).toBe(URI);
    expect(d.base_updated).toBe("2026-09-13T00:00:00.000Z");
    expect(d.saved).toBeTruthy();
    expect(d.fields.title).toBe("半编辑标题");
  });

  it("多字段共存（标题 + 详情 + agent 输入）", () => {
    writeDrafts(URI, { title: "T", detail: "多行\n详情", agent_input: "打到一半" });
    const d = readDrafts(URI)!;
    expect(d.fields.title).toBe("T");
    expect(d.fields.detail).toBe("多行\n详情");
    expect(d.fields.agent_input).toBe("打到一半");
  });

  it("合并语义：后写字段不冲掉先前字段", () => {
    writeDrafts(URI, { title: "T" });
    writeDrafts(URI, { agent_input: "草稿" });
    const d = readDrafts(URI)!;
    expect(d.fields.title).toBe("T");
    expect(d.fields.agent_input).toBe("草稿");
  });

  it("base_updated 保留首次落盘的值（不被后续写覆盖）", () => {
    writeDrafts(URI, { title: "T" }, "v1");
    writeDrafts(URI, { detail: "D" }, "v2");
    expect(readDrafts(URI)!.base_updated).toBe("v1");
  });

  it("值原样保存（不 trim、保留空行与首尾空白）", () => {
    const raw = "  前后有空格  \n\n";
    writeDrafts(URI, { agent_input: raw });
    expect(readDrafts(URI)!.fields.agent_input).toBe(raw);
  });
});

describe("drafts 清理", () => {
  it("清单个字段：其余字段留存", () => {
    writeDrafts(URI, { title: "T", detail: "D" });
    clearDrafts(URI, ["title"]);
    const d = readDrafts(URI)!;
    expect(d.fields.title).toBeUndefined();
    expect(d.fields.detail).toBe("D");
  });

  it("清到无字段 → 文件消失（不留空壳）", () => {
    writeDrafts(URI, { title: "T" });
    clearDrafts(URI, ["title"]);
    expect(existsSync(draftsFilePath(URI))).toBe(false);
    expect(readDrafts(URI)).toBeNull();
  });

  it("不带 fields 清空 → 整个文件消失", () => {
    writeDrafts(URI, { title: "T", detail: "D" });
    clearDrafts(URI);
    expect(existsSync(draftsFilePath(URI))).toBe(false);
  });

  it("幂等：文件不存在时清空不报错", () => {
    expect(() => clearDrafts(URI)).not.toThrow();
    expect(() => clearDrafts(URI, ["title"])).not.toThrow();
  });

  it("写入空串等于清除该字段（不落空串）", () => {
    writeDrafts(URI, { title: "T", detail: "D" });
    writeDrafts(URI, { detail: "" });
    const d = readDrafts(URI)!;
    expect(d.fields.detail).toBeUndefined();
    expect(d.fields.title).toBe("T");
  });

  it("清到全空后文件删除（写空串路径）", () => {
    writeDrafts(URI, { title: "T" });
    writeDrafts(URI, { title: "" });
    expect(existsSync(draftsFilePath(URI))).toBe(false);
  });
});

describe("drafts 健壮性", () => {
  it("yaml 损坏 → 读回 null 且不抛错", () => {
    writeRaw("{ 这不是合法 yaml: [");
    expect(() => readDrafts(URI)).not.toThrow();
    expect(readDrafts(URI)).toBeNull();
  });

  it("kind 不符 → 读回 null（防误读别的 yaml）", () => {
    writeRaw("kind: something-else\nversion: 1\nfields:\n  title: X\n");
    expect(readDrafts(URI)).toBeNull();
  });

  it("version 不符 → 读回 null（丢不起的数据不静默降级）", () => {
    writeRaw(`kind: ${DRAFTS_KIND}\nversion: 999\nfields:\n  title: X\n`);
    expect(readDrafts(URI)).toBeNull();
  });

  it("未知字段被忽略（白名单外不落盘）", () => {
    writeDrafts(URI, { title: "T", ...({ bogus: "X" } as object) });
    const raw = readFileSync(draftsFilePath(URI), "utf-8");
    expect(raw.includes("bogus")).toBe(false);
    expect(readDrafts(URI)!.fields.title).toBe("T");
  });

  it("文件里的未知字段读不进来（只认白名单）", () => {
    writeRaw(`kind: ${DRAFTS_KIND}\nversion: 1\nfields:\n  title: T\n  bogus: X\n`);
    const d = readDrafts(URI)!;
    expect(d.fields.title).toBe("T");
    expect(Object.keys(d.fields)).toEqual(["title"]);
  });

  it("非字符串字段值被忽略", () => {
    writeRaw(`kind: ${DRAFTS_KIND}\nversion: 1\nfields:\n  title: 123\n`);
    expect(readDrafts(URI)!.fields.title).toBeUndefined();
  });

  it("原子写：写完不留 .tmp", () => {
    writeDrafts(URI, { title: "T" });
    expect(existsSync(draftsFilePath(URI) + ".tmp")).toBe(false);
  });
});

describe("drafts 存储位置", () => {
  it("落在任务目录内 .diy/drafts.yaml（随任务目录删除而删除）", () => {
    writeDrafts(URI, { title: "T" });
    const fp = draftsFilePath(URI);
    expect(fp).toBe(join(diyHome(), URI, ".diy", "drafts.yaml"));
    expect(taskSystemDir(URI)).toBe(join(taskDir(URI), ".diy"));
  });
});
