// lib/ui-state.ts — 界面状态（视图 cache）字段池
//
// 定位：localStorage **全部是「可清理的视图 cache」**——丢失无数据损失（滚动位置、
// 展开状态、面板宽度、聊天密度、主题偏好等），是低重要性数据，可以随时清空。
// 与业务数据（$DIY_HOME 文件、任务 frontmatter）严格分离：一旦丢失会造成
// 数据/配置损失的，一律不进 localStorage（如任务模型选择 → 任务 frontmatter）。
//
// 唯一入口：Caches 对象。属性名 = 存储 key 完全一致（`diy_<模块>_<组件>_<用途>`，
// 下划线分隔），grep / devtools 反查零转换（key 即属性名，搜 key 命中所有出现）。
// 不保留 cache/ui 段：localStorage 内没有非 cache 数据，段位冗余。
//
// 模式：field(key, spec) 扁平字段，每个字段 = key + 类型 + 反序列化/校验 + 默认值，
// 统一 .get()/.set()/.reset()。收益：
//   1. 类型化读写：调用方不再各自 Number()/JSON.parse/cast
//   2. 约束集中：范围校验（density 1-4、宽度 360-1000）定义即生效
//   3. 与存储解耦：未来换 IndexedDB/$DIY_HOME 文件只改本文件内部
// 不引入 zod：zod 的运行时校验 + 类型派生服务于跨进程契约（RPC）；视图 cache
// 是进程内单端标量字段，轻量 parse 即可。

export type DiyTheme = "dark" | "light";

// ─── 聊天信息密度（枚举：值即存储值，自解释，替代裸数字） ─────────

export const DENSITY_LEVEL = {
  OUTLINE: "outline", // L1 脉络：user 全文 + assistant 单行，过程隐藏
  READ: "read", // L2 阅读：正文全文 + 过程压成发丝线（默认）
  AUDIT: "audit", // L3 审计：过程标题行可展开
  FORENSIC: "forensic", // L4 取证：全部展开
} as const;
export type Density = (typeof DENSITY_LEVEL)[keyof typeof DENSITY_LEVEL];
/** 由简到繁的顺序（工具条渲染顺序） */
export const DENSITY_VALUES: readonly Density[] = [
  DENSITY_LEVEL.OUTLINE,
  DENSITY_LEVEL.READ,
  DENSITY_LEVEL.AUDIT,
  DENSITY_LEVEL.FORENSIC,
];
/** 旧版数字存储（1-4）→ 语义值兼容 */
const LEGACY_DENSITY: Record<string, Density> = {
  "1": DENSITY_LEVEL.OUTLINE,
  "2": DENSITY_LEVEL.READ,
  "3": DENSITY_LEVEL.AUDIT,
  "4": DENSITY_LEVEL.FORENSIC,
};

// ─── 缓存字段（get/set/reset，内部吞异常 + 留痕） ─────────────

export interface CacheField<T> {
  readonly key: string;
  readonly defaultValue: T;
  get(): T;
  set(v: T): void;
  reset(): void;
}

interface CacheFieldSpec<T> {
  /** 反序列化 + 校验；返回 null 表示无效 → 回默认值 */
  parse?: (raw: string) => T | null;
  serialize: (v: T) => string;
  defaultValue: T;
}

function field<T>(key: string, spec: CacheFieldSpec<T>): CacheField<T> {
  return {
    key,
    defaultValue: spec.defaultValue,
    get() {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return spec.defaultValue;
        const v = spec.parse ? spec.parse(raw) : (raw as unknown as T);
        if (v === null) {
          console.warn(`[ui-state] ${key} 解析失败，回默认值:`, raw);
          return spec.defaultValue;
        }
        return v;
      } catch (e) {
        console.warn(`[ui-state] ${key} 读取失败，回默认值:`, e);
        return spec.defaultValue;
      }
    },
    set(v) {
      try {
        localStorage.setItem(key, spec.serialize(v));
      } catch (e) {
        console.warn(`[ui-state] ${key} 写入失败（忽略，仅影响下次默认值）:`, e);
      }
    },
    reset() {
      try {
        localStorage.removeItem(key);
      } catch {
        /* 存储不可用忽略 */
      }
    },
  };
}

