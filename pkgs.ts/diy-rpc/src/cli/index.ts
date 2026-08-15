import type { _Router, _AnyProcedureMeta } from "../core/meta";
import {
  _buildRouteTree,
  _routeResolve,
  _routeLeaves,
  type _RouteNode,
  type _RouterNode,
} from "../core/_tree";
import type { ClientBinding } from "../core/server-binding";
import { parseArgv, generateHelp, CliParseError } from "./_parser";

import "../core/_cli-meta";

/** 按点分路径查找 _RouterNode（如 'diy.app' → diy 下 app 节点），找不到返回 null */
function findNodeByPath(
  root: _RouterNode,
  path: string,
): _RouterNode | null {
  const segs = path.split(".").filter(Boolean);
  let node: _RouterNode = root;
  for (const seg of segs) {
    const child = node.children.find((c) => c.name === seg);
    if (!child) return null;
    if (child.kind === "proc") return null; // cliRootPath 必须指向 router 层
    node = child;
  }
  return node;
}

/**
 * 根据 cliRootPath 决定 CLI 命令树：
 *  - 空 → 整棵 router 树
 *  - 单个路径 → 该子树（摊平 children 到顶层，命令 `task list`）
 *  - 数组 → 合并多个子树到同一个虚拟根
 *    - 普通路径（如 'diy.app'）→ 摊平 children 到顶层（命令 `task list`）
 *    - `!` 前缀路径（如 '!diy.ui'）→ 保留该层命名空间为顶层组（命令 `ui status`）
 * 每个子树的 proc 直接复用（path 仍是完整全名，_routeResolve 按 name 匹配）。
 */
function resolveCliTree(
  root: _RouterNode,
  cliRootPath?: string | string[],
): _RouterNode {
  if (!cliRootPath) return root;
  const paths = Array.isArray(cliRootPath) ? cliRootPath : [cliRootPath];
  const flattened: _RouteNode[] = [];
  for (const p of paths) {
    const keepNs = p.startsWith("!");
    const segPath = keepNs ? p.slice(1) : p;
    const sub = findNodeByPath(root, segPath);
    if (!sub) continue;
    if (keepNs) {
      // 保留命名空间：包成一层 router（name = 子树最后一段，如 ui），并把该层的 desc（group 的 desc）透传
      const nsName = segPath.split(".").pop() ?? segPath;
      flattened.push({ kind: "router", name: nsName, path: segPath, parent: null, desc: sub.desc, children: sub.children });
    } else {
      flattened.push(...sub.children);
    }
  }
  if (flattened.length === 0) return root;
  return { kind: "router", name: "", path: "", parent: null, children: flattened };
}

/**
 * 命令级短命令名：从 proc/router 自身开始，沿 parent 链上溯到命令树根（path 为空的虚拟根），
 * 收集各段 name，得到用户实际输入的命令（如 `task create`，而非 RPC 全名 `diy.app.task.create`）。
 */
function commandName(proc: _RouteNode): string {
  const segs: string[] = [];
  let node: _RouteNode | null = proc;
  // 自身名字必含；上溯到 parent 为虚拟根（path 为空）为止
  while (node && node.name) {
    segs.unshift(node.name);
    node = node.parent;
  }
  return segs.join(" ");
}

/** 叶子命令描述（ProcedureMeta.desc） */
function procDesc(def: _AnyProcedureMeta): string {
  return def.desc ?? "";
}

/** 命令描述第一行（命令列表里的简介）。desc 多行时只取首行。 */
function descFirstLine(desc: string): string {
  const first = desc.split("\n")[0]?.trim() ?? "";
  return first;
}

/** Levenshtein 编辑距离（用于 did-you-mean 拼写建议） */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,                    // 删除
        dp[j - 1] + 1,                // 插入
        prev + (a[i - 1] === b[j - 1] ? 0 : 1), // 替换
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * did-you-mean：对未知命令做编辑距离匹配，返回距离 ≤2 的候选短命令名。
 * 只匹配命令树的顶层段名（argv[0] 定位到子树），返回其下叶子命令。
 */
function suggestCommand(root: _RouterNode, input: string): string[] {
  const candidates: { name: string; dist: number }[] = [];
  for (const leaf of _routeLeaves(root)) {
    // 取叶子路径的首段作为候选命令名（如 diy.app.task.create → task）
    const segs = leaf.path.split(".");
    for (const seg of segs) {
      const dist = editDistance(input, seg);
      if (dist <= 2) candidates.push({ name: seg, dist });
    }
  }
  // 按距离排序，去重，取最近 3 个
  candidates.sort((a, b) => a.dist - b.dist);
  return [...new Set(candidates.map((c) => c.name))].slice(0, 3);
}

