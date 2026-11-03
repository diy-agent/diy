#!/usr/bin/env node
/**
 * pi-tui 接口检查工具
 *
 * 从 @mariozechner/pi-tui 导入所有公开组件类，检查构造函数签名、
 * 公开方法签名、以及是否实现 Component 接口。
 * 输出为 TypeScript 类型定义风格，便于直接复制到 wrapper 代码。
 *
 * 用法:
 *   npx tsx tools/check-pitui.ts                    # 检查所有组件
 *   npx tsx tools/check-pitui.ts --class Text       # 过滤单个类
 *   npx tsx tools/check-pitui.ts --list             # 列出所有类名
 *   npx tsx tools/check-pitui.ts --methods Text     # 查看方法签名
 *   npx tsx tools/check-pitui.ts --all > docs/ref-pitui-interfaces.md  # 生成完整参考
 */
import * as pi from "@mariozechner/pi-tui";
import { isFocusable, type Component } from "@mariozechner/pi-tui";

// ── 默认组件清单（按设计文档 §13.14） ──────────────────────
const DEFAULT_COMPONENTS: Record<string, string> = {
  // Core
  Container: "Container",
  TUI: "TUI",
  // Components
  Text: "Text",
  TruncatedText: "TruncatedText",
  Box: "Box",
  Input: "Input",
  Editor: "Editor",
  SelectList: "SelectList",
  SettingsList: "SettingsList",
  Spacer: "Spacer",
  Markdown: "Markdown",
  Image: "Image",
  Loader: "Loader",
  CancellableLoader: "CancellableLoader",
};

// Component 接口必须实现的方法
const COMPONENT_IFACE = [
  "render",
  "handleInput",
  "wantsKeyRelease",
  "invalidate",
] as const;

// 基类通用方法排除（Object.prototype 等）
const BASE_EXCLUDE = new Set([
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__proto__",
]);

// 方法名前缀排除
const PREFIX_EXCLUDE = ["_"];

// 运行时方法排除：只排除那些写在 js prototype 上但不在 .d.ts 公开声明中的内部实现。
// 保守列表，宁可多漏也不要多杀。
const INTERNAL_EXCLUDE = new Set([
  // Box 运行时实现（.d.ts 无）
  "applyBg",
  "invalidateCache",
  "matchCache",
  // CancellableLoader 内部
  "dispose",
]);

function shouldExcludeMethod(name: string): boolean {
  if (BASE_EXCLUDE.has(name)) return true;
  if (INTERNAL_EXCLUDE.has(name)) return true;
  for (const prefix of PREFIX_EXCLUDE) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

// ── 辅助函数 ──────────────────────────────────────────────

/** 获取构造函数参数签名的文本表示 */
function getConstructorSignature(cls: any, className: string): string {
  const src = cls.toString();
  // 匹配 constructor(... 或类名(... (类表达式)
  const ctorMatch = src.match(/(?:constructor|class\s+\w+)\s*\(([^)]*)\)/);
  if (ctorMatch && ctorMatch[1]) {
    const params = ctorMatch[1].trim();
    return `constructor(${params})`;
  }
  // 回退：用 .length 推参数个数
  const paramCount = cls.length;
  if (paramCount > 0) {
    const generic = Array.from(
      { length: paramCount },
      (_, i) => `arg${i}`,
    ).join(", ");
    return `constructor(${generic}) // 推断 ${paramCount} 参数, 无源码签名`;
  }
  return `constructor()`;
}

/** 获取公开方法签名列表 */
function getPublicMethods(cls: any): string[] {
  const proto = cls.prototype;
  const own = new Set<string>();

  // 收集原型链上的方法（去重）
  const methods: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (shouldExcludeMethod(name)) continue;
    if (own.has(name)) continue;
    own.add(name);

    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc) continue;

    // getter/setter
    if (desc.get || desc.set) {
      if (desc.get) methods.push(`get ${name}()`);
      if (desc.set) methods.push(`set ${name}(v)`);
      continue;
    }

    if (typeof desc.value === "function") {
      methods.push(name);
    }
  }
  return methods.sort();
}

/** 检查是否实现 Component 接口 */
function checkComponentInterface(cls: any): Record<string, boolean | string> {
  const proto = cls.prototype;
  return {
    render: typeof proto.render === "function",
    handleInput: typeof proto.handleInput === "function",
    wantsKeyRelease: "wantsKeyRelease" in proto,
    invalidate: typeof proto.invalidate === "function",
    focused: "focused" in proto ? "Focusable" : "-",
  };
}

/** 格式化方法签名为可以复制的 TS 风格 */
function formatMethod(cls: any, methodName: string): string {
  const proto = cls.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, methodName);
  if (!desc) return `${methodName}(...): unknown`;

  if (desc.get) return `get ${methodName}(): unknown`;
  if (desc.set) return `set ${methodName}(v: unknown): void`;

  const fn = desc.value as (...args: any[]) => any;
  // 尝试从源码提取签名
  const src = fn.toString();
  const match = src.match(/^[^(]*\(([^)]*)\)/);
  if (match) {
    const params = match[1].trim();
    // 去除 this 参数、带类型注解的参数简化为名字
    const clean = params
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "this" && p.length > 0)
      .join(", ");
    return `${methodName}(${clean}): void`;
  }
  return `${methodName}(...args: any[]): unknown`;
}

