// components/ModelConfigPage.tsx — 模型 provider 配置（直译 $DIY_HOME/model.yaml）
//
// 两组卡片：std = models.dev snapshot provider（spec 只读）；custom = providers.custom.yaml
// （baseUrl / provider 级默认面(npm) 可编辑）。卡片内：账号 → 模型清单（勾选启用）→ [保存][移除]。
// 模型清单不显示「面」列：面由 npm/端点自动解析，对用户没意义（provider 级默认面仍可改）。
// 价格：每行填 base 档（in/out/读/写 + 基准标签）；「时段档」展开后可加 utc-range 档
// （峰/谷价 + 可选日历 = 工作日限定，UI 只列内置日历）—— 变换逻辑在 shared/cost-edit.ts。
// 「添加 provider」即时落盘（否则 read 拿不到新 provider 的模型清单）；其余编辑攒 dirty → 每卡 [保存]。
//
// 交互约定（对齐 dsh 模型设置页）：
//   · 添加 provider 带**搜索框**（snapshot 有上百家，不能靠滚动找）
//   · 密钥由人输入：输入框只给**占位提示**（env[0]），不预填 `$VAR`
//   · 提供 [测试] 按钮（拉 /models 验连通 + 拿清单）
//   · custom 模型不支持「覆盖」models.dev 参数（全球共用），故无覆盖列
import { For, Index, Show, createMemo, createSignal, onMount } from "solid-js";
import type {
  Account,
  CalendarChoice,
  CatalogEntry,
  Cost,
  CostTier,
  CustomSpecsFile,
  LlmConfigView,
  ModelConfigFile,
  ProviderConfig,
  SpecProvider,
} from "../../shared/model-config";
import { filterAllows, npmOfEndpoints } from "../../shared/model-config";
import type { CostField } from "../../shared/cost-edit";
import { addUtcRangeTier, patchUtcRange, removeTier, setBaseLabel, setBasePrice, tierIssues, utcRangeSlots } from "../../shared/cost-edit";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";

type FilterMode = "all" | "include" | "exclude";

function modeOf(f: ProviderConfig["filter"]): FilterMode {
  if (!f || (f.include.length === 0 && f.exclude.length === 0)) return "all";
  return f.include.length > 0 ? "include" : "exclude";
}

