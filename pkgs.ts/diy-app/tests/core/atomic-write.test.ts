// ##382：原子写原语（core/atomic-write.ts）—— 重点是**失败注入**下的三条承诺：
//   ① 目标文件逐字不变（连 mtime 都不动）② tmp 已清理 ③ 错误原样上抛（同一个错误对象）。
// 为什么必须注入而不是「真把磁盘填满」：填满磁盘不可复现、代价大，而 2026-10-18 的 ENOSPC 事故
// 正是这么撞上的。这里两种注入都是**确定性**的：
//   · 只读目录 / 注入的 writeFileSync 抛错 → 写临时文件失败（真实的 EACCES / 复刻 ENOSPC）
//   · 注入的 renameSync 抛固定错误对象 → rename 失败（并可断言「抛出的就是它本身」）
import * as nodeFs from "node:fs";

import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realFs, writeFileAtomic, type FsLike } from "../../src/main/core/atomic-write";

// 故障注入**走依赖参数**（##402），不 mock 全局 `node:fs`：mock 改的是全局模块表，
// `isolate:false` 下谁先加载了 fs 它就会静默失效。这里造一份「除故障点外全转发真 fs」的桩
// —— 其余调用仍是**真盘**语义（tmp 真的落盘、真 rename、真 stat）。
const faults = {
    write: false,
    rename: false,
    // 固定实例：断言「错误原样上抛」靠的就是对象同一性
    writeError: Object.assign(new Error("injected write failure"), { code: "ENOSPC" }),
    renameError: Object.assign(new Error("injected rename failure"), { code: "EIO" }),
};

const faultyFs: FsLike = {
    ...realFs,
    writeFileSync: (...args: Parameters<typeof nodeFs.writeFileSync>) => {
        if (faults.write) throw faults.writeError;
        return nodeFs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof nodeFs.renameSync>) => {
        if (faults.rename) throw faults.renameError;
        return nodeFs.renameSync(...args);
    },
};

const OLD = "# 老正文\n\n第一段（必须逐字留在原地）。\n\n第二段：中文 + emoji 🐳 + \\n 转义。\n";

let root: string;
let dir: string;
let fp: string;

beforeEach(() => {
    faults.write = false;
    faults.rename = false;
    root = mkdtempSync(join(tmpdir(), "atomic-write-"));
    dir = join(root, "tasks", "166");
    fp = join(dir, "AGENTS.md");
});

afterEach(() => {
    faults.write = false;
    faults.rename = false;
    if (existsSync(dir)) chmodSync(dir, 0o700); // 只读用例改了权限：先复原，否则删不掉
    rmSync(root, { recursive: true, force: true });
});

/** 目录里的文件清单（排序）—— 用来断言「没留下 tmp」 */
const entries = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);

/** 造一份「已有正文」的目标文件，返回它的 stat（供失败后比对 mtime / inode / size） */
function seedOld(): { mtimeMs: number; ino: number; size: number } {
    writeFileAtomic(fp, OLD);
    const st = statSync(fp);
    return { mtimeMs: st.mtimeMs, ino: st.ino, size: st.size };
}

describe("writeFileAtomic — 正常路径", () => {
    it("父目录不存在时先建目录，内容整体落盘", () => {
        expect(existsSync(dir)).toBe(false);
        writeFileAtomic(fp, OLD);
        expect(readFileSync(fp, "utf-8")).toBe(OLD);
        expect(entries(dir)).toEqual(["AGENTS.md"]);
    });

    it("覆盖已存在文件：内容换成新的、不留 tmp、且是 rename 换 inode（不是原地截断）", () => {
        const before = seedOld();
        writeFileAtomic(fp, "新的正文");
        expect(readFileSync(fp, "utf-8")).toBe("新的正文");
        expect(entries(dir)).toEqual(["AGENTS.md"]);
        // rename 是「换个文件进来」：inode 变 ⇒ 替换前旧文件始终完整（读者永不看到半截）
        expect(statSync(fp).ino).not.toBe(before.ino);
    });

    it("fsync: true 也走同一条路（写 + fsync + rename），内容一致、不留 tmp", () => {
        writeFileAtomic(fp, OLD, { fsync: true });
        expect(readFileSync(fp, "utf-8")).toBe(OLD);
        expect(entries(dir)).toEqual(["AGENTS.md"]);
    });

    it("空内容也照写（清空是可表达的意图，不是本原语要拦的事）", () => {
        seedOld();
        writeFileAtomic(fp, "");
        expect(readFileSync(fp, "utf-8")).toBe("");
    });
});

