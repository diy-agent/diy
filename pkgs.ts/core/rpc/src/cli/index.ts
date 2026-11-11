import type { _Router, _AnyProcedureMeta } from '../core/meta.js';
import {
  _buildRouteTree,
  _flattenRouter,
  _routeResolve,
  type _RouteNode,
  type _RouterNode,
} from '../core/_tree.js';
import type { ClientBinding } from '../core/server-binding.js';
import {
  parseArgv,
  generateHelp,
  fmtUsageArgs,
  CliParseError,
  globalOptionTable,
  scanGlobalOptions,
  renderGlobalOptions,
  kebabOf,
  type GlobalOption,
} from './_parser.js';
import { _getCliOptionMeta } from '../core/_cli-meta.js';
import { z } from 'zod';
import { RpcSchema } from '../core/rpc.js';
import { createScopedClient, mountService, type ScopedClient } from '../core/scope.js';
import { ChannelClientBinding, ChannelServerBinding } from '../core/index.js';
import { createMemTransportPair } from '../core/mem.js';

import '../core/_cli-meta.js';

/** 按点分路径查找 _RouterNode（如 'diy.app' → diy 下 app 节点），找不到返回 null */
function findNodeByPath(root: _RouterNode, path: string): _RouterNode | null {
  const segs = path.split('.').filter(Boolean);
  let node: _RouterNode = root;
  for (const seg of segs) {
    const child = node.children.find((c) => c.name === seg);
    if (!child) return null;
    if (child.kind === 'proc') return null; // cliRootPath 必须指向 router 层
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
function resolveCliTree(root: _RouterNode, cliRootPath?: string | string[]): _RouterNode {
  if (!cliRootPath) return root;
  const paths = Array.isArray(cliRootPath) ? cliRootPath : [cliRootPath];
  const flattened: _RouteNode[] = [];
  for (const p of paths) {
    const keepNs = p.startsWith('!');
    const segPath = keepNs ? p.slice(1) : p;
    const sub = findNodeByPath(root, segPath);
    if (!sub) continue;
    if (keepNs) {
      // 保留命名空间：包成一层 router（name = 子树最后一段，如 ui），并把该层的 desc（group 的 desc）透传
      const nsName = segPath.split('.').pop() ?? segPath;
      flattened.push({
        kind: 'router',
        name: nsName,
        path: segPath,
        parent: null,
        desc: sub.desc,
        title: sub.title,
        children: sub.children,
      });
    } else {
      flattened.push(...sub.children);
    }
  }
  if (flattened.length === 0) return root;
  return { kind: 'router', name: '', path: '', parent: null, children: flattened };
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
  return segs.join(' ');
}

/** 叶子命令描述（ProcedureMeta.desc） */
function procDesc(def: _AnyProcedureMeta): string {
  return def.desc ?? '';
}

/** 命令节点的单行简介：叶子用 meta.title，父命令用 router 节点.title（均 = desc 首行） */
function nodeTitle(node: _RouteNode): string {
  if (node.kind === 'proc') return node.def.title ?? '';
  return node.title ?? '';
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
  const m = a.length,
    n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1, // 删除
        dp[j - 1] + 1, // 插入
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
function firstUnmatched(root: _RouterNode, args: string[]): { idx: number; parent: _RouterNode } {
  let node = root;
  for (let i = 0; i < args.length; i++) {
    const child = node.children.find((c) => c.name === args[i]);
    if (!child) return { idx: i, parent: node };
    if (child.kind === 'proc') {
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
  const { createInterface } = await import('node:readline');
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: process.stdin.isTTY ? '> ' : undefined,
  });
  if (process.stdin.isTTY) rl.prompt();
  for await (const line of rl) yield line;
  rl.close();
}

/** @internal */
export interface CliConfig<TRouter extends _Router | _AnyProcedureMeta> {
  name: string;
  version?: string;
  /**
   * 命令树来源（二选一）：
   *   · `router`    —— 一棵 api 树（旧的用法，配合 `rpcPrefix`）
   *   · `clients`   —— **推荐**：若干 `createScopedClient` 的返回值，
   *                    每个自带 prefix / cmd / api / transport，CliApp 只做合并与路由
   */
  router?: TRouter;
  /**
   * 若干**已挂载**的模块客户端（`createScopedClient` 的返回值）。
   *
   * 给了它就不需要 `router` / `transport` / `rpcPrefix`：前缀与 api 都在 client 上，
   * 命令段用各自的 `cmd`，调用直接走各自的 `transport`。
   * 同一个模块可以出现在多个 scope 里（不同前缀），命令段用 `cmd` 区分。
   */
  clients?: readonly ScopedClient<any>[];
  /** 旧的单连接（`router` 模式必填；`clients` 模式下忽略） */
  transport?: ClientBinding;
  json?: boolean;
  /**
   * **全局选项表**（进程级 flag：`--json` / `--color` / `-C <dir>` …）。
   *
   * 与 procedure 的 `input` 同一套声明方式 —— 一个 zod object + 字段上的
   * `.cliOption({ short, desc })`，不引入第二套 DSL。声明、解析、help 读同一份 schema，
   * 所以不会再出现「解析里认、help 里没有」（`--json` 以前就是这样漏的）。
   *
   * 注意作用域：全局选项**不会进 RPC 的 input**（命令实现跑在服务端，它看不到）；
   * 需要在客户端消费的值（输出格式/颜色/路径基准）才是它该放的地方。
   * 想影响服务端的值属于 procedure 参数或调用级 meta。
   *
   * 位置：命令段之前或之后都接受（`diy --json task list` ≡ `diy task list --json`）。
   */
  globalOptions?: z.ZodObject<z.ZodRawShape>;
  /**
   * CLI 根路径裁剪：CLI 命令树从这里开始匹配（如 'diy.app' → 命令 `task show`），
   * 但 RPC 调用方法名仍用完整 path（diy.app.task.show）。
   * 支持数组（如 ['diy.app','diy.ui']）合并多个子树到一个命令树根。
   * 默认空 = 全树匹配（命令 `diy app task show`）。
   */
  cliRootPath?: string | string[];
  // 别名 / 弃用**不在这里配**：声明在命令自己身上（`RpcSchema.unary({ alias: 'ls' })`），
  // 由 resolveCliTree 遍历时收集（##518 用户裁：全局表与定义分离，迟早对不上）。
  /**
   * RPC 方法名的**根前缀**（如 `"diy."`）。
   *
   * 为什么需要：`router` 一般由 `apiDef.diy` 这棵**子树**传入，`proc.path` 因此是相对路径
   * （`app.info`）。而 binding 注册的是全名（`diy.app.info`）—— 漏了这层前缀，
   * CLI 会回 `Unknown method: app.info`。
   *
   * 2026-11 之前靠 `RpcSchema.bindNames` 回写的 `meta.name` 兜住；`bindNames` 退役后
   * 必须由调用方显式给出。
   */
  rpcPrefix?: string;
  /**
   * 解析路径参数（`resolvePath` 标记）的基准目录。
   * 必须由入口传**调用者**的 cwd —— 入口脚本普遍先 cd 到应用目录再 exec
   * （diy.sh / bin/diy 都这样），那时 process.cwd() 已不是用户敲命令的目录。
   * 缺省 process.cwd()。
   */
  cwd?: string;
  /**
   * 结果决定退出码（"按名取实体"类命令用：查不到 ≠ 成功）。
   *
   * 为什么不在命令实现里 `process.exit`：handler 跑在 app 进程（CLI 只是 RPC 客户端），
   * 且 `/cli` 端点也复用同一个 CliApp —— 退出语义必须留在**输出层**一处。
   *
   * 契约：**结果打印之后**调用；返回 `undefined` = 不介入（退出码 0），非 0 走 `exit` 钩子
   * （与错误路径同一条收尾：先 flush 两条流再退）。搜索 / 列举类命令**不要**实现它 ——
   * 空结果是正常结果。
   */
  exitCodeOf?: (args: { rpcName: string; result: unknown }) => number | undefined;
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
/**
 * 从命令树收集别名表（##518）。
 *
 * 表来源 = **命令自己的声明**（`RpcSchema.unary({ alias: 'ls' })` / `{ deprecated: 'release publish' }`），
 * 而不是 CLI 的全局配置 —— 全局表与定义分开写，迟早会出现「表里有、代码里没有」。
 *
 * 返回 `键（用户敲的命令段）→ { to（目标命令段）, isDeprecated }`。
 */
function collectAliases(
  router: _Router | _AnyProcedureMeta,
  out = new Map<string, { to: string; isDeprecated: boolean }>(),
): Map<string, { to: string; isDeprecated: boolean }> {
  // 用 `_flattenRouter` 拿「路径 → 命令元信息」：它给出的 path 就是命令段（`traffic.query`），
  // 与用户敲的一致；而 `_RouteNode` 那棵树经过 cliRootPath 裁剪/摊平，拿不到 def。
  for (const [path, meta] of Object.entries(_flattenRouter(router as _Router))) {
    const m = meta as { alias?: string | readonly string[]; deprecated?: string };
    if (m.alias === undefined) continue;
    const segs = path.split('.');
    const aliases = Array.isArray(m.alias) ? m.alias : [m.alias as string];
    for (const alias of aliases) {
      out.set([...segs.slice(0, -1), alias].join(' '), {
        to: segs.join(' '),
        isDeprecated: m.deprecated !== undefined,
      });
    }
  }
  return out;
}

/**
 * `CliApp.inProcess(...)` 的返回值：除了 app 本身，还给出服务端（要断言
 * `listRegistered()`）与一次性的 `run`（注入 out/err/exit 哨兵）。
 */
export interface InProcessCli {
  readonly app: CliApp<any>;
  readonly server: ChannelServerBinding;
  /** 跑一条命令：返回退出码与两路输出（按行，便于断言） */
  run(
    argv: string[],
    opts?: { json?: boolean },
  ): Promise<{ code: number; out: string[]; err: string[] }>;
  listRegistered(): string[];
  dispose(): void;
}

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
  /** 全局选项值校验（默认值/枚举/类型都在这）：错误统一成 CliParseError，退出码同命令用法错 */
  private _validateGlobals(
    schema: z.ZodObject<z.ZodRawShape>,
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    try {
      return schema.parse(values) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof z.ZodError) {
        const msgs = e.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new CliParseError(`全局选项取值错误:\n${msgs}`);
      }
      throw e;
    }
  }

  private config: CliConfig<TRouter>;
  private tree: _RouterNode;
  /** 根命令描述 = router 顶层第一个 group（如 diy）的 desc，替代原 config.desc */
  private rootDesc?: string;
  private _jsonFlag = false;
  /** 全局选项表（构造期从 globalOptions 反射；空表 = 宿主没声明） */
  private _globalTable: GlobalOption[] = [];
  /** 全局选项的已校验值（zod parse 后，带默认值）；命令实现读不到它，只有 CLI 自身消费 */
  private _globals: Record<string, unknown> = {};
  /** 外部强制的 JSON 输出（`inProcess().run({ json })`）：不写进 argv，也不被 parse 覆盖 */
  private _forceJson = false;
  /** clients 模式：顶层命令段 → 对应的 scoped client */
  private _scoped = new Map<string, ScopedClient<any>>();
  /** 实际生效的命令树源（clients 模式 = 合并出来的那棵） */
  private _router!: _Router | _AnyProcedureMeta;

  constructor(config: CliConfig<TRouter>) {
    this.config = config;
    // `clients` 模式：把各 scope 的 api 合并成一棵命令树，顶层命令 = 各 client 的 cmd
    let router: any = config.router;
    if (config.clients?.length) {
      // 命令树 = 各模块 api 的**小孩直接合并**：模块层（`task` / `agent`）由模块自己写死，
      // 这里只做平铺，不重新组装层（不做「任意树 merge」——那会让线上名取决于合并顺序）。
      const merged: Record<string, unknown> = {};
      for (const c of config.clients) {
        const api = c.api as any;
        if (api?._streamMode !== 'group') {
          throw new Error('CliApp: clients 模式要求每个 api 是 RpcSchema.group（自带模块层）');
        }
        for (const [seg, child] of Object.entries(api.children as Record<string, unknown>)) {
          if (seg in merged) {
            // 同一 app 下两个模块抢同一个命令段：启动期就报，别等运行时撞车
            throw new Error(
              `CliApp: 命令段 "${seg}" 被两个模块占用（模块层由模块自己声明，改名请改模块）`,
            );
          }
          merged[seg] = child;
          this._scoped.set(seg, c);
        }
      }
      router = merged;
    }
    if (!router) throw new Error('CliApp: 需要 router 或 clients');
    if (!config.transport && !config.clients?.length) {
      throw new Error('CliApp: router 模式需要 transport（或改用 clients）');
    }
    this._router = router as _Router | _AnyProcedureMeta;
    const isTopGroup = (router as any)?._streamMode === 'group';
    let root: _RouterNode;
    if (isTopGroup) {
      // 最外层是顶层 group（如 diy）：它即根命令，desc 直接作为根描述，children 作为命令树
      const group = config.router as any;
      this.rootDesc = group.desc;
      root = _buildRouteTree(group.children as _Router);
    } else {
      root = _buildRouteTree(router as _Router);
      // 根命令描述 = 顶层第一个 group/命名空间节点（如 diy）的 desc。
      // clients 模式下没有"根 group"这回事（顶层是各 scope 的命令段），
      // 取第一个 scope 的 desc 当根描述会把它的说明串到根上 —— 干脆不设。
      if (this._scoped.size === 0) {
        const topRouter = root.children.find((c) => c.kind === 'router');
        this.rootDesc = topRouter ? (topRouter as _RouterNode).desc : undefined;
      }
    }
    this.tree = resolveCliTree(root, config.cliRootPath);
    this._backfillParent(this.tree, null);
    // 全局表在构造期就反射出来：下面的重名检测要用（parse 里会再取一次，幂等）
    this._globalTable = globalOptionTable(config.globalOptions);
    this._assertNoGlobalOptionClash();
  }

  private _backfillParent(node: _RouteNode, parent: _RouterNode | null): void {
    (node as { parent: _RouterNode | null }).parent = parent;
    if (node.kind === 'router') {
      for (const c of node.children) this._backfillParent(c, node);
    }
  }

  /**
   * 全局选项与**命令级**选项重名检测（构造期，一次）。
   *
   * 为什么必须查：`scanGlobalOptions` 在命令解析**之前**跑并吃掉命中的 token ——
   * 于是命令自己那个同名 option 永远拿不到值，且不报任何错（静默失效）。
   * 例：将来给全局表加 `-C/--cwd`，`diy flow run --cwd /x` 的 `--cwd` 会被全局吞掉。
   */
  private _assertNoGlobalOptionClash(): void {
    if (this._globalTable.length === 0) return;
    const globals = new Set(this._globalTable.map((o) => o.long));
    const clash: string[] = [];
    for (const [path, meta] of Object.entries(_flattenRouter(this._router))) {
      const shape = (meta.inputSchema as unknown as { shape?: Record<string, unknown> } | undefined)
        ?.shape;
      if (!shape) continue;
      for (const [key, field] of Object.entries(shape)) {
        const m = _getCliOptionMeta(field as object);
        if (!m || m.callerCwd) continue; // callerCwd 不是用户可敲的选项，不占名字
        if (globals.has(kebabOf(key))) clash.push(`${path} --${kebabOf(key)}`);
      }
    }
    if (clash.length > 0) {
      throw new Error(
        `全局选项与命令选项重名（命令端会被全局静默吞掉）：\n  ${clash.join('\n  ')}`,
      );
    }
  }

  async parse(rawArgv: string[]): Promise<void> {
    // ── 全局选项（进程级 flag）：命令段之前或之后都接受 ──
    // 扫描时只剥命中的 token，未命中原样留下、顺序不变 —— 后面照旧走
    // _routeResolve + parseArgv，命令侧一行都不用改。
    this._globalTable = globalOptionTable(this.config.globalOptions);
    const hasTable = this._globalTable.length > 0;
    let scanned: { values: Record<string, unknown>; rest: string[] };
    try {
      scanned = hasTable
        ? scanGlobalOptions(this._globalTable, rawArgv)
        : // 未声明表的老宿主：保留原来的 `--json` 特例（行为与之前逐字一致）
          { values: {}, rest: rawArgv.filter((a) => a !== '--json') };
      this._globals =
        hasTable && this.config.globalOptions
          ? this._validateGlobals(this.config.globalOptions, scanned.values)
          : scanned.values;
    } catch (err: unknown) {
      // 全局选项的用法错误：与命令参数同一条出口（打印后 exit 2），不走命令帮助
      if (err instanceof CliParseError) {
        this._printErr(err.message);
        this._exit(2);
      }
      throw err;
    }
    // `--json` 的消费点统一：表里声明了就看值，没表就看老姿势在不在。
    // `_forceJson` 是 `inProcess().run(argv, { json: true })` 用的强制开关 —— 这里必须
    // 并进来，否则 parse 每次都重算会把外部设定覆盖掉（实测：传了 json:true 仍输出表格）。
    this._jsonFlag =
      this._forceJson || this._globals['json'] === true || rawArgv.includes('--json');
    const argv = scanned.rest;

    // ── 别名 / 弃用改写（##518）──
    // 表的来源是**命令自己的声明**（meta.alias / meta.deprecated），不是外部配置。
    for (const [from, { to, isDeprecated }] of collectAliases(this._router)) {
      const fromSegs = from.split(' ').filter(Boolean);
      if (!fromSegs.every((seg, i) => argv[i] === seg)) continue;
      argv.splice(0, fromSegs.length, ...to.split(' '));
      if (isDeprecated) this._printErr(`⚠ 命令已改名：${from} → ${to}（旧名下个版本移除）`);
      break;
    }

    // 剥离末尾 --help/-h：`diy <命令> --help` 显示该命令自身帮助（父命令或叶子），非根帮助
    let helpRequested = false;
    if (argv.length > 1 && (argv[argv.length - 1] === '--help' || argv[argv.length - 1] === '-h')) {
      helpRequested = true;
      argv.pop();
    }

    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      this.showHelp();
      return;
    }
    if (argv[0] === '--version' || argv[0] === '-V') {
      if (this.config.version) this._print(this.config.version);
      return;
    }
    if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
      // `diy help <subcommand>` 等价 `diy <subcommand> --help`
      if (argv[0] === 'help' && argv.length > 1) {
        const rest = argv.slice(1);
        const sub = _routeResolve(this.tree, rest);
        if (sub) {
          this.showNodeHelp(sub);
          return;
        }
        this._printErr(`Unknown command: ${rest.join(' ')}`);
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

    if (!resolved || resolved.kind !== 'proc') {
      if (resolved && resolved.kind === 'router') {
        // 父命令（group）：无子命令时显示自身帮助（子命令列表），而非根帮助
        this.showNodeHelp(resolved);
        return;
      } else {
        // resolved 为 null = 某段在树上匹配不到。报**第一个失败段**（含前缀路径），
        // 而非 argv[0]：`ui view open …` 中 ui/view 都合法，只有 open 不存在，
        // 报 "Unknown command: ui" 会把合法前缀当未知命令，建议器还会回显自己（任务 205）。
        const { idx, parent } = firstUnmatched(this.tree, argv);
        const input = argv.slice(0, idx + 1).join(' ');
        const sugg = suggestCommand(parent.children, argv[idx] ?? '');
        if (sugg.length > 0) {
          this._printErr(`Unknown command: ${input}`);
          this._printErr(`Did you mean: ${sugg.join(', ')}?`);
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
    while (walk && walk.parent && walk.parent.path !== '') {
      walk = walk.parent;
      depth++;
    }
    const remaining = argv.slice(depth);

    const desc = procDesc(def);
    // 路由键用 RPC 全名（def.name，router() 回写）。当 router 是最外层 group（如 diy）被解包时，
    // proc.path 会丢失 "diy." 前缀，与 binding 注册的全名不匹配，故路由一律用 def.name。
    // clients 模式：线上名 = app 前缀 + 完整命令路径（模块层就在 path 里）
    const scopeCmd = proc.path.split('.')[0] ?? '';
    const scoped = this._scoped.get(scopeCmd);
    const rpcName = scoped
      ? `${scoped.prefix}.${proc.path}`
      : (def.name ?? `${this.config.rpcPrefix ?? ''}${proc.path}`);

    /**
     * 结果派生的退出码：在 try **之外**退出。
     * 若在 try 里调 `_exit`，注入的 exit 钩子抛出的哨兵会被下面的 `catch` 当成运行错误，
     * 再多打一行 `Error: cli exit N`（实测）。故只在这里记下，try/catch 结束后再走 exit 钩子。
     */
    let resultExitCode: number | undefined;
    try {
      const { input, helpRequested } = parseArgv(def, remaining, { cwd: this.config.cwd });

      if (helpRequested) {
        // 命令级 Usage 用裁剪后的短命令名（用户实际输入的命令），非 RPC 全名
        const shortCmd = commandName(proc);
        const args = fmtUsageArgs(def);
        this._print(`Usage: ${this.config.name} ${shortCmd} [options]${args ? ` ${args}` : ''}`);
        const help = generateHelp(def, shortCmd, desc);
        if (help) this._print('\n' + help);
        return;
      }

      const tx = (scoped?.transport ?? this.config.transport)!;
      const mode = def._streamMode as string;

      if (mode === 'server') {
        const handle = await tx.serverStream(rpcName, { input });
        for await (const chunk of handle as any) {
          const line = typeof chunk === 'object' ? JSON.stringify(chunk) : String(chunk);
          this._print(line);
        }
      } else if (mode === 'client') {
        const lines = stdinAsync();
        const result = await tx.clientStream(rpcName, { input }, lines as any);
        if (result === undefined) return;
        const line = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
        this._print(line);
      } else if (mode === 'bidi') {
        const handle = await tx.bidiStream(rpcName, { input }, stdinAsync() as any);
        for await (const chunk of handle as any) {
          const line = typeof chunk === 'object' ? JSON.stringify(chunk) : String(chunk);
          this._print(line);
        }
      } else {
        const result = await tx.invoke(rpcName, { input });
        if (result === undefined) return;
        if (this._jsonFlag || this.config.json) {
          this._print(JSON.stringify({ ok: true, data: result }));
        } else {
          const output =
            typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
          this._print(output);
        }
        // 按名取实体查不到 ⇒ 非零退出（`get X && ...` 不许对不存在的东西说通过）。
        // 在**打印之后**判：人要能看见 `resolved: []` 与 notes 再拿退出码。
        resultExitCode = this.config.exitCodeOf?.({ rpcName, result });
      }
    } catch (err: unknown) {
      if (err instanceof CliParseError) {
        this._printErr(err.message);
        const shortCmd = commandName(proc);
        const help = generateHelp(def, shortCmd, desc);
        if (help) this._printErr('\n' + help);
        this._exit(2); // 用法错误（CLIG：usage error = 2）
      }
      this._printErr(`Error: ${err instanceof Error ? err.message : String(err)}`);
      this._exit(1);
    }

    // 结果派生的非零退出（放在 try 外：见上方 resultExitCode 注释）
    if (resultExitCode !== undefined && resultExitCode !== 0) this._exit(resultExitCode);
  }

  /** 单个命令帮助：叶子命令显示参数 help；父命令显示自身 desc + 子命令列表 */
  showNodeHelp(node: _RouteNode): void {
    if (node.kind === 'proc') {
      const shortCmd = commandName(node);
      const args = fmtUsageArgs(node.def);
      this._print(`Usage: ${this.config.name} ${shortCmd} [options]${args ? ` ${args}` : ''}`);
      const help = generateHelp(node.def, shortCmd, procDesc(node.def));
      if (help) this._print('\n' + help);
      return;
    }
    // 父命令（router）：显示自身 desc + 子命令列表
    const lines: string[] = [];
    const shortCmd = commandName(node);
    lines.push(`Usage: ${this.config.name} ${shortCmd} <subcommand> [options]`);
    if (node.desc) lines.push('', node.desc);
    if (node.children.length > 0) lines.push('', 'Commands:');
    emitCommandList(
      lines,
      node.children.map((child) => ({ name: child.name, desc: nodeTitle(child) })),
    );
    this._print(lines.join('\n'));
  }

  // ═══════════════════════════════════════════════════
  //  工厂：两种部署形态各一个入口（测试里最常用 inProcess）
  // ═══════════════════════════════════════════════════

  /**
   * **进程外**（连远端 app）：clients 由调用方建好（`createScopedClient`）。
   *
   * ```ts
   * const cli = CliApp.remote({ name: 'diy', version, clients: [task, agent] });
   * await cli.parse(process.argv.slice(2));
   * ```
   */
  static remote(opts: {
    name: string;
    version?: string;
    clients: readonly ScopedClient<any>[];
    json?: boolean;
    cwd?: string;
    exitCodeOf?: CliConfig<any>['exitCodeOf'];
    out?: (line: string) => void;
    err?: (line: string) => void;
    exit?: (code: number) => void;
  }): CliApp<any> {
    return new CliApp<any>({ ...opts });
  }

  /**
   * **进程内**（无网络，测试 / 嵌入式用）：给 api + handlers，内部自己起 mem 通道与服务端。
   *
   * ```ts
   * const cli = CliApp.inProcess({
   *   name: 'demo',
   *   scopes: [{ prefix: 'demo.task', cmd: 'task', api: taskApi, handlers: { list, create } }],
   * });
   * const r = await cli.run(['task', 'list', '--json']);   // { code, out, err }
   * ```
   *
   * 为什么不直接用 `new CliApp`：那样每个测试都要手写 out/err/exit 三个哨兵，
   * 还要自己搭 mem 通道和 server —— 这类样板与「要验的行为」无关。
   */
  static inProcess(opts: {
    name: string;
    version?: string;
    scopes: readonly {
      /** 应用前缀（`diy`）：多 app 时同前缀可挂多个模块 */
      prefix: string;
      /** 模块 api：必须是 group，模块层（`task` / `agent`）写在它里面 */
      api: any;
      handlers: any;
    }[];
    json?: boolean;
    cwd?: string;
    /** 全局选项表（与线上同一份，见 `CliConfig.globalOptions`） */
    globalOptions?: z.ZodObject<z.ZodRawShape>;
    exitCodeOf?: CliConfig<any>['exitCodeOf'];
  }): InProcessCli {
    const { serverTx, clientTx } = createMemTransportPair();
    const server = new ChannelServerBinding(serverTx);
    const client = new ChannelClientBinding(clientTx);
    const clients = opts.scopes.map((sc) => {
      mountService(server, { prefix: sc.prefix, api: sc.api, handlers: sc.handlers });
      return createScopedClient({ api: sc.api, client, prefix: sc.prefix });
    });

    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    class Exit extends Error {
      constructor(public readonly code: number) {
        super(`cli exit ${code}`);
      }
    }
    const app = new CliApp<any>({
      name: opts.name,
      version: opts.version,
      clients,
      ...(opts.json !== undefined ? { json: opts.json } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.globalOptions !== undefined ? { globalOptions: opts.globalOptions } : {}),
      ...(opts.exitCodeOf !== undefined ? { exitCodeOf: opts.exitCodeOf } : {}),
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      exit: (c: number): never => {
        code = c;
        throw new Exit(c);
      },
    });

    return {
      app,
      server,
      listRegistered: () => server.listRegistered(),
      run: async (argv: string[], runOpts?: { json?: boolean }) => {
        out.length = 0;
        err.length = 0;
        code = 0;
        const prevJson = app['_forceJson'] as boolean;
        if (runOpts?.json !== undefined) app['_forceJson'] = runOpts.json;
        try {
          await app.parse(argv);
        } catch (e) {
          if (!(e instanceof Exit)) throw e;
        } finally {
          if (runOpts?.json !== undefined) app['_forceJson'] = prevJson;
        }
        return { code, out: out.slice(), err: err.slice() };
      },
      dispose: () => {
        client.dispose();
        server.destroy();
      },
    };
  }

  showHelp(): void {
    const lines: string[] = [];
    lines.push(`Usage: ${this.config.name} <command> [options]`);
    if (this.rootDesc) lines.push('', this.rootDesc);

    // 顶层直接显示每个子命令（proc 或 router 父命令），desc 取第一行
    const items: { name: string; desc: string; mode: string }[] = [];

    for (const child of this.tree.children) {
      const name = child.name;
      if (child.kind === 'proc') {
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
          mode: '',
        });
      }
    }

    if (items.length > 0) lines.push('', 'Commands:');

    emitCommandList(
      lines,
      items.map(({ name, desc, mode }) => {
        const modeTag = mode && mode !== 'unary' ? ` (${mode})` : '';
        return { name: name + modeTag, desc };
      }),
    );

    lines.push('', 'Options:');
    // 全局选项与解析同源（同一张表）：以前 `--json` 解析认、help 不列，就是这么漏的
    const optRows: [string, string][] = renderGlobalOptions(this._globalTable);
    optRows.push(['-h, --help', 'Show help']);
    if (this.config.version) optRows.push(['-V, --version', 'Show version']);
    const w = optRows.reduce((m, [l]) => Math.max(m, l.length), 0);
    for (const [l, r] of optRows) lines.push(r ? `  ${l.padEnd(w)}  ${r}` : `  ${l}`);

    this._print(lines.join('\n'));
  }
}