function fmtK(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** npm（面）可选项：只认这两家（见 shared/models.ts NPM_FACE）。值是 npm 包名。 */
const FACE_OPTIONS = [
  { npm: "@ai-sdk/openai-compatible", label: "chat（/chat/completions）" },
  { npm: "@ai-sdk/openai", label: "responses（/responses）" },
] as const;

/** 单价输入框（key 是 spec 的 snake_case；$/1M tokens）。逐档价格复用同一组控件。 */
const COST_FIELDS: { key: CostField; ph: string; label: string }[] = [
  { key: "input", ph: "in", label: "非缓存输入 $/1M（必填）" },
  { key: "output", ph: "out", label: "输出 $/1M（必填）" },
  { key: "cache_read", ph: "读", label: "缓存读 $/1M（可选）" },
  { key: "cache_write", ph: "写", label: "缓存写 $/1M（可选）" },
];

export function ModelConfigPage() {
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [view, setView] = createSignal<LlmConfigView | null>(null);
  const [file, setFile] = createSignal<ModelConfigFile>({ stdProviders: {}, customProviders: {} });
  const [specs, setSpecs] = createSignal<CustomSpecsFile>({});
  const [query, setQuery] = createSignal("");
  const [showNewCustom, setShowNewCustom] = createSignal(false);

  const reload = async () => {
    try {
      const v = await diyService.diy.llmConfig.read({});
      setView(v);
      setFile(structuredClone(v.modelFile));
      setSpecs(structuredClone(v.customSpecs));
      setDirty(false);
      // read 降级（配置结构非法）时仍打开页面，只提示原因（避免 RPC 抛错锁死，##275 R1-6）
      if (v.error) notificationStore.addToast("error", `配置读取失败：${v.error}`);
    } catch (e) {
      notificationStore.addToast("error", e instanceof Error ? e.message : "配置读取失败");
    } finally {
      setLoading(false);
    }
  };
  onMount(reload);

  const mutateFile = (fn: (f: ModelConfigFile) => void) => {
    const next = structuredClone(file());
    fn(next);
    setFile(next);
    setDirty(true);
  };
  const mutateSpec = (key: string, fn: (s: SpecProvider) => void) => {
    const next = structuredClone(specs());
    const cur = next[key] ?? { id: key, npm: FACE_OPTIONS[0].npm, api: "", models: {} };
    fn(cur);
    next[key] = cur;
    setSpecs(next);
    setDirty(true);
  };

  /** 保存（write modelFile + 脏 spec 逐条 writeSpec + 重新 read） */
  const save = async () => {
    setSaving(true);
    try {
      await diyService.diy.llmConfig.write({ modelFile: file() });
      const base = view()?.customSpecs ?? {};
      const now = specs();
      const ids = new Set([...Object.keys(base), ...Object.keys(now)]);
      for (const id of ids) {
        const a = base[id] ? JSON.stringify(base[id]) : null;
        const b = now[id] ? JSON.stringify(now[id]) : null;
        if (a !== b) await diyService.diy.llmConfig.writeSpec({ id, spec: now[id] ?? null });
      }
      await reload();
      notificationStore.addToast("success", "model.yaml 已保存");
    } catch (e) {
      notificationStore.addToast("error", e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  /** 添加 std provider：账号留空（人填 key），env[0] 只作占位提示 */
  const addStd = async (id: string) => {
    const next = structuredClone(file());
    next.stdProviders[id] = {
      accounts: [{ type: "apiKey", data: { value: "" } }],
      filter: { include: [], exclude: [] },
    };
    setFile(next);
    try {
      await diyService.diy.llmConfig.write({ modelFile: next });
      await reload();
      notificationStore.addToast("success", `已添加 ${id}（请填密钥）`);
    } catch (e) {
      notificationStore.addToast("error", e instanceof Error ? e.message : "添加失败");
    }
  };

  const unconfigured = createMemo<CatalogEntry[]>(() => {
    const v = view();
    if (!v) return [];
    const used = new Set(Object.keys(file().stdProviders));
    const q = query().trim().toLowerCase();
    return v.catalog
      .filter((c) => !used.has(c.id))
      .filter((c) => !q || c.id.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q));
  });

  const stdCards = createMemo(() =>
    Object.entries(file().stdProviders).map(([key, cfg]) => ({
      key,
      cfg,
      base: view()?.providers.find((p) => p.kind === "std" && p.key === key),
    })),
  );
  const customCards = createMemo(() =>
    Object.entries(file().customProviders).map(([key, cfg]) => ({
      key,
      cfg,
      spec: specs()[key] ?? null,
      base: view()?.providers.find((p) => p.kind === "custom" && p.key === key),
    })),
  );

  const removeProvider = (kind: "std" | "custom", key: string) => {
    if (!confirm(`移除 provider「${kind === "custom" ? `custom:${key}` : key}」？模型选择随之消失。`)) return;
    mutateFile((f) => {
      if (kind === "std") delete f.stdProviders[key];
      else delete f.customProviders[key];
    });
  };

  return (
    <div class="p-4 space-y-3 overflow-y-auto h-full">
      <div class="flex items-center justify-between">
        <div class="text-title font-bold">🤖 模型 provider 配置</div>
        <div class="flex gap-2 items-center">
          <code class="text-body opacity-50 text-xs">~/.diy/model.yaml</code>
          <button class="btn btn-sm btn-primary" disabled={loading() || !dirty() || saving()} onClick={() => void save()}>
            {saving() ? "保存中…" : "保存全部"}
          </button>
        </div>
      </div>
      <div class="text-body opacity-60 text-xs">
        密钥支持 <code>$ENV</code> 插值（未定义会报错）；模型清单来自 models.dev snapshot（models.dev
        provider）或 providers.custom.yaml（自定义）。勾选即启用/隐藏，逐卡片「保存」落盘。
        自定义 provider 可在模型行**填单价**（$/1M，落 providers.custom.yaml）；不填 = 无价（金额显示
        <code>—</code>，绝不按 0 计）。峰谷价用行内**时段档**（时刻 + 可选日历，如中国法定工作日）。
      </div>

      <Show when={!loading()} fallback={<div class="text-body opacity-50">加载中…</div>}>
        {/* ── stdProviders ── */}
        <div class="text-title font-semibold mt-2">models.dev provider（snapshot）</div>
        <Show when={unconfigured().length > 0}>
          <div class="flex gap-2 items-start max-w-2xl">
            <input
              class="input input-bordered input-sm w-56"
              placeholder="🔍 搜索 provider…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <div class="flex-1 max-h-40 overflow-y-auto border rounded-box bg-base-100">
              <Index each={unconfigured().slice(0, 200)}>
                {(c) => (
                  <button
                    class="block w-full text-left px-2 py-1 text-sm hover:bg-base-200"
                    onClick={() => void addStd(c().id)}
                  >
                    <span class="font-mono">{c().id}</span>
                    <Show when={c().name}>
                      <span class="opacity-50"> — {c().name}</span>
                    </Show>
                    <span class="opacity-40 text-xs"> · {c().npm}</span>
                  </button>
                )}
              </Index>
              <Show when={unconfigured().length === 0}>
                <div class="px-2 py-1 text-xs opacity-50">无匹配（清空搜索查看全部）</div>
              </Show>
            </div>
          </div>
        </Show>
        <Index each={stdCards()}>
          {(c) => (
            <StdCard
              card={c()}
              file={file}
              mutateFile={mutateFile}
              save={save}
              saving={saving}
              onRemove={() => removeProvider("std", c().key)}
            />
          )}
        </Index>

        {/* ── customProviders ── */}
        <div class="text-title font-semibold mt-4">自定义 provider（providers.custom.yaml）</div>
        <Index each={customCards()}>
          {(c) => (
            <CustomCard
              card={c()}
              file={file}
              mutateFile={mutateFile}
              specs={specs}
              mutateSpec={mutateSpec}
              calendars={() => view()?.calendars ?? []}
              save={save}
              saving={saving}
              onRemove={() => removeProvider("custom", c().key)}
            />
          )}
        </Index>
        <Show when={!showNewCustom()}>
          <button class="btn btn-sm btn-outline" onClick={() => setShowNewCustom(true)}>
            ＋ 新增 custom provider
          </button>
        </Show>
        <Show when={showNewCustom()}>
          <NewCustomForm
            existing={specs()}
            onCancel={() => setShowNewCustom(false)}
            onCreate={(id, spec, keyValue) => {
              const nextSpecs = { ...specs(), [id]: spec };
              setSpecs(nextSpecs);
              mutateFile((f) => {
                f.customProviders[id] = { accounts: [{ type: "apiKey", data: { value: keyValue } }], filter: { include: [], exclude: [] } };
              });
              setShowNewCustom(false);
              notificationStore.addToast("success", `已添加 custom:${id}（点「保存全部」落盘）`);
            }}
          />
        </Show>
      </Show>
    </div>
  );
}

// ── 账号编辑（std / custom 共用） ──────────────────────────────
// 用 <Index>（按序号复用 DOM）而非 <For>：<For> 以对象身份为键，每次 structuredClone 都
// 产生新身份 → 行被重建 → 输入框丢焦点（"输入一个字符焦点就跳开" 的根因）。

function AccountsEditor(props: {
  cfg: () => ProviderConfig;
  mutateCfg: (fn: (c: ProviderConfig) => void) => void;
  base: () => { accounts: { error: string | null; account: Account }[] } | undefined;
  limited: () => string;
  placeholder: () => string;
  onTest: () => void;
  testing: () => boolean;
  testLabel?: () => string;
}) {
  return (
    <div class="space-y-1">
      <div class="flex items-center gap-3">
        <span class="text-sm font-medium">账号</span>
        <span class="text-xs opacity-50">name@provider 里的 name（可选，缺省 = 序号）</span>
      </div>
      <Index each={props.cfg().accounts}>
        {(acc, i) => {
          const baseAt = () => props.base()?.accounts[i];
          return (
            <div class="flex gap-2 items-center flex-wrap">
              <input
                class="input input-bordered input-sm w-32"
                placeholder="账号显示名"
                value={acc().name ?? ""}
                onInput={(e) =>
                  props.mutateCfg((c) => {
                    const a = c.accounts[i];
                    const v = e.currentTarget.value.trim();
                    if (v) a.name = v;
                    else delete a.name;
                  })
                }
              />
              <input
                class="input input-bordered input-sm flex-1 min-w-56"
                placeholder={props.placeholder()}
                value={acc().data.value}
                onInput={(e) => props.mutateCfg((c) => { c.accounts[i].data.value = e.currentTarget.value; })}
              />
              <code class="text-xs opacity-60">{acc().name ?? i}@{props.limited()}</code>
              <Show when={baseAt()?.error && baseAt()!.account.data.value === acc().data.value}>
                <span class="text-error text-xs">{baseAt()!.error}</span>
              </Show>
              <Show when={props.cfg().accounts.length > 1}>
                <button class="btn btn-xs btn-ghost" title="删除此账号" onClick={() => props.mutateCfg((c) => { c.accounts.splice(i, 1); })}>
                  ×
                </button>
              </Show>
              <Show when={i === 0}>
                <button class="btn btn-xs btn-outline" disabled={props.testing()} onClick={props.onTest}>
                  {props.testing() ? "测试中…" : (props.testLabel?.() ?? "测试")}
                </button>
              </Show>
            </div>
          );
        }}
      </Index>
      <div class="flex gap-2">
        <button
          class="btn btn-xs btn-outline"
          onClick={() => props.mutateCfg((c) => { c.accounts.push({ type: "apiKey", data: { value: "" } } as Account); })}
        >
          ＋ 添加账号
        </button>
      </div>
    </div>
  );
}

// ── std provider 卡片（spec 只读） ─────────────────────────────

function StdCard(props: {
  card: { key: string; cfg: ProviderConfig; base: LlmConfigView["providers"][number] | undefined };
  file: () => ModelConfigFile;
  mutateFile: (fn: (f: ModelConfigFile) => void) => void;
  save: () => Promise<void>;
  saving: () => boolean;
  onRemove: () => void;
}) {
  const [testing, setTesting] = createSignal(false);
  const [modelQuery, setModelQuery] = createSignal("");
  const mutateCfg = (fn: (c: ProviderConfig) => void) =>
    props.mutateFile((f) => { const c = f.stdProviders[props.card.key]; if (c) fn(c); });

  const spec = () => props.card.base?.spec ?? null;
  const mode = () => modeOf(props.card.cfg.filter);
  const models = createMemo(() => {
    const q = modelQuery().trim().toLowerCase();
    const all = props.card.base?.models ?? [];
    return all.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  });

  const test = async () => {
    const s = spec();
    if (!s) return;
    const acc = props.card.cfg.accounts[0];
    setTesting(true);
    try {
      const r = await diyService.diy.llmConfig.probe({ baseUrl: s.api, apiKey: acc?.data.value ?? "" });
      if (r.ok) notificationStore.addToast("success", `连通（HTTP ${r.status}，${r.models.length} 个模型）`);
      else notificationStore.addToast("error", `不通：${r.error ?? "未知错误"}`);
    } finally {
      setTesting(false);
    }
  };

  const setFilter = (m: FilterMode) => {
    const ms = props.card.base?.models ?? [];
    mutateCfg((cfg) => {
      if (m === "all") cfg.filter = { include: [], exclude: [] };
      else if (m === "include") cfg.filter = { include: ms.filter((x) => filterAllows(cfg.filter ?? { include: [], exclude: [] }, x.id)).map((x) => x.id), exclude: [] };
      else cfg.filter = { include: [], exclude: ms.filter((x) => !filterAllows(cfg.filter ?? { include: [], exclude: [] }, x.id)).map((x) => x.id) };
    });
  };
  const toggle = (id: string) => {
    const m = mode();
    if (m === "all") return;
    mutateCfg((cfg) => {
      const flt = cfg.filter ?? { include: [], exclude: [] };
      const list = m === "include" ? flt.include : flt.exclude;
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1); else list.push(id);
      cfg.filter = flt;
    });
  };

  return (
    <div class="card border bg-base-100 p-3 space-y-2 mt-2">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-semibold">{props.card.key}</span>
        <code class="text-xs opacity-60">{props.card.key}</code>
        <span class={`badge badge-sm ${props.card.base?.usable ? "badge-success" : "badge-warning"}`}>
          {props.card.base?.usable ? "密钥可用" : "无可用密钥"}
        </span>
        <Show when={props.card.base && !props.card.base.spec}>
          <span class="badge badge-error badge-sm">spec 缺失</span>
        </Show>
      </div>
      <Show when={spec()}>
        {(s) => (
          <div class="text-xs opacity-60 flex gap-3 flex-wrap">
            <span>npm: <code>{s().npm}</code></span>
            <span>api: <code>{s().api}</code></span>
          </div>
        )}
      </Show>
      <AccountsEditor
        cfg={() => props.card.cfg}
        mutateCfg={mutateCfg}
        base={() => props.card.base}
        limited={() => props.card.key}
        placeholder={() => (spec()?.env?.[0] ? `输入密钥，或 $${spec()!.env[0]}` : "输入密钥，或 $ENV")}
        onTest={() => void test()}
        testing={testing}
      />

      <ModelFilter mode={mode} setFilter={setFilter} />
      <div class="flex items-center gap-2">
        <input class="input input-bordered input-xs w-56" placeholder="🔍 搜索模型…" value={modelQuery()} onInput={(e) => setModelQuery(e.currentTarget.value)} />
        <span class="text-xs opacity-50">{models().length} / {props.card.base?.models.length ?? 0}</span>
      </div>
      <Show when={models().length > 0} fallback={<div class="text-xs opacity-50">（无模型清单）</div>}>
        <div class="max-h-72 overflow-y-auto">
          <table class="table table-xs">
            <thead>
              <tr>
                <th class="w-8">{mode() === "exclude" ? "排除" : "启用"}</th>
                <th>模型</th>
                <th class="w-36">context / output</th>
                <th class="w-24">推理档位</th>
                <th class="w-24">$/1M</th>
              </tr>
            </thead>
            <tbody>
              <Index each={models()}>
                {(m) => {
                  const enabled = () => {
                    if (mode() === "all") return true;
                    const flt = props.card.cfg.filter;
                    if (!flt) return true;
                    return mode() === "include" ? flt.include.includes(m().id) : !flt.exclude.includes(m().id);
                  };
                  return (
                    <tr class={enabled() ? "" : "opacity-40"}>
                      <td>
                        <input type="checkbox" class="checkbox checkbox-xs" disabled={mode() === "all"} checked={enabled()} onChange={() => toggle(m().id)} />
                      </td>
                      <td>
                        <div class="flex gap-2 items-center flex-wrap">
                          <span class="font-mono text-xs">{m().id}</span>
                          <span class="text-xs opacity-70">{m().name}</span>
                          <Show when={m().specMissing}>
                            <span class="badge badge-error badge-xs">spec无</span>
                          </Show>
                        </div>
                      </td>
                      <td class="font-mono text-xs">{fmtK(m().context)} / {fmtK(m().output)}</td>
                      <td class="text-xs">
                        <Show when={m().reasoning.declared} fallback={<span class="opacity-50">未声明</span>}>
                          {m().reasoning.supported.join("/")}
                        </Show>
                      </td>
                      <td class="text-xs">{m().cost?.input != null ? `${m().cost!.input}/${m().cost!.output}` : "—"}</td>
                    </tr>
                  );
                }}
              </Index>
            </tbody>
          </table>
        </div>
      </Show>

      <div class="flex gap-2 pt-1">
        <button class="btn btn-sm btn-primary" disabled={props.saving()} onClick={() => void props.save()}>保存</button>
        <button class="btn btn-sm btn-outline btn-error" onClick={props.onRemove}>移除</button>
      </div>
    </div>
  );
}

function ModelFilter(props: { mode: () => FilterMode; setFilter: (m: FilterMode) => void }) {
  return (
    <div class="flex gap-3 items-center text-sm">
      <span class="font-medium">模型启用</span>
      <label class="label cursor-pointer gap-1 py-0">
        <input type="radio" class="radio radio-xs" checked={props.mode() === "all"} onChange={() => props.setFilter("all")} />
        <span class="label-text text-xs">全部</span>
      </label>
      <label class="label cursor-pointer gap-1 py-0">
        <input type="radio" class="radio radio-xs" checked={props.mode() === "include"} onChange={() => props.setFilter("include")} />
        <span class="label-text text-xs">仅包含（白名单）</span>
      </label>
      <label class="label cursor-pointer gap-1 py-0">
        <input type="radio" class="radio radio-xs" checked={props.mode() === "exclude"} onChange={() => props.setFilter("exclude")} />
        <span class="label-text text-xs">排除（黑名单）</span>
      </label>
    </div>
  );
}

// ── custom provider 卡片（spec 可编辑） ────────────────────────
//
// 模型清单**唯一来源 = `/models`**（「测试并获取模型列表」按钮）。不支持手工加模型：
// 手工输入的 id 没有 context/面 等元数据，等于让用户自己编参数。拿不到 /models 的端点
// 不适合做 custom provider（交给 provider 自带的 models.dev 定义）。
// 拉到的 `context_length` / `supported_endpoints` / `name` 落进 spec（与 models.dev 同构），
// 之后各字段仍可就地改（context/output/面/档位），与新增时同一套控件。

function CustomCard(props: {
  card: { key: string; cfg: ProviderConfig; spec: SpecProvider | null; base: LlmConfigView["providers"][number] | undefined };
  file: () => ModelConfigFile;
  mutateFile: (fn: (f: ModelConfigFile) => void) => void;
  specs: () => CustomSpecsFile;
  mutateSpec: (key: string, fn: (s: SpecProvider) => void) => void;
  /** 内置日历清单（时段档的「工作日扩展」下拉项，来自 llmConfig.read） */
  calendars: () => CalendarChoice[];
  save: () => Promise<void>;
  saving: () => boolean;
  onRemove: () => void;
}) {
  const [testing, setTesting] = createSignal(false);
  const [modelQuery, setModelQuery] = createSignal("");
  /** 展开编辑时段档的模型 id（同一时刻只展开一个，表窄） */
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const mutateCfg = (fn: (c: ProviderConfig) => void) =>
    props.mutateFile((f) => { const c = f.customProviders[props.card.key]; if (c) fn(c); });

  const spec = () => props.card.spec;
  const providerNpm = () => spec()?.npm ?? FACE_OPTIONS[0].npm;
  const modelIds = createMemo(() => {
    const q = modelQuery().trim().toLowerCase();
    return Object.keys(spec()?.models ?? {}).filter((id) => {
      if (!q) return true;
      const nm = (spec()?.models[id] as { name?: string } | undefined)?.name ?? "";
      return id.toLowerCase().includes(q) || nm.toLowerCase().includes(q);
    });
  });
  const mode = () => modeOf(props.card.cfg.filter);

  /** 测试连通 + 从 /models 同步模型清单（替换 spec.models；context/面 取自元数据） */
  const testAndFetch = async () => {
    const s = spec();
    if (!s) return;
    if (!s.api.trim()) { notificationStore.addToast("error", "先填 API 地址"); return; }
    setTesting(true);
    try {
      const r = await diyService.diy.llmConfig.probe({ baseUrl: s.api, apiKey: props.card.cfg.accounts[0]?.data.value ?? "" });
      if (!r.ok) { notificationStore.addToast("error", `不通：${r.error ?? "未知错误"}`); return; }
      const fallbackNpm = providerNpm();
      const prevModels = spec()?.models ?? {};
      const next: Record<string, SpecProvider["models"][string]> = {};
      let skipped = 0;
      for (const m of r.models) {
        // endpoints 非空 → 按端点定面（只支持两家；anthropic 等跳过）；为空 → 用 provider 级默认面。
        const faceNpm = m.endpoints.length > 0 ? npmOfEndpoints(m.endpoints) : fallbackNpm;
        if (!faceNpm) { skipped++; continue; }
        const prev = prevModels[m.id];
        // 合并而非重建：/models 只提供 name/context/面；**手工登记的价格/档位/自定义 limit 必须保留**
        // （否则点一次「测试并获取模型列表」就把填好的价冲掉 → 静默变无价）。
        next[m.id] = {
          ...(prev ?? {}),
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.context ? { limit: { ...(prev?.limit ?? {}), context: m.context } } : {}),
          ...(faceNpm !== fallbackNpm ? { provider: { npm: faceNpm } } : {}),
        };
      }
      props.mutateSpec(props.card.key, (sp) => { sp.models = next; });
      notificationStore.addToast(
        "success",
        `连通（HTTP ${r.status}），同步 ${Object.keys(next).length} 个模型` + (skipped ? `（跳过 ${skipped} 个未支持面的模型）` : ""),
      );
    } finally {
      setTesting(false);
    }
  };

  const patchModel = (id: string, fn: (m: NonNullable<SpecProvider["models"][string]>) => void) =>
    props.mutateSpec(props.card.key, (s) => { const m = s.models[id]; if (m) fn(m); });

  /** 读某模型某单价字段的展示值（未填 → 空串，不显示 0） */
  const costVal = (id: string, f: CostField): string => {
    const v = spec()?.models[id]?.cost?.[f];
    return v != null ? String(v) : "";
  };
  /** in/out 只填了一个（runtime 只认两者齐全的价 → 该模型仍无价）：UI 标红提醒 */
  const costPartial = (id: string): boolean => {
    const c = spec()?.models[id]?.cost;
    return c != null && (c.input != null) !== (c.output != null);
  };
  /** 写 base 档单价（$/1M，spec 的 snake_case）：清空则删字段；全空则删整个 cost（无价）。 */
  const patchCost = (id: string, f: CostField, raw: string) =>
    patchModel(id, (mm) => {
      const c = mm.cost ?? {};
      setBasePrice(c, f, raw);
      if (Object.keys(c).length > 0) mm.cost = c;
      else delete mm.cost;
    });

  // ── 时段档（utc-range）：变换在 shared/cost-edit.ts（纯函数，可单测） ──
  const costOf = (id: string): Cost | undefined => spec()?.models[id]?.cost;
  const slotsOf = (id: string) => utcRangeSlots(costOf(id));
  const patchTier = (id: string, index: number, p: Parameters<typeof patchUtcRange>[2]) =>
    patchModel(id, (mm) => patchUtcRange(mm.cost ?? {}, index, p));
  const addTier = (id: string) =>
    patchModel(id, (mm) => { addUtcRangeTier((mm.cost ??= {})); setExpanded(id); });
  const dropTier = (id: string, index: number) =>
    patchModel(id, (mm) => { if (mm.cost) removeTier(mm.cost, index); });
  /** 时段档的日历编辑块（`utc-range` 归一形状；非该类型不该出现在展开区） */
  const winOf = (t: CostTier) => (t.tier?.type === "utc-range" ? t.tier.data : null);

  const toggle = (id: string) => {
    const m = mode();
    if (m === "all") return;
    mutateCfg((cfg) => {
      const flt = cfg.filter ?? { include: [], exclude: [] };
      const list = m === "include" ? flt.include : flt.exclude;
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1); else list.push(id);
      cfg.filter = flt;
    });
  };

  return (
    <div class="card border bg-base-100 p-3 space-y-2 mt-2">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-semibold">{props.card.key}</span>
        <code class="text-xs opacity-60">custom:{props.card.key}</code>
        <span class="badge badge-outline badge-sm">custom</span>
        <span class={`badge badge-sm ${props.card.base?.usable ? "badge-success" : "badge-warning"}`}>
          {props.card.base?.usable ? "密钥可用" : "无可用密钥"}
        </span>
        <Show when={!spec()}>
          <span class="badge badge-error badge-sm">spec 缺失</span>
        </Show>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label class="form-control">
          <span class="label-text text-xs">API 地址（baseUrl，必填）</span>
          <input
            class="input input-bordered input-sm"
            placeholder="https://…/v1"
            value={spec()?.api ?? ""}
            onInput={(e) => props.mutateSpec(props.card.key, (s) => { s.api = e.currentTarget.value; })}
          />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">默认 API 协议（面；模型可从 /models 覆写）</span>
          <select
            class="select select-bordered select-sm"
            value={providerNpm()}
            onChange={(e) => props.mutateSpec(props.card.key, (s) => { s.npm = e.currentTarget.value; })}
          >
            <For each={FACE_OPTIONS}>{(o) => <option value={o.npm}>{o.label}</option>}</For>
          </select>
        </label>
      </div>

      <AccountsEditor
        cfg={() => props.card.cfg}
        mutateCfg={mutateCfg}
        base={() => props.card.base}
        limited={() => `custom:${props.card.key}`}
        placeholder={() => "输入密钥（明文或 $ENV）"}
        onTest={() => void testAndFetch()}
        testing={testing}
        testLabel={() => "测试并获取模型列表"}
      />

      <ModelFilter mode={mode} setFilter={(m) => {
        const ids = Object.keys(spec()?.models ?? {});
        mutateCfg((cfg) => {
          if (m === "all") cfg.filter = { include: [], exclude: [] };
          else if (m === "include") cfg.filter = { include: ids.filter((x) => filterAllows(cfg.filter ?? { include: [], exclude: [] }, x)), exclude: [] };
          else cfg.filter = { include: [], exclude: ids.filter((x) => !filterAllows(cfg.filter ?? { include: [], exclude: [] }, x)) };
        });
      }} />

      <div class="flex items-center gap-2">
        <span class="text-xs opacity-50">模型清单由「测试并获取模型列表」从 /models 同步</span>
        <span class="flex-1" />
        <input class="input input-bordered input-xs w-40" placeholder="🔍 搜索模型…" value={modelQuery()} onInput={(e) => setModelQuery(e.currentTarget.value)} />
      </div>

      <Show when={modelIds().length > 0} fallback={<div class="text-xs opacity-50">（还没有模型：先填 API 地址与密钥，点「测试并获取模型列表」）</div>}>
        <div class="max-h-72 overflow-y-auto">
          <table class="table table-xs">
            <thead>
              <tr>
                <th class="w-8">{mode() === "exclude" ? "排除" : "启用"}</th>
                <th>模型 id / 名称</th>
                <th class="w-28">context</th>
                <th class="w-28">output</th>
                <th class="w-52">档位（逗号，空=平台默认）</th>
                <th class="w-72">价格 $/1M（in / out / 缓存读 / 缓存写）</th>
              </tr>
            </thead>
            <tbody>
              <Index each={modelIds()}>
                {(id) => {
                  const m = () => spec()!.models[id()];
                  const enabled = () => {
                    if (mode() === "all") return true;
                    const flt = props.card.cfg.filter;
                    if (!flt) return true;
                    return mode() === "include" ? flt.include.includes(id()) : !flt.exclude.includes(id());
                  };
                  const efforts = () => {
                    const opts = (m() as { reasoning_options?: Array<{ type?: string; values?: unknown }> }).reasoning_options ?? [];
                    const v = opts.find((o) => o.type === "effort")?.values;
                    return Array.isArray(v) ? (v as string[]).join(",") : "";
                  };
                  return (
                    <>
                    <tr class={enabled() ? "" : "opacity-40"}>
                      <td>
                        <input type="checkbox" class="checkbox checkbox-xs" disabled={mode() === "all"} checked={enabled()} onChange={() => toggle(id())} />
                      </td>
                      <td>
                        <div class="flex gap-2 items-center flex-wrap">
                          <span class="font-mono text-xs">{id()}</span>
                          <Show when={(m() as { name?: string })?.name}>
                            <span class="text-xs opacity-70">{(m() as { name?: string }).name}</span>
                          </Show>
                        </div>
                      </td>
                      <td>
                        <input
                          class="input input-bordered input-xs w-24"
                          placeholder="200000"
                          value={m()?.limit?.context != null ? String(m()!.limit!.context) : ""}
                          onInput={(e) => patchModel(id(), (mm) => { const t = e.currentTarget.value.trim(); mm.limit = { ...mm.limit, ...(t ? { context: Number(t) } : {}) }; if (!t) delete mm.limit!.context; })}
                        />
                      </td>
                      <td>
                        <input
                          class="input input-bordered input-xs w-24"
                          placeholder="32768"
                          value={m()?.limit?.output != null ? String(m()!.limit!.output) : ""}
                          onInput={(e) => patchModel(id(), (mm) => { const t = e.currentTarget.value.trim(); mm.limit = { ...mm.limit, ...(t ? { output: Number(t) } : {}) }; if (!t) delete mm.limit!.output; })}
                        />
                      </td>
                      <td>
                        <input
                          class="input input-bordered input-xs w-48"
                          placeholder="如 low,medium,high"
                          value={efforts()}
                          onInput={(e) => patchModel(id(), (mm) => {
                            const vals = e.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean);
                            const other = ((mm as { reasoning_options?: unknown[] }).reasoning_options ?? []).filter((o) => (o as { type?: string }).type !== "effort");
                            (mm as { reasoning_options?: unknown[] }).reasoning_options = [...other, ...(vals.length ? [{ type: "effort", values: vals }] : [])];
                          })}
                        />
                      </td>
                      <td>
                        <div class="flex items-center gap-1">
                          <Index each={COST_FIELDS}>
                            {(f) => (
                              <input
                                class="input input-bordered input-xs w-14"
                                placeholder={f().ph}
                                title={f().label}
                                value={costVal(id(), f().key)}
                                onInput={(e) => patchCost(id(), f().key, e.currentTarget.value)}
                              />
                            )}
                          </Index>
                        </div>
                        <div class="flex items-center gap-1 mt-1">
                          <input
                            class="input input-bordered input-xs w-16"
                            placeholder="基准标签"
                            title="未命中任何时段档时的档名（如 off-peak）；留空显示 base"
                            value={costOf(id())?.baseLabel ?? ""}
                            onInput={(e) =>
                              patchModel(id(), (mm) => {
                                // 与 patchCost 同一收尾：改完若整个 cost 空了就删键，别留 `cost: {}`
                                const c = (mm.cost ??= {});
                                setBaseLabel(c, e.currentTarget.value);
                                if (Object.keys(c).length === 0) delete mm.cost;
                              })
                            }
                          />
                          <button
                            class="btn btn-xs btn-ghost"
                            title="峰/谷时段价（按 UTC 时刻 + 可选日历）"
                            onClick={() => setExpanded(expanded() === id() ? null : id())}
                          >
                            时段档{slotsOf(id()).length ? ` ${slotsOf(id()).length}` : ""}
                          </button>
                        </div>
                        <Show when={costPartial(id())}>
                          <span class="text-error text-xs">in/out 需同填才有价</span>
                        </Show>
                      </td>
                    </tr>
                    <Show when={expanded() === id()}>
                      <tr class="bg-base-200">
                        <td colspan={6}>
                          <div class="space-y-1 py-1">
                            <div class="text-xs opacity-60">
                              命中时段用档价，未命中用上面的默认价（基准标签 <code>{costOf(id())?.baseLabel ?? "base"}</code>）。
                              时刻 = 带 UTC 偏移的 ISO 8601（如 <code>01:00:00+08:00</code>）；end &lt; start = 跨零点。
                              日历 = 该时段只在这些日子生效；档内价格留空 = 沿用默认价。
                            </div>
                            <For each={slotsOf(id())}>
                              {(slot) => {
                                const d = () => winOf(slot.tier)!;
                                const issues = () => tierIssues(costOf(id()), slot.tier);
                                return (
                                  <div class="flex items-center gap-1 flex-wrap">
                                    <input
                                      class="input input-bordered input-xs w-36 font-mono"
                                      title="开始时刻（含 UTC 偏移）"
                                      value={d().start}
                                      onInput={(e) => patchTier(id(), slot.index, { start: e.currentTarget.value })}
                                    />
                                    <span class="opacity-50">→</span>
                                    <input
                                      class="input input-bordered input-xs w-36 font-mono"
                                      title="结束时刻（偏移须与开始一致）"
                                      value={d().end}
                                      onInput={(e) => patchTier(id(), slot.index, { end: e.currentTarget.value })}
                                    />
                                    <select
                                      class="select select-bordered select-xs w-44"
                                      title="仅在这些日子生效（中国法定工作日含周末调休补班）"
                                      value={d().calendar ?? ""}
                                      onChange={(e) => patchTier(id(), slot.index, { calendar: e.currentTarget.value })}
                                    >
                                      <option value="">不限日历（每天）</option>
                                      <For each={props.calendars()}>{(c) => <option value={c.id}>{c.label}</option>}</For>
                                    </select>
                                    <input
                                      class="input input-bordered input-xs w-20"
                                      placeholder="标签 peak"
                                      title="该时段的档名（落 usage.jsonl 的 window 字段）"
                                      value={d().label ?? ""}
                                      onInput={(e) => patchTier(id(), slot.index, { label: e.currentTarget.value })}
                                    />
                                    <Index each={COST_FIELDS}>
                                      {(f) => (
                                        <input
                                          class="input input-bordered input-xs w-14"
                                          placeholder={f().ph}
                                          title={`本档 ${f().label}`}
                                          value={slot.tier[f().key] != null ? String(slot.tier[f().key]) : ""}
                                          onInput={(e) => patchTier(id(), slot.index, { price: { f: f().key, raw: e.currentTarget.value } })}
                                        />
                                      )}
                                    </Index>
                                    <button class="btn btn-xs btn-ghost text-error" title="删除此档" onClick={() => dropTier(id(), slot.index)}>×</button>
                                    <Show when={issues().length > 0}>
                                      <span class="text-error text-xs">{issues().join("；")}</span>
                                    </Show>
                                  </div>
                                );
                              }}
                            </For>
                            <div class="flex items-center gap-2">
                              <button class="btn btn-xs btn-outline" onClick={() => addTier(id())}>＋ 时段档</button>
                              <span class="text-xs opacity-50">
                                档位顺序即优先级（首个命中者生效）；判档用请求发起时刻。
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    </Show>
                    </>
                  );
                }}
              </Index>
            </tbody>
          </table>
        </div>
      </Show>

      <div class="flex gap-2 pt-1">
        <button class="btn btn-sm btn-primary" disabled={props.saving()} onClick={() => void props.save()}>保存</button>
        <button class="btn btn-sm btn-outline btn-error" onClick={props.onRemove}>移除</button>
      </div>
    </div>
  );
}