describe("writeFileAtomic — 失败注入：原文件逐字不变 + tmp 清理 + 错误上抛", () => {
    it("写临时文件失败（只读目录 → 真 EACCES）", () => {
        const before = seedOld();
        chmodSync(dir, 0o500); // 目录不可写：tmp 建不出来
        let err: NodeJS.ErrnoException | undefined;
        try {
            writeFileAtomic(fp, "半截都不许有");
        } catch (e) {
            err = e as NodeJS.ErrnoException;
        }
        expect(err?.code).toBe("EACCES");
        // ① 原文件逐字不变（连 mtime / 大小都不动）
        expect(readFileSync(fp, "utf-8")).toBe(OLD);
        const after = statSync(fp);
        expect({ mtimeMs: after.mtimeMs, size: after.size }).toEqual({ mtimeMs: before.mtimeMs, size: before.size });
        // ② tmp 已清理 ③ 错误上抛（不是静默成功）
        expect(entries(dir)).toEqual(["AGENTS.md"]);
    });

    it("写临时文件失败（注入 writeFileSync 抛 ENOSPC —— 复刻 2026-10-18 那次磁盘满）", () => {
        seedOld();
        faults.write = true;
        expect(() => writeFileAtomic(fp, "x".repeat(64), { fs: faultyFs })).toThrow(faults.writeError);
        expect(readFileSync(fp, "utf-8")).toBe(OLD);
        expect(entries(dir)).toEqual(["AGENTS.md"]);
    });

    it("rename 失败（注入）：抛出的是**同一个错误对象**，原文件不变，tmp 已清", () => {
        const before = seedOld();
        faults.rename = true;
        let caught: unknown;
        try {
            writeFileAtomic(fp, "写不进去的正文", { fs: faultyFs });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBe(faults.renameError); // 原样上抛：没被包装、没被吞
        // ① 原文件逐字不变（正文 + mtime + inode —— 证明我们压根没碰它）
        expect(readFileSync(fp, "utf-8")).toBe(OLD);
        const after = statSync(fp);
        expect({ mtimeMs: after.mtimeMs, ino: after.ino }).toEqual({ mtimeMs: before.mtimeMs, ino: before.ino });
        // ② tmp 已清理
        expect(entries(dir)).toEqual(["AGENTS.md"]);
    });

    it("失败后**再次**写入是干净的（上次的 tmp 不干扰本次）", () => {
        seedOld();
        faults.write = true;
        expect(() => writeFileAtomic(fp, "失败的第一次", { fs: faultyFs })).toThrow();
        faults.write = false;
        writeFileAtomic(fp, "成功的第二次");
        expect(readFileSync(fp, "utf-8")).toBe("成功的第二次");
        expect(entries(dir)).toEqual(["AGENTS.md"]);
    });

    it("目标路径是**非空目录** → rename 真失败（不经注入），错误照抛、别的文件没被波及、不留 tmp", () => {
        writeFileAtomic(join(dir, "keep.txt"), "邻居文件");
        mkdirSync(fp, { recursive: true }); // 目标路径成了目录
        writeFileSync(join(fp, "inner.txt"), "占位");
        expect(() => writeFileAtomic(fp, "永远不会成为文件")).toThrow();
        expect(readdirSync(fp)).toEqual(["inner.txt"]);
        expect(readFileSync(join(dir, "keep.txt"), "utf-8")).toBe("邻居文件");
        expect(entries(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
    });
});

describe("writeFileAtomic — 权限位继承（##383）", () => {
    it("覆盖 chmod 600 的既有文件后仍是 600：绝不把私密文件放宽成 0644", () => {
        writeFileAtomic(fp, OLD);
        chmodSync(fp, 0o600); // 如含 API key 的 providers.custom.yaml
        writeFileAtomic(fp, "新的正文");
        expect(statSync(fp).mode & 0o777).toBe(0o600);
        expect(readFileSync(fp, "utf-8")).toBe("新的正文");
    });

    it("目标不存在（新建）→ 权限同普通新建，不受继承逻辑影响", () => {
        mkdirSync(dir, { recursive: true });
        const control = join(dir, "control.txt");
        writeFileSync(control, "");
        writeFileAtomic(fp, OLD);
        expect(statSync(fp).mode & 0o777).toBe(statSync(control).mode & 0o777);
    });
});
