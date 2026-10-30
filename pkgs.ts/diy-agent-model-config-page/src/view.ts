// view.ts — 页面插件的 renderer 侧：provider / 模型 / 账号 / 当前选择。
//
// 只做展示与转发：整页状态来自 `ctx.invoke('snapshot')`，每次写操作后再拿一份新快照重画。
// 本文件不认识 Electron / IPC / 文件系统，也拿不到任何算法 —— key 只从 `<input type=password>`
// 单向送进主进程，回来后只有 `{ chars }`。
//
// 硬规则（##467 判据 3）：**任何情况下都不把 key 写进 DOM**。页面上关于 key 的文字只有
// 「未设置 / 已设置（N 字符）/ 已设置（环境变量）」，输入框写后立刻清空。

import type { PageContext, PageView } from '@diy-agent/workbench-ui';
import { accountLabel, groupModels, modelKeyOf, savedAccountLabel } from './format.js';
import type { AccountStateView, ConfigSnapshot, ModelView, ProviderView, WriteResult } from './shared.js';

const STYLE_ID = 'model-config-page-style';
const STYLE = `
.mc-page { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; }
.mc-head { flex: none; display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid #e4e7eb; }
.mc-title { font-size: 15px; font-weight: 600; }
.mc-home { flex: 1; font-size: 12px; color: #8b95a1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-btn { appearance: none; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.mc-btn:disabled { color: #a9b7cc; cursor: default; }
.mc-btn[data-danger="true"] { border-color: #e3b4b4; color: #b23b3b; }
.mc-status { flex: none; padding: 0 20px; font-size: 12px; color: #4b5563; min-height: 20px; line-height: 20px; }
.mc-status[data-kind="error"] { color: #b23b3b; }
.mc-body { flex: 1; min-height: 0; overflow: auto; padding: 0 20px 24px; }
.mc-section { margin-top: 18px; }
.mc-section-title { font-size: 13px; font-weight: 600; color: #1f2937; margin: 0 0 8px; }
.mc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.mc-table th, .mc-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef0f3; vertical-align: middle; }
.mc-table th { color: #6b7280; font-weight: 500; font-size: 12px; }
.mc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.mc-muted { color: #8b95a1; }
.mc-input { padding: 4px 8px; border: 1px solid #d3d8de; border-radius: 6px; font: inherit; font-size: 13px; box-sizing: border-box; }
.mc-input:focus { outline: 2px solid #b9c9e4; outline-offset: 0; }
.mc-name { width: 100%; min-width: 120px; }
.mc-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0 4px; }
.mc-account-row td { border-bottom: 1px dashed #eef0f3; }
.mc-key { width: 200px; }
`;

/** 页面方法 + 统一的 busy / 提示包装（各区块只依赖这一小撮能力） */
interface PageApi {
    invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
    /** 写操作：禁用刷新 → invoke → 提示；错误只显示 message（永远不含 key） */
    act<T>(label: string, task: () => Promise<T>, done: (result: T) => string): Promise<void>;
}

export const modelConfigPageView: PageView = {
    id: 'model-config',
    title: '模型配置',
    render(root: HTMLElement, ctx: PageContext): () => void {
        const doc = root.ownerDocument;
        ensureStyle(doc);
        root.replaceChildren();

        const page = el(doc, 'div', 'mc-page');
        const head = el(doc, 'div', 'mc-head');
        const title = el(doc, 'span', 'mc-title');
        title.textContent = '模型配置';
        const homeText = el(doc, 'code', 'mc-home');
        homeText.textContent = '加载中…';
        const refresh = el(doc, 'button', 'mc-btn') as HTMLButtonElement;
        refresh.type = 'button';
        refresh.textContent = '刷新';
        head.append(title, homeText, refresh);

        const status = el(doc, 'div', 'mc-status');
        const body = el(doc, 'div', 'mc-body');
        page.append(head, status, body);
        root.append(page);

        let busy = false;
        const setStatus = (text: string, kind?: 'error'): void => {
            status.textContent = text;
            if (kind === 'error') status.dataset['kind'] = 'error';
            else delete status.dataset['kind'];
        };

        const api: PageApi = {
            invoke: <T>(method: string, args?: unknown) => ctx.invoke<T>(method, args),
            act: async <T>(label: string, task: () => Promise<T>, done: (result: T) => string) => {
                if (busy) {
                    setStatus('上一个操作还没结束…', 'error');
                    return;
                }
                busy = true;
                refresh.disabled = true;
                setStatus(`${label}…`);
                try {
                    const result = await task();
                    setStatus(done(result));
                } catch (cause) {
                    setStatus(`${label}失败：${messageOf(cause)}`, 'error');
                } finally {
                    busy = false;
                    refresh.disabled = false;
                }
            },
        };

        const paint = (snapshot: ConfigSnapshot): void => {
            homeText.textContent = `数据根：${snapshot.home}`;
            body.replaceChildren(
                defaultSection(doc, snapshot, api),
                providerSection(doc, snapshot, api),
                modelSection(doc, snapshot, api),
                accountSection(doc, snapshot, api),
            );
        };

        const load = (): void => {
            void api.act(
                '读取配置',
                () => api.invoke<ConfigSnapshot>('snapshot'),
                (snapshot) => {
                    paint(snapshot);
                    return `已加载 ${snapshot.providers.length} 个 provider、${snapshot.models.length} 个模型`;
                },
            );
        };

        refresh.addEventListener('click', load);
        load();

        return () => {
            root.replaceChildren();
        };
    },
};

