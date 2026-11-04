#!/usr/bin/env node
// scripts/gen-tsconfig-build-all.mjs — 「一次编全仓能力包」的配置生成器
//
// 背景（2026-10-31 实测本机）：`build-pkgs` 原来是 bash 循环、每包一个 `bash sha.sh build`
// （内含 `npx tsc`）。Windows 上每个进程光启动就 ~1.0s（bash + sha 引擎）+ ~0.9s（node + npx + tsc），
// 25 个包 ≈ 60s，其中真正在编译的不到三分之一。改成单进程 `tsc -b` + 增量后：冷 4s / 热 0.4s。
//
// 本脚本做三件事（幂等，可反复跑）：
//   ① 给每个包的 `tsconfig.build.json` 补 `composite: true` + `tsBuildInfoFile`（增量信息）；
//   ② 按 package.json 的 `@diy-agent/*` 依赖补 `references`（**正确性关键**：没有它，改了 A 的
//      公开 API 不会重编 B —— 增量会把 B 判成"没变"，而它的 .d.ts 输入其实变了）；
//   ③ 生成 `tsconfig.build-all.json`（`tsc -b` 的 solution，references 按 `scripts/build-order.mjs`
//      的拓扑序）。
//
// 用法：
//   node scripts/gen-tsconfig-build-all.mjs           写入
//   node scripts/gen-tsconfig-build-all.mjs --check   只校验（给 check 用，防止手改漂移）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { workspaceDirs } from "./workspace-dirs.mjs";

const ROOT = join(import.meta.dirname, "..");
// 生成物放 build/（.gitignore 里已忽略 `build/`）：它是**纯构建产物** —— 进了版本库就会和
// 「别人重新生成」撞冲突（实测 diy-time/tsconfig.build.json 在 30 个提交里被改 3 次、每次合并都冲突）。
const SOLUTION = join(ROOT, "build", "tsconfig.build-all.json");
const TS_BUILD_INFO = "node_modules/.cache/tsbuildinfo/tsconfig.build.tsbuildinfo";
const checkOnly = process.argv.includes("--check");

/** writeFile / exit 的统一出口：--check 时只报错不写 */
function fail(msg) {
    console.error(`✗ ${msg}`);
    process.exit(1);
}

