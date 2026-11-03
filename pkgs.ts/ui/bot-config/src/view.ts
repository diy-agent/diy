// view.ts — 页面插件的 renderer 侧：bot 列表 / 身份编辑 / 测试对话。
//
// 只做展示与转发：整页状态来自 `ctx.invoke('snapshot')`，每个写操作后再拿一份新快照重画。
// 本文件不认识 Electron / IPC / 文件系统；**测试对话的会话在主进程里、只在内存里**，
// 这里拿到的只有 `{ role, text }[]`（页面上明说「不落盘」）。
//
// 「测试」按钮 = 把编辑区指向这个 bot，并在下方开一段临时对话；说完随手「清空」即丢弃。

import type { PageContext, PageView } from '@diy-agent/workbench-ui';
import { modelKeyOf, modelLabel, roleLabel, sessionCountLabel, timeLabel, usageLabel } from './format.js';
import type { BotSnapshot, BotView, TestChatView } from './shared.js';

const STYLE_ID = 'bot-config-page-style';
const STYLE = `
.bc-page { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; }
.bc-head { flex: none; display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid #e4e7eb; }
.bc-title { font-size: 15px; font-weight: 600; }
.bc-home { flex: 1; font-size: 12px; color: #8b95a1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bc-btn { appearance: none; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.bc-btn:disabled { color: #a9b7cc; cursor: default; }
.bc-btn[data-danger="true"] { border-color: #e3b4b4; color: #b23b3b; }
.bc-status { flex: none; padding: 0 20px; font-size: 12px; color: #4b5563; min-height: 20px; line-height: 20px; }
.bc-status[data-kind="error"] { color: #b23b3b; }
.bc-body { flex: 1; min-height: 0; overflow: auto; padding: 0 20px 24px; }
.bc-section { margin-top: 18px; }
.bc-section-title { font-size: 13px; font-weight: 600; color: #1f2937; margin: 0 0 8px; }
.bc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.bc-table th, .bc-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef0f3; vertical-align: middle; }
.bc-table th { color: #6b7280; font-weight: 500; font-size: 12px; }
.bc-table tr[data-active="true"] td { background: #f5f8fd; }
.bc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.bc-muted { color: #8b95a1; }
.bc-row-actions { display: flex; gap: 6px; }
.bc-form { display: grid; grid-template-columns: 96px 1fr; gap: 8px 12px; align-items: start; max-width: 720px; }
.bc-label { font-size: 13px; color: #4b5563; padding-top: 6px; }
.bc-input { padding: 4px 8px; border: 1px solid #d3d8de; border-radius: 6px; font: inherit; font-size: 13px; box-sizing: border-box; width: 100%; }
.bc-input:focus { outline: 2px solid #b9c9e4; outline-offset: 0; }
.bc-textarea { min-height: 96px; resize: vertical; }
.bc-form-actions { grid-column: 2; display: flex; gap: 8px; align-items: center; }
.bc-test-title { display: flex; align-items: baseline; gap: 10px; }
.bc-test-meta { font-size: 12px; color: #8b95a1; }
.bc-test-log { border: 1px solid #eef0f3; border-radius: 8px; padding: 10px 12px; min-height: 80px; max-height: 320px; overflow: auto; background: #fbfcfd; }
.bc-test-row { display: flex; gap: 8px; padding: 4px 0; font-size: 13px; }
.bc-test-role { flex: none; width: 40px; color: #6b7280; font-size: 12px; }
.bc-test-text { white-space: pre-wrap; word-break: break-word; }
.bc-test-input { display: flex; gap: 8px; margin-top: 8px; }
.bc-test-input .bc-input { flex: 1; }
.bc-empty { font-size: 13px; color: #8b95a1; padding: 8px 0; }
`;

/** 编辑区的状态（id = null 表示「新建」） */
interface FormState {
    id: string | null;
    name: string;
    instructions: string;
    model: string;
}

const EMPTY_FORM: FormState = { id: null, name: '', instructions: '', model: '' };

interface PageApi {
    invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
    act<T>(label: string, task: () => Promise<T>, done: (result: T) => string): Promise<void>;
}