export default modelConfigPageView;

// ── 各区块（快照 + PageApi 进，DOM 出） ────────────

function defaultSection(doc: Document, snapshot: ConfigSnapshot, api: PageApi): HTMLElement {
    const section = el(doc, 'section', 'mc-section');
    section.append(titleNode(doc, '当前选择'));
    const line = el(doc, 'div', 'mc-add');
    const select = el(doc, 'select', 'mc-input') as HTMLSelectElement;
    const none = doc.createElement('option');
    none.value = '';
    none.textContent = '（未设置）';
    select.append(none);
    for (const model of snapshot.models) {
        const option = doc.createElement('option');
        option.value = modelKeyOf(model.providerId, model.modelId);
        option.textContent = `${model.providerId} · ${model.name}`;
        select.append(option);
    }
    select.value = snapshot.defaultModel ?? '';
    select.addEventListener('change', () => {
        const modelKey = select.value === '' ? null : select.value;
        void api.act(
            '保存默认模型',
            () => api.invoke<ConfigSnapshot>('saveDefaultModel', { modelKey }),
            () => '默认模型已保存（写入 model.yaml 的 defaultModel）',
        );
    });
    line.append(select);
    section.append(line);
    return section;
}

function providerSection(doc: Document, snapshot: ConfigSnapshot, api: PageApi): HTMLElement {
    const section = el(doc, 'section', 'mc-section');
    section.append(titleNode(doc, 'Provider'));

    const table = el(doc, 'table', 'mc-table');
    const thead = doc.createElement('thead');
    const hr = doc.createElement('tr');
    for (const text of ['id', '类型', 'api', 'npm', '模型数', '账号', '操作']) {
        const th = doc.createElement('th');
        th.textContent = text;
        hr.append(th);
    }
    thead.append(hr);
    const tbody = doc.createElement('tbody');
    for (const provider of snapshot.providers) {
        const tr = doc.createElement('tr');
        tr.append(
            cell(doc, provider.providerId, 'mc-mono'),
            cell(doc, provider.kind),
            cell(doc, provider.api ?? '（未写 api）', 'mc-mono'),
            cell(doc, provider.npm ?? '—', 'mc-mono'),
            cell(doc, String(provider.modelCount)),
            cell(doc, String(provider.accounts.length)),
        );
        const actions = doc.createElement('td');
        const remove = el(doc, 'button', 'mc-btn') as HTMLButtonElement;
        remove.type = 'button';
        remove.textContent = '删除';
        remove.dataset['danger'] = 'true';
        remove.addEventListener('click', () => {
            if (!confirmIfPossible(doc, `删除 provider「${provider.providerId}」？`)) return;
            void api.act(
                '删除 provider',
                () => api.invoke<ConfigSnapshot>('removeProvider', { providerId: provider.providerId }),
                () => `已删除 provider「${provider.providerId}」`,
            );
        });
        actions.append(remove);
        tr.append(actions);
        tbody.append(tr);
    }
    table.append(thead, tbody);
    section.append(table);

    // 新增 / 更新 provider（custom spec）
    const form = el(doc, 'div', 'mc-add');
    const idInput = input(doc, 'id', '（provider id）');
    const apiInput = input(doc, 'api', 'https://…（custom 的 api）');
    const npmInput = input(doc, 'npm', '@ai-sdk/openai-compatible');
    const add = el(doc, 'button', 'mc-btn') as HTMLButtonElement;
    add.type = 'button';
    add.textContent = '添加 / 更新';
    add.addEventListener('click', () => {
        const providerId = idInput.value.trim();
        if (providerId === '') {
            setError(api, 'provider id 不能为空');
            return;
        }
        const spec: Record<string, string> = {};
        if (apiInput.value.trim() !== '') spec['api'] = apiInput.value.trim();
        if (npmInput.value.trim() !== '') spec['npm'] = npmInput.value.trim();
        const existing = snapshot.providers.find((item) => item.providerId === providerId);
        const kind = existing?.kind ?? 'custom';
        void api.act(
            '保存 provider',
            () =>
                api.invoke<ConfigSnapshot>('saveProvider', {
                    providerId,
                    kind,
                    ...(Object.keys(spec).length === 0 ? {} : { spec }),
                }),
            () => `已保存 provider「${providerId}」`,
        );
    });
    form.append(idInput, apiInput, npmInput, add);
    section.append(form);
    return section;
}