async function* stdinAsync(): AsyncGenerator<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: process.stdin.isTTY ? "> " : undefined,
  });
  if (process.stdin.isTTY) rl.prompt();
  for await (const line of rl) yield line;
  rl.close();
}

/** @internal */
export interface CliConfig<TRouter extends _Router | _AnyProcedureMeta> {
  name: string;
  version?: string;
  router: TRouter;
  transport: ClientBinding;
  json?: boolean;
  /**
   * CLI 根路径裁剪：CLI 命令树从这里开始匹配（如 'diy.app' → 命令 `task show`），
   * 但 RPC 调用方法名仍用完整 path（diy.app.task.show）。
   * 支持数组（如 ['diy.app','diy.ui']）合并多个子树到一个命令树根。
   * 默认空 = 全树匹配（命令 `diy app task show`）。
   */
  cliRootPath?: string | string[];
}

/** @internal */
export class CliApp<TRouter extends _Router | _AnyProcedureMeta> {
  private config: CliConfig<TRouter>;
  private tree: _RouterNode;
  /** 根命令描述 = router 顶层第一个 group（如 diy）的 desc，替代原 config.desc */
  private rootDesc?: string;
  private _jsonFlag = false;

  constructor(config: CliConfig<TRouter>) {
    this.config = config;
    // 最外层可为 RpcSchema.group（统一父命令形态）；解包取其 children 作为树根。
    const isTopGroup = (config.router as any)?._streamMode === 'group';
    const routerDef: _Router = isTopGroup
      ? (config.router as any).children
      : (config.router as _Router);
    const root = _buildRouteTree(routerDef);
    // 根命令描述 = 顶层第一个 group/命名空间节点（如 diy）的 desc
    const topRouter = root.children.find((c) => c.kind === "router");
    this.rootDesc = topRouter ? (topRouter as _RouterNode).desc : undefined;
    this.tree = resolveCliTree(root, config.cliRootPath);
    this._backfillParent(this.tree, null);
  }

  private _backfillParent(
    node: _RouteNode,
    parent: _RouterNode | null,
  ): void {
    (node as { parent: _RouterNode | null }).parent = parent;
    if (node.kind === "router") {
      for (const c of node.children) this._backfillParent(c, node);
    }
  }

  async parse(rawArgv: string[]): Promise<void> {
    // 全局 --json flag：任意位置识别，剥离后进入命令解析；输出 JSON
    this._jsonFlag = rawArgv.includes("--json");
    const argv = rawArgv.filter((a) => a !== "--json");

    // 剥离末尾 --help/-h：`diy <命令> --help` 显示该命令自身帮助（父命令或叶子），非根帮助
    let helpRequested = false;
    if (argv.length > 1 && (argv[argv.length - 1] === "--help" || argv[argv.length - 1] === "-h")) {
      helpRequested = true;
      argv.pop();
    }

    if (
      argv.length === 0 ||
      argv[0] === "--help" ||
      argv[0] === "-h"
    ) {
      this.showHelp();
      return;
    }
    if (
      argv[0] === "--version" ||
      argv[0] === "-V"
    ) {
      if (this.config.version) console.log(this.config.version);
      return;
    }
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
      // `diy help <subcommand>` 等价 `diy <subcommand> --help`
      if (argv[0] === "help" && argv.length > 1) {
        const rest = argv.slice(1);
        const sub = _routeResolve(this.tree, rest);
        if (sub) {
          this.showNodeHelp(sub);
          return;
        }
        console.error(`Unknown command: ${rest.join(" ")}`);
        this.showHelp();
        process.exit(2);
      }
      this.showHelp();
      return;
    }

    const resolved = _routeResolve(this.tree, argv);

    // `diy <命令> --help`：显示该命令自身帮助（叶子显示参数 help，父命令显示子命令列表），不执行
    if (helpRequested && resolved) {
      this.showNodeHelp(resolved);
      return;
    }

    if (!resolved || resolved.kind !== "proc") {
      if (resolved && resolved.kind === "router") {
        // 父命令（group）：无子命令时显示自身帮助（子命令列表），而非根帮助
        this.showNodeHelp(resolved);
        return;
      } else {
        const input = argv[0] ?? "";
        const sugg = suggestCommand(this.tree, input);
        if (sugg.length > 0) {
          console.error(`Unknown command: ${input}`);
          console.error(`Did you mean: ${sugg.join(", ")}?`);
        } else {
          console.error(`Unknown command: ${input}`);
        }
      }
      this.showHelp();
      process.exit(2);
    }

    const proc = resolved;
    const def = proc.def;
    // CLI 命令树深度 = 从 proc 上溯到命令树根（path 为空的虚拟根）经过的段数，
    // 命令树根本身不消费 argv，不计入。
    let depth = 1;
    let walk: _RouteNode | null = proc;
    while (walk && walk.parent && walk.parent.path !== "") {
      walk = walk.parent;
      depth++;
    }
    const remaining = argv.slice(depth);