export const botConfigPageView: PageView = {
    id: 'bot-config',
    title: 'Bot 配置',
    render(root: HTMLElement, ctx: PageContext): () => void {
        const doc = root.ownerDocument;
        ensureStyle(doc);
        root.replaceChildren();

        const page = el(doc, 'div', 'bc-page');
        const head = el(doc, 'div', 'bc-head');
        const title = el(doc, 'span', 'bc-title');
        title.textContent = 'Bot 配置';
        const homeText = el(doc, 'code', 'bc-home');
        homeText.textContent = '加载中…';
        const refresh = el(doc, 'button', 'bc-btn') as HTMLButtonElement;
        refresh.type = 'button';
        refresh.textContent = '刷新';
        head.append(title, homeText, refresh);

        const status = el(doc, 'div', 'bc-status');
        const body = el(doc, 'div', 'bc-body');
        page.append(head, status, body);
        root.append(page);

        let snapshot: BotSnapshot | null = null;
        let form: FormState = { ...EMPTY_FORM };
        let testBotId: string | null = null;
        let testView: TestChatView | null = null;
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

        // ── 三个区块（一次性建好，之后只换内容，输入框不会被无谓重建） ──

        const listSection = el(doc, 'section', 'bc-section');
        const listTitle = titleNode(doc, 'Bot 列表');
        const listTable = el(doc, 'table', 'bc-table');
        const listHead = doc.createElement('thead');
        const listHeadRow = doc.createElement('tr');
        for (const text of ['id', 'name', 'model', '会话数', '更新时间', '操作']) {
            const th = doc.createElement('th');
            th.textContent = text;
            listHeadRow.append(th);
        }
        listHead.append(listHeadRow);
        const listBody = doc.createElement('tbody');
        listTable.append(listHead, listBody);
        listSection.append(listTitle, listTable);

        const formSection = el(doc, 'section', 'bc-section');
        formSection.append(titleNode(doc, '编辑身份（保存即写 bots/<id>/bot.json）'));
        const formGrid = el(doc, 'div', 'bc-form');
        const idText = el(doc, 'code', 'bc-mono');
        const nameInput = textInput(doc, 'name');
        const instructionsInput = doc.createElement('textarea');
        instructionsInput.className = 'bc-input bc-textarea';
        instructionsInput.placeholder = '行为指令（注入 system prompt 的身份节；空 = 不注入）';
        const modelSelect = doc.createElement('select') as HTMLSelectElement;
        modelSelect.className = 'bc-input';
        const formActions = el(doc, 'div', 'bc-form-actions');
        const saveBtn = el(doc, 'button', 'bc-btn') as HTMLButtonElement;
        saveBtn.type = 'button';
        saveBtn.textContent = '保存';
        const newBtn = el(doc, 'button', 'bc-btn') as HTMLButtonElement;
        newBtn.type = 'button';
        newBtn.textContent = '新建';
        const formHint = el(doc, 'span', 'bc-muted');
        formActions.append(saveBtn, newBtn, formHint);
        formGrid.append(
            labelOf(doc, 'id'),
            idText,
            labelOf(doc, 'name'),
            nameInput,
            labelOf(doc, 'instructions'),
            instructionsInput,
            labelOf(doc, 'model'),
            modelSelect,
            formActions,
        );
        formSection.append(formGrid);

        const testSection = el(doc, 'section', 'bc-section');
        const testTitleLine = el(doc, 'div', 'bc-test-title');
        const testTitle = titleNode(doc, '测试对话（内存会话，不落盘）');
        const testMeta = el(doc, 'span', 'bc-test-meta');
        testTitleLine.append(testTitle, testMeta);
        const testLog = el(doc, 'div', 'bc-test-log');
        const testInputLine = el(doc, 'div', 'bc-test-input');
        const testInput = textInput(doc, 'test');
        testInput.placeholder = '对选中的 bot 说一句话（真模型；这段对话不会出现在会话列表）';
        const sendBtn = el(doc, 'button', 'bc-btn') as HTMLButtonElement;
        sendBtn.type = 'button';
        sendBtn.textContent = '发送';
        const resetBtn = el(doc, 'button', 'bc-btn') as HTMLButtonElement;
        resetBtn.type = 'button';
        resetBtn.textContent = '清空对话';
        testInputLine.append(testInput, sendBtn, resetBtn);
        testSection.append(testTitleLine, testLog, testInputLine);

        body.append(listSection, formSection, testSection);

        // ── 渲染 ──────────────────────────────────────

        const applyForm = (): void => {
            idText.textContent = form.id ?? '（新建，保存时生成）';
            nameInput.value = form.name;
            instructionsInput.value = form.instructions;
            fillModelOptions(doc, modelSelect, snapshot, form.model);
            formHint.textContent = form.id === null ? '正在新建' : `正在编辑 ${form.id}`;
            renderList();
            renderTest();
        };

        const renderList = (): void => {
            listBody.replaceChildren();
            const bots = snapshot?.bots ?? [];
            if (bots.length === 0) {
                const tr = doc.createElement('tr');
                const td = doc.createElement('td');
                td.colSpan = 6;
                td.className = 'bc-empty';
                td.textContent = '还没有 bot —— 在下面填个 name 点「保存」即新建。';
                tr.append(td);
                listBody.append(tr);
                return;
            }
            for (const bot of bots) listBody.append(botRow(doc, bot));
        };

        const botRow = (doc2: Document, bot: BotView): HTMLTableRowElement => {
            const tr = doc2.createElement('tr');
            if (bot.id === form.id) tr.dataset['active'] = 'true';
            const actions = doc2.createElement('td');
            const group = el(doc2, 'div', 'bc-row-actions');
            const edit = smallButton(doc2, '编辑');
            edit.addEventListener('click', () => {
                form = { id: bot.id, name: bot.name, instructions: bot.instructions, model: bot.model ?? '' };
                testBotId = bot.id;
                testView = null;
                applyForm();
            });
            const test = smallButton(doc2, '测试');
            test.addEventListener('click', () => {
                form = { id: bot.id, name: bot.name, instructions: bot.instructions, model: bot.model ?? '' };
                testBotId = bot.id;
                testView = null;
                applyForm();
                testInput.focus();
            });
            const remove = smallButton(doc2, '删除');
            remove.dataset['danger'] = 'true';
            remove.addEventListener('click', () => {
                if (!confirmIfPossible(doc2, `删除 bot「${bot.name}」？会话数据不会被删除。`)) return;
                void api.act(
                    '删除 bot',
                    () => api.invoke<BotSnapshot>('removeBot', { id: bot.id }),
                    (next) => {
                        applySnapshot(next);
                        return `已删除 bot「${bot.name}」（会话目录未动）`;
                    },
                );
            });
            group.append(edit, test, remove);
            actions.append(group);
            tr.append(
                cell(doc2, bot.id, 'bc-mono'),
                cell(doc2, bot.name),
                cell(doc2, modelLabel(bot.model), 'bc-mono'),
                cell(doc2, sessionCountLabel(bot)),
                cell(doc2, timeLabel(bot.updatedAt), 'bc-muted'),
                actions,
            );
            return tr;
        };

        const renderTest = (): void => {
            const botId = testBotId;
            if (botId === null) {
                testMeta.textContent = '';
                testLog.replaceChildren(emptyNode(doc, '先在上表点「测试」或「编辑」选中一个 bot。'));
                sendBtn.disabled = true;
                resetBtn.disabled = true;
                return;
            }
            sendBtn.disabled = false;
            resetBtn.disabled = false;
            const view = testView;
            testMeta.textContent = `${botId}${view === null ? '' : ` · ${usageLabel(view.usage)}`}`;
            testLog.replaceChildren();
            if (view === null || view.messages.length === 0) {
                testLog.append(emptyNode(doc, '说一句话试试 —— 回复来自真模型，这段历史只在本页内存里。'));
                return;
            }
            for (const message of view.messages) {
                const row = el(doc, 'div', 'bc-test-row');
                const role = el(doc, 'span', 'bc-test-role');
                role.textContent = roleLabel(message.role);
                const text = el(doc, 'span', 'bc-test-text');
                text.textContent = message.text;
                row.append(role, text);
                testLog.append(row);
            }
            testLog.scrollTop = testLog.scrollHeight;
        };

        const applySnapshot = (next: BotSnapshot): void => {
            snapshot = next;
            homeText.textContent = `数据根：${next.home} · ${next.bots.length} 个 bot · ${next.models.length} 个模型`;
            // 选中的 bot 被删了 / 还没选中：表单保持，但列表高亮与测试面板按 id 判断
            if (form.id !== null && !next.bots.some((bot) => bot.id === form.id)) {
                // 被外部删掉了：退回新建态（不静默编辑一个不存在的 id）
                form = { ...EMPTY_FORM };
                testBotId = null;
                testView = null;
            }
            applyForm();
        };

        // ── 事件 ──────────────────────────────────────

        refresh.addEventListener('click', () => {
            void api.act(
                '读取 bot',
                () => api.invoke<BotSnapshot>('snapshot'),
                (next) => {
                    applySnapshot(next);
                    return `已加载 ${next.bots.length} 个 bot`;
                },
            );
        });

        newBtn.addEventListener('click', () => {
            form = { ...EMPTY_FORM };
            testBotId = null;
            testView = null;
            applyForm();
            nameInput.focus();
        });

        saveBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (name === '') {
                setStatus('name 不能为空', 'error');
                return;
            }
            const model = modelSelect.value.trim();
            const payload = { name, instructions: instructionsInput.value, model };
            const creating = form.id === null;
            const label = creating ? '新建 bot' : '保存 bot';
            void api.act(
                label,
                () =>
                    creating
                        ? api.invoke<BotSnapshot>('createBot', payload)
                        : api.invoke<BotSnapshot>('saveBot', { id: form.id, ...payload }),
                (next) => {
                    // 新建后选中刚建的那个（按 name 找：create 返回的是整张快照）
                    const created = creating ? next.bots.find((bot) => bot.name === name) : undefined;
                    if (created !== undefined) {
                        form = { id: created.id, name: created.name, instructions: created.instructions, model: created.model ?? '' };
                        testBotId = created.id;
                    } else if (form.id !== null) {
                        form = { ...form, name, instructions: payload.instructions, model };
                    }
                    testView = null;
                    applySnapshot(next);
                    return creating ? `已新建 bot「${name}」` : `已保存「${name}」到 bots/${form.id}/bot.json`;
                },
            );
        });

        sendBtn.addEventListener('click', () => {
            const botId = testBotId;
            const text = testInput.value.trim();
            if (botId === null) {
                setStatus('先选中一个 bot', 'error');
                return;
            }
            if (text === '') {
                setStatus('说点什么再发送', 'error');
                return;
            }
            void api.act(
                '测试对话',
                () => api.invoke<TestChatView>('testSend', { id: botId, text }),
                (view) => {
                    testInput.value = '';
                    testView = view;
                    renderTest();
                    return `收到回复（${usageLabel(view.usage)}；这段对话不落盘）`;
                },
            );
        });

        testInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendBtn.click();
            }
        });

        resetBtn.addEventListener('click', () => {
            const botId = testBotId;
            if (botId === null) return;
            void api.act(
                '清空对话',
                () => api.invoke<TestChatView>('testReset', { id: botId }),
                (view) => {
                    testView = view;
                    renderTest();
                    return '已清空测试对话（内存里的那份也丢了）';
                },
            );
        });

        // 首次加载
        applyForm();
        void api.act(
            '读取 bot',
            () => api.invoke<BotSnapshot>('snapshot'),
            (next) => {
                applySnapshot(next);
                return `已加载 ${next.bots.length} 个 bot`;
            },
        );

        return () => {
            root.replaceChildren();
        };
    },
};

