// components/ModelConfigPage.tsx — 模型 provider 配置（直译 $DIY_HOME/model.yaml）
//
// 结构 = 配置形式：stdProviders（models.dev snapshot）/ customProviders 两组卡片，
// 卡片内 accounts → filter → 模型清单（勾选启用 + 逐模型覆盖），底部 custom spec 编辑。
// 「添加 provider」即时落盘（否则 read 拿不到新 provider 的模型清单）；其余编辑攒 dirty → [保存]。
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type {
  Account,
  CatalogEntry,
  CustomSpecsFile,
  LlmConfigView,
  ModelConfigFile,
  ModelOverride,
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

export function ModelConfigPage() {
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [view, setView] = createSignal<LlmConfigView | null>(null);
  const [file, setFile] = createSignal<ModelConfigFile>({ stdProviders: {}, customProviders: {} });
  const [specs, setSpecs] = createSignal<CustomSpecsFile>({});
  const [specForm, setSpecForm] = createSignal<{ key: string; isNew: boolean } | null>(null);

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

  /** 保存（write + 脏 spec 逐条 writeSpec + 重新 read） */
  const save = async () => {
    setSaving(true);
    try {
      await diyService.diy.llmConfig.write({ modelFile: file() });
      // custom spec 脏项：与 read 基线比对
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

  /** 添加 std provider：账号占位 = `$ENV[0]`（合法值），即刻落盘让卡片出现 */
  const addStd = async (id: string) => {
    const cat = view()?.catalog.find((c) => c.id === id);
    const next = structuredClone(file());
    next.stdProviders[id] = {
      accounts: [{ type: "apiKey", data: { value: cat?.env[0] ? `$${cat.env[0]}` : "PASTE_KEY_HERE" } }],
      filter: { include: [], exclude: [] },
    };
    setFile(next);
    try {
      await diyService.diy.llmConfig.write({ modelFile: next });
      await reload();
      notificationStore.addToast("success", `已添加 ${id}`);
    } catch (e) {
      notificationStore.addToast("error", e instanceof Error ? e.message : "添加失败");
    }
  };

  const unconfigured = createMemo<CatalogEntry[]>(() => {
    const v = view();
    if (!v) return [];
    const used = new Set(Object.keys(file().stdProviders));
    return v.catalog.filter((c) => !used.has(c.id));
  });

  const cards = createMemo(() => {
    const v = view();
    const f = file();
    const bases = new Map((v?.providers ?? []).map((p) => [`${p.kind}:${p.key}`, p]));
    return [
      ...Object.entries(f.stdProviders).map(([key, cfg]) => ({ kind: "std" as const, key, cfg, base: bases.get(`std:${key}`) })),
      ...Object.entries(f.customProviders).map(([key, cfg]) => ({ kind: "custom" as const, key, cfg, base: bases.get(`custom:${key}`) })),
    ];
  });

  return (
    <div class="p-4 space-y-3 overflow-y-auto h-full">
      <div class="flex items-center justify-between">
        <div class="text-title font-bold">🤖 模型 provider 配置</div>
        <div class="flex gap-2 items-center">
          <code class="text-body opacity-50 text-xs">~/.diy/model.yaml</code>
          <button class="btn btn-sm" disabled={loading() || !dirty()} onClick={save}>
            {saving() ? "保存中…" : dirty() ? "保存" : "已保存"}
          </button>
        </div>
      </div>
      <div class="text-body opacity-60 text-xs">
        账号密钥支持 <code>$ENV</code> 插值（未定义会报错）；模型清单来自 models.dev snapshot 与
        providers.custom.yaml，勾选即启用/隐藏。
      </div>

      <Show when={!loading()} fallback={<div class="text-body opacity-50">加载中…</div>}>
        {/* ── stdProviders ── */}
        <div class="text-title font-semibold mt-2">models.dev provider（snapshot）</div>
        <Show when={unconfigured().length > 0}>
          <select
            class="select select-bordered select-sm w-full max-w-md"
            value=""
            onChange={(e) => {
              const id = e.currentTarget.value;
              if (id) void addStd(id);
              e.currentTarget.value = "";
            }}
          >
            <option value="" disabled>
              ＋ 添加 provider（来自 models.dev）…
            </option>
            <For each={unconfigured()}>
              {(c) => (
                <option value={c.id}>
                  {c.id}
                  {c.name ? ` — ${c.name}` : ""}
                </option>
              )}
            </For>
          </select>
        </Show>
        <For each={cards().filter((c) => c.kind === "std")}>{(c) => <ProviderCard card={c} file={file} mutate={mutateFile} view={view} specs={specs} setSpecForm={setSpecForm} />}</For>

        {/* ── customProviders ── */}
        <div class="text-title font-semibold mt-4">自定义 provider</div>
        <For each={cards().filter((c) => c.kind === "custom")}>{(c) => <ProviderCard card={c} file={file} mutate={mutateFile} view={view} specs={specs} setSpecForm={setSpecForm} />}</For>
        <Show when={specForm() === null}>
          <button class="btn btn-sm btn-outline" onClick={() => setSpecForm({ key: "", isNew: true })}>
            ＋ 新增 custom provider
          </button>
        </Show>
        <Show when={specForm()}>
          {(form) => (
            <SpecForm
              initial={form().isNew ? null : (specs()[form().key] ?? null)}
              key={form().key}
              specs={specs}
              setSpecs={setSpecs}
              mutateFile={mutateFile}
              close={() => setSpecForm(null)}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

// ── 单个 provider 卡片 ──────────────────────────────────────────

type Card = { kind: "std" | "custom"; key: string; cfg: ProviderConfig };

function ProviderCard(props: {
  card: Card;
  file: () => ModelConfigFile;
  mutate: (fn: (f: ModelConfigFile) => void) => void;
  view: () => LlmConfigView | null;
  specs: () => CustomSpecsFile;
  setSpecForm: (v: { key: string; isNew: boolean } | null) => void;
}) {
  const base = () => props.view()?.providers.find((p) => p.kind === props.card.kind && p.key === props.card.key);
  const limited = () => (props.card.kind === "custom" ? `custom:${props.card.key}` : props.card.key);
  const mode = () => modeOf(props.card.cfg.filter);

  /** 与 view（保存态）合并的模型清单：view 有以 view 为基，新添加的先空（read 后就有） */
  const models = () => base()?.models ?? [];

  const setFilter = (m: FilterMode) => {
    const ms = models();
    props.mutate((f) => {
      const cfg = cfgOf(f);
      if (!cfg) return;
      if (m === "all") cfg.filter = { include: [], exclude: [] };
      else if (m === "include") cfg.filter = { include: ms.filter((x) => filterAllows(cfg.filter ?? { include: [], exclude: [] }, x.id)).map((x) => x.id), exclude: [] };
      else cfg.filter = { include: [], exclude: ms.filter((x) => !filterAllows(cfg.filter ?? { include: [], exclude: [] }, x.id)).map((x) => x.id) };
    });
  };

  const toggle = (id: string) => {
    const m = mode();
    if (m === "all") return;
    props.mutate((f) => {
      const cfg = cfgOf(f);
      if (!cfg) return;
      const flt = cfg.filter ?? { include: [], exclude: [] };
      const list = m === "include" ? flt.include : flt.exclude;
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
      else list.push(id);
      cfg.filter = flt;
    });
  };

  /** 定位到本卡片在编辑态里的段 */
  const cfgOf = (f: ModelConfigFile): ProviderConfig | undefined =>
    props.card.kind === "std" ? f.stdProviders[props.card.key] : f.customProviders[props.card.key];

  const editCfg = (fn: (c: ProviderConfig) => void) => {
    props.mutate((f) => {
      const cfg = cfgOf(f);
      if (cfg) fn(cfg);
    });
  };

  /** 移除整个 provider 段（std/custom 同法）；custom spec 保留在 providers.custom.yaml（下次再加不用重填） */
  const removeProvider = () => {
    if (!confirm(`移除 provider「${props.card.key}」？（模型选择随之消失；custom spec 保留）`)) return;
    props.mutate((f) => {
      if (props.card.kind === "std") delete f.stdProviders[props.card.key];
      else delete f.customProviders[props.card.key];
    });
  };

  return (
    <div class="card border bg-base-100 p-3 space-y-2">
      {/* 头 */}
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-semibold">{props.card.key}</span>
        <code class="text-xs opacity-60">{limited()}</code>
        <Show when={props.card.kind === "custom"}>
          <span class="badge badge-outline badge-sm">custom</span>
          <button class="btn btn-xs" onClick={() => props.setSpecForm({ key: props.card.key, isNew: false })}>
            编辑 spec
          </button>
        </Show>
        <span class="flex-1" />
        <button class="btn btn-xs btn-error btn-outline" onClick={removeProvider}>
          移除
        </button>
        <span class={`badge badge-sm ${base()?.usable ? "badge-success" : "badge-warning"}`}>
          {base()?.usable ? "密钥可用" : base() ? "无可用密钥" : "未读到"}
        </span>
        <Show when={base() && !base()!.spec}>
          <span class="badge badge-error badge-sm">spec 缺失</span>
        </Show>
      </div>
      <Show when={base()?.spec}>
        {(s) => (
          <div class="text-xs opacity-60 flex gap-3 flex-wrap">
            <span>npm: <code>{s().npm}</code></span>
            <span>api: <code>{s().api}</code></span>
          </div>
        )}
      </Show>

      {/* accounts */}
      <div class="space-y-1">
        <div class="text-sm font-medium">账号</div>
        <For each={props.card.cfg.accounts}>
          {(acc, i) => {
            const accBase = () => base()?.accounts[i()];
            return (
              <div class="flex gap-2 items-center flex-wrap">
                <input
                  class="input input-bordered input-sm w-28"
                  placeholder={`名字(${i()})`}
                  value={acc.name ?? ""}
                  onInput={(e) => editCfg((c) => { const a = c.accounts[i()]; const v = e.currentTarget.value.trim(); if (v) a.name = v; else delete a.name; })}
                />
                <input
                  class="input input-bordered input-sm flex-1 min-w-56"
                  placeholder="$ENV 或明文"
                  value={acc.data.value}
                  onInput={(e) => editCfg((c) => { c.accounts[i()].data.value = e.currentTarget.value; })}
                />
                <code class="text-xs opacity-60">{acc.name ?? i()}@{limited()}</code>
                <Show when={accBase()?.error && accBase()?.account.data.value === acc.data.value}>
                  <span class="text-error text-xs">{accBase()!.error}</span>
                </Show>
                <Show when={props.card.cfg.accounts.length > 1}>
                  <button class="btn btn-xs" onClick={() => editCfg((c) => { c.accounts.splice(i(), 1); })}>×</button>
                </Show>
              </div>
            );
          }}
        </For>
        <button
          class="btn btn-xs btn-outline"
          onClick={() => editCfg((c) => { c.accounts.push({ type: "apiKey", data: { value: "" } } as Account); })}
        >
          ＋ 添加账号
        </button>
      </div>

      {/* filter */}
      <div class="space-y-1">
        <div class="flex gap-3 items-center text-sm">
          <span class="font-medium">模型启用</span>
          <label class="label cursor-pointer gap-1 py-0">
            <input type="radio" class="radio radio-xs" checked={mode() === "all"} onChange={() => setFilter("all")} />
            <span class="label-text text-xs">全部</span>
          </label>
          <label class="label cursor-pointer gap-1 py-0">
            <input type="radio" class="radio radio-xs" checked={mode() === "include"} onChange={() => setFilter("include")} />
            <span class="label-text text-xs">仅包含（白名单，新模型不自动进来）</span>
          </label>
          <label class="label cursor-pointer gap-1 py-0">
            <input type="radio" class="radio radio-xs" checked={mode() === "exclude"} onChange={() => setFilter("exclude")} />
            <span class="label-text text-xs">排除（黑名单）</span>
          </label>
        </div>

        {/* 模型清单 */}
        <Show when={models().length > 0} fallback={<div class="text-xs opacity-50">（无模型清单——read 后显示）</div>}>
          <table class="table table-xs">
            <thead>
              <tr>
                <th class="w-8">{mode() === "exclude" ? "排除" : "启用"}</th>
                <th>模型</th>
                <th class="w-36">context / output</th>
                <th class="w-20">面</th>
                <th class="w-20">推理</th>
                <th class="w-20">成本 $/1M</th>
                <th class="w-24">覆盖</th>
              </tr>
            </thead>
            <For each={models()}>
              {(m) => {
                const [open, setOpen] = createSignal(false);
                const enabledNow = () => {
                  const flt = props.card.cfg.filter;
                  if (mode() === "all") return true;
                  if (!flt) return true;
                  return mode() === "include" ? flt.include.includes(m.id) : !flt.exclude.includes(m.id);
                };
                const ov = () => (props.card.cfg.models ?? {})[m.id] as ModelOverride | undefined;
                return (
                  <>
                    <tr class={enabledNow() ? "" : "opacity-40"}>
                      <td>
                        <input
                          type="checkbox"
                          class="checkbox checkbox-xs"
                          disabled={mode() === "all"}
                          checked={enabledNow()}
                          onChange={() => toggle(m.id)}
                        />
                      </td>
                      <td>
                        <div class="flex gap-2 items-center flex-wrap">
                          <span class="font-mono text-xs">{m.id}</span>
                          <span class="text-xs opacity-70">{m.name}</span>
                          <Show when={m.specMissing}>
                            <span class="badge badge-error badge-xs" title="config 里有覆盖但 spec 无此模型（id 打错或 snapshot 已变）">spec无</span>
                          </Show>
                          <Show when={m.overridden}>
                            <span class="badge badge-info badge-xs">覆盖</span>
                          </Show>
                        </div>
                      </td>
                      <td class="font-mono text-xs">
                        {fmtK(m.context)} / {fmtK(m.output)}
                      </td>
                      <td class="text-xs"><code>{m.api}</code></td>
                      <td class="text-xs">{m.reasoning ? "✓" : "—"}</td>
                      <td class="text-xs">{m.cost?.input != null ? `${m.cost.input}/${m.cost.output}` : "—"}</td>
                      <td>
                        <button class="btn btn-xs" onClick={() => setOpen(!open())}>{open() ? "收起" : "⚙"}</button>
                      </td>
                    </tr>
                    <Show when={open()}>
                      <tr>
                        <td colspan={7}>
                          <OverrideEditor
                            value={ov()}
                            onSave={(o) => editCfg((c) => {
                              const map = (c.models ??= {});
                              if (o) map[m.id] = o;
                              else delete map[m.id];
                            })}
                          />
                        </td>
                      </tr>
                    </Show>
                  </>
                );
              }}
            </For>
          </table>
        </Show>
      </div>
    </div>
  );
}

function fmtK(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 逐模型覆盖编辑（白名单字段：name / api 面 / limit / reasoning 档位 / cost） */
function OverrideEditor(props: { value: ModelOverride | undefined; onSave: (o: ModelOverride | null) => void }) {
  const [name, setName] = createSignal(props.value?.name ?? "");
  const [ctx, setCtx] = createSignal(props.value?.limit?.context != null ? String(props.value.limit.context) : "");
  const [out, setOut] = createSignal(props.value?.limit?.output != null ? String(props.value.limit.output) : "");
  const [cin, setCin] = createSignal(props.value?.cost?.input != null ? String(props.value.cost.input) : "");
  const [cout, setCout] = createSignal(props.value?.cost?.output != null ? String(props.value.cost.output) : "");
  const [sup, setSup] = createSignal(props.value?.reasoning?.supported.join(", ") ?? "");
  const [def, setDef] = createSignal(props.value?.reasoning?.default ?? "");

  const commit = () => {
    const o: ModelOverride = {};
    if (name().trim()) o.name = name().trim();
    const limit: NonNullable<ModelOverride["limit"]> = {};
    if (ctx().trim()) limit.context = Number(ctx());
    if (out().trim()) limit.output = Number(out());
    if (limit.context || limit.output) o.limit = limit;
    const cost: NonNullable<ModelOverride["cost"]> = { input: 0, output: 0 };
    if (cin().trim() && cout().trim()) { cost.input = Number(cin()); cost.output = Number(cout()); o.cost = cost; }
    const supported = sup().split(",").map((s) => s.trim()).filter(Boolean);
    if (supported.length && def().trim()) o.reasoning = { supported, default: def().trim() };
    props.onSave(Object.keys(o).length ? o : null);
  };

  return (
    <div class="grid grid-cols-2 md:grid-cols-6 gap-2 p-2 bg-base-200 rounded items-end">
      <label class="form-control">
        <span class="label-text text-xs">显示名</span>
        <input class="input input-bordered input-xs" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="form-control">
        <span class="label-text text-xs">context</span>
        <input class="input input-bordered input-xs" placeholder="如 200000" value={ctx()} onInput={(e) => setCtx(e.currentTarget.value)} />
      </label>
      <label class="form-control">
        <span class="label-text text-xs">output</span>
        <input class="input input-bordered input-xs" placeholder="如 32768" value={out()} onInput={(e) => setOut(e.currentTarget.value)} />
      </label>
      <label class="form-control">
        <span class="label-text text-xs">成本 input/output</span>
        <div class="flex gap-1">
          <input class="input input-bordered input-xs w-14" placeholder="in" value={cin()} onInput={(e) => setCin(e.currentTarget.value)} />
          <input class="input input-bordered input-xs w-14" placeholder="out" value={cout()} onInput={(e) => setCout(e.currentTarget.value)} />
        </div>
      </label>
      <label class="form-control">
        <span class="label-text text-xs">档位 supported</span>
        <input class="input input-bordered input-xs" placeholder="none, low, …" value={sup()} onInput={(e) => setSup(e.currentTarget.value)} />
      </label>
      <label class="form-control">
        <span class="label-text text-xs">档位 default</span>
        <div class="flex gap-1">
          <input class="input input-bordered input-xs" placeholder="medium" value={def()} onInput={(e) => setDef(e.currentTarget.value)} />
          <button class="btn btn-xs" onClick={commit}>存</button>
          <Show when={props.value}>
            <button class="btn btn-xs btn-ghost" onClick={() => props.onSave(null)}>清</button>
          </Show>
        </div>
      </label>
    </div>
  );
}

// ── custom spec 表单（providers.custom.yaml 单条；字段 = models.dev 条目同构） ──

function SpecForm(props: {
  key: string;
  initial: SpecProvider | null;
  specs: () => CustomSpecsFile;
  setSpecs: (fn: (s: CustomSpecsFile) => void) => void;
  mutateFile: (fn: (f: ModelConfigFile) => void) => void;
  close: () => void;
}) {
  const init = props.initial;
  const [id, setId] = createSignal(init?.id ?? props.key);
  const [name, setName] = createSignal(init?.name ?? "");
  const [npm, setNpm] = createSignal(init?.npm ?? "@ai-sdk/openai-compatible");
  const [api, setApi] = createSignal(init?.api ?? "");
  const [env, setEnv] = createSignal((init?.env ?? []).join(", "));
  const [models, setModels] = createSignal<{ id: string; name: string; context: string; output: string; reasoning: boolean }[]>(
    Object.entries(init?.models ?? {}).map(([mid, m]) => ({
      id: mid,
      name: (m as { name?: string }).name ?? "",
      context: String((m as { limit?: { context?: number } }).limit?.context ?? ""),
      output: String((m as { limit?: { output?: number } }).limit?.output ?? ""),
      reasoning: (m as { reasoning?: boolean }).reasoning ?? false,
    })),
  );
  const [apiKey, setApiKey] = createSignal(props.initial ? "" : "");

  const commit = async () => {
    const key = id().trim();
    if (!key || !api().trim()) { notificationStore.addToast("error", "id 与 api 必填"); return; }
    const spec: SpecProvider = {
      id: key,
      name: name().trim() || undefined,
      npm: npm().trim(),
      api: api().trim(),
      env: env().split(",").map((s) => s.trim()).filter(Boolean),
      models: Object.fromEntries(
        models()
          .filter((m) => m.id.trim())
          .map((m) => [m.id.trim(), {
            id: m.id.trim(),
            name: m.name.trim() || m.id.trim(),
            reasoning: m.reasoning,
            tool_call: true,
            limit: {
              ...(m.context.trim() ? { context: Number(m.context) } : {}),
              ...(m.output.trim() ? { output: Number(m.output) } : {}),
            },
          }]),
      ),
    };
    props.setSpecs((s) => { s[key] = spec; });
    // 配置段（若还没有）：账号占位
    const val = apiKey().trim() || (spec.env?.[0] ? `$${spec.env[0]}` : "PASTE_KEY_HERE");
    props.mutateFile((f) => {
      if (!f.customProviders[key]) {
        f.customProviders[key] = { accounts: [{ type: "apiKey", data: { value: val } }], filter: { include: [], exclude: [] } };
      }
    });
    props.close();
    notificationStore.addToast("success", "已编辑（点「保存」落盘）");
  };

  return (
    <div class="card border p-3 bg-base-200 space-y-2">
      <div class="text-sm font-semibold">{init ? `编辑 spec：${props.key}` : "新增 custom provider"}</div>
      <div class="grid grid-cols-2 md:grid-cols-5 gap-2">
        <label class="form-control"><span class="label-text text-xs">id（裸，不带 custom:）</span>
          <input class="input input-bordered input-xs" disabled={!!init} value={id()} onInput={(e) => setId(e.currentTarget.value)} /></label>
        <label class="form-control"><span class="label-text text-xs">name</span>
          <input class="input input-bordered input-xs" value={name()} onInput={(e) => setName(e.currentTarget.value)} /></label>
        <label class="form-control"><span class="label-text text-xs">npm（面）</span>
          <input class="input input-bordered input-xs" value={npm()} onInput={(e) => setNpm(e.currentTarget.value)} /></label>
        <label class="form-control"><span class="label-text text-xs">api（baseUrl，必填）</span>
          <input class="input input-bordered input-xs" placeholder="https://…/v1" value={api()} onInput={(e) => setApi(e.currentTarget.value)} /></label>
        <label class="form-control"><span class="label-text text-xs">env（逗号）</span>
          <input class="input input-bordered input-xs" placeholder="GOAT_API_KEY" value={env()} onInput={(e) => setEnv(e.currentTarget.value)} /></label>
      </div>
      <Show when={!init}>
        <label class="form-control max-w-md"><span class="label-text text-xs">apiKey（$ENV 或明文）</span>
          <input class="input input-bordered input-xs" placeholder="$GOAT_KEY" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)} /></label>
      </Show>

      {/* models 表 */}
      <div class="text-xs font-medium">模型（models.dev 同构）</div>
      <table class="table table-xs">
        <thead><tr><th>id</th><th>name</th><th>context</th><th>output</th><th>reasoning</th><th /></tr></thead>
        <For each={models()}>
          {(m, i) => (
            <tr>
              <td><input class="input input-bordered input-xs font-mono" value={m.id} onInput={(e) => setModels((arr) => { arr[i()].id = e.currentTarget.value; return [...arr]; })} /></td>
              <td><input class="input input-bordered input-xs" value={m.name} onInput={(e) => setModels((arr) => { arr[i()].name = e.currentTarget.value; return [...arr]; })} /></td>
              <td><input class="input input-bordered input-xs w-24" placeholder="200000" value={m.context} onInput={(e) => setModels((arr) => { arr[i()].context = e.currentTarget.value; return [...arr]; })} /></td>
              <td><input class="input input-bordered input-xs w-24" placeholder="32768" value={m.output} onInput={(e) => setModels((arr) => { arr[i()].output = e.currentTarget.value; return [...arr]; })} /></td>
              <td><input type="checkbox" class="checkbox checkbox-xs" checked={m.reasoning} onChange={(e) => setModels((arr) => { arr[i()].reasoning = e.currentTarget.checked; return [...arr]; })} /></td>
              <td><button class="btn btn-xs" onClick={() => setModels((arr) => arr.filter((_, j) => j !== i()))}>×</button></td>
            </tr>
          )}
        </For>
      </table>
      <button class="btn btn-xs btn-outline" onClick={() => setModels((arr) => [...arr, { id: "", name: "", context: "", output: "", reasoning: false }])}>
        ＋ 添加模型
      </button>
      <div class="flex gap-2">
        <button class="btn btn-sm btn-primary" onClick={() => void commit()}>完成（入编辑态）</button>
        <button class="btn btn-sm" onClick={props.close}>取消</button>
      </div>
    </div>
  );
}