    const desc = procDesc(def);

    try {
      const { input, helpRequested } = parseArgv(def, remaining);

      if (helpRequested) {
        // 命令级 Usage 用裁剪后的短命令名（用户实际输入的命令），非 RPC 全名
        const shortCmd = commandName(proc);
        console.log(
          `Usage: ${this.config.name} ${shortCmd} [options]`,
        );
        const help = generateHelp(def, shortCmd, desc);
        if (help) console.log("\n" + help);
        return;
      }

      const tx = this.config.transport;
      const mode = def._streamMode as string;

      if (mode === "server") {
        const handle = await tx.serverStream(proc.path, { input });
        for await (const chunk of handle as any) {
          const line =
            typeof chunk === "object"
              ? JSON.stringify(chunk)
              : String(chunk);
          console.log(line);
        }
      } else if (mode === "client") {
        const lines = stdinAsync();
        const result = await tx.clientStream(
          proc.path,
          { input },
          lines as any,
        );
        if (result === undefined) return;
        const line =
          typeof result === "object"
            ? JSON.stringify(result, null, 2)
            : String(result);
        console.log(line);
      } else if (mode === "bidi") {
        const handle = await tx.bidiStream(
          proc.path,
          { input },
          stdinAsync() as any,
        );
        for await (const chunk of handle as any) {
          const line =
            typeof chunk === "object"
              ? JSON.stringify(chunk)
              : String(chunk);
          console.log(line);
        }
      } else {
        const result = await tx.invoke(proc.path, { input });
        if (result === undefined) return;
        if (this._jsonFlag || this.config.json) {
          console.log(JSON.stringify({ ok: true, data: result }));
        } else {
          const output =
            typeof result === "object"
              ? JSON.stringify(result, null, 2)
              : String(result);
          console.log(output);
        }
      }
    } catch (err: unknown) {
      if (err instanceof CliParseError) {
        console.error(err.message);
        const shortCmd = commandName(proc);
        const help = generateHelp(def, shortCmd, desc);
        if (help) console.error("\n" + help);
        process.exit(2); // 用法错误（CLIG：usage error = 2）
      }
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  /** 单个命令帮助：叶子命令显示参数 help；父命令显示自身 desc + 子命令列表 */
  showNodeHelp(node: _RouteNode): void {
    if (node.kind === "proc") {
      const shortCmd = commandName(node);
      console.log(`Usage: ${this.config.name} ${shortCmd} [options]`);
      const help = generateHelp(node.def, shortCmd, procDesc(node.def));
      if (help) console.log("\n" + help);
      return;
    }
    // 父命令（router）：显示自身 desc + 子命令列表
    const lines: string[] = [];
    const shortCmd = commandName(node);
    lines.push(`Usage: ${this.config.name} ${shortCmd} <subcommand> [options]`);
    if (node.desc) lines.push("", node.desc);
    if (node.children.length > 0) lines.push("", "Commands:");
    for (const child of node.children) {
      const desc =
        child.kind === "proc"
          ? descFirstLine(procDesc(child.def))
          : descFirstLine(child.desc ?? "");
      if (desc) lines.push(`  ${child.name}  ${desc}`);
      else lines.push(`  ${child.name}`);
    }
    console.log(lines.join("\n"));
  }

  showHelp(): void {
    const lines: string[] = [];
    lines.push(`Usage: ${this.config.name} <command> [options]`);
    if (this.rootDesc)
      lines.push("", this.rootDesc);

    // 顶层直接显示每个子命令（proc 或 router 父命令），desc 取第一行
    const items: { name: string; desc: string; mode: string }[] = [];

    for (const child of this.tree.children) {
      const name = child.name;
      if (child.kind === "proc") {
        const def = child.def;
        items.push({
          name,
          desc: descFirstLine(procDesc(def)),
          mode: def._streamMode!,
        });
      } else {
        // 父命令（router 节点）：显示自身 desc 第一行；其子命令在 `diy <name>` 查看
        items.push({
          name,
          desc: descFirstLine(child.desc ?? ""),
          mode: "",
        });
      }
    }

    if (items.length > 0) lines.push("", "Commands:");

    for (const { name, desc, mode } of items) {
      const modeTag =
        mode && mode !== "unary" ? ` (${mode})` : "";
      if (desc) lines.push(`  ${name}${modeTag}  ${desc}`);
      else lines.push(`  ${name}`);
    }

    lines.push("", "Options:");
    lines.push("  -h, --help     Show help");
    if (this.config.version) lines.push("  -V, --version  Show version");

    console.log(lines.join("\n"));
  }
}