export default botConfigPageView;

// ── DOM 小工具 ───────────────────────────────────

function el(doc: Document, tag: string, className = ''): HTMLElement {
    const node = doc.createElement(tag);
    if (className !== '') node.className = className;
    return node;
}

function titleNode(doc: Document, text: string): HTMLElement {
    const node = el(doc, 'h2', 'bc-section-title');
    node.textContent = text;
    return node;
}

function labelOf(doc: Document, text: string): HTMLElement {
    const node = el(doc, 'span', 'bc-label');
    node.textContent = text;
    return node;
}

function cell(doc: Document, text: string, className = ''): HTMLTableCellElement {
    const td = doc.createElement('td');
    if (className !== '') td.className = className;
    td.textContent = text;
    return td;
}

function textInput(doc: Document, name: string): HTMLInputElement {
    const node = doc.createElement('input');
    node.type = 'text';
    node.className = 'bc-input';
    node.name = name;
    return node;
}

function smallButton(doc: Document, text: string): HTMLButtonElement {
    const node = el(doc, 'button', 'bc-btn') as HTMLButtonElement;
    node.type = 'button';
    node.textContent = text;
    return node;
}

function emptyNode(doc: Document, text: string): HTMLElement {
    const node = el(doc, 'div', 'bc-empty');
    node.textContent = text;
    return node;
}

/** 模型下拉：第一项 = 跟随缺省；现有 bot 的 model 不在目录里时也补一项（不静默改值） */
function fillModelOptions(
    doc: Document,
    select: HTMLSelectElement,
    snapshot: BotSnapshot | null,
    selected: string,
): void {
    select.replaceChildren();
    const follow = doc.createElement('option');
    follow.value = '';
    follow.textContent = '（跟随缺省）';
    select.append(follow);
    const models = snapshot?.models ?? [];
    const keys = new Set(models.map(modelKeyOf));
    for (const model of models) {
        const option = doc.createElement('option');
        option.value = modelKeyOf(model);
        option.textContent = `${model.providerId} · ${model.name}`;
        select.append(option);
    }
    if (selected !== '' && !keys.has(selected)) {
        const option = doc.createElement('option');
        option.value = selected;
        option.textContent = `${selected}（目录里已没有）`;
        select.append(option);
    }
    select.value = selected;
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
