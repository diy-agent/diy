/**
 * progress.test.ts — parseGitProgress 表驱动单测
 *
 * 样本来自 190 第六节实测（git 2.49，stderr=pipe + --progress，\r 分隔 + 行尾 padding）。
 * 覆盖：Enumerating / Counting / Compressing / Receiving / Resolving / Updating / Total、
 * 带 / 不带 bytes、remote: 前缀、padding 空格、[\r\n] 切段、非进度行为 null。
 * F3 放宽：千分位计数 (1,234/5,678)；体积与速率独立可选（仅体积 / 仅速率 / 都有 / 都无）。
 * 纯函数，全离线。
 */
import { describe, it, expect } from "vitest";
import { parseGitProgress, type GitProgress } from "../src/ref/progress";

interface Case {
    name: string;
    seg: string;
    want: Partial<GitProgress> | null;
}

const cases: Case[] = [
    {
        name: "Enumerating（remote、行首裸数字为总数、done）",
        seg: "remote: Enumerating objects: 202, done.",
        want: {
            phase: "Enumerating objects",
            percent: null,
            count: null,
            total: 202,
            done: true,
            remote: true,
        },
    },
    {
        name: "Counting 中间进度（remote、% 与 n/total，无 bytes）",
        seg: "remote: Counting objects:  10% (21/202)",
        want: {
            phase: "Counting objects",
            percent: 10,
            count: 21,
            total: 202,
            done: false,
            remote: true,
        },
    },
    {
        name: "Counting done（remote 100%）",
        seg: "remote: Counting objects: 100% (202/202), done.",
        want: {
            phase: "Counting objects",
            percent: 100,
            count: 202,
            total: 202,
            done: true,
            remote: true,
        },
    },
    {
        name: "Compressing（remote 服务端阶段）",
        seg: "remote: Compressing objects:  50% (1/2)",
        want: { phase: "Compressing objects", percent: 50, count: 1, total: 2, remote: true },
    },
    {
        name: "Total 汇总行（无冒号，裸数字为总数）",
        seg: "remote: Total 12439 (delta 515), reused 384 (delta 370), pack-reused 11709 (from 3)",
        want: {
            phase: "Total",
            percent: null,
            count: null,
            total: 12439,
            done: false,
            remote: true,
        },
    },
    {
        name: "Receiving 起始（客户端阶段、无 bytes/速率）",
        seg: "Receiving objects:   0% (1/202)",
        want: {
            phase: "Receiving objects",
            percent: 0,
            count: 1,
            total: 202,
            done: false,
            remote: false,
        },
    },
    {
        name: "Receiving 中间（7%）",
        seg: "Receiving objects:   7% (1/13)",
        want: { phase: "Receiving objects", percent: 7, count: 1, total: 13, remote: false },
    },
    {
        name: "Receiving done（带 bytes + 速率）",
        seg: "Receiving objects: 100% (202/202), 9.08 KiB | 3.03 MiB/s, done.",
        want: {
            phase: "Receiving objects",
            percent: 100,
            count: 202,
            total: 202,
            bytes: "9.08 KiB",
            rate: "3.03 MiB/s",
            done: true,
            remote: false,
        },
    },
    {
        name: "Resolving deltas done",
        seg: "Resolving deltas: 100% (120/120), done.",
        want: { phase: "Resolving deltas", percent: 100, count: 120, total: 120, done: true },
    },
    {
        name: "Updating refs done",
        seg: "Updating refs: 100% (5/5), done.",
        want: { phase: "Updating refs", percent: 100, count: 5, total: 5, done: true },
    },
    {
        name: "Updating files（括号内 padding 空格）",
        seg: "Updating files:  10% (  2/17), done.",
        want: { phase: "Updating files", percent: 10, count: 2, total: 17, done: true },
    },
    {
        name: "行尾 padding 空格（抹除残留）",
        seg: "Receiving objects: 100% (13/13), done.        ",
        want: { phase: "Receiving objects", percent: 100, count: 13, total: 13, done: true },
    },
    {
        name: "F3 千分位计数 (1,234/5,678)",
        seg: "Receiving objects: 100% (1,234/5,678), done.",
        want: {
            phase: "Receiving objects",
            percent: 100,
            count: 1234,
            total: 5678,
            done: true,
            remote: false,
        },
    },
    {
        name: "F3 千分位 + 体积 + 速率",
        seg: "Receiving objects: 100% (1,234/5,678), 4.89 MiB | 249.00 KiB/s, done.",
        want: {
            phase: "Receiving objects",
            percent: 100,
            count: 1234,
            total: 5678,
            bytes: "4.89 MiB",
            rate: "249.00 KiB/s",
            done: true,
        },
    },
    {
        name: "F3 千分位裸数字（Enumerating）",
        seg: "remote: Enumerating objects: 12,439, done.",
        want: {
            phase: "Enumerating objects",
            percent: null,
            count: null,
            total: 12439,
            done: true,
            remote: true,
        },
    },
    {
        name: "F3 仅体积无速率（bytes 不丢）",
        seg: "Receiving objects: 100% (13/13), 9.08 KiB",
        want: {
            phase: "Receiving objects",
            percent: 100,
            count: 13,
            total: 13,
            bytes: "9.08 KiB",
            done: false,
        },
    },
    {
        name: "F3 仅速率无体积（MiB/s 不被当成体积）",
        seg: "Resolving deltas: 100% (7120/7120), 3.03 MiB/s, done.",
        want: {
            phase: "Resolving deltas",
            percent: 100,
            count: 7120,
            total: 7120,
            rate: "3.03 MiB/s",
            done: true,
        },
    },
    {
        name: "非进度行：Cloning into → null",
        seg: "Cloning into 'progtest'...",
        want: null,
    },
    {
        name: "非进度行：remote warning → null",
        seg: "remote: warning: LF will be replaced by CRLF",
        want: null,
    },
    {
        name: "非进度行：无数字的阶段行 → null",
        seg: "remote: Executing server-side filter (see git-partial-fetch docs)",
        want: null,
    },
];

