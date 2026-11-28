# 文档状态机 + 数字带出处（2026-11-28）

> 状态：候选
> 出处：2026-11-28 会话 —— PR #651「bot/session 确认稿」把三个数字当事实、并按它排迁移
> 取代：`docs/plans/2026-11-28-bot-session-domain.md` 里那些手写的库表数字（文档本身仍有效，数字要换成本文的写法）

## 一、为什么要这条规矩（事故原文）

一份标着**「这份是唯一口径」**的确认稿里，三个数字全是手抄的，而且分别来自**三张不同的表 / 三个不同的时刻**：

<!-- numbers-ok: 这一节整段是引用事故里的错误数字，不是本文断言 -->
| 文档写的 | 实测 | 41 / 46 / 34 的真实出处 |
|---|---|---|
| 「41 个任务房」 | 45 | 41 = `select count(distinct entity_id) from room_entries` —— **有聊天记录的房数**，还混着项目房 |
| 「46 个 task/project → 46 行 bot」 | 50（+1 全局 = 51） | 46 = 41 + 5，由上一个错数**算出来的** |
| 「34 份 session_state」 | 48 行 / 41 实体 | 34 是更早某刻的行数，一直没重算 |

<!-- numbers-ok: 这一行仍在引事故里的错数（41 与实际差 4，连带 10 个房） -->
**代价**：迁移按 41 个房排，10 个房不会有 bot。而这份稿又是从**分支 worktree 里的一份 HTML**（同一份草稿的另一种格式）抄来的 —— 两份都像定稿，谁也没说自己是草稿。

所以问题不是「bot 会不会写错」，而是**错了没人能当场发现**：文档没有档位、数字没有出处、草稿和定稿长得一样。

## 二、三档状态（写进开篇引用块）

```markdown
> 状态：候选
> 出处：<哪次会话 / 哪个 PR>
```

| 档位 | 含义 | 允许在哪 | 能写「唯一口径」吗 |
|---|---|---|---|
| **草稿** | 还能被推翻，作者自己都还没信 | 工作区 / 分支，随时可删 | ✗ |
| **候选** | 已提 PR 接受评审，作者认为「可以照它干活了」 | PR 分支 | ✗ |
| **定稿** | 已进 main 且被文档索引收录 | main | ✓ |

一句话判据：**读者看完会不会拿它当唯一依据？** 会 → 必须定稿；不会 → 老实写草稿。

## 三、四道护栏（`./sha.sh check` 里跑）

实现 `scripts/check-docs.mjs`，判据四条：

1. **状态行**必须存在（存量 55 篇按 `scripts/docs-status-baseline.txt` 棘轮豁免，补一行删一行）
2. **权威话术**（「唯一口径 / 以此为准 / 本稿为准 / 这份取代」）只许出现在**定稿**正文里
   —— 写在引用块（`>`）里的「取代：某稿」是在说明自己的档位，不算
3. **stats 块必须新鲜**：块里的数字与库重算一致，过期就报「跑 `./sha.sh doc-stats <file>`」
<!-- numbers-ok: 这一行在举例说明什么是「手抄数字」 -->
4. **手抄数字**（`45 个任务房` / `48 行`）出现在 stats 块外 → 计数超基线即 ✗（提醒性质，棘轮只许减）

## 四、数字怎么写：stats 块

写文档时不要手打数字，写一个块，让脚本填（块里保持空白，`doc-stats` 会填）：

```markdown
<!-- stats:tasks -->
<!-- /stats:tasks -->
```

然后跑：

```bash
./sha.sh doc-stats docs/plans/2026-11-28-doc-lifecycle.md   # 重写这份文档里所有块
./sha.sh doc-stats --list                                   # 有哪些命名查询
```

生成出来的样子（**表格 + 一行出处**：库、查询、采集时刻 —— 谁都能重跑）：

<!-- stats:tasks -->
| 指标 | 值 |
|---|---|
| 任务 | 45 |

采集：2026-11-29 00:05 · 库 `~/.diy2/diy2.db` · 查询 `select count(*) as n from tasks`
<!-- /stats:tasks -->

<!-- stats:session-state -->
| 指标 | 值 |
|---|---|
| 快照行数 | 48 |
| 涉及实体 | 41 |

采集：2026-11-29 00:05 · 库 `~/.diy2/diy2.db` · 查询 `select count(*) as rows, count(distinct entity_id) as entities from session_state`
<!-- /stats:session-state -->

**为什么必须带查询而不是只带数字**：数字是某一刻的快照，查询是可重算的事实。事故里那三个数之所以错，
就是因为只留下了数字、没留下它是从哪张表哪一刻取的 —— 后来谁也没法判断它还成不成立。

**四个「房数」的教训**：`rooms_v0` / `room_entries` / `entity_items` / `tasks` 是四个不同的数
（见下），文档里凡是写「N 个房」都必须说清是哪张表，否则下一个人只会引到另一个数。

<!-- stats:rooms-v0 -->
| 指标 | 值 |
|---|---|
| 房间（rooms_v0） | 24 |

采集：2026-11-29 00:05 · 库 `~/.diy2/diy2.db` · 查询 `select count(*) as n from rooms_v0`
<!-- /stats:rooms-v0 -->

<!-- stats:rooms-with-entries -->
| 指标 | 值 |
|---|---|
| 有聊天记录的房 | 41 |

采集：2026-11-29 00:05 · 库 `~/.diy2/diy2.db` · 查询 `select count(distinct entity_id) as n from room_entries`
<!-- /stats:rooms-with-entries -->

## 五、落地

- `scripts/check-docs.mjs` —— 判据 + `--self-test` + `--list` + `--refresh-baseline`（接 `./sha.sh check`）
- `scripts/doc-stats.mjs` —— 命名查询 + `--print` / `--update`（接 `./sha.sh doc-stats`）
- `scripts/docs-status-baseline.txt` —— 缺状态行的存量（棘轮，只许减）
- `scripts/docs-number-claims-baseline.txt` —— 手抄数字的存量（棘轮，只许减）
- 与文档索引的关系：`docs.index` 早就抽 `status` 字段（`apps/diy-app/src/main/services/docs-index.ts`），
  本护栏复用同一口径（`scripts/lib/doc-status.mjs`），不另写一份正则

## 六、没做 / 留着的

- **没强制「main 上不许有草稿」**：check 在工作区跑，分不清当前分支，交给评审与人；真要强制得在 CI 上加一步
- **没做自动降级**：「定稿的文档被改过」目前只能靠 `touched` 日期提示，没有「改了就回草稿」的机制
- **存量 55 篇没有状态行**：老文档多是「当时的研究记录」，补状态反而会误导（它们该按日期读，不是按档位）
