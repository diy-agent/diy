// migrate.ts —— 迁移专用的小服务：一个页面 + 一条 SSE 流。
//
// **为什么不挂进主界面**（用户 2026-11-27 明确要求）：主界面一打开就会拉 rooms / bots /
// models，迁移还没跑完时那些请求会把「旧库读不了」的错误糊满屏幕，真正的迁移进度反而看不见。
// 所以这里是一个**独立进程、独立端口、只服务一个页面**，除了它自己谁也不碰这个库。
//
// 它不迁移：迁移在子进程里跑（见 migrate-worker.ts，原因是同步 sqlite 会卡住事件循环）。
// 这个进程只做三件事：读「迁移前」的底座数字、spawn 子进程、把它的 JSON 行转成 SSE。

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { MIGRATION_STEPS } from '@diy-agent/entity-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根的 node_modules/.bin/tsx（HERE 是 apps/diy2/server，要往上**三层**到仓根） */
const TSX_BIN = join(HERE, '../../../node_modules/.bin/tsx');

function argOf(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? undefined : process.argv[index + 1];
}

const dbPath = resolve(argOf('db') ?? '');
const port = Number(argOf('port') ?? '5179');

if (!existsSync(dbPath)) {
    console.error(`✗ 数据库不存在：${dbPath}\n  用法：./sha.sh migrate --db <path> [--port 5179]`);
    process.exit(2);
}

/** 迁移前的底座数字。**只读打开**：绝不能用 openStore（那会当场把库改了）。 */
function beforeOf(file: string): Record<string, number> {
    const db = new DatabaseSync(file, { readOnly: true });
    const count = (table: string): number => {
        try {
            return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        } catch {
            return -1;
        }
    };
    const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
            (row) => row.name,
        ),
    );
    const sessionColumns = (() => {
        try {
            return (db.prepare('PRAGMA table_info(session_state)').all() as Array<{ name: string }>).map((r) => r.name);
        } catch {
            return [];
        }
    })();
    const out = {
        botRoles: count('bot_roles'),
        botProfiles: count('bot_profiles'),
        bots: count('bots'),
        sessions: count('session_state'),
        roomEntries: count('room_entries'),
        rooms: count('rooms_v0'),
        entities: count('entities'),
    };
    db.close();
    return {
        ...out,
        hasLegacyBots: tables.has('bots') ? 1 : 0,
        sessionKeyColumn: sessionColumns.includes('bot_profile_id')
            ? 3
            : sessionColumns.includes('bot_role_id')
              ? 2
              : sessionColumns.includes('bot_id')
                ? 1
                : 0,
    };
}

const clients = new Set<ServerResponse>();
function broadcast(payload: unknown): void {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients) response.write(line);
}

let running = false;