// ── 输出函数 ──────────────────────────────────────────────

/** 单类详细输出 */
function printClass(cls: any, className: string): void {
  console.log(`\n## ${className}`);
  console.log();

  // 1. 构造函数签名
  console.log("### 构造函数签名");
  console.log("```typescript");
  console.log(getConstructorSignature(cls, className));
  console.log("```");
  console.log();

  // 2. 公开方法签名
  console.log("### 公开方法签名");
  const methods = getPublicMethods(cls);
  if (methods.length > 0) {
    console.log("```typescript");
    for (const m of methods) {
      console.log(formatMethod(cls, m));
    }
    console.log("```");
  } else {
    console.log("_(无公开方法)_");
  }
  console.log();

  // 3. Component 接口实现
  console.log("### Component 接口");
  const iface = checkComponentInterface(cls);
  console.log("| 方法 | 实现 |");
  console.log("|------|------|");
  for (const key of COMPONENT_IFACE) {
    console.log(`| \`${key}\` | ${iface[key] ? "✅" : "❌"} |`);
  }
  console.log(`| \`focused\` (Focusable) | ${iface.focused} |`);
  console.log();

  // 4. 是否有 children (容器类)
  if ("children" in cls.prototype) {
    console.log("### 子组件管理（Container）");
    const childrenDesc = Object.getOwnPropertyDescriptor(
      cls.prototype,
      "children",
    );
    if (childrenDesc) {
      console.log("- **children**: `Component[]`");
    }
    const containerMethods = ["addChild", "removeChild", "clear"].filter((m) =>
      methods.includes(m),
    );
    if (containerMethods.length > 0) {
      console.log(
        `- 方法: ${containerMethods.map((m) => `\`${m}()\``).join(", ")}`,
      );
    }
    console.log();
  }
}

/** 列出所有可用组件 */
function listComponents(): void {
  console.log("\n可用的 pi-tui 组件类:\n");
  // 实际可用的（在 DEFAULT_COMPONENTS 中且可 import 的）
  for (const name of Object.keys(DEFAULT_COMPONENTS).sort()) {
    const cls = (pi as any)[name];
    const available = typeof cls === "function" ? "✓" : "✗";
    console.log(`  ${available} ${name}`);
  }
  console.log();
}

// ── 入口 ──────────────────────────────────────────────────

function parseArgs(): {
  class?: string;
  list?: boolean;
  methods?: string;
  all?: boolean;
} {
  const args = process.argv.slice(2);
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--class" || args[i] === "-c") {
      result.class = args[++i];
    } else if (args[i] === "--list" || args[i] === "-l") {
      result.list = true;
    } else if (args[i] === "--methods" || args[i] === "-m") {
      result.methods = args[++i];
    } else if (args[i] === "--all") {
      result.all = true;
    }
  }
  return result;
}

function getClass(name: string): { cls: any; className: string } | null {
  // 精确匹配
  const cls = (pi as any)[name];
  if (typeof cls === "function") return { cls, className: name };

  // 模糊匹配
  const lower = name.toLowerCase();
  for (const n of Object.keys(DEFAULT_COMPONENTS)) {
    if (n.toLowerCase().includes(lower)) {
      const c = (pi as any)[n];
      if (typeof c === "function") return { cls: c, className: n };
    }
  }
  return null;
}

function main(): void {
  const opts = parseArgs();

  if (opts.list) {
    listComponents();
    return;
  }

  if (opts.methods) {
    const found = getClass(opts.methods);
    if (!found) {
      console.error(`❌ 未找到类: ${opts.methods}`);
      process.exit(1);
    }
    console.log(`\n# ${found.className} 方法签名\n`);
    for (const m of getPublicMethods(found.cls)) {
      console.log(`  ${formatMethod(found.cls, m)}`);
    }
    return;
  }

  if (opts.class) {
    const found = getClass(opts.class);
    if (!found) {
      console.error(`❌ 未找到类: ${opts.class}`);
      process.exit(1);
    }
    printClass(found.cls, found.className);
    return;
  }

  // 默认或 --all：检查所有组件
  console.log("# pi-tui 接口参考");
  console.log(`> 自动生成于 ${new Date().toISOString()}`);
  console.log(`> 来源: @mariozechner/pi-tui`);
  console.log();

  // 先输出 Component 接口定义
  console.log("## Component 接口");
  console.log("```typescript");
  console.log("interface Component {");
  console.log("  render(width: number): string[];");
  console.log("  handleInput?(data: string): void;");
  console.log("  wantsKeyRelease?: boolean;");
  console.log("  invalidate(): void;");
  console.log("}");
  console.log("```");
  console.log();

  for (const name of Object.keys(DEFAULT_COMPONENTS)) {
    const cls = (pi as any)[name];
    if (typeof cls === "function") {
      printClass(cls, name);
    }
  }
}

main();
