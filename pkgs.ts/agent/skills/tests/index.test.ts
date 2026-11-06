// 两条线：① **真实加载**本机 `~/.agents/skills`（用户要的「先写个测试加载看看」）
//          ② fixture 覆盖各级合并 / frontmatter 解析（真实目录不在 CI 上，不能只靠它）
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFrontmatter, skillsOf } from "../src/index.js";

const REAL_GLOBAL = join(homedir(), ".agents");

describe("真实数据：本机 ~/.agents/skills", () => {
    const root = REAL_GLOBAL;

    it.skipIf(!existsSync(join(root, "skills")))("能列出真实技能，且每条都有名字和描述", () => {
        const skills = skillsOf({ cwd: homedir(), globalRoot: root, stopAt: homedir() });
        // 本机实测 22 个（2026-11-06）。这里不断言具体数量（会变），只断言「能拿到、字段全」
        expect(skills.length).toBeGreaterThan(0);
        for (const s of skills) {
            expect(s.name).not.toBe("");
            expect(s.desc).not.toBe("");
            expect(s.path.endsWith("SKILL.md")).toBe(true);
            expect(existsSync(s.path)).toBe(true);
        }
        // 至少要有 diy-cli 这种真实存在的（防止路径拼错还"成功"返回空）
        expect(skills.some((s) => s.name === "diy-cli")).toBe(true);
    });

    it.skipIf(!existsSync(join(root, "skills")))("description 里带「触发词」，这是模型判断要不要打开的判据", () => {
        const skills = skillsOf({ cwd: homedir(), globalRoot: root, stopAt: homedir() });
        const diyCli = skills.find((s) => s.name === "diy-cli");
        expect(diyCli).toBeDefined();
        expect(diyCli!.desc).toContain("触发词");
        expect(diyCli!.desc.length).toBeGreaterThan(50);
    });
});

describe("fixture：各级合并与 frontmatter", () => {
    let root: string;

    const skill = (dir: string, name: string, desc: string): void => {
        mkdirSync(join(dir, "skills", name), { recursive: true });
        writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`, "utf-8");
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "skills-"));
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("全局层 + 项目层都能收；全局排在前，按名排序", () => {
        const globalRoot = join(root, "global");
        const repo = join(root, "repo");
        skill(globalRoot, "aaa", "全局的");
        skill(join(repo, ".agents"), "zzz", "项目的");
        const out = skillsOf({ cwd: repo, globalRoot, stopAt: root });
        expect(out.map((s) => s.name)).toEqual(["aaa", "zzz"]);
        // scope 已删（用户 2026-11-07：只留 path 先试效果）—— 改断言 path 落在哪一层
        expect(out[0]!.path).toContain("global");
        expect(out[1]!.path).toContain("repo");
    });

    it("同名时**更近的目录**覆盖（项目能覆盖全局）", () => {
        const globalRoot = join(root, "global");
        const repo = join(root, "repo");
        skill(globalRoot, "same", "全局版本");
        skill(join(repo, ".agents"), "same", "项目版本");
        const out = skillsOf({ cwd: repo, globalRoot, stopAt: root });
        expect(out).toHaveLength(1);
        expect(out[0]!.desc).toBe("项目版本");
    });

    it("网络层：逐层向上都能收到（repo/.agents 与 repo/sub/.agents）", () => {
        const globalRoot = join(root, "global");
        const repo = join(root, "repo");
        const sub = join(repo, "sub");
        mkdirSync(sub, { recursive: true });
        skill(join(repo, ".agents"), "outer", "外层的");
        skill(join(sub, ".agents"), "inner", "内层的");
        const out = skillsOf({ cwd: sub, globalRoot, stopAt: root });
        expect(out.map((s) => s.name).sort()).toEqual(["inner", "outer"]);
    });

    it("目录不存在 ⇒ 空数组，不抛", () => {
        expect(skillsOf({ cwd: join(root, "nope"), globalRoot: join(root, "nope2"), stopAt: root })).toEqual([]);
    });

    it("没有 SKILL.md 的子目录被跳过", () => {
        const globalRoot = join(root, "global");
        mkdirSync(join(globalRoot, "skills", "empty-dir"), { recursive: true });
        expect(skillsOf({ cwd: root, globalRoot, stopAt: root })).toEqual([]);
    });
});

describe("readFrontmatter", () => {
    it("折叠标量 `>-` 收成单行", () => {
        const meta = readFrontmatter("---\nname: x\ndescription: >-\n  第一行\n  第二行\n---\n\n正文\n");
        expect(meta["name"]).toBe("x");
        expect(meta["description"]).toBe("第一行 第二行");
    });

    it("字面标量 `|` 也收成单行（下游要一句话，不需要换行）", () => {
        const meta = readFrontmatter("---\ndescription: |\n  甲\n  乙\n---\n");
        expect(meta["description"]).toBe("甲 乙");
    });

    it("普通单行 + 引号剥掉", () => {
        expect(readFrontmatter('---\nname: "带引号"\n---\n')["name"]).toBe("带引号");
    });

    it("没有 frontmatter ⇒ 空对象", () => {
        expect(readFrontmatter("# 只有正文\n")).toEqual({});
    });

    it("正文里出现的 key: value 不会被误读（只读 `---` 之间）", () => {
        const meta = readFrontmatter("---\nname: x\n---\n\nname: 正文里的\n");
        expect(meta["name"]).toBe("x");
    });
});