// ─── 字段池（属性名 = key 完全一致，单一事实来源） ─────────

/** 视图 cache 字段池：Caches.<模块>_<组件>_<用途>.get()/.set()/.reset() */
export const Caches = {
  /** 任务树：展开节点集 */
  diy_task_tree_expanded: field("diy_task_tree_expanded", {
    parse: (raw) => {
      try {
        const a = JSON.parse(raw);
        return Array.isArray(a) ? (a.filter((x) => typeof x === "string") as string[]) : null;
      } catch {
        return null;
      }
    },
    serialize: (v) => JSON.stringify(v),
    defaultValue: [] as string[],
  }),
  /** 任务树：滚动容器 scrollTop（>=1 才恢复，0 表示未滚动过） */
  diy_task_tree_scroll: field("diy_task_tree_scroll", {
    parse: (raw) => {
      const v = Number(raw);
      return Number.isFinite(v) && v >= 1 ? v : null;
    },
    serialize: (v) => String(v),
    defaultValue: 0,
  }),
  /** 任务详情面板宽度（px，范围 360-1000） */
  diy_task_detail_width: field("diy_task_detail_width", {
    parse: (raw) => {
      const v = Number(raw);
      return v >= 360 && v <= 1000 ? v : null;
    },
    serialize: (v) => String(v),
    defaultValue: 560,
  }),
  /** 本地聊天密度（枚举语义值 outline/read/audit/forensic，兼容旧数字 1-4） */
  diy_chat_density: field<Density>("diy_chat_density", {
    parse: (raw) => {
      if (DENSITY_VALUES.includes(raw as Density)) return raw as Density;
      // 旧版数字（1-4）兼容
      return LEGACY_DENSITY[raw] ?? null;
    },
    serialize: (v) => v,
    defaultValue: DENSITY_LEVEL.READ,
  }),
  /** 主题偏好（白名单 dark/light） */
  diy_app_theme: field<DiyTheme>("diy_app_theme", {
    parse: (raw) => (raw === "dark" || raw === "light" ? raw : null),
    serialize: (v) => v,
    defaultValue: "dark",
  }),
};

/** 已注册字段（clearUiCache 枚举用：字段池即全部，新增字段自动纳入） */
const allFields: CacheField<unknown>[] = Object.values(Caches);

/** 历史上散落的旧 key（历次命名迭代）：清理时一并捎走，避免升级残留 */
const LEGACY_KEYS = [
  // 带 cache 段的下划线版（diy_cache_ui_*）
  "diy_cache_ui_task_tree_expanded",
  "diy_cache_ui_task_tree_scroll",
  "diy_cache_ui_task_detail_width",
  "diy_cache_ui_chat_density",
  "diy_cache_ui_app_theme",
  // 点分路径版（diy.cache.ui.* / diy.ui.cache.*）
  "diy.cache.ui.task.tree.expanded",
  "diy.cache.ui.task.tree.scroll",
  "diy.cache.ui.task.detail.width",
  "diy.cache.ui.chat.density",
  "diy.cache.ui.app.theme",
  "diy.ui.cache.task-tree.expanded",
  "diy.ui.cache.task-tree.scroll",
  "diy.ui.cache.detail-width",
  "diy.ui.cache.chat-density",
  "diy.ui.cache.theme",
  // 最早的裸 key
  "diy-task-tree-expanded",
  "diy-task-tree-scroll",
  "diy-detail-width",
  "diy-local-density",
  "diy-theme",
];

/** 清空全部视图 cache：注册字段池 + 前缀兜底（防未来直写漏注册）+ 旧 key 兼容。返回删除条数。 */
export function clearUiCache(): number {
  let n = 0;
  const del = (k: string) => {
    try {
      if (localStorage.getItem(k) !== null) {
        localStorage.removeItem(k);
        n++;
      }
    } catch {
      /* 存储不可用忽略 */
    }
  };
  const keys = new Set(allFields.map((f) => f.key));
  // 先收集再删：枚举 localStorage.key(i) 时删除会使下标前移
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("diy_")) keys.add(k);
  }
  for (const k of keys) del(k);
  for (const k of LEGACY_KEYS) del(k);
  return n;
}