describe("parseGitProgress 表驱动", () => {
    for (const c of cases) {
        it(c.name, () => {
            const got = parseGitProgress(c.seg);
            if (c.want === null) {
                expect(got).toBeNull();
            } else {
                expect(got).not.toBeNull();
                expect(got).toMatchObject(c.want);
            }
        });
    }

    it("中间进度行不带 bytes/速率（bytes 只在 done 行，190 修正 2）", () => {
        const mid = parseGitProgress("Receiving objects:  45% (91/202)");
        expect(mid?.bytes).toBeUndefined();
        expect(mid?.rate).toBeUndefined();
        const done = parseGitProgress(
            "Receiving objects: 100% (202/202), 9.08 KiB | 3.03 MiB/s, done.",
        );
        expect(done?.bytes).toBe("9.08 KiB");
        expect(done?.rate).toBe("3.03 MiB/s");
    });

    it("[\\r\\n] 切段后逐段可解析（190 修正 3：分隔符是 \\r 不是 \\n）", () => {
        const blob =
            "Cloning into 'progtest'...\r" +
            "remote: Enumerating objects: 202, done.        \r" +
            "remote: Counting objects: 100% (202/202), done.\r" +
            "Receiving objects: 100% (202/202), 9.08 KiB | 3.03 MiB/s, done.\n";
        const segs = blob
            .split(/[\r\n]/)
            .map((s) => s.trim())
            .filter(Boolean);
        const parsed = segs.map((s) => parseGitProgress(s));
        expect(parsed).toHaveLength(4);
        expect(parsed[0]).toBeNull();
        expect(parsed[1]).toMatchObject({ phase: "Enumerating objects", remote: true });
        expect(parsed[2]).toMatchObject({ phase: "Counting objects", done: true });
        expect(parsed[3]).toMatchObject({
            phase: "Receiving objects",
            bytes: "9.08 KiB",
            done: true,
        });
    });

    it("F3 bytes / rate 各自独立可选：都无 → 均 undefined", () => {
        const got = parseGitProgress("Resolving deltas: 100% (120/120), done.");
        expect(got?.bytes).toBeUndefined();
        expect(got?.rate).toBeUndefined();
    });

    it("F3 仅速率行的 bytes 不被误匹配（负先行排除 x.y MiB/s）", () => {
        const got = parseGitProgress("Receiving objects: 100% (13/13), 9.08 KiB/s, done.");
        expect(got?.rate).toBe("9.08 KiB/s");
        expect(got?.bytes).toBeUndefined();
    });
});
