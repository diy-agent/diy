# 运行产物的外部存储方案（tool / job 输出，2026-11-28）

起因：`diy2.db` 长到 243MB，其中 **96% 是 `tool` 条目**。用户问「消息历史是不是该放 jsonl」——
量完发现不是那回事：`chat` 六千多条只有 3MB，真凶是**工具输出原文无上限地整条入库**。
所以这轮只动「运行产物」，**消息一个字不动**。

## 一、现状：一份输出存了两遍，db 里那遍没人管

| 域 | 现在落在哪 | 谁写 | 有保留策略吗 |
|---|---|---|---|
| 工具输出**原文** | `entity_items`（`item.data.result`） | `projection.ts` 的 `tool.completed` | ❌ 跟随房间，永不清理 |
| 工具输出**原文（超 64KB 时）** | `<home>/toolout/<callId>.txt` | `tool-output.ts` 的 `toModelOutput` | ❌ 只写不删 |
| 作业输出 | `<home>/log/job/runs/<YYYY-MM-DD>/<runId>/out.log` | `pkgs.ts/agent/jobs` 的 run 自写 fd | ❌ 注释自己写着「没有保留策略」 |
| 附件（用户上传） | `<home>/blobs/` | `createBlobStore` | — |

真库实测（4.3 万 items / 243MB）：

| 内容 | 条数 | 体积 |
|---|---|---|
| `tool` | 35,775 | **144 MB** |
| ├ 其中 ≥4MB 的 | **5 条** | **60 MB**（最大单条 31MB，来自全盘 `rg` 的 bash 输出） |
| `chat` | 6,670 | 3 MB |
| notice / error | 732 | <1 MB |
| 全部索引 | — | 4 MB |

两个结论：

1. **同一份大输出存两遍**：投递层（`toModelOutput`）为了「模型够不着时能 read 回取」，把原文写到
   `toolout/`；而投影层早就把原文整条写进了 db。工具输出越界时是 2× 磁盘，且 db 那遍还要被
   `chat.history` / 全表 json 分组反复解析（正是 11-28 那批卡顿的来源之一）。
2. **谁也没有清理策略**：`toolout/` 已 30MB、`log/job` 8.6MB / 526 个 run，全靠人手动 `rm`。

## 二、边界（这次不动的）

- **消息（`chat` / `notice` / `error`）**：继续在 `entity_items` 里。它们要按条件查（未读水位、
  上一轮结局、分页），正是 sqlite 擅长的；而且只有 3MB。
- `<home>/blobs/`（用户上传的附件）、`<home>/log/app`、`<home>/log/network`：不动。
- `tool` 条目**本身**还在 `entity_items` 里（id / 时间 / 工具名 / 入参 / 状态都要可查），
  只是**结果正文**挪出去。

## 三、布局：一个根 `<home>/runs/`

```
<home>/
  diy2.db
  runs/
    tool/2026-11-28/task-mwjddcy0/tool-call_abc123.txt    # 单条工具输出原文
    job/2026-11-28/r-mwt9bwcz-hlec/{meta.json,out.log,done.json}
  blobs/…                                                 # 附件（不动）
  log/{app,network}/…                                     # 应用 / 网络日志（不动）
```

- **按日分区**：GC 天然是「删掉 N 天前的目录」，不用扫全库。
- **tool 再按房间**：删房间时整目录带走（现在删房间连 `toolout/` 里的文件都没人清）。
- **job 保持 run 自己的目录**（`meta.json` / `out.log` / `done.json` 一个 run 自述，现成的，别拆）。
- 文件名只做 `[^\w.-]+ → _` 归一（现有 `safeName` 的规矩），不做 content-addressed 去重：
  重复的大输出是偶发（重试），而 sha 索引换来的是「删一个文件影响多条目」的复杂度。

## 四、item 里的引用：`data.output`，缺省即老数据

```jsonc
{
  "type": "tool",
  "data": {
    "name": "bash",
    "args": { "command": "rg -n 'stdout.log' /Users/ccc" },
    "state": "ok",
    // 老数据：结果原文就在这儿（字符串）。下列字段一个都没有 ⇒ 读侧照旧直接渲染。
    "result": "…",
    // 新数据（> 64KB）：正文不在这里了
    "output": {
      "ref": "runs/tool/2026-11-28/task-mwjddcy0/tool-call_abc123.txt",  // 相对 <home>
      "bytes": 33352624,
      "lines": 812345,
      "truncated": true,
      "preview": { "head": "…前 40 行…", "tail": "…后 40 行…" }
    }
  }
}
```

- **相对 `<home>` 存 ref，不存绝对路径**：数据根搬走（`--home` 换位置）后引用仍然有效；
  绝对路径只在给**模型**的 marker 里现算（`read` 工具按 cwd 解析，给相对路径它读不到 —— 这条
  坑 `tool-output.ts` 里已经记着）。
- **两条判据，不要发明第三条**：`data.output !== undefined` ⇒ 正文在文件；否则用 `data.result`。
- **≤ 64KB 的输出直接存在 `data.result`**（今天平均 2.2KB）：不为每条小输出建文件，
  也避免「几千个小文件」把 inode 与备份拖死。阈值与 `TOOL_OUTPUT_MAX_BYTES` 同一个数
  （`pkgs.ts/agent/tools/src/limits.ts` = 64KB / 2000 行）。
