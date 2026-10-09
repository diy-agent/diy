// components/ModelConfigPage.tsx — 模型 provider 配置（直译 $DIY_HOME/model.yaml）
//
// 两组卡片：std = models.dev snapshot provider（spec 只读）；custom = providers.custom.yaml
// （baseUrl / 面(npm) 可编辑）。卡片内：账号 → 模型清单（勾选启用）→ [保存][移除]。
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
  CatalogEntry,
  CustomSpecsFile,
  LlmConfigView,
  ModelConfigFile,
  ProviderConfig,
  SpecProvider,
} from "../../shared/model-config";
import { filterAllows } from "../../shared/model-config";
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
    const v = await diyService.diy.llmConfig.read({});
    setView(v);
    setFile(structuredClone(v.modelFile));
    setSpecs(structuredClone(v.customSpecs));
    setDirty(false);
    setLoading(false);
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
                  {props.testing() ? "测试中…" : "测试"}
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
                <th class="w-20">面</th>
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
                      <td class="text-xs"><code>{m().api}</code></td>
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

function CustomCard(props: {
  card: { key: string; cfg: ProviderConfig; spec: SpecProvider | null; base: LlmConfigView["providers"][number] | undefined };
  file: () => ModelConfigFile;
  mutateFile: (fn: (f: ModelConfigFile) => void) => void;
  specs: () => CustomSpecsFile;
  mutateSpec: (key: string, fn: (s: SpecProvider) => void) => void;
  save: () => Promise<void>;
  saving: () => boolean;
  onRemove: () => void;
}) {
  const [testing, setTesting] = createSignal(false);
  const [newModelId, setNewModelId] = createSignal("");
  const [modelQuery, setModelQuery] = createSignal("");
  const mutateCfg = (fn: (c: ProviderConfig) => void) =>
    props.mutateFile((f) => { const c = f.customProviders[props.card.key]; if (c) fn(c); });

  const spec = () => props.card.spec;
  const faceNpm = () => spec()?.npm ?? FACE_OPTIONS[0].npm;
  const modelIds = createMemo(() => {
    const q = modelQuery().trim().toLowerCase();
    return Object.keys(spec()?.models ?? {}).filter((id) => !q || id.toLowerCase().includes(q));
  });
  const mode = () => modeOf(props.card.cfg.filter);

  const test = async () => {
    const s = spec();
    if (!s) return;
    setTesting(true);
    try {
      const r = await diyService.diy.llmConfig.probe({ baseUrl: s.api, apiKey: props.card.cfg.accounts[0]?.data.value ?? "" });
      if (r.ok) notificationStore.addToast("success", `连通（HTTP ${r.status}，${r.models.length} 个模型）`);
      else notificationStore.addToast("error", `不通：${r.error ?? "未知错误"}`);
    } finally {
      setTesting(false);
    }
  };

  const addModel = (id: string, extra?: { name?: string | null; context?: number; output?: number; reasoning?: boolean }) => {
    const mid = id.trim();
    if (!mid) return;
    props.mutateSpec(props.card.key, (s) => {
      if (!s.models[mid]) {
        s.models[mid] = {
          id: mid,
          ...(extra?.name ? { name: extra.name } : {}),
          reasoning: extra?.reasoning ?? false,
          tool_call: true,
          ...(extra?.context || extra?.output ? { limit: { ...(extra.context ? { context: extra.context } : {}), ...(extra.output ? { output: extra.output } : {}) } } : {}),
        };
      }
    });
  };
  const removeModel = (id: string) => props.mutateSpec(props.card.key, (s) => { delete s.models[id]; });
  const patchModel = (id: string, fn: (m: NonNullable<SpecProvider["models"][string]>) => void) =>
    props.mutateSpec(props.card.key, (s) => { const m = s.models[id]; if (m) fn(m); });

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
          <span class="label-text text-xs">API 协议（面）</span>
          <select
            class="select select-bordered select-sm"
            value={faceNpm()}
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
        placeholder={() => "输入密钥，或 $ENV"}
        onTest={() => void test()}
        testing={testing}
      />

      <ModelFilter mode={mode} setFilter={(m) => {
        const ids = Object.keys(spec()?.models ?? {});
        mutateCfg((cfg) => {
          if (m === "all") cfg.filter = { include: [], exclude: [] };
          else if (m === "include") cfg.filter = { include: ids.filter((x) => filterAllows(cfg.filter ?? { include: [], exclude: [] }, x)), exclude: [] };
          else cfg.filter = { include: [], exclude: ids.filter((x) => !filterAllows(cfg.filter ?? { include: [], exclude: [] }, x)) };
        });
      }} />

      <ModelFetch inline onAdd={(ms) => ms.forEach((m) => addModel(m.id, { name: m.name, context: m.context, output: m.output, reasoning: m.reasoning }))} api={() => spec()?.api ?? ""} keyValue={() => props.card.cfg.accounts[0]?.data.value ?? ""} />

      <div class="flex items-center gap-2">
        <input class="input input-bordered input-xs w-56 font-mono" placeholder="手动输入模型 id…" value={newModelId()} onInput={(e) => setNewModelId(e.currentTarget.value)} />
        <button class="btn btn-xs" onClick={() => { addModel(newModelId()); setNewModelId(""); }}>＋ 添加模型</button>
        <span class="flex-1" />
        <input class="input input-bordered input-xs w-40" placeholder="🔍 搜索模型…" value={modelQuery()} onInput={(e) => setModelQuery(e.currentTarget.value)} />
      </div>

      <Show when={modelIds().length > 0} fallback={<div class="text-xs opacity-50">（还没有模型：先「获取模型」或手动添加）</div>}>
        <div class="max-h-72 overflow-y-auto">
          <table class="table table-xs">
            <thead>
              <tr>
                <th class="w-8">{mode() === "exclude" ? "排除" : "启用"}</th>
                <th>模型 id（不可改）</th>
                <th class="w-28">context</th>
                <th class="w-28">output</th>
                <th class="w-16">推理</th>
                <th class="w-52">档位（逗号，可空）</th>
                <th class="w-10" />
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
                    <tr class={enabled() ? "" : "opacity-40"}>
                      <td>
                        <input type="checkbox" class="checkbox checkbox-xs" disabled={mode() === "all"} checked={enabled()} onChange={() => toggle(id())} />
                      </td>
                      <td class="font-mono text-xs">{id()}</td>
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
                        <input type="checkbox" class="checkbox checkbox-xs" checked={m()?.reasoning ?? false} onChange={(e) => patchModel(id(), (mm) => { mm.reasoning = e.currentTarget.checked; })} />
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
                      <td><button class="btn btn-xs btn-ghost" title="删除模型" onClick={() => removeModel(id())}>×</button></td>
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

/** 拉 /models 并勾选加入（dsh 的「获取可用模型」）：/models 只给 id 列表，不含档位。 */
function ModelFetch(props: {
  api: () => string;
  keyValue: () => string;
  onAdd: (ms: { id: string; name: string | null; context: number; output: number; reasoning: boolean }[]) => void;
  inline?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [list, setList] = createSignal<{ id: string; name: string | null; checked: boolean }[]>([]);
  const [q, setQ] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);

  const fetchList = async () => {
    if (!props.api().trim()) { notificationStore.addToast("error", "先填 API 地址"); return; }
    setBusy(true);
    setErr(null);
    try {
      const r = await diyService.diy.llmConfig.probe({ baseUrl: props.api(), apiKey: props.keyValue() });
      if (!r.ok) { setErr(r.error ?? "拉取失败"); setList([]); }
      else setList(r.models.map((m) => ({ id: m.id, name: m.name, checked: true })));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };
  const shown = () => {
    const s = q().trim().toLowerCase();
    return list().filter((m) => !s || m.id.toLowerCase().includes(s) || (m.name ?? "").toLowerCase().includes(s));
  };

  return (
    <div class="space-y-1">
      <div class="flex gap-2 items-center">
        <button class="btn btn-xs btn-outline" disabled={busy()} onClick={() => void fetchList()}>
          {busy() ? "获取中…" : "获取可用模型"}
        </button>
        <Show when={err()}>
          <span class="text-error text-xs">{err()}</span>
        </Show>
      </div>
      <Show when={open()}>
        <div class="border rounded-box p-2 bg-base-200 space-y-1">
          <div class="flex gap-2 items-center">
            <input class="input input-bordered input-xs flex-1" placeholder="🔍 搜索模型" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
            <button class="btn btn-xs" onClick={() => setList((l) => l.map((m) => ({ ...m, checked: true })))}>全选</button>
            <button class="btn btn-xs" onClick={() => setList((l) => l.map((m) => ({ ...m, checked: false })))}>取消全选</button>
          </div>
          <div class="max-h-56 overflow-y-auto">
            <Index each={shown()}>
              {(m) => (
                <label class="flex items-center gap-2 px-1 py-0.5 hover:bg-base-100">
                  <input
                    type="checkbox"
                    class="checkbox checkbox-xs"
                    checked={m().checked}
                    onChange={(e) => setList((l) => {
                      const target = m().id;
                      return l.map((x) => (x.id === target ? { ...x, checked: e.currentTarget.checked } : x));
                    })}
                  />
                  <code class="text-xs">{m().id}</code>
                  <Show when={m().name}><span class="text-xs opacity-60">{m().name}</span></Show>
                </label>
              )}
            </Index>
          </div>
          <div class="flex justify-end gap-2">
            <button class="btn btn-xs" onClick={() => setOpen(false)}>取消</button>
            <button
              class="btn btn-xs btn-primary"
              onClick={() => {
                props.onAdd(list().filter((m) => m.checked).map((m) => ({ id: m.id, name: m.name, context: 0, output: 0, reasoning: false })));
                setOpen(false);
              }}
            >
              加入所选（{list().filter((m) => m.checked).length}）
            </button>
          </div>
        </div>
      </Show>
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
      <div class="text-xs opacity-60">创建后再进卡片「获取可用模型」或用 /models 拉清单。</div>
      <div class="flex gap-2">
        <button class="btn btn-sm btn-primary" onClick={create}>创建</button>
        <button class="btn btn-sm" onClick={props.onCancel}>取消</button>
      </div>
    </div>
  );
}