function startMigration(): void {
    if (running) {
        broadcast({ kind: 'error', message: '已经在跑了（一次只能跑一个）' });
        return;
    }
    running = true;
    broadcast({ kind: 'started', at: Date.now() });

    const child = spawn(TSX_BIN, [join(HERE, 'migrate-worker.ts'), dbPath], {
        cwd: HERE,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        buffered += chunk;
        let index = buffered.indexOf('\n');
        while (index >= 0) {
            const line = buffered.slice(0, index);
            buffered = buffered.slice(index + 1);
            index = buffered.indexOf('\n');
            if (!line.startsWith('@@')) {
                if (line.trim() !== '') broadcast({ kind: 'log', text: line });
                continue;
            }
            try {
                broadcast(JSON.parse(line.slice(2)) as unknown);
            } catch {
                broadcast({ kind: 'log', text: line });
            }
        }
    });

    // spawn 失败（路径不对 / 没执行权限）默认会抛 'error' 把整个服务打死 ——
    // 那正好是「人正盯着页面看」的时候，必须变成页面上的一行红字，不是进程消失。
    child.on('error', (error: Error) => {
        running = false;
        broadcast({ kind: 'error', message: `起不了迁移进程：${error.message}` });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => broadcast({ kind: 'stderr', text: chunk }));
    child.on('close', (code) => {
        running = false;
        broadcast({ kind: 'closed', code });
    });
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>diy2 迁移</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#2b303b;--fg:#e6e8ee;--muted:#9aa3b2;
        --ok:#4ec9a8;--run:#e0a458;--skip:#6b7484;--bad:#ff6b6b}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 24px 64px;background:var(--bg);color:var(--fg);
       font:14px/1.6 -apple-system,"PingFang SC",ui-sans-serif,sans-serif}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:18px;margin:0 0 6px;font-weight:600}
  .path{color:var(--muted);font-size:12px;word-break:break-all;margin-bottom:20px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin-bottom:16px}
  .verdict{font-size:22px;font-weight:600;line-height:1.35;margin:0 0 6px}
  .verdict.ok{color:var(--ok)} .verdict.bad{color:var(--bad)} .verdict.run{color:var(--run)}
  .sub{color:var(--muted);font-size:13px}
  .track{height:10px;border-radius:999px;background:#0b0d11;overflow:hidden;margin:18px 0 8px}
  .fill{height:100%;width:0;background:var(--run);transition:width .25s ease}
  .fill.ok{background:var(--ok)} .fill.bad{background:var(--bad)}
  .countline{display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:12.5px}
  .countline .cur{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  button{font:inherit;font-size:14px;padding:9px 20px;border-radius:9px;cursor:pointer;
         background:var(--ok);color:#07110d;border:0;font-weight:700;margin-top:18px}
  button:disabled{background:var(--line);color:var(--muted);cursor:not-allowed}
  ul.checks{list-style:none;margin:14px 0 0;padding:0}
  ul.checks li{padding:8px 0;border-top:1px solid var(--line);font-size:13.5px;display:flex;gap:10px}
  ul.checks li:first-child{border-top:0}
  ul.checks .good{color:var(--ok);font-weight:700}
  ul.checks .warn{color:var(--run);font-weight:700}
  details{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:12px}
  summary{cursor:pointer;padding:14px 20px;font-size:13.5px;color:var(--muted);user-select:none}
  summary:hover{color:var(--fg)}
  .rows{border-top:1px solid var(--line)}
  .row{display:grid;grid-template-columns:20px 1fr auto;gap:12px;padding:9px 20px;align-items:start;
       border-bottom:1px solid var(--line);font-size:13px}
  .row:last-child{border-bottom:0}
  .ico{line-height:1.5}
  .note{color:var(--muted);font-size:12px;margin-top:2px}
  .meta{color:var(--muted);font-size:12px;white-space:nowrap}
  .running .ico,.running .name{color:var(--run)}
  .done .ico{color:var(--ok)}
  .skipped{opacity:.6} .skipped .ico{color:var(--skip)}
  .failed .ico,.failed .name{color:var(--bad)}
  pre{margin:0;padding:14px 20px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);
      white-space:pre-wrap;max-height:240px;overflow:auto;font-family:ui-monospace,Menlo,monospace}
</style></head><body><div class="wrap">
<h1>diy2 数据库迁移</h1>
<div class="path">__DB__</div>

<div class="card">
  <div class="verdict" id="verdict">等待开始</div>
  <div class="sub" id="sub">共 __TOTAL__ 个步骤。迁移前：会话 __SESSIONS__ 份 · 消息 __ENTRIES__ 条 · 会话键列 __COL__</div>
  <div class="track"><div class="fill" id="fill"></div></div>
  <div class="countline"><span id="counter">0 / __TOTAL__</span><span class="cur" id="cur"></span></div>
  <button id="go">开始迁移</button>
</div>

<div class="card" id="result" hidden>
  <div class="verdict" id="resultVerdict"></div>
  <ul class="checks" id="checks"></ul>
</div>

<details><summary>详细步骤（<span id="stepCount">0</span> / __TOTAL__）</summary><div class="rows" id="rows"></div></details>
<details><summary>运行日志</summary><pre id="log"></pre></details>
<script>
var TOTAL=__TOTAL__, BEFORE_SESSIONS=__SESSIONS__, BEFORE_ENTRIES=__ENTRIES__;
var finished={}, total=TOTAL, doneOk=false;
var NL=String.fromCharCode(10);
var elGo=document.getElementById('go'), elFill=document.getElementById('fill'),
    elCounter=document.getElementById('counter'), elCur=document.getElementById('cur'),
    elVerdict=document.getElementById('verdict'), elSub=document.getElementById('sub'),
    elRows=document.getElementById('rows'), elLog=document.getElementById('log'),
    elCount=document.getElementById('stepCount');

function log(t){ elLog.textContent += t + NL; elLog.scrollTop = elLog.scrollHeight; }
function setVerdict(text, cls){ elVerdict.textContent = text; elVerdict.className = 'verdict ' + (cls||''); }
function resetButton(){ elGo.disabled = false; elGo.textContent = '开始迁移'; }
function refresh(){
  var n = Object.keys(finished).length;
  elFill.style.width = (total ? Math.round(n * 100 / total) : 0) + '%';
  elCounter.textContent = n + ' / ' + total;
  elCount.textContent = String(n);
}

var ICON = {running:'◐', done:'✓', skipped:'–', failed:'✗'};
function rowOf(e){
  var el = document.getElementById('row-' + e.id);
  if(!el){
    el = document.createElement('div');
    el.id = 'row-' + e.id;
    el.innerHTML = '<span class="ico"></span><div><div class="name"></div><div class="note"></div></div><span class="meta"></span>';
    elRows.appendChild(el);
  }
  el.className = 'row ' + e.state;
  el.querySelector('.ico').textContent = ICON[e.state] || '·';
  el.querySelector('.name').textContent = e.title;
  el.querySelector('.note').textContent = e.note || '';
  var meta = [];
  if(e.progress) meta.push(e.progress.done + '/' + e.progress.total);
  if(e.changes) meta.push(e.changes + ' 行');
  if(e.durationMs !== undefined) meta.push(e.durationMs + 'ms');
  el.querySelector('.meta').textContent = meta.join(' · ');
}

function showResult(p){
  var s = p.summary, checks = [];
  checks.push({ok: s.sessions === BEFORE_SESSIONS,
    text: '会话 ' + s.sessions + ' 份' + (s.sessions === BEFORE_SESSIONS ? '，和迁移前一样' : '，迁移前是 ' + BEFORE_SESSIONS + ' 份')});
  checks.push({ok: s.roomEntries === BEFORE_ENTRIES,
    text: '消息 ' + s.roomEntries + ' 条' + (s.roomEntries === BEFORE_ENTRIES ? '，和迁移前一样' : '，迁移前是 ' + BEFORE_ENTRIES + ' 条')});
  checks.push({ok: p.orphanSessions === 0,
    text: p.orphanSessions === 0 ? '没有对不上的会话' : '有 ' + p.orphanSessions + ' 份会话找不到主人'});
  checks.push({ok: s.botProfiles > 0,
    text: '机器人配置 ' + s.botProfiles + ' 个（' + s.botProfilesV0 + ' 个旧 bot 已留档）'});

  doneOk = checks.every(function(c){ return c.ok; });
  document.getElementById('result').hidden = false;
  var rv = document.getElementById('resultVerdict');
  rv.textContent = doneOk ? '✓ 迁移成功' : '⚠ 迁移完成，但有项对不上';
  rv.className = 'verdict ' + (doneOk ? 'ok' : 'bad');
  setVerdict(doneOk ? '✓ 迁移成功' : '⚠ 迁移完成，但有项对不上', doneOk ? 'ok' : 'bad');
  elFill.className = 'fill ' + (doneOk ? 'ok' : 'bad');
  elCur.textContent = '';
  elSub.textContent = '用时 ' + (p.durationMs / 1000).toFixed(1) + ' 秒';

  var ul = document.getElementById('checks');
  ul.innerHTML = '';
  checks.forEach(function(c){
    var li = document.createElement('li');
    var mark = document.createElement('span');
    mark.className = c.ok ? 'good' : 'warn';
    mark.textContent = c.ok ? '✓' : '!';
    var span = document.createElement('span');
    span.textContent = c.text;
    li.appendChild(mark); li.appendChild(span);
    ul.appendChild(li);
  });
}

var es = new EventSource('/api/events');
es.onmessage = function(m){
  var p = JSON.parse(m.data);
  if(p.kind === 'plan'){ total = p.steps.length; refresh(); return; }
  if(p.kind === 'step'){
    var e = p.event;
    rowOf(e);
    if(e.state === 'running'){
      elCur.textContent = '正在：' + e.title + (e.progress ? '（' + e.progress.done + '/' + e.progress.total + '）' : '');
    } else {
      finished[e.id] = true;
      refresh();
    }
    return;
  }
  if(p.kind === 'started'){ elCur.textContent = '正在启动…'; log('── 开始 ' + new Date(p.at).toLocaleTimeString()); return; }
  if(p.kind === 'log' || p.kind === 'stderr'){ if(p.text.trim()) log(p.text.trimEnd()); return; }
  if(p.kind === 'error'){ setVerdict('✗ 迁移失败', 'bad'); elFill.className = 'fill bad'; log('✗ ' + p.message); resetButton(); return; }
  if(p.kind === 'closed'){
    resetButton();
    if(p.code !== 0){ if(!doneOk){ setVerdict('✗ 迁移失败', 'bad'); elFill.className = 'fill bad'; } log('✗ 子进程退出码 ' + p.code); }
    else if(!doneOk){ setVerdict('⚠ 没拿到结果，看下面日志', 'run'); }
    return;
  }
  if(p.kind === 'summary'){ showResult(p); return; }
};

elGo.onclick = function(){
  elGo.disabled = true; elGo.textContent = '迁移中…';
  finished = {}; total = TOTAL; refresh();
  elRows.innerHTML = ''; document.getElementById('result').hidden = true;
  elLog.textContent = ''; elCur.textContent = ''; doneOk = false;
  elFill.className = 'fill';
  setVerdict('正在迁移…', 'run');
  elSub.textContent = '共 ' + TOTAL + ' 个步骤；迁移前：会话 ' + BEFORE_SESSIONS + ' 份 · 消息 ' + BEFORE_ENTRIES + ' 条';
  fetch('/api/start', {method: 'POST'}).then(function(res){
    if(!res.ok){ setVerdict('✗ 启动失败', 'bad'); resetButton(); }
  }).catch(function(e){
    setVerdict('✗ ' + e.message, 'bad'); resetButton();
  });
};
</script></div></body></html>`;

const COL_LABEL: Record<number, string> = { 0: '(未知)', 1: 'bot_id（最老）', 2: 'bot_role_id', 3: 'bot_profile_id（已迁）' };

const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (url === '/' || url.startsWith('/?')) {
        const before = beforeOf(dbPath);
        // ⚠ 必须用 replaceAll：`__SESSIONS__` 这类占位在页面上出现**不止一处**
        // （顶部说明一次、脚本里的基线值一次），replace 只换第一个 ——
        // 脚本里那句会原样留着 `var TOTAL=__TOTAL__`，浏览器直接 SyntaxError。
        const html = PAGE.replaceAll('__DB__', dbPath)
            .replaceAll('__TOTAL__', String(MIGRATION_STEPS.length))
            .replaceAll('__SESSIONS__', String(before.sessions))
            .replaceAll('__ENTRIES__', String(before.roomEntries))
            .replaceAll('__COL__', COL_LABEL[before.sessionKeyColumn] ?? '(未知)');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
    }

    if (url === '/api/events') {
        response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        response.write(': connected\n\n');
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
    }

    if (url === '/api/start' && request.method === 'POST') {
        startMigration();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
        return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
    const size = (statSync(dbPath).size / 1024 / 1024).toFixed(1);
    console.log(`── diy2 迁移页  http://127.0.0.1:${String(port)}/`);
    console.log(`   数据库：${dbPath}（${size} MB）`);
    console.log('   这个进程只服务迁移页，不碰主界面。');
});
