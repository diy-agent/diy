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
  body{margin:0;padding:28px 24px 64px;background:var(--bg);color:var(--fg);
       font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,"PingFang SC",monospace}
  .wrap{max-width:1000px;margin:0 auto}
  h1{font-size:19px;margin:0 0 4px;font-weight:600}
  .path{color:var(--muted);font-size:12.5px;word-break:break-all}
  .bar{display:flex;gap:24px;flex-wrap:wrap;margin:18px 0 22px;padding:14px 16px;
       background:var(--panel);border:1px solid var(--line);border-radius:10px}
  .bar div{font-size:12.5px;color:var(--muted)}
  .bar b{display:block;color:var(--fg);font-size:15px;font-weight:600;margin-top:2px}
  button{font:inherit;font-size:13px;padding:7px 16px;border-radius:8px;cursor:pointer;
         background:var(--ok);color:#07110d;border:0;font-weight:700}
  button:disabled{background:var(--line);color:var(--muted);cursor:not-allowed}
  #steps{margin-top:18px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .row{display:grid;grid-template-columns:22px 1fr auto;gap:12px;padding:10px 14px;
       border-bottom:1px solid var(--line);background:var(--panel);align-items:start}
  .row:last-child{border-bottom:0}
  .ico{font-size:14px;line-height:1.45}
  .name{font-size:13.5px}
  .note{color:var(--muted);font-size:12px;margin-top:2px}
  .meta{color:var(--muted);font-size:12px;white-space:nowrap}
  .running .ico{color:var(--run)} .running .name{color:var(--run)}
  .done .ico{color:var(--ok)} .skipped{opacity:.62} .skipped .ico{color:var(--skip)}
  .failed .ico{color:var(--bad)} .failed .name{color:var(--bad)}
  #summary{margin-top:22px;display:none}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:600;font-size:12px}
  .ok{color:var(--ok)} .bad{color:var(--bad)}
  #log{margin-top:16px;font-size:12px;color:var(--muted);white-space:pre-wrap;max-height:220px;overflow:auto}
</style></head><body><div class="wrap">
<h1>diy2 数据库迁移</h1>
<div class="path">__DB__</div>
<div class="bar">
  <div>迁移前会话<b id="b-sessions">__SESSIONS__</b></div>
  <div>迁移前消息<b id="b-entries">__ENTRIES__</b></div>
  <div>迁移前 bot 行<b id="b-bots">__BOTS__</b></div>
  <div>会话键列<b id="b-col">__COL__</b></div>
  <div style="margin-left:auto"><button id="go">开始迁移</button></div>
</div>
<div id="steps"></div>
<div id="summary"></div>
<div id="log"></div>
<script>
const ICON={running:'◐',done:'✓',skipped:'–',failed:'✗'};
const rows=new Map();const steps=document.getElementById('steps');
function rowOf(e){
  let el=rows.get(e.id);
  if(!el){
    el=document.createElement('div');
    el.innerHTML='<span class="ico"></span><div><div class="name"></div><div class="note"></div></div><span class="meta"></span>';
    steps.appendChild(el);rows.set(e.id,el);
  }
  el.className='row '+e.state;
  el.querySelector('.ico').textContent=ICON[e.state]||'·';
  el.querySelector('.name').textContent=e.title;
  el.querySelector('.note').textContent=e.note||'';
  const meta=[];
  if(e.progress)meta.push(e.progress.done+'/'+e.progress.total);
  if(e.changes!==undefined&&e.changes>0)meta.push(e.changes+' 行');
  if(e.durationMs!==undefined)meta.push(e.durationMs+'ms');
  el.querySelector('.meta').textContent=meta.join(' · ');
}
const logEl=document.getElementById('log');
function log(t){logEl.textContent+=t+'\n';logEl.scrollTop=logEl.scrollHeight;}
const es=new EventSource('/api/events');
es.onmessage=(m)=>{
  const p=JSON.parse(m.data);
  if(p.kind==='step')return rowOf(p.event);
  if(p.kind==='started'){log('── 开始 '+(new Date(p.at)).toLocaleTimeString());return;}
  if(p.kind==='log'||p.kind==='stderr'){if(p.text.trim())log(p.text.trimEnd());return;}
  if(p.kind==='error'){log('✗ '+p.message);logEl.style.color='var(--bad)';return;}
  if(p.kind==='closed'){
    document.getElementById('go').disabled=false;
    if(p.code!==0)log('✗ 子进程退出码 '+p.code);
    return;
  }
  if(p.kind==='summary'){
    const s=p.summary;const box=document.getElementById('summary');
    const rowsHtml=[
      ['机器人配置 bot_profiles',s.botProfiles],
      ['类型默认 bot_profile_defaults',s.botProfileDefaults],
      ['旧表留档 bots_v0',s.botProfilesV0],
      ['会话 session_state',s.sessions],
      ['消息 room_entries',s.roomEntries],
      ['房间 rooms_v0',s.rooms],
      ['实体 entities',s.entities],
      ['任务 tasks',s.tasks],
      ['项目 projects',s.projects],
    ].map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('');
    box.innerHTML='<table><thead><tr><th>表</th><th>行数</th></tr></thead><tbody>'+rowsHtml+
      '<tr><td>孤儿会话（指向不存在的配置）</td><td class="'+(p.orphanSessions===0?'ok':'bad')+'">'+
      p.orphanSessions+'</td></tr></tbody></table>'+
      '<div class="path" style="margin-top:8px">整个迁移耗时 '+p.durationMs+'ms</div>';
    box.style.display='block';
    document.getElementById('b-sessions').textContent=s.sessions;
    document.getElementById('b-entries').textContent=s.roomEntries;
  }
};
document.getElementById('go').onclick=async()=>{
  const btn=document.getElementById('go');btn.disabled=true;btn.textContent='迁移中…';
  steps.innerHTML='';rows.clear();document.getElementById('summary').style.display='none';
  logEl.textContent='';logEl.style.color='var(--muted)';
  await fetch('/api/start',{method:'POST'});
  btn.textContent='开始迁移';
};
</script></div></body></html>`;

const COL_LABEL: Record<number, string> = { 0: '(未知)', 1: 'bot_id（最老）', 2: 'bot_role_id', 3: 'bot_profile_id（已迁）' };

const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (url === '/' || url.startsWith('/?')) {
        const before = beforeOf(dbPath);
        const html = PAGE.replace('__DB__', dbPath)
            .replace('__SESSIONS__', String(before.sessions))
            .replace('__ENTRIES__', String(before.roomEntries))
            .replace('__BOTS__', String(before.hasLegacyBots === 1 ? before.bots : before.botProfiles))
            .replace('__COL__', COL_LABEL[before.sessionKeyColumn] ?? '(未知)');
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