- 类型定义落在 `pkgs.ts/agent/protocol/src/types.ts` 的 `type: 'tool'` 分支（现在只有
  `name / args / result / state / error`）。

## 五、写入：投影层是唯一入口

现在两处都在写，改成一处：

| 层 | 现在 | 改成 |
|---|---|---|
| 投影层 `projection.ts` 的 `tool.completed` | 无条件 `data.result = event.result` | **调 `outputStore.put()`**：超 64KB ⇒ 写文件 + 存 `output`，否则存 `result` |
| 投递层 `tool-output.ts` 的 `toModelOutput` | 裁 + 顺手把原文写盘 | **只裁**（头尾 + marker），`resume` 指向 `output.ref` 算出来的绝对路径；不再写盘 |

为什么入口必须是投影层：UI / 历史 / 压缩都从 item 取数，item 才是「这条输出存哪」的**真源**；
投递层只是「发给模型的那一份」。反过来（只在投递层落盘）就会出现今天的局面：db 里有原文、
盘上另有一份、两份都可能没人清。

`outputStore.put()` 的失败处理：写盘失败**不假装成功** —— 退化成「不落盘 + `truncated: true` +
marker 里不带 `resume`」，与今天 `toModelOutput` 失败时的行为一致（模型至少知道被裁了）。

## 六、读取

- **UI**：工具卡片加一个「查看完整输出」入口 → `GET /api/tool-output?room=<roomId>&call=<callId>`
  （`diy2/server/app.ts` 的 HTTP 层，与 `/api/metrics` 同一处；支持 `Range`，`Cache-Control: no-store`）。
  只认「item 里那个 ref」，不接受任意路径 —— 否则就是一个任意文件读。
- **模型**：marker 里的 `resume`（绝对路径）+ 现成的 `read` 工具，行为不变。
- **删房间**：`deleteRoom` 联带删 `runs/tool/*/<roomId>/`（现在这块是空白）。

## 七、job 并入同一根

- `rootDir` 从 `<home>/log/job/runs` 改成 `<home>/runs/job`（调用点在 `apps/diy2/server/app.ts` 的
  `createJobRegistry`；`pkgs.ts/agent/jobs` 只认 `rootDir`，不知道分布）。
- 存量迁移：`mv ~/.diy2/log/job/runs/* ~/.diy2/runs/job/`（run 目录自述，内容不用改）。
- `job-done` 进消息的只是通知 + tail（几 KB），保持在 items 里。

## 八、存量迁移（一次性脚本，需停实例）

1. `SELECT id, entity_id, at, item FROM entity_items WHERE type='tool' AND length(item) > 64KB`；
2. 逐条：解析 → `data.result` 写到 `runs/tool/<at 的日期>/<roomId>/<callId>.txt` → 改写
   `data.output`（ref / bytes / lines / truncated / preview）→ `UPDATE entity_items SET item=?`；
3. 幂等：已经有 `data.output` 的跳过；同名文件已存在就覆盖（同一条 item 重跑结果一致）；
4. 全量跑完再 `VACUUM`（这步要独占库）。
5. 预期：243MB → **~90MB**（60MB 巨块 + 剩余大块外置，再回收 ~40MB 空闲页）。

跑之前先备份：`cp diy2.db diy2.db.bak-pre-output-migrate`（同 11-27 迁移的老规矩）。

## 九、GC 与观测

- 保留期：`runs/tool/<日期>` 与 `runs/job/<日期>` 默认 **30 天**（环境变量 `DIY_RUNS_KEEP_DAYS` 兜底）；
  运行中的 job 目录永不删（`done.json` 不在就跳过）。
- **跑在监听之后**（`app.resume()` 旁边），异步 + 每删一批 `await` 一次让出事件循环 —— 不能在
  `createDiy2App` 的同步段里做（那就是在治 5875ms 的同时造一个新的）。
- 观测：`runs` 的体积 / 文件数 / 本次删了几个目录，进日志（`diy2:runs`）；等 OTEL 指标上线后一并变成指标。

## 十、为什么不是「消息搬 jsonl」

- **查询面**：未读水位（`seq > last_read` + 只数 chat + 排掉自己）、上一轮结局（`(房间,bot)` 取最后
  一条、按 owner 取轮级事实）、分页（`ORDER BY seq DESC LIMIT n`）、删除（按 `(turnId,botId,kind)`）。
  这些在 jsonl 上全是「全量扫 + 内存过滤」—— 等于把刚修掉的「加载全部」换个地方重演。
- **体量**：`chat` 只有 3MB。搬它省不了空间，只赔上索引与事务。
- 真要冷热分离，正确粒度是「**老的工具条目**」（正文已经外置成文件了，条目本身很小）：
  以后要做就是「N 天前的 tool 条目导出 jsonl 并从 items 删」，不影响消息。

## 十一、实现顺序（每步都能单独验收）

1. **布局 + 约定**（本文档）——先把 ref 字段与目录定死。
2. **写入闸**：投影层接 `outputStore.put()`，投递层改成只裁；>64KB 的走文件。
   （验收：跑一条 1MB 输出，item < 8KB，文件字节数对得上，UI 能展开看全文。）
3. **读取路径**：`/api/tool-output` + 卡片入口 + 删房间联动。
4. **存量迁移 + VACUUM**（可单独跑，失败不影响线上）。
5. **job 目录并入 + GC**（最后做：它只影响新产物与清理，不阻塞前面）。
