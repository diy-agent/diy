import type { _Router, _AnyProcedureMeta } from "../core/meta";
import {
  _buildRouteTree,
  _routeResolve,
  type _RouteNode,
  type _RouterNode,
} from "../core/_tree";
import type { ClientBinding } from "../core/server-binding";
import { parseArgv, generateHelp, fmtUsageArgs, CliParseError } from "./_parser";

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
      flattened.push({ kind: "router", name: nsName, path: segPath, parent: null, desc: sub.desc, title: sub.title, children: sub.children });
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

/** 命令节点的单行简介：叶子用 meta.title，父命令用 router 节点.title（均 = desc 首行） */
function nodeTitle(node: _RouteNode): string {
  if (node.kind === "proc") return node.def.title ?? "";
  return node.title ?? "";
}

/** 对齐输出命令列表：命令名列 padEnd 到最宽，描述列统一起列；无描述的条目不补尾随空格。 */
function emitCommandList(lines: string[], items: { name: string; desc: string }[]): void {
  const w = items.reduce((m, { name, desc }) => Math.max(m, desc ? name.length : 0), 0);
  for (const { name, desc } of items) {
    lines.push(desc ? `  ${name.padEnd(w)}  ${desc}` : `  ${name}`);
  }
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
 * did-you-mean：对未知命令段做编辑距离匹配，返回距离 ≤2 的候选命令名。
 * 只在**失败段的同级兄弟**（所在节点的 children）里匹配 —— 整树叶子路径匹配会把
 * 输入自己回显回来（如 `ui view open …` 的 "Did you mean: ui?"，任务 205），
 * 且跨层候选（任意深度的段名）对定位失败点没有意义。
 */
function suggestCommand(siblings: _RouteNode[], input: string): string[] {
  const candidates: { name: string; dist: number }[] = [];
  for (const c of siblings) {
    const dist = editDistance(input, c.name);
    if (dist <= 2) candidates.push({ name: c.name, dist });
  }
  // 按距离排序，去重，取最近 3 个
  candidates.sort((a, b) => a.dist - b.dist);
  return [...new Set(candidates.map((c) => c.name))].slice(0, 3);
}

/**
 * 定位 argv 中第一个在命令树上匹配不到的段（_routeResolve 返回 null 时必存在）。
 * 返回 { idx: 失败段下标, parent: 失败段所在节点（建议器在其 children 里匹配）}。
 * 报错必须报到这里 —— 否则 `diy ui view open …`（view 下只有 expand/set、没有 open）
 * 会退化成 "Unknown command: ui"（argv[0]），把合法的前缀段当成未知命令（任务 205）。
 */
function firstUnmatched(
  root: _RouterNode,
  args: string[],
): { idx: number; parent: _RouterNode } {
  let node = root;
  for (let i = 0; i < args.length; i++) {
    const child = node.children.find((c) => c.name === args[i]);
    if (!child) return { idx: i, parent: node };
    if (child.kind === "proc") {
      // 叶子后跟的是参数而非命令段；_routeResolve 遇 proc 直接返回（不会走到 null），
      // 走到这里说明 resolved 异常 —— 按该段失败处理
      return { idx: i, parent: node };
    }
    node = child;
  }
  // 全部段匹配却仍为 null：不可能（末段必返回 child），兜底报最后一段
  return { idx: Math.max(0, args.length - 1), parent: root };
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
  /**
   * 解析路径参数（`resolvePath` 标记）的基准目录。
   * 必须由入口传**调用者**的 cwd —— 入口脚本普遍先 cd 到应用目录再 exec
   * （diy.sh / bin/diy 都这样），那时 process.cwd() 已不是用户敲命令的目录。
   * 缺省 process.cwd()。
   */
  cwd?: string;
  /**
   * 输出/退出注入（server 内嵌 CLI / 端点用，见 diy-app rpc-port.ts 的 /cli）：
   * 缺省 = console.log / console.error / process.exit —— 直连 CLI 行为不变。
   *
   * 契约：`out`/`err` 收到的参数与 `console.log`/`console.error` **完全同参**
   * （一行文本，**不含行尾换行**）—— 落盘时由注入方自行补 `\n`，这样字节与直连一致。
   * `exit` 应为不返回（否则 parse 继续跑），见 `_exit` 的 never 收窄。
   */
  out?: (line: string) => void;
  err?: (line: string) => void;
  exit?: (code: number) => void;
}

/** @internal */
export class CliApp<TRouter extends _Router | _AnyProcedureMeta> {

  // ── 输出/退出注入（server 内嵌 /cli 端点用；缺省 = 原行为，直连 CLI 不变）──
  /** stdout 写入点：缺省 console.log；注入方负责补行尾换行（契约见 CliConfig.out） */
  private _print(line: string): void {
    (this.config.out ?? ((x: string) => console.log(x)))(line);
  }
  /** stderr 写入点：缺省 console.error（同上，注入方补换行） */
  private _printErr(line: string): void {
    (this.config.err ?? ((x: string) => console.error(x)))(line);
  }
  /** 退出点：缺省 process.exit；注入后由调用方接管（内嵌时抛异常中止 parse）。
   *  返回类型 never —— 与 process.exit 对齐，调用点后的 TS 收窄（resolved/proc）不被破坏。 */
  private _exit(code: number): never {
    (this.config.exit ?? ((c: number) => process.exit(c)))(code);
    // 到这里只有两种情况：注入的 exit 实现返回了（不允许）——显式炸，别静默继续
    throw new Error(`[cli] exit(${code}) hook returned normally`);
  }
  private config: CliConfig<TRouter>;
  private tree: _RouterNode;
  /** 根命令描述 = router 顶层第一个 group（如 diy）的 desc，替代原 config.desc */
  private rootDesc?: string;
  private _jsonFlag = false;

  constructor(config: CliConfig<TRouter>) {
    this.config = config;
    const isTopGroup = (config.router as any)?._streamMode === 'group';
    let root: _RouterNode;
    if (isTopGroup) {
      // 最外层是顶层 group（如 diy）：它即根命令，desc 直接作为根描述，children 作为命令树
      const group = config.router as any;
      this.rootDesc = group.desc;
      root = _buildRouteTree(group.children as _Router);
    } else {
      root = _buildRouteTree(config.router as _Router);
      // 根命令描述 = 顶层第一个 group/命名空间节点（如 diy）的 desc
      const topRouter = root.children.find((c) => c.kind === "router");
      this.rootDesc = topRouter ? (topRouter as _RouterNode).desc : undefined;
    }
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
      if (this.config.version) this._print(this.config.version);
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
        this._printErr(`Unknown command: ${rest.join(" ")}`);
        this.showHelp();
        this._exit(2);
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
        // resolved 为 null = 某段在树上匹配不到。报**第一个失败段**（含前缀路径），
        // 而非 argv[0]：`ui view open …` 中 ui/view 都合法，只有 open 不存在，
        // 报 "Unknown command: ui" 会把合法前缀当未知命令，建议器还会回显自己（任务 205）。
        const { idx, parent } = firstUnmatched(this.tree, argv);
        const input = argv.slice(0, idx + 1).join(" ");
        const sugg = suggestCommand(parent.children, argv[idx] ?? "");
        if (sugg.length > 0) {
          this._printErr(`Unknown command: ${input}`);
          this._printErr(`Did you mean: ${sugg.join(", ")}?`);
        } else {
          this._printErr(`Unknown command: ${input}`);
        }
      }
      this.showHelp();
      this._exit(2);
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
    // 路由键用 RPC 全名（def.name，router() 回写）。当 router 是最外层 group（如 diy）被解包时，
    // proc.path 会丢失 "diy." 前缀，与 binding 注册的全名不匹配，故路由一律用 def.name。
    const rpcName = def.name ?? proc.path;

    try {
      const { input, helpRequested } = parseArgv(def, remaining, { cwd: this.config.cwd });

      if (helpRequested) {
        // 命令级 Usage 用裁剪后的短命令名（用户实际输入的命令），非 RPC 全名
        const shortCmd = commandName(proc);
        const args = fmtUsageArgs(def);
        this._print(
          `Usage: ${this.config.name} ${shortCmd} [options]${args ? ` ${args}` : ""}`,
        );
        const help = generateHelp(def, shortCmd, desc);
        if (help) this._print("\n" + help);
        return;
      }

      const tx = this.config.transport;
      const mode = def._streamMode as string;

      if (mode === "server") {
        const handle = await tx.serverStream(rpcName, { input });
        for await (const chunk of handle as any) {
          const line =
            typeof chunk === "object"
              ? JSON.stringify(chunk)
              : String(chunk);
          this._print(line);
        }
      } else if (mode === "client") {
        const lines = stdinAsync();
        const result = await tx.clientStream(
          rpcName,
          { input },
          lines as any,
        );
        if (result === undefined) return;
        const line =
          typeof result === "object"
            ? JSON.stringify(result, null, 2)
            : String(result);
        this._print(line);
      } else if (mode === "bidi") {
        const handle = await tx.bidiStream(
          rpcName,
          { input },
          stdinAsync() as any,
        );
        for await (const chunk of handle as any) {
          const line =
            typeof chunk === "object"
              ? JSON.stringify(chunk)
              : String(chunk);
          this._print(line);
        }
      } else {
        const result = await tx.invoke(rpcName, { input });
        if (result === undefined) return;
        if (this._jsonFlag || this.config.json) {
          this._print(JSON.stringify({ ok: true, data: result }));
        } else {
          const output =
            typeof result === "object"
              ? JSON.stringify(result, null, 2)
              : String(result);
          this._print(output);
        }
      }
    } catch (err: unknown) {
      if (err instanceof CliParseError) {
        this._printErr(err.message);
        const shortCmd = commandName(proc);
        const help = generateHelp(def, shortCmd, desc);
        if (help) this._printErr("\n" + help);
        this._exit(2); // 用法错误（CLIG：usage error = 2）
      }
      this._printErr(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      this._exit(1);
    }
  }

  /** 单个命令帮助：叶子命令显示参数 help；父命令显示自身 desc + 子命令列表 */
  showNodeHelp(node: _RouteNode): void {
    if (node.kind === "proc") {
      const shortCmd = commandName(node);
      const args = fmtUsageArgs(node.def);
      this._print(`Usage: ${this.config.name} ${shortCmd} [options]${args ? ` ${args}` : ""}`);
      const help = generateHelp(node.def, shortCmd, procDesc(node.def));
      if (help) this._print("\n" + help);
      return;
    }
    // 父命令（router）：显示自身 desc + 子命令列表
    const lines: string[] = [];
    const shortCmd = commandName(node);
    lines.push(`Usage: ${this.config.name} ${shortCmd} <subcommand> [options]`);
    if (node.desc) lines.push("", node.desc);
    if (node.children.length > 0) lines.push("", "Commands:");
    emitCommandList(lines, node.children.map((child) => ({ name: child.name, desc: nodeTitle(child) })));
    this._print(lines.join("\n"));
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
          desc: nodeTitle(child),
          mode: def._streamMode!,
        });
      } else {
        // 父命令（router 节点）：显示自身 title（desc 首行）；其子命令在 `diy <name>` 查看
        items.push({
          name,
          desc: nodeTitle(child),
          mode: "",
        });
      }
    }

    if (items.length > 0) lines.push("", "Commands:");

    emitCommandList(lines, items.map(({ name, desc, mode }) => {
      const modeTag = mode && mode !== "unary" ? ` (${mode})` : "";
      return { name: name + modeTag, desc };
    }));

    lines.push("", "Options:");
    lines.push("  -h, --help     Show help");
    if (this.config.version) lines.push("  -V, --version  Show version");

    this._print(lines.join("\n"));
  }
}
