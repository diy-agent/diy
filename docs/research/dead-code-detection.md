# 研究：怎么可靠地判断「这段逻辑还在被使用」

> 状态：**未定**（2026-11-04 提出）。当前只做到「静态 import 图 + 测试引用甄别」，
> 明显不够 —— 见下方「已知不足」。

## 为什么需要

`scripts/find-orphan-tests.mjs` 用**字符串正则**扫 import，能抓「只被测试引用」的源文件，
但误报/漏报都不少（`apps/web/server.ts` 被 `.mjs` 引用就漏了）。
更要紧的是它只回答「**文件**有没有被 import」，回答不了：

- 导出了 20 个函数，**只有 3 个**被用 —— 剩下 17 个是死的，但文件本身活着
- 一个函数**只在测试里被调用**（同孤儿文件，但粒度是函数）
- 动态 import / 依赖注入 / 字符串拼路径 → 静态图看不见
- **间接使用**：A 调 B，B 调 C，C 只在罕见分支用到 —— 是「死」还是「防御性代码」？

## 候选手段

### 1. TypeScript 编译器 API（AST）—— 中成本，高精度

```ts
import ts from "typescript";
// 建 Program → 遍历 SourceFile → 收集 ImportDeclaration / CallExpression
// 再反向解符号（checker.getSymbolAtLocation）
```

- ✅ 能回答「这个**导出符号**有没有被引用」（不只文件）
- ✅ 能跨文件解析、处理 re-export / 别名
- ❌ 动态 `import()` 仍是黑盒（除非把字符串常量也算进去）
- 现成实现：`ts-prune` / `knip`（底层就是 AST）

### 2. knip（已在用）—— 低成本

- ✅ `unused exports` 已经在报 227 个
- ❌ 对「只有测试引用」不敏感（测试算引用源）
- ❌ 大量假阳性（esbuild/vite 入口、monorepo exports 配置）

**改进做法**：给 knip 配置 `ignoreExportsUsedInFile` + 把 `tests/` 从 import 源里剔除后重跑一次，
得到的就是「只被测试用」的导出。这大概率比自写脚本准。

### 3. 运行时覆盖率（c8 / istanbul）—— 高精度，但有陷阱

- ✅ 唯一能回答「**真的被执行过**」的手段
- ❌ 需要跑真实场景；覆盖率低 ≠ 死代码（可能是罕见分支）
- ❌ 测试覆盖率会把「只被测试调用」当成覆盖 —— **必须区分「生产覆盖率」与「测试覆盖率」**

**关键技巧**：跑一次**只走生产路径**的覆盖率（不带 tests），看哪些函数一个 hit 都没有。
配上 `--all`（把未加载文件也计入）才是全貌。

### 4. 依赖图分析（madge / dependency-cruiser）

- ✅ 能画子图、找环、找孤立节点
- ⚠️ 和 knip 重叠，主要价值是**可视化**（人看哪儿断了）

### 5. 语义级：符号表 + 调用图

- 最彻底：用 `ts.Program` 建**调用图**（call graph），回答「这个函数被谁调」而不只是「被谁 import」
- ❌ 成本高（需要类型信息、处理高阶函数/回调注入）
- 适用：只对**核心模块**做（如 `local-agent.ts` 的 6364 行）

### 6. 保守标记法（零工具成本）

给新代码加 `/* @usedBy: <说明> */` 或反向索引注释 —— 人写的，不会误报，但会腐坏。
**只适合临时验证，不适合长期**。

## 已知不足（当前脚本）

| 问题 | 例子 |
|---|---|
| 只解析静态相对路径 import | 别名（`@diy-agent/*`）走 node_modules 解析，脚本看不见 |
| 扫 `.ts` 为主 | `.mjs` 入口漏扫（已补，但设计上是补丁）|
| 不区分「文件活 / 导出死」 | 20 个导出用 3 个也算活 |
| 动态 import 黑盒 | `import(someVar)` 完全看不见 |

## 实测：knip 排除 tests 模式（2026-11-04，已跑通）

**结论：可用，成本极低，但需要过滤假阳性。**

做法：临时配置把 `vitest.entry` / 所有 `tests/**` 从入口里去掉 —— 这样「只被测试引用」
的导出就会变成 "unused exports"。

```bash
# 1. 复制 knip.json，去掉 tests / vitest / *.test.* / *.probe.* 入口
node -e "
const j = require('./knip.json');
for (const ws of Object.values(j.workspaces||{}))
  ws.entry = (ws.entry||[]).filter(e => !/test|probes/.test(e));
delete j.vitest;
j.ignore = [...(j.ignore||[]), '**/tests/**', '**/*.test.*', '**/*.probe.*', '**/*.gen.ts'];
require('fs').writeFileSync('/tmp/knip-notests.json', JSON.stringify(j,null,2));
"
# 2. 只报 exports 类问题
npx knip --config /tmp/knip-notests.json --reporter=compact --include exports
```

全仓实测：**27 处**「只被测试用」的导出。

### 两类假阳性（必须人工过一遍）

| 类型 | 例子 | 判断 |
|---|---|---|
| **同文件内部使用** | `os/posix.ts: defaultPosixDeps` —— 被同文件的 `createPosixOs()` 当默认参数用 | knip 只统计**跨文件**引用 ⇒ 真·多余导出，可降级 |
| **测试注入点** | `os/posix.ts` 的 `PosixDeps` 类型 | 故意导出给测试造桩 ⇒ 保留 |

### 与 `find-orphan-tests.mjs` 的分工

| 工具 | 粒度 | 回答 |
|---|---|---|
| `find-orphan-tests.mjs` | **文件** | 「这个文件只被测试 import 吗」 |
| `knip --include exports`（排除 tests）| **导出符号** | 「这个导出只被测试用吗」 |

**先跑后者**：文件级孤儿的绝大多数，其所有导出都会出现在导出级清单里 ——
从导出级反查文件更省力（也是一个更细的判据）。

### 已验证的清理（本轮）

- `os/posix.ts: defaultPosixDeps` / `win32.ts: defaultWin32Deps` —— 降级为包内函数
  （只被同文件的 `createPosixOs()` 当默认参数用）

### 不打算清的

- `apps/diy-app/src/shared/session-*.ts` 的十几个导出 —— diy-app 要废弃，清了也没收益
- `tests` 里的注入点（`PosixDeps` / `Win32Deps` 等）—— 故意的

## 建议的下一步（未做）

1. **先试 knip 的「排除 tests」模式** —— 成本最低，先看它能不能直接给出「只被测试用」的导出清单
2. 若不够，用 `ts.Program` 写一个**导出级**孤儿检测（只处理 `export` 声明，不求全）
3. 覆盖率只对**核心包**跑（`pkgs.ts/agent/*`），不要全仓（噪音淹没有用信号）
4. 把三者的结论交叉验证 —— **三个工具都说死，才敢删**；任一说不死就人工看一眼

## 不属于这个研究的问题

- 「测试有没有意义」（那是 `docs/testing.md` 的 probe/golden 分工）
- 「代码质量」（死代码只是其中一项）
