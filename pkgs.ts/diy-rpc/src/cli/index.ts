import type { Router } from "../core/meta";
import {
  buildRouteTree,
  routeResolve,
  routeWalk,
  type RouteNode,
  type RouterNode,
  type ProcNode,
} from "../core/tree";
import type { RawClient } from "../core/raw";
import { parseArgv, generateHelp, CliParseError } from "./parser";
import type { ProcedureCliMeta } from "../core/cli-meta";

export { getCliOptionMeta, getCliArgMeta, hasCliMeta } from "../core/cli-meta";
export type { CliOptionMeta, CliArgMeta, ProcedureCliMeta } from "../core/cli-meta";

import "../core/cli-meta";

/** 按点分路径查找 RouterNode（如 'diy.app' → diy 下 app 节点），找不到返回 null */
function findNodeByPath(
  root: RouterNode,
  path: string,
): RouterNode | null {
  const segs = path.split(".").filter(Boolean);
  let node: RouterNode = root;
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
 * 每个子树的 proc 直接复用（path 仍是完整全名，routeResolve 按 name 匹配）。
 */
function resolveCliTree(
  root: RouterNode,
  cliRootPath?: string | string[],
): RouterNode {
  if (!cliRootPath) return root;
  const paths = Array.isArray(cliRootPath) ? cliRootPath : [cliRootPath];
  const flattened: RouteNode[] = [];
  for (const p of paths) {
    const keepNs = p.startsWith("!");
    const segPath = keepNs ? p.slice(1) : p;
    const sub = findNodeByPath(root, segPath);
    if (!sub) continue;
    if (keepNs) {
      // 保留命名空间：包成一层 router（name = 子树最后一段，如 ui）
      const nsName = segPath.split(".").pop() ?? segPath;
      flattened.push({ kind: "router", name: nsName, path: segPath, parent: null, children: sub.children });
    } else {
      flattened.push(...sub.children);
    }
  }
  if (flattened.length === 0) return root;
  return { kind: "router", name: "", path: "", parent: null, children: flattened };
}

async function* stdinAsync(): AsyncGenerator<string> {
  const { createInterface } = await import("readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: process.stdin.isTTY ? "> " : undefined,
  });
  if (process.stdin.isTTY) rl.prompt();
  for await (const line of rl) yield line;
  rl.close();
}

export interface CliConfig<TRouter extends Router> {
  name: string;
  version?: string;
  description?: string;
  router: TRouter;
  transport: RawClient;
  json?: boolean;
  groups?: Record<string, string>;
  /**
   * CLI 根路径裁剪：CLI 命令树从这里开始匹配（如 'diy.app' → 命令 `task show`），
   * 但 RPC 调用方法名仍用完整 path（diy.app.task.show）。
   * 支持数组（如 ['diy.app','diy.ui']）合并多个子树到一个命令树根。
   * 默认空 = 全树匹配（命令 `diy app task show`）。
   */
  cliRootPath?: string | string[];
}

export class CliApp<TRouter extends Router> {
  private config: CliConfig<TRouter>;
  private tree: RouterNode;
  private _jsonFlag = false;

  constructor(config: CliConfig<TRouter>) {
    this.config = config;
    const root = buildRouteTree(config.router);
    this.tree = resolveCliTree(root, config.cliRootPath);
    this._backfillParent(this.tree, null);
  }

  private _backfillParent(
    node: RouteNode,
    parent: RouterNode | null,
  ): void {
    (node as { parent: RouterNode | null }).parent = parent;
    if (node.kind === "router") {
      for (const c of node.children) this._backfillParent(c, node);
    }
  }

  async parse(rawArgv: string[]): Promise<void> {
    // 全局 --json flag：任意位置识别，剥离后进入命令解析；输出 JSON
    this._jsonFlag = rawArgv.includes("--json");
    const argv = rawArgv.filter((a) => a !== "--json");

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

    const resolved = routeResolve(this.tree, argv);

    if (!resolved || resolved.kind !== "proc") {
      if (resolved && resolved.kind === "router") {
        console.error(
          `Incomplete command: ${resolved.path || resolved.name} — expected subcommand`,
        );
      } else {
        console.error(`Unknown command: ${argv[0]}`);
      }
      this.showHelp();
      process.exit(1);
    }

    const proc = resolved;
    const def = proc.def;
    // CLI 命令树深度 = 从 proc 上溯到命令树根（path 为空的虚拟根）经过的段数，
    // 命令树根本身不消费 argv，不计入。
    let depth = 1;
    let walk: RouteNode | null = proc;
    while (walk && walk.parent && walk.parent.path !== "") {
      walk = walk.parent;
      depth++;
    }
    const remaining = argv.slice(depth);

    const desc =
      (def.cliDesc as ProcedureCliMeta | undefined)?.description ?? "";

    try {
      const { input, helpRequested } = parseArgv(def, remaining);

      if (helpRequested) {
        const usageParts = proc.path.split(".");
        console.log(
          `Usage: ${this.config.name} ${usageParts.join(" ")} [options]`,
        );
        const help = generateHelp(def, proc.path, desc);
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
        const help = generateHelp(def, proc.path, desc);
        if (help) console.error("\n" + help);
        process.exit(1);
      }
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  showHelp(): void {
    const lines: string[] = [];
    lines.push(`Usage: ${this.config.name} <command> [options]`);
    if (this.config.description)
      lines.push("", this.config.description);

    const groups = this.config.groups;

    const topLevel = new Map<
      string | symbol,
      { title: string; items: { name: string; desc: string; mode: string }[] }
    >();
    const TOP = Symbol("top");

    for (const child of this.tree.children) {
      if (child.kind === "proc") {
        const def = child.def;
        const desc =
          (def.cliDesc as ProcedureCliMeta | undefined)?.description ??
          "";
        if (!topLevel.has(TOP)) topLevel.set(TOP, { title: "", items: [] });
        topLevel.get(TOP)!.items.push({
          name: child.name,
          desc,
          mode: def._streamMode!,
        });
        continue;
      }

      const groupKey = child.name;
      const groupTitle = groups?.[groupKey] ?? groupKey;
      if (!topLevel.has(groupKey)) {
        topLevel.set(groupKey, { title: groupTitle, items: [] });
      }
      const group = topLevel.get(groupKey)!;

      routeWalk(child, (node) => {
        if (node.kind !== "proc") return;
        const def = node.def;
        const desc =
          (def.cliDesc as ProcedureCliMeta | undefined)?.description ??
          "";
        group.items.push({
          name: node.path,
          desc,
          mode: def._streamMode!,
        });
      });
    }

    if (topLevel.size > 0) lines.push("", "Commands:");

    for (const [key, group] of Array.from(topLevel.entries())) {
      if (key !== TOP) {
        lines.push("", `  ${group.title}:`);
      }
      for (const { name, desc, mode } of group.items) {
        const label = key === TOP ? `  ${name}` : `    ${name}`;
        const modeTag =
          mode && mode !== "unary" ? ` (${mode})` : "";
        if (desc) lines.push(`${label}${modeTag}  ${desc}`);
        else lines.push(label);
      }
    }

    lines.push("", "Options:");
    lines.push("  -h, --help     Show help");
    if (this.config.version) lines.push("  -V, --version  Show version");

    console.log(lines.join("\n"));
  }
}