function modelSection(doc: Document, snapshot: ConfigSnapshot, api: PageApi): HTMLElement {
    const section = el(doc, 'section', 'mc-section');
    section.append(titleNode(doc, '模型（改 name 后保存即写回 model.yaml 覆盖）'));
    if (snapshot.models.length === 0) {
        const empty = el(doc, 'div', 'mc-muted');
        empty.textContent =
            '目录里没有可用模型 —— 先给 provider 写 api（custom 还要在 providers.custom.yaml 写 models）。';
        section.append(empty);
        return section;
    }
    const grouped = groupModels(snapshot.models);
    for (const [providerId, models] of grouped) {
        const caption = el(doc, 'div', 'mc-muted');
        caption.textContent = `${providerId} · ${models.length} 个模型`;
        const table = el(doc, 'table', 'mc-table');
        const thead = doc.createElement('thead');
        const hr = doc.createElement('tr');
        for (const text of ['模型 id', 'name', 'contextWindow', 'cost（input/output）', '操作']) {
            const th = doc.createElement('th');
            th.textContent = text;
            hr.append(th);
        }
        thead.append(hr);
        const tbody = doc.createElement('tbody');
        for (const model of models) tbody.append(modelRow(doc, model, api));
        table.append(thead, tbody);
        section.append(caption, table);
    }
    return section;
}

function modelRow(doc: Document, model: ModelView, api: PageApi): HTMLTableRowElement {
    const tr = doc.createElement('tr');
    const nameInput = input(doc, 'name');
    nameInput.value = model.name;
    nameInput.className = 'mc-input mc-name';
    nameInput.dataset['model'] = model.modelId;
    const save = el(doc, 'button', 'mc-btn') as HTMLButtonElement;
    save.type = 'button';
    save.textContent = '保存';
    save.dataset['action'] = 'save-model';
    save.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (name === '') {
            setError(api, '模型 name 不能为空');
            return;
        }
        void api.act(
            '保存模型',
            () =>
                api.invoke<ConfigSnapshot>('saveProvider', {
                    providerId: model.providerId,
                    models: { [model.modelId]: { name } },
                }),
            () => `已保存 ${model.providerId}/${model.modelId} 的 name`,
        );
    });
    const actions = doc.createElement('td');
    actions.append(save);
    tr.append(
        cell(doc, model.modelId, 'mc-mono'),
        tdWith(doc, nameInput),
        cell(doc, model.contextWindow === undefined ? '—' : String(model.contextWindow)),
        cell(doc, model.cost === undefined ? '—' : `${model.cost.input} / ${model.cost.output}`),
        actions,
    );
    return tr;
}

function accountSection(doc: Document, snapshot: ConfigSnapshot, api: PageApi): HTMLElement {
    const section = el(doc, 'section', 'mc-section');
    section.append(titleNode(doc, '账号（key 只写不回显）'));
    const table = el(doc, 'table', 'mc-table');
    const tbody = doc.createElement('tbody');
    for (const provider of snapshot.providers) {
        tbody.append(accountHeaderRow(doc, provider));
        for (const account of provider.accounts) tbody.append(accountRow(doc, provider, account, api));
        tbody.append(newAccountRow(doc, provider, api));
    }
    table.append(tbody);
    section.append(table);
    return section;
}