/** 拓扑序（复用既有判据，别在这里另算一套依赖关系） */
const order = execFileSync(process.execPath, [join(ROOT, "scripts/build-order.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
})
    .trim()
    .split(/\s+/)
    .filter(Boolean);

// build-order 输出的是**仓相对目录**（`pkgs.ts/agent/bot`），直接就是 project 路径
const projects = order.filter((p) => existsSync(join(ROOT, p, "tsconfig.build.json")));

/** 包名 → 仓相对目录（`@diy-agent/context` → `pkgs.ts/agent/context`） */
const nameToDir = new Map();
for (const dir of workspaceDirs(ROOT)) {
    if (!dir.startsWith("pkgs.ts/")) continue;
    const pkgJson = join(ROOT, dir, "package.json");
    if (!existsSync(pkgJson)) continue;
    const name = JSON.parse(readFileSync(pkgJson, "utf8")).name;
    if (name) nameToDir.set(name, dir);
}

const changes = [];

// ① composite / tsBuildInfoFile（去掉与 composite 冲突的 `incremental:false` / `composite:false`）
for (const p of projects) {
    const file = join(ROOT, p, "tsconfig.build.json");
    const text = readFileSync(file, "utf8");
    if (text.includes('"tsBuildInfoFile"') && !/"composite":\s*false/.test(text)) continue;

    let next = text
        // 先删掉与 composite 冲突的两行
        .replace(/\n\s*"incremental":\s*false,/, "")
        .replace(/\n\s*"composite":\s*false,/, "");
    if (!next.includes('"tsBuildInfoFile"')) {
        next = next.replace(
            /("compilerOptions"\s*:\s*\{)/,
            [
                "$1",
                "    // tsc -b 需要 composite；增量信息落 node_modules/.cache（不污染包目录、不进 git）",
                '    "composite": true,',
                `    "tsBuildInfoFile": ${JSON.stringify(TS_BUILD_INFO)},`,
            ].join("\n"),
        );
    }
    if (next === text) fail(`${p}/tsconfig.build.json 补写失败（compilerOptions 格式变了？）`);
    changes.push([file, next, `补 composite/tsBuildInfoFile：${p}`]);
}

// ② references（依赖 → 被依赖项目；路径相对本配置文件）
for (const p of projects) {
    const file = join(ROOT, p, "tsconfig.build.json");
    const pkgJson = join(ROOT, p, "package.json");
    const deps = existsSync(pkgJson)
        ? Object.keys(JSON.parse(readFileSync(pkgJson, "utf8")).dependencies ?? {})
        : [];
    const refs = deps
        .map((n) => nameToDir.get(n))
        .filter((d) => d && d !== p && existsSync(join(ROOT, d, "tsconfig.build.json")))
        // references 相对**本配置文件所在目录**：分层后 `../<组>/<包>` 不一定对，一律算相对。
        // 分隔符统一成 `/`（Windows 上 relative 会给 `..\\core\\x`，与仓库里的生成物不一致 →
        // 每次 build 都改脏 tsconfig.build.json、check 判漂移）
        .map((d) => relative(dirname(file), join(ROOT, d, "tsconfig.build.json")).replaceAll("\\", "/"));

    const current = changes.find(([f]) => f === file)?.[1] ?? readFileSync(file, "utf8");
    // 去掉旧的 references 块，再把文件尾**归一**成 "}" + 一个换行 ——
    // 不归一会每跑一次就多一个空行（曾经踩过：生成器不幂等 ⇒ check 永远红）
    const stripped = current.replace(/,\s*"references"\s*:\s*\[[^\]]*\]/s, "").replace(/\s*\}\s*$/, "\n}\n");
    const indent = "  ";
    const block = refs.map((r) => `${indent}  { "path": ${JSON.stringify(r)} }`).join(",\n");
    const next =
        refs.length === 0
            ? stripped
            : stripped.replace(/\}\n$/, `,\n${indent}"references": [\n${block}\n${indent}]\n}\n`);
    if (next !== current) {
        const existing = changes.find(([f]) => f === file);
        if (existing) {
            existing[1] = next;
        } else {
            changes.push([file, next, `补 references（${refs.length} 个）：${p}`]);
        }
    }
}

// ③ solution 文件
const solution = {
    $comment:
        "生成物：`node scripts/gen-tsconfig-build-all.mjs`（勿手改）。`tsc -b build/tsconfig.build-all.json` = 一次编全部能力包（增量；改一个包只重编它与依赖它的）。",
    files: [],
    // 唯一要注意的：references 相对**本文件**解析，放在 build/ 下就要 `../`
    references: projects.map((path) => ({ path: `../${path}/tsconfig.build.json` })),
};
const solutionText = `${JSON.stringify(solution, null, 2)}\n`;
const solutionBefore = existsSync(SOLUTION) ? readFileSync(SOLUTION, "utf8") : "";

if (checkOnly) {
    if (changes.length > 0) {
        for (const [, , what] of changes) console.error(`✗ 漂移：${what}`);
        fail("tsconfig.build.json 与依赖/生成规则不一致 —— 跑 node scripts/gen-tsconfig-build-all.mjs");
    }
    if (solutionBefore !== solutionText) fail("tsconfig.build-all.json 与生成结果不一致 —— 跑 node scripts/gen-tsconfig-build-all.mjs");
    console.log(`✓ 构建配置一致（${projects.length} 个项目；tsconfig.build-all.json 最新）`);
    process.exit(0);
}

for (const [file, next, what] of changes) {
    writeFileSync(file, next, "utf8");
    console.log(`✓ ${what}`);
}
if (solutionBefore !== solutionText) {
    mkdirSync(dirname(SOLUTION), { recursive: true });
    writeFileSync(SOLUTION, solutionText, "utf8");
    console.log(`✓ 写出 tsconfig.build-all.json（${projects.length} 个项目）`);
} else if (changes.length === 0) {
    console.log(`✓ 已最新（${projects.length} 个项目）`);
} else {
    console.log(`✓ tsconfig.build-all.json 已最新（${projects.length} 个项目）`);
}
