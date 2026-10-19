// tests/core/local-paths-layout.test.ts
// 🎯 会话落位的**分层 + 双认 + 粘旧**（##379）——三条裁决缺一不可，这里逐条钉住。
//
// 为什么这三条要一起测：单看任意一条都对，合起来才不丢历史 ——
//   · 只有「新优先」：存量会话的下一次 append 写到新文件，读侧从此只看新文件 = 历史静默腰斩；
//   · 只有「旧优先」：迁移过的会话永远读不回新文件 = 迁移白做；
//   · 「都不在 → 新」：新会话才落到分层目录。
// 末条是端到端：投递文本里的 `history.file` 相对路径必须**真能 readFileSync 到文件**
// （漂移 = 模型按索引取不到原文，比不给索引更坏）。

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import {
    CLEARED_SESSION_KINDS,
    keyOf,
    legacySessionFile,
    llmFile,
    llmLogRelPath,
    localDir,
    resolveSessionFile,
    sessionDir,
    sessionFile,
    sessionFileForWrite,
    sessionFilesToClear,
} from "../../src/main/core/local-paths";
import { resolveToolOutFile, toolOutFile, toolOutRelPath } from "../../src/main/services/tool-output";

let URI = "";
beforeAll(() => {
    const pid = createProject(join(diyHome(), "layout-work"));
    URI = createTask({ title: "落位测试", project: pid });
});

describe("分层落位（##379）", () => {
    it("会话目录 = local/<uri 路径>/<keyOf(uri)>（key 算法原样，只是从文件名升成目录名）", () => {
        const dir = sessionDir(URI);
        expect(dir).toBe(join(localDir(), ...URI.split("/"), keyOf(URI)));
        expect(dir.startsWith(join(diyHome(), "local"))).toBe(true);
    });

    it("文件名 = <kind>.jsonl（不再带 key 前缀）", () => {
        expect(sessionFile(URI, "ops")).toBe(join(sessionDir(URI), "ops.jsonl"));
        expect(sessionFile(URI, "llm")).toBe(join(sessionDir(URI), "llm.jsonl"));
    });

    it("旧平铺路径仍可算出（迁移 / 兜底用）：local/<key>.<kind>.jsonl", () => {
        expect(legacySessionFile(URI, "compact")).toBe(join(localDir(), `${keyOf(URI)}.compact.jsonl`));
    });
});

describe("读侧双认 + 写侧粘旧（同一裁决）", () => {
    it("都不在 → 新落位（新会话按新路径创建）", () => {
        const uri = createTask({ title: "落位-空", project: createProject(join(diyHome(), "layout-empty")) });
        expect(resolveSessionFile(uri, "ops")).toBe(sessionFile(uri, "ops"));
    });

    it("只有旧平铺 → 旧（存量会话继续追加，历史不被劈成两半）", () => {
        const uri = createTask({ title: "落位-旧", project: createProject(join(diyHome(), "layout-legacy")) });
        const legacy = legacySessionFile(uri, "ops");
        writeFileSync(legacy, `{"op":"start"}\n`, "utf-8");
        expect(resolveSessionFile(uri, "ops")).toBe(legacy);
        // 写侧也解析到旧文件 → append 接在同一条史书上
        expect(sessionFileForWrite(uri, "ops")).toBe(legacy);
    });

    it("新落位存在 → 新优先（迁移断点两侧并存时取新：新是完整副本）", () => {
        const uri = createTask({ title: "落位-新", project: createProject(join(diyHome(), "layout-new")) });
        writeFileSync(legacySessionFile(uri, "ops"), `old\n`, "utf-8");
        const next = sessionFileForWrite(uri, "ops");
        writeFileSync(next, `new\n`, "utf-8");
        expect(resolveSessionFile(uri, "ops")).toBe(next);
    });

    it("写侧建父目录：sessionFileForWrite 之后父目录必然存在（调用方不必自己 mkdir）", () => {
        const uri = createTask({ title: "落位-建目录", project: createProject(join(diyHome(), "layout-mkdir")) });
        const f = sessionFileForWrite(uri, "usage");
        expect(existsSync(dirname(f))).toBe(true);
    });
});

describe("投递文本契约：相对路径真能回取（端到端，不是字符串相等）", () => {
    it("history.file 的 relPath 指向的文件存在且内容一致", () => {
        const uri = createTask({ title: "落位-投递", project: createProject(join(diyHome(), "layout-deliver")) });
        const f = sessionFileForWrite(uri, "llm");
        writeFileSync(f, `{"role":"user"}\n`, "utf-8");

        const rel = llmLogRelPath(uri);
        expect(rel.startsWith("local/")).toBe(true);
        expect(rel).toBe(`local/${URI_SPLIT(uri)}/${keyOf(uri)}/llm.jsonl`);
        // 模型/人按 rel 取原文：$DIY_HOME/<rel>
        expect(readFileSync(join(diyHome(), rel), "utf-8")).toBe(`{"role":"user"}\n`);
        expect(llmFile(uri)).toBe(f);
    });

    it("旧平铺会话的 relPath 指的是**旧**文件（不谎报一个不存在的新路径）", () => {
        const uri = createTask({ title: "落位-投递旧", project: createProject(join(diyHome(), "layout-deliver-old")) });
        const legacy = legacySessionFile(uri, "llm");
        writeFileSync(legacy, `old-line\n`, "utf-8");
        const rel = llmLogRelPath(uri);
        expect(rel).toBe(`local/${keyOf(uri)}.llm.jsonl`);
        expect(readFileSync(join(diyHome(), rel), "utf-8")).toBe("old-line\n");
    });
});

/** uri → `projects/<pid>/tasks/<tid>` 的相对形式（与 sessionDir 的段拼法保持一致） */
function URI_SPLIT(uri: string): string {
    return uri.split("/").filter(Boolean).join("/");
}

describe("clear 的文件清单（两落位都删；changelog 除外）", () => {
    it("覆盖全部 kind × 新老两份", () => {
        const files = sessionFilesToClear(URI);
        expect(files.length).toBe(CLEARED_SESSION_KINDS.length * 2);
        for (const kind of CLEARED_SESSION_KINDS) {
            expect(files).toContain(sessionFile(URI, kind));
            expect(files).toContain(legacySessionFile(URI, kind));
        }
    });

    it("不含 changelog（它是跨会话审计时间线，清对话 ≠ 清审计）", () => {
        for (const f of sessionFilesToClear(URI)) expect(f).not.toContain(".changelog.jsonl");
    });
});

describe("工具输出原文（##379 随会话分层）", () => {
    it("新落位在会话目录下；旧共享目录的存量文件读侧兜底", () => {
        const id = "call_layout_1";
        const next = toolOutFile(URI, id);
        expect(next).toBe(join(sessionDir(URI), "toolout", `${id}.txt`));
        // 未落盘时：resolve 给新路径（写侧目标）
        expect(resolveToolOutFile(URI, id)).toBe(next);
        // 旧共享目录里有一份 → 兜底认得（存量 24871 个不强制迁移）
        const legacy = join(localDir(), "toolout", `${id}.txt`);
        mkdirSync(dirname(legacy), { recursive: true });
        writeFileSync(legacy, "old-out", "utf-8");
        expect(resolveToolOutFile(URI, id)).toBe(legacy);
        expect(readFileSync(join(diyHome(), toolOutRelPath(URI, id)), "utf-8")).toBe("old-out");
        expect(toolOutRelPath(URI, id)).toBe(`local/toolout/${id}.txt`);
        rmSync(legacy, { force: true });
    });
});
