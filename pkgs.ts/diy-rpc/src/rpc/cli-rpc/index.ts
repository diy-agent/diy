import type {
  Router,
  AnyProcedure,
  RouteNode,
  RouterNode,
  ProcNode,
} from "..";
import {
  buildRouteTree,
  routeResolve,
  routeWalk,
} from "..";
import type { RawClient } from "../raw-client";
import type { AnyProcedureMeta } from "..";
import { parseArgv, generateHelp, CliParseError } from "./parser";
import type { ProcedureCliMeta } from "./meta";

export { getCliOptionMeta, getCliArgMeta, hasCliMeta } from "./meta";
export type { CliOptionMeta, CliArgMeta, ProcedureCliMeta } from "./meta";

import "./meta";

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
}

export class CliApp<TRouter extends Router> {
  private config: CliConfig<TRouter>;
  private tree: RouterNode;

  constructor(config: CliConfig<TRouter>) {
    this.config = config;
    this.tree = buildRouteTree(config.router);
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
    const argv = [...rawArgv];

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
    const consumed = proc.path.split(".").length;
    const remaining = argv.slice(consumed);

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
        if (this.config.json) {
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

export function createCli<TRouter extends Router>(
  config: CliConfig<TRouter>,
): CliApp<TRouter> {
  return new CliApp(config);
}