// ── 新增 custom provider ──────────────────────────────────────

function NewCustomForm(props: {
  existing: CustomSpecsFile;
  onCancel: () => void;
  onCreate: (id: string, spec: SpecProvider, keyValue: string) => void;
}) {
  const [id, setId] = createSignal("");
  const [api, setApi] = createSignal("");
  const [npm, setNpm] = createSignal<string>(FACE_OPTIONS[0].npm);
  const [keyValue, setKeyValue] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);

  const create = () => {
    const k = id().trim();
    if (!k) { setErr("填 provider id"); return; }
    if (props.existing[k]) { setErr(`custom:${k} 已存在`); return; }
    if (!api().trim()) { setErr("填 API 地址"); return; }
    props.onCreate(k, { id: k, npm: npm(), api: api().trim(), models: {} }, keyValue());
  };

  return (
    <div class="card border p-3 bg-base-200 space-y-2 mt-2">
      <div class="text-sm font-semibold">新增 custom provider</div>
      <div class="grid grid-cols-2 gap-2">
        <label class="form-control">
          <span class="label-text text-xs">provider id（裸，不带 custom:）</span>
          <input class="input input-bordered input-sm font-mono" placeholder="goat" value={id()} onInput={(e) => setId(e.currentTarget.value)} />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">API 地址（baseUrl，必填）</span>
          <input class="input input-bordered input-sm" placeholder="https://…/v1" value={api()} onInput={(e) => setApi(e.currentTarget.value)} />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">API 协议（面）</span>
          <select class="select select-bordered select-sm" value={npm()} onChange={(e) => setNpm(e.currentTarget.value)}>
            <For each={FACE_OPTIONS}>{(o) => <option value={o.npm}>{o.label}</option>}</For>
          </select>
        </label>
        <label class="form-control">
          <span class="label-text text-xs">密钥（明文或 $ENV）</span>
          <input class="input input-bordered input-sm" placeholder="sk-… 或 $MY_KEY" value={keyValue()} onInput={(e) => setKeyValue(e.currentTarget.value)} />
        </label>
      </div>
      <Show when={err()}><div class="text-error text-xs">{err()}</div></Show>
      <div class="text-xs opacity-60">创建后进卡片填密钥，点「测试并获取模型列表」从 /models 同步模型（只支持能提供模型元数据的端点）。</div>
      <div class="flex gap-2">
        <button class="btn btn-sm btn-primary" onClick={create}>创建</button>
        <button class="btn btn-sm" onClick={props.onCancel}>取消</button>
      </div>
    </div>
  );
}