function accountHeaderRow(doc: Document, provider: ProviderView): HTMLTableRowElement {
    const tr = doc.createElement('tr');
    const th = doc.createElement('th');
    th.colSpan = 4;
    th.textContent = `${provider.providerId}（${provider.kind}）`;
    tr.append(th);
    return tr;
}

function accountRow(
    doc: Document,
    provider: ProviderView,
    account: AccountStateView,
    api: PageApi,
): HTMLTableRowElement {
    return keyRow(doc, provider, account.name, accountLabel(account), api);
}

function newAccountRow(doc: Document, provider: ProviderView, api: PageApi): HTMLTableRowElement {
    const tr = doc.createElement('tr');
    tr.className = 'mc-account-row';
    const nameInput = input(doc, 'name', '新账号名');
    const keyInput = keyField(doc);
    const save = el(doc, 'button', 'mc-btn') as HTMLButtonElement;
    save.type = 'button';
    save.textContent = '新增';
    save.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (name === '') {
            setError(api, '账号名不能为空');
            return;
        }
        submitKey(provider, name, keyInput, api);
    });
    const actions = doc.createElement('td');
    actions.append(save);
    tr.append(tdWith(doc, nameInput), cell(doc, '未设置', 'mc-muted'), tdWith(doc, keyInput), actions);
    return tr;
}

function keyRow(doc: Document, provider: ProviderView, name: string, label: string, api: PageApi): HTMLTableRowElement {
    const tr = doc.createElement('tr');
    tr.className = 'mc-account-row';
    const keyInput = keyField(doc);
    const save = el(doc, 'button', 'mc-btn') as HTMLButtonElement;
    save.type = 'button';
    save.textContent = '设置 key';
    save.addEventListener('click', () => submitKey(provider, name, keyInput, api));
    const actions = doc.createElement('td');
    actions.append(save);
    const labelCell = cell(doc, label, 'mc-muted');
    labelCell.dataset['account'] = name;
    tr.append(cell(doc, name, 'mc-mono'), labelCell, tdWith(doc, keyInput), actions);
    return tr;
}

function submitKey(provider: ProviderView, name: string, keyInput: HTMLInputElement, api: PageApi): void {
    const value = keyInput.value;
    if (value.trim() === '') {
        setError(api, 'key 不能为空');
        return;
    }
    void api.act(
        '保存 key',
        () => api.invoke<WriteResult>('saveAccount', { providerId: provider.providerId, name, value }),
        (result) => {
            keyInput.value = '';
            const saved = result.saved;
            return saved === undefined
                ? `已保存 ${provider.providerId}/${name} 的 key`
                : `${provider.providerId}/${name}：${savedAccountLabel(saved)}`;
        },
    );
}

function setError(api: PageApi, message: string): void {
    void api.act(
        '校验',
        () => Promise.reject(new Error(message)),
        () => message,
    );
}

// ── DOM 小工具 ───────────────────────────────────

function el(doc: Document, tag: string, className = ''): HTMLElement {
    const node = doc.createElement(tag);
    if (className !== '') node.className = className;
    return node;
}

function titleNode(doc: Document, text: string): HTMLElement {
    const node = el(doc, 'h2', 'mc-section-title');
    node.textContent = text;
    return node;
}

function cell(doc: Document, text: string, className = ''): HTMLTableCellElement {
    const td = doc.createElement('td');
    if (className !== '') td.className = className;
    td.textContent = text;
    return td;
}

function tdWith(doc: Document, child: HTMLElement): HTMLTableCellElement {
    const td = doc.createElement('td');
    td.append(child);
    return td;
}

function input(doc: Document, name: string, placeholder = ''): HTMLInputElement {
    const node = doc.createElement('input');
    node.type = 'text';
    node.className = 'mc-input';
    node.name = name;
    if (placeholder !== '') node.placeholder = placeholder;
    return node;
}

function keyField(doc: Document): HTMLInputElement {
    const node = doc.createElement('input');
    node.type = 'password';
    node.className = 'mc-input mc-key';
    node.autocomplete = 'off';
    node.placeholder = '输入新 key（写入后不回显）';
    return node;
}

function confirmIfPossible(doc: Document, message: string): boolean {
    const view = doc.defaultView;
    return view?.confirm === undefined ? true : view.confirm(message);
}

function messageOf(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

function ensureStyle(doc: Document): void {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.append(style);
}
