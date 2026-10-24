# Changelog

## [0.1.25](https://github.com/diy-agent/diy/compare/diy-v0.1.24...diy-v0.1.25) (2026-10-24)


### ⚠ BREAKING CHANGES

* **rpc:** 包名变更，导入路径由 @diy/rpc 改为 @diy-agent/rpc。

### Features

* **##369:** 模型不可用时实验实例顶栏出 bar（判据纯函数 + 表驱动单测） ([c6a5af4](https://github.com/diy-agent/diy/commit/c6a5af45a6fa196a79cda2b544db9f0da2b7f6b2))
* **##369:** 模型不可用时实验实例顶栏出 bar（判据纯函数 + 表驱动单测） ([b3ff78d](https://github.com/diy-agent/diy/commit/b3ff78d70737bb32cf0069abacf16eff62ff3838))
* **##377:** room 历史进 agent 上下文（最小版 · 第 18 刀 · lastSeen 水位 + 近期发言段） ([2dd1a0e](https://github.com/diy-agent/diy/commit/2dd1a0e0faf198433177c7bbcd60199203a323bc))
* **##377:** room 历史进 agent 上下文（最小版）—— lastSeen 水位 + deliveryText 附「近期发言」（#[#166](https://github.com/diy-agent/diy/issues/166) §44.6） ([a81bc2a](https://github.com/diy-agent/diy/commit/a81bc2a40872e0d4d1fb469d04b4d28101bba042))
* **agent/ui:** 插话缺省投递时机 下一轮 → 下一步（#[#360](https://github.com/diy-agent/diy/issues/360)） ([91100eb](https://github.com/diy-agent/diy/commit/91100ebd6bdb7854dfd9b77e8b573c3c9d7f47f8))
* **agent/ui:** 插话缺省投递时机改为「下一步」（#[#360](https://github.com/diy-agent/diy/issues/360)(聊天插话缺省投递时机)） ([367c3b9](https://github.com/diy-agent/diy/commit/367c3b914b46e14bd22455155b94b41182c574cd))
* **agent:** #[#240](https://github.com/diy-agent/diy/issues/240) 会话/轮次注册表内核 + 全局注册表订阅 + limits 写入口 ([973d24c](https://github.com/diy-agent/diy/commit/973d24cb85ba782284113529413865dcf52257e2))
* **agent:** #[#293](https://github.com/diy-agent/diy/issues/293)(大会话分页) 按字节预算 seek 冷加载起点 ([30b5972](https://github.com/diy-agent/diy/commit/30b5972622198fecf605ae9b12f2ce064ba1fe9f))
* **agent:** #[#339](https://github.com/diy-agent/diy/issues/339) 窗口触发改绝对 token 阈值 38400 + 投递压缩可见性（重做 PR [#172](https://github.com/diy-agent/diy/issues/172) 于现 main） ([f3dbdca](https://github.com/diy-agent/diy/commit/f3dbdca2372f53db395950e2a9b89f3f71185697))
* **agent:** #[#339](https://github.com/diy-agent/diy/issues/339) 窗口触发改绝对 token 阈值 38400 + 投递压缩可见性（重做 PR [#172](https://github.com/diy-agent/diy/issues/172) 于现 main） ([2272770](https://github.com/diy-agent/diy/commit/227277055b4622f1a20613f7fb1faf091c31a63d))
* **agent:** edit 工具 —— 批量 edits[] + 归一匹配 + unified patch（#[#415](https://github.com/diy-agent/diy/issues/415)） ([9b0dbc4](https://github.com/diy-agent/diy/commit/9b0dbc4911163f4d3be8942a268d20be6cb8390d))
* **agent:** local/ 会话数据布局分层 —— 会话目录 + 读侧双认 + 迁移命令（#[#379](https://github.com/diy-agent/diy/issues/379)） ([13d5b91](https://github.com/diy-agent/diy/commit/13d5b9130b515ac16dcd11371eb8fb44584aea31))
* **agent:** local/ 会话数据布局分层 —— 会话目录 + 读侧双认 + 迁移命令（#[#379](https://github.com/diy-agent/diy/issues/379)） ([0dc9731](https://github.com/diy-agent/diy/commit/0dc97312f451ebc8e34724e469e23eb871a52d70))
* **agent:** plan 版本化 —— 内容寻址 CAS + 版本链，压缩事件只记版本（#[#378](https://github.com/diy-agent/diy/issues/378)） ([0b1cdac](https://github.com/diy-agent/diy/commit/0b1cdac73061c78b179aca19d52db2d7871dad6c))
* **agent:** write 工具（整文件写 + 路径/大小护栏 + 审计 + diff 摘要）（#[#414](https://github.com/diy-agent/diy/issues/414)） ([b252239](https://github.com/diy-agent/diy/commit/b252239d0808291a7f3e0f8198d6de2b321a51fd))
* **agent:** 大会话 seek 起点 —— 按字节预算向上取最近轮首（#[#293](https://github.com/diy-agent/diy/issues/293)） ([2fbcf1e](https://github.com/diy-agent/diy/commit/2fbcf1e70ca627b3179ad93203f19201e9a934ff))
* **agent:** 大会话分页 —— 窗口/游标接进 history 与渲染端（#[#293](https://github.com/diy-agent/diy/issues/293)） ([3483828](https://github.com/diy-agent/diy/commit/34838288908976f01b8e800d7cd99b6bd5aaace6))
* **agent:** 开轮准入 TurnGate —— 终态任务的会话不再开轮（#[#400](https://github.com/diy-agent/diy/issues/400)） ([f5ccc1e](https://github.com/diy-agent/diy/commit/f5ccc1e37ac40452da1ec001f4324821ee848995))
* **agent:** 开轮准入 TurnGate —— 终态任务的会话不再开轮（#[#400](https://github.com/diy-agent/diy/issues/400)） ([668a652](https://github.com/diy-agent/diy/commit/668a652190698d1553a4b867106737da3b9322da))
* **agent:** 补段多一条入口 —— 顶部提示条可点（#[#293](https://github.com/diy-agent/diy/issues/293) review R5/R7） ([4f422b3](https://github.com/diy-agent/diy/commit/4f422b3990bea7265745b9ba3c5318e64da5881b))
* **agent:** 补齐轮次结束的观察数据（rawFinishReason + 步流形状 + 原始 chunk）（#[#288](https://github.com/diy-agent/diy/issues/288)） ([9f3ec96](https://github.com/diy-agent/diy/commit/9f3ec96914f1999b9b28c1e067b98e527eef890f))
* **agent:** 轮次结束原因 endReason（判别联合落 turn 块）+ 崩溃轮补 interrupted（#[#288](https://github.com/diy-agent/diy/issues/288)） ([e1509e7](https://github.com/diy-agent/diy/commit/e1509e721f91357e5d07c8c6ff037b93fb256f53))
* **chat:** 会话数据层检索面板（⌘⇧F）+ ⌘F 0/0 桥接（#[#389](https://github.com/diy-agent/diy/issues/389)） ([f34916f](https://github.com/diy-agent/diy/commit/f34916f7aa08863ce08330af39c526a4cadec88c))
* **chat:** 会话数据层检索面板（⌘⇧F）+ ⌘F 0/0 桥接（#[#389](https://github.com/diy-agent/diy/issues/389)） ([337db9b](https://github.com/diy-agent/diy/commit/337db9b778bf94b778c56c3d178e1f8315868c76))
* **chat:** 动态框装所有收取中的数据（含正文）+ 结论/错误现场按 endReason（#[#262](https://github.com/diy-agent/diy/issues/262)） ([b7cea97](https://github.com/diy-agent/diy/commit/b7cea97f76b762a01c1aa2abd3e02ae25327d679))
* **chat:** 级别同构——一条行序列 + 活动框全级别可见 + 计数恒显（#[#253](https://github.com/diy-agent/diy/issues/253)） ([6f8c404](https://github.com/diy-agent/diy/commit/6f8c40488244f2c2372d6bc3de68914c27f4c053))
* **chat:** 结构 v4 落地 —— 过程历史 / 结尾槽 / 状态行三分（对齐定稿草图 rail-v4.html） ([17ddd10](https://github.com/diy-agent/diy/commit/17ddd10ae82ee5679f80511a56442a277162e8a4))
* **chat:** 轮次级四层折叠 + 身份上移 + 紧凑模式（#[#253](https://github.com/diy-agent/diy/issues/253) 重设计） ([4db744e](https://github.com/diy-agent/diy/commit/4db744e01e878bfd7fb03e75413f22c18b2fa4f1))
* **compact:** #[#343](https://github.com/diy-agent/diy/issues/343) M1 裁剪能力轴（取法可声明 clip）+ 保底 6 步全量 + 收编 #[#127](https://github.com/diy-agent/diy/issues/127) ([ac67c14](https://github.com/diy-agent/diy/commit/ac67c1478796c6689bc940e3801afff413edc44c))
* **compact:** #[#344](https://github.com/diy-agent/diy/issues/344) M2 plan 进配置（存储 history.keep[] + CLI plan get/set/check + 事件账 v3） ([4705abd](https://github.com/diy-agent/diy/commit/4705abd230998ddabac0b00f5eb62a8536ac4ea0))
* **compact:** #[#344](https://github.com/diy-agent/diy/issues/344) M2 UI 级列表编辑器 + 编辑纯函数单测 ([2b0e49c](https://github.com/diy-agent/diy/commit/2b0e49c0e7daf26ca4c5b472d6a0d1bd28e7ee33))
* **compact:** #[#363](https://github.com/diy-agent/diy/issues/363) plan reset 逃生窗口 —— 一键回出厂缺省（CLI + 工具 + UI 按钮 + 快照 + 审计） ([7cae116](https://github.com/diy-agent/diy/commit/7cae116e2ecce6bc7edd96eba459b41f1c9f2c6e))
* **compact:** plan reset 逃生窗口 —— 一键回出厂缺省（删 history.keep[]） ([e4c70a5](https://github.com/diy-agent/diy/commit/e4c70a51a5b8520dd1bc960e3b40ecf513f77983))
* **compact:** plan 工具面 + 安全闸 —— compact_plan 工具 + history.allowAgentWrite + 快照/审计（#[#362](https://github.com/diy-agent/diy/issues/362)） ([a81edf1](https://github.com/diy-agent/diy/commit/a81edf1f1073dd020d3ed8a59c7bf446bb281726))
* **compact:** reasoning 投递预算治理 —— 第二条裁剪轴 reasoningClip（只可裁短不可裁空） ([14ed065](https://github.com/diy-agent/diy/commit/14ed06599ace78ffd14abee8537d41e8638aa17d))
* **context-changelog:** 起点（baseline）= 一段会话的起点，可多条 + 手工重置入口（#[#310](https://github.com/diy-agent/diy/issues/310)） ([5538d0b](https://github.com/diy-agent/diy/commit/5538d0b4b972a7f840032aba8bf9b2a2e2eb077d))
* **context:** 信封（zod 派生 help）+ 每步变更告知（runtimeDiff）+ 可见性 view（#[#310](https://github.com/diy-agent/diy/issues/310)） ([6e1d56d](https://github.com/diy-agent/diy/commit/6e1d56d11ab0e0fd0c8d053039993365e73ad412))
* **ctxlab:** 变量树变更（步级标注）+ 该步实际请求（流量日志）+ 跳流量页定位（#[#310](https://github.com/diy-agent/diy/issues/310)） ([9b404fa](https://github.com/diy-agent/diy/commit/9b404fa1fc8f2f22c78e2c1f088ab4d0da835112))
* **ctx:** 单条工具结果不可绕过硬顶 100 KB（#[#406](https://github.com/diy-agent/diy/issues/406) 刀 3 · 治 #[#401](https://github.com/diy-agent/diy/issues/401) 死锁的根） ([91f4047](https://github.com/diy-agent/diy/commit/91f4047f5183c95c9e3e829c62b6e334b77f73fa))
* **diy-app:** instances 域 —— 实例大盘（#[#366](https://github.com/diy-agent/diy/issues/366)） ([84da55f](https://github.com/diy-agent/diy/commit/84da55f0b71c818aa94e8553f1ed7fec21b5e820))
* **diy-app:** instances 域 —— 实例大盘（扫进程 + 启动注册表 + 活体探测 + ls + 唤起） ([8926fc4](https://github.com/diy-agent/diy/commit/8926fc499fa4852ca80ec1363f06bf443282547a))
* **diy-ui/web:** 聊天 demo 归一化 + .unsafe 演示页 ([2e34b59](https://github.com/diy-agent/diy/commit/2e34b59ede5cb96be55b2d8db1404c79a7c456a3))
* **diy-ui/web:** 聊天/会话复刻 demo（真实大会话数据）+ rerun 诊断浮层 ([49c4b6a](https://github.com/diy-agent/diy/commit/49c4b6ad86f03c84a672e7bac2447c10ae737443))
* **diy-ui:** TS 实现包入库（core + pi-tui/DOM provider + web 原型） ([d9a20cc](https://github.com/diy-agent/diy/commit/d9a20cc38433fbd7a3b563d5a034508e189da7ae))
* **diy-ui:** 纯 TS 声明式 DOM 层（A/Eager + B/Generator）+ rerun 可观测 ([7fdc222](https://github.com/diy-agent/diy/commit/7fdc222859896f3e1490de4dece1cea0f3b0a2a6))
* **diy-ui:** 节点方法 + .unsafe 逃生口 + keyed 行级增量对账 ([7d441bd](https://github.com/diy-agent/diy/commit/7d441bdb67afebd4cd67c5f544b063b279a8fdb2))
* **docs:** 各领域规范中文 key 索引总表 + 查重护栏（#[#388](https://github.com/diy-agent/diy/issues/388)） ([6734fec](https://github.com/diy-agent/diy/commit/6734fecce059f6987b84ad027602d5fbc4c40c6b))
* **docs:** 各领域规范中文 key 索引总表 + 查重护栏（#[#388](https://github.com/diy-agent/diy/issues/388)） ([4038d77](https://github.com/diy-agent/diy/commit/4038d774bc2803d0eeb1e393434744c75f0be57c))
* **env-watch:** 环境感知 v1 —— 磁盘满/网断侦测 → 顶栏红条（#[#384](https://github.com/diy-agent/diy/issues/384)） ([b365863](https://github.com/diy-agent/diy/commit/b3658631e8ea3ee1581e24f45031bcf5dff42789))
* **env-watch:** 环境感知 v1 —— 磁盘满/网断侦测 → 顶栏红条（#[#384](https://github.com/diy-agent/diy/issues/384)） ([e856768](https://github.com/diy-agent/diy/commit/e85676851f0f15b63986d932466a98e8368c16c9))
* **err-triage:** 全局异常三档判据 + 统一 code + 棘轮护栏（#[#394](https://github.com/diy-agent/diy/issues/394) 刀1） ([d4dc908](https://github.com/diy-agent/diy/commit/d4dc90874548f6c77d16554ca335f035302deb24))
* **err-triage:** 全局异常三档判据 + 统一 code + 棘轮护栏（#[#394](https://github.com/diy-agent/diy/issues/394) 刀1） ([db3487b](https://github.com/diy-agent/diy/commit/db3487ba209978f2240efd3af75e3e036fa91fde))
* **error-remedy:** 外部错误 → 配置引导：声明式修复表 + 「去修复」入口 + 目标页定位高亮（#[#407](https://github.com/diy-agent/diy/issues/407)） ([68ec19b](https://github.com/diy-agent/diy/commit/68ec19b8d9a8c6a8829dcf9a62acc947879238d4))
* **error-remedy:** 外部错误 → 配置引导（#[#407](https://github.com/diy-agent/diy/issues/407)） ([d3614b8](https://github.com/diy-agent/diy/commit/d3614b8bf143351c705d6f57f31504174c16851f))
* **flow:** #[#313](https://github.com/diy-agent/diy/issues/313)(@diy/flow 工作流内核) —— 定义 DSL + 单指针泳道容器 + 轨迹投影 ([a7181b9](https://github.com/diy-agent/diy/commit/a7181b9166b28dc803c34f38bdc31f8b8542c17c))
* **flow:** #[#313](https://github.com/diy-agent/diy/issues/313)(@diy/flow 工作流内核) —— 定义 DSL（类型护栏）+ 单指针泳道容器（打回不增节点）+ 轨迹折线投影（意图测试 25 例） ([bc45d0a](https://github.com/diy-agent/diy/commit/bc45d0a555549829a71a422ea981c104fc4f734d))
* **flow:** #[#315](https://github.com/diy-agent/diy/issues/315) 插件槽位 + guard 数组求值 + 转移执行器 ([47e997c](https://github.com/diy-agent/diy/commit/47e997c02139955b3d4ae80ccee47c96bbda6556))
* **flow:** #[#315](https://github.com/diy-agent/diy/issues/315) 插件槽位 + guard 数组求值 + 转移执行器 ([0d4039d](https://github.com/diy-agent/diy/commit/0d4039dea273ef7ec6b7b20cd072ea5cdfc56315))
* **flow:** #[#316](https://github.com/diy-agent/diy/issues/316) 参数层 —— params schema（可枚举类型全集）+ 校验 + ctx.params 注入 ([4d5986b](https://github.com/diy-agent/diy/commit/4d5986b4923ffb589929ef4e5946ab7de1601207))
* **flow:** #[#316](https://github.com/diy-agent/diy/issues/316) 参数层 —— params schema（可枚举类型全集）+ 校验 + ctx.params 注入 ([1f06f6d](https://github.com/diy-agent/diy/commit/1f06f6d198e28a89bbf0a682c921dfe35f23491a))
* **flow:** #[#317](https://github.com/diy-agent/diy/issues/317) 范例①开发工作流 —— 端到端含打回轨迹 + ci/pr 插件 + params（工作流开发包样板） ([096b726](https://github.com/diy-agent/diy/commit/096b726646642fb588d319b5e051e84f387cf512))
* **flow:** #[#317](https://github.com/diy-agent/diy/issues/317) 范例①开发工作流 —— 端到端含打回轨迹 + ci/pr 插件 + params（工作流开发包样板） ([0b3bcd4](https://github.com/diy-agent/diy/commit/0b3bcd4ea0f7df6f9b5c741e98ead757db6d4944))
* **flow:** #[#318](https://github.com/diy-agent/diy/issues/318) 范例②视频 + 范例③金融工作流 + 通用渲染器契约（九种 data 形状） ([ae01ec1](https://github.com/diy-agent/diy/commit/ae01ec1263dc8e14fa7b7873dbb9d7f43457d178))
* **flow:** #[#318](https://github.com/diy-agent/diy/issues/318) 范例②视频 + 范例③金融工作流 + 通用渲染器契约（九种 data 形状） ([a6b4e41](https://github.com/diy-agent/diy/commit/a6b4e41799c38ebffb31976f05ccb10541fe3215))
* **flow:** #[#319](https://github.com/diy-agent/diy/issues/319) 宿主接入 —— 实例存储 + diy flow CLI 域 + 工作流与 task 绑定 + 提示词装配 ([fcfb53c](https://github.com/diy-agent/diy/commit/fcfb53c20f2f0446eee8c4d536bc623109e7acad))
* **flow:** #[#319](https://github.com/diy-agent/diy/issues/319) 宿主接入 —— 实例存储 + diy flow CLI 域 + 工作流与 task 绑定 + 提示词装配 ([96ff458](https://github.com/diy-agent/diy/commit/96ff45835483d839544b5d2f411b01d2990498fe))
* **flow:** #[#320](https://github.com/diy-agent/diy/issues/320)(泳道视图 UI) 轨迹折线 + 产物区 + 参数表单（独立子页面） ([3c8f2d0](https://github.com/diy-agent/diy/commit/3c8f2d0fd276839b693b03ed23bdcb650619b256))
* **flow:** #[#320](https://github.com/diy-agent/diy/issues/320)(泳道视图 UI) 轨迹折线 + 产物区 + 参数表单（真数据、独立子页面） ([94f4b0e](https://github.com/diy-agent/diy/commit/94f4b0ec7b57bbc05745228f2a3ed412b1707c57))
* **flow:** #[#333](https://github.com/diy-agent/diy/issues/333) 内核依赖反转 —— 领域状态一等（path/params 落盘 + 可重建快照）+ 事件降为审计 ([e39d27f](https://github.com/diy-agent/diy/commit/e39d27fe418856f9673cb796170ae1b7388366e1))
* **flow:** #[#333](https://github.com/diy-agent/diy/issues/333) 内核依赖反转 —— 领域状态一等（path/params 落盘 + 可重建快照）+ 事件降为审计 ([f47a645](https://github.com/diy-agent/diy/commit/f47a645563b23b70af783789127c2a105b419c51))
* **flow:** #[#337](https://github.com/diy-agent/diy/issues/337) 宿主的节点产物与视图下发（art + render 插件 + flow view） ([577d073](https://github.com/diy-agent/diy/commit/577d073f8c329d433c5e11d7675ce5f02a3586bc))
* **flow:** #[#341](https://github.com/diy-agent/diy/issues/341) 工作流自动轮转（节点执行器 + 驱动环 + actor 三分流） ([b5224dc](https://github.com/diy-agent/diy/commit/b5224dc4e782e224fbaa3740765b104218562cb9))
* **flow:** #[#341](https://github.com/diy-agent/diy/issues/341) 工作流自动轮转（节点执行器 + 驱动环 + actor 三分流） ([2fcaadf](https://github.com/diy-agent/diy/commit/2fcaadf7ce9e909ec4d19c8705647918bfe0f3fd))
* **flow:** #[#342](https://github.com/diy-agent/diy/issues/342) 打回意见与讨论线程：意见正文一等落盘 + 讨论视图 ([041b55d](https://github.com/diy-agent/diy/commit/041b55d4b1e073ac242104c763ca0f9bdac70fc0))
* **flow:** #[#342](https://github.com/diy-agent/diy/issues/342) 打回意见与讨论线程（意见正文一等落盘 + 讨论视图） ([ff140fe](https://github.com/diy-agent/diy/commit/ff140fe6e0692bc56a1e23398cf45bd911f0bc60))
* **flow:** 节点产物与视图下发（art + render 插件 + flow view） ([6ee392a](https://github.com/diy-agent/diy/commit/6ee392a201edbe574325dee075a86d0b621cd864))
* **job:** job 定义注册表 + 触发规则纯函数（#[#408](https://github.com/diy-agent/diy/issues/408) v1 刀 3） ([988d3fb](https://github.com/diy-agent/diy/commit/988d3fb7818e3e65972dfbd5b5a09d7aa91167d2))
* **job:** JobRun 记录模型 + origin 锚点 + 执行账（#[#408](https://github.com/diy-agent/diy/issues/408) v1 刀 2） ([7f969d5](https://github.com/diy-agent/diy/commit/7f969d56856f35186c2b61f4766863ec5be0d335))
* **job:** spawned job 闭环 —— bash 长命令 → 执行账 + 采样 + CLI 可见（#[#408](https://github.com/diy-agent/diy/issues/408) v1 刀 5） ([62967ba](https://github.com/diy-agent/diy/commit/62967bac2235341e5d1140f3cb1ab4e1efd1afac))
* **job:** 作业面板 + 来源导航（#[#408](https://github.com/diy-agent/diy/issues/408) v1 刀 6 · 用户面收口） ([ed9b8fb](https://github.com/diy-agent/diy/commit/ed9b8fbffd0b93ed235006b77d4e93480bf13188))
* **job:** 输出环 + 双 cursor（#[#408](https://github.com/diy-agent/diy/issues/408) v1 刀 4） ([e39be7a](https://github.com/diy-agent/diy/commit/e39be7a5421365f1a73e255a5d8e45e73b0f3985))
* **llm-traffic:** LLM 流量面板 —— 内存环形留住真实请求/响应，偶发 400 可当场追因（#[#309](https://github.com/diy-agent/diy/issues/309)(上游偶发 400 不可归因)） ([960a478](https://github.com/diy-agent/diy/commit/960a47816ed405f534d20390a8b81d0679f636b9))
* **llm-traffic:** 补聊天侧入口 + 完整查看器（树⇄原文、撑满高度）（#[#309](https://github.com/diy-agent/diy/issues/309)(上游偶发 400 不可归因)） ([e974063](https://github.com/diy-agent/diy/commit/e9740631e148ab92c4917266ed7170ccd17a1214))
* **local-agent:** 发消息排队化 —— 生成中再发消息改入队，不再抛错（#[#306](https://github.com/diy-agent/diy/issues/306)(发消息排队化)） ([2720894](https://github.com/diy-agent/diy/commit/2720894f6a11a008457bb2f9a1e047f3c66963e5))
* **local-agent:** 每步重算上下文并及时投递（prepareStep 刷新） ([88a9ebc](https://github.com/diy-agent/diy/commit/88a9ebc4d02f5d6a63a90c9cdc661587792d5019))
* **local-chat:** #[#307](https://github.com/diy-agent/diy/issues/307) 会话可见性读侧 —— main 写侧即推 op 增量 + renderer 按 seq 订阅折叠（收编 #[#232](https://github.com/diy-agent/diy/issues/232)/#[#306](https://github.com/diy-agent/diy/issues/306)） ([c74bba5](https://github.com/diy-agent/diy/commit/c74bba507c265c10ce9de3115bc519ef57835e62))
* **local-chat:** #[#307](https://github.com/diy-agent/diy/issues/307)(会话可见性读侧) —— main 写侧即推 op 增量 + renderer 按 seq 订阅折叠（收编 #[#232](https://github.com/diy-agent/diy/issues/232)） ([3f468a6](https://github.com/diy-agent/diy/commit/3f468a6c864744c982924aacf3eaf7d70af5100b))
* **models:** 模型目录应用内刷新 —— $DIY_HOME 落位 + 手工按钮 + 启动刷新（#[#385](https://github.com/diy-agent/diy/issues/385)） ([eb9d18a](https://github.com/diy-agent/diy/commit/eb9d18a5c3a86a008f33e037674e97f7c4d97437))
* **models:** 模型目录应用内刷新 —— $DIY_HOME 落位 + 手工按钮 + 启动自动刷新（#[#385](https://github.com/diy-agent/diy/issues/385)） ([dfc96d9](https://github.com/diy-agent/diy/commit/dfc96d9930964b2a79ecf71e46233a453756e79f))
* **nav:** #[#302](https://github.com/diy-agent/diy/issues/302) nav 按项目分类 —— 项目分组标题 + 归属色标（V1） ([fba3083](https://github.com/diy-agent/diy/commit/fba30836546410f1065c14b0261bc1421b6c5be8))
* **nav:** #[#302](https://github.com/diy-agent/diy/issues/302) nav 按项目分类 —— 项目分组标题 + 归属色标（V1） ([62e62a1](https://github.com/diy-agent/diy/commit/62e62a1950f9ddcd638e73912cf17552b40d6a65))
* **nav:** 会话列表合成一份（去掉三区标题，状态点表达活态） ([e9684ce](https://github.com/diy-agent/diy/commit/e9684ce2f2b428ca4579d8dc3d10e14dd8c07f13))
* **nav:** 会话行时间改相对（20h，每分钟自更新）+ 已对话/未对话退成会话气泡图标 ([a67e8de](https://github.com/diy-agent/diy/commit/a67e8de7a2a703b91afe42d6bd121bcc811db19b))
* **process-health:** 后台进程判活本地判据 + 采样器（#[#401](https://github.com/diy-agent/diy/issues/401) L1） ([35033d2](https://github.com/diy-agent/diy/commit/35033d2e91be1bea190052581ddc5da97dcfdbb7))
* **process-health:** 后台进程判活的本地判据 + 采样器（#[#401](https://github.com/diy-agent/diy/issues/401) L1） ([4f790ff](https://github.com/diy-agent/diy/commit/4f790ff2ddf4165a8233d5f8bf6dda13263c9841))
* **release:** npm 发布 @diy-agent/rpc + @diy-agent/ui（含 rpc 改名） ([5ed8544](https://github.com/diy-agent/diy/commit/5ed8544443e39ee7c5fc617e1f661686bfa060f4))
* **release:** npm 发布能力（@diy-agent/rpc / @diy-agent/ui） ([327be71](https://github.com/diy-agent/diy/commit/327be710a000bba3fe44a7565e2e0a39f1e1f606))
* **room:** channel 占位符进 room + 邀请成员只从人物选（#[#377](https://github.com/diy-agent/diy/issues/377) / #[#166](https://github.com/diy-agent/diy/issues/166) §28.K） ([888f825](https://github.com/diy-agent/diy/commit/888f82550b8e58b8abfacde6519039b20c0093a1))
* **room:** mention chip / 笔记消息 / 成员面板层级披露（#[#377](https://github.com/diy-agent/diy/issues/377) 第 12 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §38） ([cd57ce8](https://github.com/diy-agent/diy/commit/cd57ce8a50f3ea5b8ee9f32f2c5e4c04396c2036))
* **room:** 两个任务 agent 同室可寻址 + 投递带房间来源（#[#377](https://github.com/diy-agent/diy/issues/377) 第 21/22/23 刀） ([364cd99](https://github.com/diy-agent/diy/commit/364cd99e5c96f3c61fa5a1f407ed59cd79097caa))
* **room:** 任务会话署名贯通 + --diy-surface-raised 第四档（#[#377](https://github.com/diy-agent/diy/issues/377) 第 14 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §40） ([a9a829a](https://github.com/diy-agent/diy/commit/a9a829a913c9a717f5620bf7af940db4b8d5ca32))
* **room:** 任务会话署名贯通 + --diy-surface-raised 第四档（#[#377](https://github.com/diy-agent/diy/issues/377) 第 14 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §40） ([44edfe5](https://github.com/diy-agent/diy/commit/44edfe5e9d6324773ad3ec9824bd74266fa08c8e))
* **room:** 任务页发送改走 room 投递 + @ 成员补全 + 右栏默认开合（#[#377](https://github.com/diy-agent/diy/issues/377) 第 17 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §44.2） ([94cccb3](https://github.com/diy-agent/diy/commit/94cccb3598ba5954631e9a63ec14b3d4f344a13c))
* **room:** 任务页成员栏 + 「别人说的话」只读回显（#[#377](https://github.com/diy-agent/diy/issues/377) 第 16 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §43.3） ([1460383](https://github.com/diy-agent/diy/commit/1460383182fd8d1ba2f309cf54b8c3c426d73c8b))
* **room:** 任务页成员栏 + 「别人说的话」只读回显（#[#377](https://github.com/diy-agent/diy/issues/377) 第 16 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §43.3） ([75dcf78](https://github.com/diy-agent/diy/commit/75dcf7895f3cf5d38e875da92e271bd79432204d))
* **room:** 侧边栏三态 + 宽度可拖 + 输入区学任务对话（#[#377](https://github.com/diy-agent/diy/issues/377) 第 9 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §30） ([e67f9ae](https://github.com/diy-agent/diy/commit/e67f9aefb0d40f804c5cc5ffb267a95275986b37))
* **room:** 侧边栏布局四改 —— 文字/成员抽屉/成员行紧凑/右缘把手（#[#377](https://github.com/diy-agent/diy/issues/377) 第 13 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §39） ([705fa51](https://github.com/diy-agent/diy/commit/705fa51c52cd1c8a6b94ff703dc8148377e879e0))
* **room:** 侧边栏未读提示 —— 球态角标 + 面板「新消息」分界线（#[#377](https://github.com/diy-agent/diy/issues/377) 第 28 刀） ([d37366f](https://github.com/diy-agent/diy/commit/d37366fe2b97ae9dee3f91920175b50662e66b5a))
* **room:** 侧边栏未读提示（#[#377](https://github.com/diy-agent/diy/issues/377) 第 28 刀 · 可用性收口第 3 条） ([682a017](https://github.com/diy-agent/diy/commit/682a017815547e3418a7cb1c0e2acecdd61fbbc1))
* **room:** 侧边栏语义底色分层（#[#377](https://github.com/diy-agent/diy/issues/377) 第 10 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §36） ([def7fa8](https://github.com/diy-agent/diy/commit/def7fa8297c37e72ee8efc6d54d1fbf8337948f1))
* **room:** 全局侧边栏助手 room（#[#377](https://github.com/diy-agent/diy/issues/377) 第 8 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §30 · §31 待拍 82+85） ([f5b3804](https://github.com/diy-agent/diy/commit/f5b3804764b242d933288a27a07528f0322695d4))
* **room:** 右栏成员视图 + @all/多地址 + 单成员串行投递队列（#[#377](https://github.com/diy-agent/diy/issues/377)） ([1033088](https://github.com/diy-agent/diy/commit/103308859a563ab3c65f613c5650846a917cb1bf))
* **room:** 多人 room 侧边栏 —— 人 + 多 agent 同室对话（#[#377](https://github.com/diy-agent/diy/issues/377) / #[#166](https://github.com/diy-agent/diy/issues/166)） ([f688370](https://github.com/diy-agent/diy/commit/f688370a1995ed4f32ddb5181d03670c9f874360))
* **room:** 多人房间最小切片 —— 成员栏 + @/focus 投递 + 署名回显（#[#377](https://github.com/diy-agent/diy/issues/377)） ([f5624cd](https://github.com/diy-agent/diy/commit/f5624cdc996c9a99585ad48bf13759eb1fa46b5e))
* **room:** 宿主 = 任务对话页 —— room id = taskUri + 主人格成员 + 人物邀请后端（#[#377](https://github.com/diy-agent/diy/issues/377) / #[#166](https://github.com/diy-agent/diy/issues/166) §28.7 G） ([c0f143b](https://github.com/diy-agent/diy/commit/c0f143b35d9bce82a884b8a662b9d6229b08fa96))
* **room:** 形式无关的数据层 —— L1 成员状态 + 通用轮次读口（#[#377](https://github.com/diy-agent/diy/issues/377) / #[#166](https://github.com/diy-agent/diy/issues/166) 第三轮口径） ([5fe0133](https://github.com/diy-agent/diy/commit/5fe0133695656dbcc73bf65746cbdae265b9151c))
* **room:** 忙时发送语义统一 —— 每句话先落 room，忙则插进正在跑的那一轮（#[#377](https://github.com/diy-agent/diy/issues/377) 第 27 刀） ([f96eae8](https://github.com/diy-agent/diy/commit/f96eae83600b5ec0ac91b1be70a390a85eeb51c6))
* **room:** 忙时发送语义统一（#[#377](https://github.com/diy-agent/diy/issues/377) 第 27 刀） ([21e37a3](https://github.com/diy-agent/diy/commit/21e37a3ec0009c14270053db1b3ba63d6e269811))
* **room:** 忙时插话的回复归属（#[#377](https://github.com/diy-agent/diy/issues/377) 第 29 刀 · v1 收口） ([058a363](https://github.com/diy-agent/diy/commit/058a36327499778800bde6c788c91d275d009954))
* **room:** 忙时插话的回复归属可查 —— steerId 落盘 + 读侧反查 turnId（#[#377](https://github.com/diy-agent/diy/issues/377) 第 29 刀） ([5814fff](https://github.com/diy-agent/diy/commit/5814fff6bbc7c5c64845b1b1ae6af7002ac80ba7))
* **room:** 成员别名 —— 让「两个任务 agent 同室」可寻址（#[#377](https://github.com/diy-agent/diy/issues/377) 第 21 刀） ([54296db](https://github.com/diy-agent/diy/commit/54296dbbe2de4e600771da14f7bd272dcb1a15e4))
* **room:** 成员自起一轮注入房间上下文（#[#377](https://github.com/diy-agent/diy/issues/377) 第 25 刀） ([9785455](https://github.com/diy-agent/diy/commit/97854553690fe731280208764dac201821e1cbcf))
* **room:** 成员自起一轮注入房间上下文（#[#377](https://github.com/diy-agent/diy/issues/377) 第 25 刀）+ review2 R1 ([b3c07cc](https://github.com/diy-agent/diy/commit/b3c07cc1f2ad3865c6c5aad26c986976f29e39fd))
* **room:** 房间上下文改成 runtime.room 变量单元（#[#377](https://github.com/diy-agent/diy/issues/377) 第 26 刀） ([21103b6](https://github.com/diy-agent/diy/commit/21103b6b02084f08f2b039e64dfb1ab956297e04))
* **room:** 房间上下文改成 runtime.room 变量单元（#[#377](https://github.com/diy-agent/diy/issues/377) 第 26 刀） ([0ec0dad](https://github.com/diy-agent/diy/commit/0ec0dad3612ce99da6ae1d80a1ce8e722dae7854))
* **room:** 投递写回接收方房间（#[#377](https://github.com/diy-agent/diy/issues/377) 第 24 刀 · 双向可见）+ review1 R1/R2 ([7e926f5](https://github.com/diy-agent/diy/commit/7e926f5b6aa1c071d9dd28019f571896da486116))
* **room:** 投递写回接收方房间（#[#377](https://github.com/diy-agent/diy/issues/377) 第 24 刀）+ review1 R1/R2 ([dd076e8](https://github.com/diy-agent/diy/commit/dd076e856f45dcd3ebbf473b91da54f7c68da41a))
* **room:** 投递带房间来源（#[#377](https://github.com/diy-agent/diy/issues/377) 第 23 刀） ([5e1817b](https://github.com/diy-agent/diy/commit/5e1817bc76fefb04c4f4334a81018da935fd4cf8))
* **room:** 输入框补全（@ 成员 / ## 任务）（#[#377](https://github.com/diy-agent/diy/issues/377) 第 11 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §37） ([1b27025](https://github.com/diy-agent/diy/commit/1b27025a0fc877deeda884fe5612c6dcbcbda0e3))
* **room:** 进度消息 —— reply 带 ref，复用任务对话的块渲染（#[#377](https://github.com/diy-agent/diy/issues/377) / #[#166](https://github.com/diy-agent/diy/issues/166) §28.7 A） ([30f28d0](https://github.com/diy-agent/diy/commit/30f28d08a5601469fdbd27634db4e4039f243f97))
* **talk:** #[#314](https://github.com/diy-agent/diy/issues/314)(装配器) —— 三种装配策略（full/text-only/changes-only）+ 注入式窗口裁剪 ([732f052](https://github.com/diy-agent/diy/commit/732f052b119b9342d094d5288f5b287eb51d7e29))
* **talk:** #[#314](https://github.com/diy-agent/diy/issues/314)(装配器) —— 三种装配策略（full/text-only/changes-only）+ 注入式窗口裁剪 ([4745753](https://github.com/diy-agent/diy/commit/47457532f377cd6fbc562e396862ce70c76f6197))
* **talk:** 新增 @diy/talk 零依赖内核包 —— 事件/锚点/反应原语 + role 铁律（#[#312](https://github.com/diy-agent/diy/issues/312)(内核包@diy/talk)） ([0a60138](https://github.com/diy-agent/diy/commit/0a60138d00833c2ce901580cd021f96ca73daa21))
* **traffic:** #[#309](https://github.com/diy-agent/diy/issues/309)(上游偶发 400 不可归因) —— 出站请求观测（流量页 + 错误块深链） ([0f50741](https://github.com/diy-agent/diy/commit/0f507418ad4c53c63617a0d2eacc5903e0c29a80))
* **traffic:** #[#324](https://github.com/diy-agent/diy/issues/324) 流量日志缓存清理界面 —— 列文件 / 占用 + 只留最近 N 天 + 二次确认 ([6b2ee3c](https://github.com/diy-agent/diy/commit/6b2ee3c629b595e2bc49a53662c37441bffafc27))
* **traffic:** 序号/完整时间/列配置/排序/惰性加载 + 日志大小 + 字符串多格式预览（#[#309](https://github.com/diy-agent/diy/issues/309)(上游偶发 400 不可归因)） ([4e0b417](https://github.com/diy-agent/diy/commit/4e0b4178249b58ebfad3603959bc8aa7ed8f4243))
* **traffic:** 流量日志落盘（按天切/带版本）+ 首尾法正文截断 + 按位置随机读（#[#309](https://github.com/diy-agent/diy/issues/309)(上游偶发 400 不可归因)） ([4f25879](https://github.com/diy-agent/diy/commit/4f258797ccaae28859af175c765d042a7dbdf077))
* **traffic:** 流量面板独立成页 + 网络监控式列表 + 请求/响应完整查看（#[#309](https://github.com/diy-agent/diy/issues/309)(上游偶发 400 不可归因)） ([8230b21](https://github.com/diy-agent/diy/commit/8230b2142e6619698d8b308e7c9c8f5291c54010))
* **traffic:** 界面精修 + 磁盘日志按日期/全文查询（#[#309](https://github.com/diy-agent/diy/issues/309)(上游偶发 400 不可归因)） ([187e763](https://github.com/diy-agent/diy/commit/187e7634922bda5d358c991b8b2b20f8cf5ff2ea))
* **ui:** #[#308](https://github.com/diy-agent/diy/issues/308) 全局会话可见性总览 —— 总览页 + nav 角标 + 任务表 chip 共用同一份注册表订阅 ([fd0c462](https://github.com/diy-agent/diy/commit/fd0c4625f9be396844d61224f1de702190661031))
* **ui:** #[#355](https://github.com/diy-agent/diy/issues/355) 任务 agent 面状态：4 态 + 窗口 token 占比/数 ([a495740](https://github.com/diy-agent/diy/commit/a4957403f37a27682d37bf40e779caf2d8b6e45c))
* **ui:** #[#355](https://github.com/diy-agent/diy/issues/355) 任务 agent 面状态：4 态 + 窗口 token 占比/数 ([663660a](https://github.com/diy-agent/diy/commit/663660a051af33f6765f455b2c6d45ee79260aa8))
* **ui:** #[#356](https://github.com/diy-agent/diy/issues/356) 父子入口 + nav 任务置顶 + NavSearch 焦点陷阱 ([7bba6f8](https://github.com/diy-agent/diy/commit/7bba6f811d9ccdcc4ec821a69a21e9cea2b6eb8d))
* **ui:** #[#356](https://github.com/diy-agent/diy/issues/356) 父子入口 + nav 任务置顶 + NavSearch 焦点陷阱 ([f46c552](https://github.com/diy-agent/diy/commit/f46c552f6878ec5b67faaff3d0800d84d14798c2))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) D1/D2 判据层 —— nav 会话活动语汇（纯函数 + 单测） ([e2b57a2](https://github.com/diy-agent/diy/commit/e2b57a2ee990f095609218d8cc1523665dcd8546))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) D1/D2 接线 —— nav 主角标 + 次角标 + 「后台活动」区 ([6310d76](https://github.com/diy-agent/diy/commit/6310d7683268514fa8f2ad722b4bd5504bad00f3))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) D3 判据层 —— 会话提示的跃迁判据（L1/L2，纯函数 + 15 例单测） ([57f2b56](https://github.com/diy-agent/diy/commit/57f2b562f0e7a1f75f31af159824ea2f7ffd9ce7))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) D3 接线 —— L1 toast+[回到] / L2 自动拉回 / 关 tab 若在跑弹确认 ([47330fd](https://github.com/diy-agent/diy/commit/47330fda839c88dfd7a3850935dbe2bb88f4a84e))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) D4「继续工作」区 —— nav 第三顺位的时间轴（跨启动） ([3118e7d](https://github.com/diy-agent/diy/commit/3118e7d1e4aab9f19995a638a165b853ec68baaf))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) D5 判据层 —— 「待你处理」区（纯函数 + 17 例单测） ([199695a](https://github.com/diy-agent/diy/commit/199695abd1902dca732cd68b917b2c65ace65bfe))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) D5 接线 —— nav「待你处理」区 + 后台区标题行常驻 ([1cc2330](https://github.com/diy-agent/diy/commit/1cc2330759ef39563909a58f6df1ff8e77d2c872))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) D7 —— 任务详情「任务树」标会话状态（复用 SessionChip） ([a3c4ee2](https://github.com/diy-agent/diy/commit/a3c4ee2ba2a128410bca47957e2845f3f240ed1e))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) 会话活动可见性 —— 未读按轮次、账本当跨启动真源、任务表会话列 + 总览切片/排序 ([3e5ee21](https://github.com/diy-agent/diy/commit/3e5ee21e254e44742373242b0723d9fcc4bbc4c6))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) 会话活动可见性（D1~D7：nav 角标 / 后台活动 / 三级提示 / 继续工作 / 待你处理 / 任务表会话列 / 详情任务树） ([462c8db](https://github.com/diy-agent/diy/commit/462c8db346898597cdaa68ea870daba134e99c32))
* **ui:** nav ⌘K 快速打开会话弹层（#[#254](https://github.com/diy-agent/diy/issues/254)） ([467eda8](https://github.com/diy-agent/diy/commit/467eda80c11111cfb4c689133e371b3a59dd7ac8))
* **ui:** 上下文变更历史（事件粒度）—— 每轮事件流 + 旧→新 + 轮次 ref（#[#310](https://github.com/diy-agent/diy/issues/310)(178偏离-换任务开发)） ([c1f2ae0](https://github.com/diy-agent/diy/commit/c1f2ae006287cf8eebaa3d1ce49e0248866c9385))
* **ui:** 增补项目/任务删除能力（含二次确认）(#[#352](https://github.com/diy-agent/diy/issues/352)) ([f47b36e](https://github.com/diy-agent/diy/commit/f47b36e2f0e9d35835b3c2217bcb76a96ae57c00))
* **ui:** 增补项目/任务删除能力（含二次确认）(#[#352](https://github.com/diy-agent/diy/issues/352)) ([cd9d266](https://github.com/diy-agent/diy/commit/cd9d266501b0fdcc0eb326fb6ee2fc2d57ee1e40))
* **ui:** 实例大盘（二）—— 导航「实例」页 + 「显示」唤起 + 自动刷新（#[#367](https://github.com/diy-agent/diy/issues/367)） ([94831da](https://github.com/diy-agent/diy/commit/94831dac77ad6ecd140d6c5285bc3f9ec6f423d9))
* **ui:** 实例页的展示语义纯函数（#[#367](https://github.com/diy-agent/diy/issues/367) ①） ([0c67449](https://github.com/diy-agent/diy/commit/0c67449751d9062c95f8bad2ff399f68c6ccf76b))
* **ui:** 导航「实例」页 —— 表格 + 「显示」唤起 + 自动刷新（#[#367](https://github.com/diy-agent/diy/issues/367) ②） ([c811ee7](https://github.com/diy-agent/diy/commit/c811ee7200f1975a3cc9c726b39062750a16b027))
* **ui:** 折叠条按草图 v3 —— 贴条整块高 + 图标首行居中 ([eaa581f](https://github.com/diy-agent/diy/commit/eaa581f25a205f3bd1561ce8810ff39701806f78))
* **ui:** 提示体系规范化 v1 —— toast/常驻条带来源·原因·机制 + 详情面板（#[#391](https://github.com/diy-agent/diy/issues/391)） ([05cd796](https://github.com/diy-agent/diy/commit/05cd796d0e2f745b4e3d79d7c14068c81e2ba4dc))
* **ui:** 提示体系规范化 v1 —— toast/常驻条带来源·原因·机制 + 详情面板（#[#391](https://github.com/diy-agent/diy/issues/391)） ([fb31276](https://github.com/diy-agent/diy/commit/fb31276c76bc3d269bef16d2de96be36c504559e))
* **ui:** 界面样式（皮肤 rail/card）开关 + agent 输出区落地；轮尾状态行补图标与实时速度 ([7f0c959](https://github.com/diy-agent/diy/commit/7f0c959bafcd423897ed83baad76b8c876331e3d))
* **ui:** 窄窗 rail 常驻 + 点开浮层 —— 侧栏永不消失（#[#297](https://github.com/diy-agent/diy/issues/297)） ([b3113fc](https://github.com/diy-agent/diy/commit/b3113fc72fb56a85ce9f4bfd961aefc92ce9b2bb))
* **ui:** 竖列折叠手柄 + card 皮肤层级改用色条色（对齐草图 v4） ([9f3dfd3](https://github.com/diy-agent/diy/commit/9f3dfd3a9631236dc89642bed57569d09d3515a3))
* **ui:** 面板与控件 —— 1 级拖高 / 工具框最大化 / app 信息 copy / 流量页 viewset ([925c390](https://github.com/diy-agent/diy/commit/925c390a3e3a9dfe6498a68644b38b6eb5b48b78))


### Bug Fixes

* **##358:** review1 —— 契约测试漂移修绿 + 清死参数/lint 净增/注释漂移（#[#180](https://github.com/diy-agent/diy/issues/180) review1） ([27e3f20](https://github.com/diy-agent/diy/commit/27e3f207ec969d761bf4bc54c6ea26f9ebc2995d))
* **##377:** 水位写失败不再挂死投递流 + done 变不变量（owner review P1；#[#166](https://github.com/diy-agent/diy/issues/166) §44.6） ([8fdf6b5](https://github.com/diy-agent/diy/commit/8fdf6b523a828168abb78fe6a69b40ce715e5ff8))
* **agent/ui:** #[#303](https://github.com/diy-agent/diy/issues/303) 空闲入队的留言不再是死消息 —— flushSteers 显式入口 + 空闲唤醒（修法 a+c） ([fb04e87](https://github.com/diy-agent/diy/commit/fb04e873bdd23b70140626419ecd9ea0510997c5))
* **agent:** #[#240](https://github.com/diy-agent/diy/issues/240) review1 处置 —— 活态属性变化即 touch + turn 带 model/cwd + activeTurns 收敛为注册表投影 ([77d2635](https://github.com/diy-agent/diy/commit/77d2635185b85372d134473804a1515ad7e56aff))
* **agent:** #[#349](https://github.com/diy-agent/diy/issues/349) token 速度三档展示 + 口径改 token÷总耗时 ([08aec50](https://github.com/diy-agent/diy/commit/08aec509e09387f4a76b40c6f8b6d73206e726d0))
* **agent:** #[#349](https://github.com/diy-agent/diy/issues/349) token 速度三档展示（⚡实时/⌀轮均/⌀总均）+ 口径改 token÷总耗时（含 TTFT） ([ecedc5f](https://github.com/diy-agent/diy/commit/ecedc5f56886029d1f5bed02b292de524154d9d2))
* **agent:** #[#371](https://github.com/diy-agent/diy/issues/371) thinking 模式回传 reasoning_content（历史投影丢弃 think 块） ([7624c9b](https://github.com/diy-agent/diy/commit/7624c9bfeb4eaae6adcff7711bf6db1830fd849e))
* **agent:** #[#372](https://github.com/diy-agent/diy/issues/372) 口径收紧 —— 计价不回退（查不到即无价目，不猜 provider） ([e815a8b](https://github.com/diy-agent/diy/commit/e815a8bd26a34273cfd7d0a92779a4649d8bd457))
* **agent:** #[#372](https://github.com/diy-agent/diy/issues/372) 裸 modelId 歧义 → 计价限定到本请求 provider ([99a2892](https://github.com/diy-agent/diy/commit/99a28926ab2ec25e423d0964ed6e654bd147fa0d))
* **agent:** #[#372](https://github.com/diy-agent/diy/issues/372) 裸 modelId 歧义 → 计价限定到本请求 provider ([99090c9](https://github.com/diy-agent/diy/commit/99090c9d40f95e2fb5adb7bc515d588529c91e52))
* **agent:** bash 工具 spawn 显式隔离 stdin，修无路径 rg 挂到 300s 超时（#[#418](https://github.com/diy-agent/diy/issues/418)） ([0c5cc05](https://github.com/diy-agent/diy/commit/0c5cc05463a06ccc8deee18d1e1715cf62d5a8a5))
* **agent:** bash 工具超时先收尾再杀组 + 结果加 YAML 头（#[#419](https://github.com/diy-agent/diy/issues/419)） ([a245419](https://github.com/diy-agent/diy/commit/a245419894d5301d968e886ade2da478ae8e33f9))
* **agent:** bash 工具超时先收尾再杀组 + 结果加 YAML 头（#[#419](https://github.com/diy-agent/diy/issues/419)） ([7406b94](https://github.com/diy-agent/diy/commit/7406b94efbf86dadf7f3b3f149c94b285839c9ba))
* **agent:** bash 超时 30s → 300s，超时文案给出时长与出路 ([c55296d](https://github.com/diy-agent/diy/commit/c55296de5e3553e5bbcd0e5028035692e77d4895))
* **agent:** bash 非零退出 + stderr 非空 → 工具行 ✗（复议 #[#332](https://github.com/diy-agent/diy/issues/332) ①） ([3adcd56](https://github.com/diy-agent/diy/commit/3adcd561dbad036618e737a0713d54beaf6378f2))
* **agent:** bash 非零退出 + stderr 非空 → 工具行 ✗（复议 #[#332](https://github.com/diy-agent/diy/issues/332) ①） ([7a8a459](https://github.com/diy-agent/diy/commit/7a8a45927c2d133edfb4e59ab08ed3c743b03824))
* **agent:** chat 流订阅也接 RPC signal，无 op 窗口断开即时退订（#[#305](https://github.com/diy-agent/diy/issues/305) review1 收口） ([6737386](https://github.com/diy-agent/diy/commit/67373863338c48d1c64e4ee1f6394c41674eb7c3))
* **agent:** plan CAS 写改走 writeFileAtomic + 清理未用 import（#[#378](https://github.com/diy-agent/diy/issues/378) review1） ([97eb222](https://github.com/diy-agent/diy/commit/97eb222edc2c69380c4b5f5b094bbc054c34aa57))
* **agent:** seek 回溯块接缝漏检 —— 相邻块留 19B 重叠（#[#293](https://github.com/diy-agent/diy/issues/293) review R2/R4/R6/R8） ([cdf9afa](https://github.com/diy-agent/diy/commit/cdf9afafe8871e420b14b93277cd279dd2870788))
* **agent:** thinking 回放归一跑到轮内每一步 —— 修 #[#405](https://github.com/diy-agent/diy/issues/405) 第 85 步 400 ([d9f63a0](https://github.com/diy-agent/diy/commit/d9f63a06925a4154c1c462aeded7eb9fbd3acf1b))
* **agent:** thinking 回放补空串兜底 —— 无 think 块的 assistant 也带 reasoning_content（#[#398](https://github.com/diy-agent/diy/issues/398)） ([a7f57dd](https://github.com/diy-agent/diy/commit/a7f57ddfaa798da3ba43e53488e1e7f89cde95d1))
* **agent:** thinking 回放补空串兜底 —— 无 think 块的 assistant 也带 reasoning_content（#[#398](https://github.com/diy-agent/diy/issues/398)） ([067c537](https://github.com/diy-agent/diy/commit/067c537fd1f622b6e0582d4adb5d834662f34cbf))
* **agent:** write 工具护栏收紧（.. 前缀误判 / 大文件不读 / realpath fail-closed / BOM 对称）（#[#414](https://github.com/diy-agent/diy/issues/414) review1） ([1ff3a70](https://github.com/diy-agent/diy/commit/1ff3a7016b49ff666bc8f32668ab57f32f06e3fe))
* **agent:** 上滚补段的位置补偿改「增量 + 锚点连校」—— 不再吞掉在途滚动（#[#293](https://github.com/diy-agent/diy/issues/293)） ([33733a6](https://github.com/diy-agent/diy/commit/33733a6ca197179e0845597813818eb369dc8098))
* **agent:** 刷新/切页/断连不再打断正在跑的轮次，生命周期独立于 renderer 连接（#[#305](https://github.com/diy-agent/diy/issues/305)） ([22de717](https://github.com/diy-agent/diy/commit/22de71730519cbf2b741899a43020446c059d606))
* **agent:** 历史投影把 think 块还原成 reasoning part（#[#371](https://github.com/diy-agent/diy/issues/371)） ([82b171f](https://github.com/diy-agent/diy/commit/82b171f182d3ca4ed051ae0040ab1936d32c3025))
* **agent:** 压缩注记只在真丢弃时出现 + 移回首条 + help 讲清压缩（#[#421](https://github.com/diy-agent/diy/issues/421)） ([4602801](https://github.com/diy-agent/diy/commit/46028019d688b15feb6d8b3cf0a6c05cc5041a66))
* **agent:** 压缩注记只在真丢弃时出现 + 移回首条 + help 讲清压缩（#[#421](https://github.com/diy-agent/diy/issues/421)） ([f980ddd](https://github.com/diy-agent/diy/commit/f980ddd4bfa66b63d21aa86e4a245e95a5d8457e))
* **agent:** 取消串到 bash 工具执行 —— 杀整组 + 工具块落「中断」终态（#[#375](https://github.com/diy-agent/diy/issues/375)） ([e2b119c](https://github.com/diy-agent/diy/commit/e2b119c7dfe55c8c488505cc483d1f77294cb854))
* **agent:** 取消串到 bash 工具执行 —— 杀整组 + 工具块落「中断」终态（#[#375](https://github.com/diy-agent/diy/issues/375)） ([0cc9ded](https://github.com/diy-agent/diy/commit/0cc9dedac739f4b95f682c1fe14f928ff275dc04))
* **agent:** 渲染端认「游标失效」—— stale 必须整树重置（#[#293](https://github.com/diy-agent/diy/issues/293) review R3） ([a7ff97b](https://github.com/diy-agent/diy/commit/a7ff97ba838fc4040b7e46a0a2f8aa2a08cbaabf))
* **agent:** 窗口预算 ≤0 / 缺省 → 退全量，不再静默截断到单轮（#[#293](https://github.com/diy-agent/diy/issues/293)） ([89ad88a](https://github.com/diy-agent/diy/commit/89ad88abaf57a649733a2bbed6da28b0f32be096))
* **agent:** 结构性 op 批原子落盘 + 开新一轮时收敛残留开口块 —— 断开切在 error 块中途会丢文案并留开口块（#[#294](https://github.com/diy-agent/diy/issues/294)） ([f2c527a](https://github.com/diy-agent/diy/commit/f2c527a9e96ecf4cf3b436b16b6c6e9a7829c30d))
* **agent:** 订阅类 serverStream 断开即时退订，订阅不残留在悬挂的 next() 上（#[#305](https://github.com/diy-agent/diy/issues/305)） ([1100a57](https://github.com/diy-agent/diy/commit/1100a574269faa88c0873264cec83dab9a5aa15d))
* **agent:** 轮次生命周期独立于 renderer 连接（#[#305](https://github.com/diy-agent/diy/issues/305)） ([62dca69](https://github.com/diy-agent/diy/commit/62dca690331c81f39c5d6a633f2dc5dbf6d43775))
* **agent:** 轮次边界 op 乐观置位，治「发消息一刹那闪本轮未完成」（#[#390](https://github.com/diy-agent/diy/issues/390)） ([3e191b9](https://github.com/diy-agent/diy/commit/3e191b9574be61882b354bf8e38776695539a408))
* **agent:** 轮次边界 op 乐观置位，治「发消息一刹那闪本轮未完成」（#[#390](https://github.com/diy-agent/diy/issues/390)） ([21a7f05](https://github.com/diy-agent/diy/commit/21a7f05b064e703a72f35de819260a698aeeb96d))
* **agent:** 迁移临时文件用 .tmp 过原子写护栏 + 截断目标备份重做（#[#379](https://github.com/diy-agent/diy/issues/379)） ([a211191](https://github.com/diy-agent/diy/commit/a211191d8a03f7588e4065ea42b3dcc7fbcb8f81))
* **agent:** 迁移改原子落盘 + review1 顺手项（#[#379](https://github.com/diy-agent/diy/issues/379)） ([efaec96](https://github.com/diy-agent/diy/commit/efaec96258fc22c058929a19ccca7b269c2abf45))
* **atomic:** src/main 整文件覆盖写全量收敛 + check 护栏（#[#383](https://github.com/diy-agent/diy/issues/383)） ([950727f](https://github.com/diy-agent/diy/commit/950727f0a7e36b806d8e2d4e36c3932942a0e59a))
* **atomic:** src/main 整文件覆盖写全量收敛到 writeFileAtomic + check 护栏（#[#383](https://github.com/diy-agent/diy/issues/383)） ([59031c5](https://github.com/diy-agent/diy/commit/59031c5e489e7416bf0d973ab4768d3f07f6dccf))
* **chat:** #[#354](https://github.com/diy-agent/diy/issues/354) 聊天页显示小改 —— 用量术语成对 + 圆环弧长同源同刻 + 订阅故障常驻条 ([0256ace](https://github.com/diy-agent/diy/commit/0256ace8d65b66fdc74954b1b337bb7d3942ebd7))
* **chat:** #[#354](https://github.com/diy-agent/diy/issues/354) 聊天页显示小改 —— 用量术语成对 + 圆环弧长同源同刻 + 订阅故障常驻条 ([fccbde2](https://github.com/diy-agent/diy/commit/fccbde21ddc2009a45e29ab8a043197f7c53ac8c))
* **chat:** 任务页「看不见最新轮」—— 三处真根因 + 逐条容错（#[#377](https://github.com/diy-agent/diy/issues/377) 第 15 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §41） ([0ca6b82](https://github.com/diy-agent/diy/commit/0ca6b82fe2fd1cee6dada0d30edf694c3ba47287))
* **chat:** 任务页「看不见最新轮」—— 四真根因 + 逐条容错（#[#377](https://github.com/diy-agent/diy/issues/377) 第 15 刀 / #[#166](https://github.com/diy-agent/diy/issues/166) §41-42） ([d6bbf32](https://github.com/diy-agent/diy/commit/d6bbf3289c7207dd3136606c6c9857809d3245d8))
* **chat:** 删掉「其他端（CLI/窗口）正在生成…」常驻文案（#[#412](https://github.com/diy-agent/diy/issues/412)） ([32b687f](https://github.com/diy-agent/diy/commit/32b687fd1dfd1fb20b2b6c7717621c1561de8911))
* **chat:** 删掉「其他端（CLI/窗口）正在生成…」常驻文案（#[#412](https://github.com/diy-agent/diy/issues/412)） ([c1e4de8](https://github.com/diy-agent/diy/commit/c1e4de8ff1b61059b9858710d9a3ea782811a805))
* **chat:** 单通道的可见性兜底 —— 订阅坏了要出声、要能补回来（#[#327](https://github.com/diy-agent/diy/issues/327) review1 R1/R2/R3） ([e57969b](https://github.com/diy-agent/diy/commit/e57969b0dd01d300c3b8f0192e224ca93e2d6388))
* **chat:** 块树唯一 apply 通道 —— chat 流不再落地 op，实时显示全交 opsWatch（#[#327](https://github.com/diy-agent/diy/issues/327)） ([9efb136](https://github.com/diy-agent/diy/commit/9efb136f7ccca50a199a327aba579f6e7012344d))
* **chat:** 定位闭环认用户接管（不再把人拽回）+/historyAt budget 语义说事实+桥接文案（#[#389](https://github.com/diy-agent/diy/issues/389) review1 R1-R4） ([29784a3](https://github.com/diy-agent/diy/commit/29784a32b85c1f0a61393f6aec02436a0086f9b8))
* **chat:** 工具结果直播可见 + 状态/输出分离 + 意图标题 + 耗时·字节角标（#[#403](https://github.com/diy-agent/diy/issues/403)，布局零改动） ([34c762b](https://github.com/diy-agent/diy/commit/34c762b258b9474523a169b381237883baba6e9b))
* **chat:** 工具结果直播可见 + 状态/输出分离 + 意图标题 + 耗时·字节角标（布局零改动） ([60b4fae](https://github.com/diy-agent/diy/commit/60b4fae1e47f151aabbefce574d80f7b8b4ea63d))
* **chat:** 收起态恒显用户发言 —— 留言不再跟着过程一起被折叠 ([5817a54](https://github.com/diy-agent/diy/commit/5817a546b73dd4dbb37d56808c1fe52422c8fa84))
* **chat:** 署名判据真同源（hasAuthor 接入 UserBubble）+ 补 lock（#[#377](https://github.com/diy-agent/diy/issues/377) 第 15 刀 / #[#266](https://github.com/diy-agent/diy/issues/266) review2 R4） ([c60326f](https://github.com/diy-agent/diy/commit/c60326f7651fe9a55cf08bfd4dc47020d26ea8dd))
* **check:** 原子写护栏结论行按泄漏分支（#[#383](https://github.com/diy-agent/diy/issues/383) review2 R6） ([e13b334](https://github.com/diy-agent/diy/commit/e13b3342f317753d8d6a364b3ebb5413297025df))
* **check:** 原子写护栏补 3 处盲区（.tsx 承诺/正则字面量/截断与拷贝族）（#[#383](https://github.com/diy-agent/diy/issues/383) review1） ([2d505e2](https://github.com/diy-agent/diy/commit/2d505e237e7ac05dd3fa14602e2486a06ba39730))
* **cli:** #[#338](https://github.com/diy-agent/diy/issues/338) task edit 正文入参显式分家 + --body 路径形态护栏 ([23c7192](https://github.com/diy-agent/diy/commit/23c7192ddaeba4dab6f585c77c0277048720a81e))
* **cli:** #[#376](https://github.com/diy-agent/diy/issues/376) task create / drafts set 的 --body 补同型护栏（#[#338](https://github.com/diy-agent/diy/issues/338) 遗留 1） ([a1aed2c](https://github.com/diy-agent/diy/commit/a1aed2cba0f0eac7e013b0b64d0f8f0732ae17c4))
* **cli:** #[#376](https://github.com/diy-agent/diy/issues/376) task create / drafts set 的 --body 补同型护栏（#[#338](https://github.com/diy-agent/diy/issues/338) 遗留 1） ([3aae4e6](https://github.com/diy-agent/diy/commit/3aae4e6ae63afc52c1545bddfc37a9b3945b166b))
* **cli:** CLI 入口快检 electron 二进制 —— 缺/悬空先补，不再「缺了不重下」 ([842c2f0](https://github.com/diy-agent/diy/commit/842c2f0033e6435bb10406cbc409342d027591d7))
* **compact:** #[#370](https://github.com/diy-agent/diy/issues/370) auto-compact.yaml 缺键不再整份静默回默认 ([f18391c](https://github.com/diy-agent/diy/commit/f18391c2c09846465e85c4f4c1a4cf4a4cbd2347))
* **compact:** #[#370](https://github.com/diy-agent/diy/issues/370) auto-compact.yaml 缺键不再整份静默回默认（逐键回落 + 出声） ([c46519a](https://github.com/diy-agent/diy/commit/c46519af9e27ddfedb6d55ca3e47cdebc28c7e55))
* **compaction:** 装配后硬上限 + 发请求前 token 预检（#[#406](https://github.com/diy-agent/diy/issues/406) 刀 2） ([980fb1d](https://github.com/diy-agent/diy/commit/980fb1d8ab5d7581c79e666cafd7f90363e36230))
* **compaction:** 装配后硬上限 + 发请求前 token 预检（#[#406](https://github.com/diy-agent/diy/issues/406) 刀 2） ([b38d2b0](https://github.com/diy-agent/diy/commit/b38d2b08e792b80a8f598a5f3f937ee0894dc747))
* **context:** 压缩注记独立成顶层键 `history:`，不再混进 user.message（#[#310](https://github.com/diy-agent/diy/issues/310)） ([1983189](https://github.com/diy-agent/diy/commit/198318925f0dd84407adfdde5e60c6462c7907a6))
* **context:** 摘要独立成顶层键 summary: + `<>` 说明走 info bar（#[#310](https://github.com/diy-agent/diy/issues/310) 九轮） ([4da50ee](https://github.com/diy-agent/diy/commit/4da50eecb8703d1fec9f716e430253fc3f5906ac))
* **context:** 跨重启播种变更游标 + 订正「拒连续同角色」的未验证依据（#[#310](https://github.com/diy-agent/diy/issues/310)） ([e677675](https://github.com/diy-agent/diy/commit/e677675d4b583294bbd8952482cec81bd4567bbb))
* **dev:** #[#368](https://github.com/diy-agent/diy/issues/368) ./sha.sh sync 同步真配置 + seed 缺省模型口径收口 ([c25e433](https://github.com/diy-agent/diy/commit/c25e433e91038c9772421559ba735104e359b0ab))
* **diy-app:** Windows 下构建产物把本地源码误判为外部依赖 ([722d104](https://github.com/diy-agent/diy/commit/722d104ca4ddfc9d81017a4c61ce79a616a6eb2d))
* **diy-ui:** sha.sh 补回可执行位（100644 → 100755） ([1280574](https://github.com/diy-agent/diy/commit/12805742a815c4def2fb462328a205f457c843cd))
* **diy-ui:** 补 test-unit 入口 —— 根 ./sha.sh test-unit 对每个 workspace 跑它，缺了整轮在最后一个包中止 ([9058e4f](https://github.com/diy-agent/diy/commit/9058e4f15e32d9cd3af2e01119cde95d19a4eb7e))
* **docs:** G3 收窄到 5 份链（不含 pkgs.ts 其余包）+ rebase 到 main（#[#388](https://github.com/diy-agent/diy/issues/388) review1） ([40a5157](https://github.com/diy-agent/diy/commit/40a5157ffa295578ace18d4ea5cf3d1bfa21b258))
* **docs:** G3 改基线 ratchet（只报增量）+ 链补主仓容器层（#[#388](https://github.com/diy-agent/diy/issues/388) review1 R1） ([6c3eaa8](https://github.com/diy-agent/diy/commit/6c3eaa8f05c2a138601f4d9acb05bc2c07fd28a0))
* **env-watch:** rebase 到最新 main + R1/R2（#[#384](https://github.com/diy-agent/diy/issues/384) review1） ([fe42708](https://github.com/diy-agent/diy/commit/fe42708c37423ace7e4ec437ce3f5ad6dcebb105))
* **env-watch:** 槽键改用卷标识 dev（#[#384](https://github.com/diy-agent/diy/issues/384) review2 R1） ([8fd6672](https://github.com/diy-agent/diy/commit/8fd6672f0620c64f42d44308db1efd384592d1eb))
* **err-triage:** legacy aborted:abort 归「预期内」+ 钉死请求超时口径（#[#394](https://github.com/diy-agent/diy/issues/394) review1 R1/R2） ([9f94ec8](https://github.com/diy-agent/diy/commit/9f94ec8f9ed6d5f9fc9c27b41e0bd6b94b691cdf))
* **flow:** #[#313](https://github.com/diy-agent/diy/issues/313)(@diy/flow) review1 收口 ([9a459f6](https://github.com/diy-agent/diy/commit/9a459f67b1bcfce95b9b8b5d2faa1fa5c6d6a6da))
* **flow:** #[#313](https://github.com/diy-agent/diy/issues/313)(@diy/flow) review1 收口 —— 根 vitest projects 登记 + README/index 示例纠错 + AGENTS 登记 ([274d53b](https://github.com/diy-agent/diy/commit/274d53b5d2078e04a889740bc6a42d4eb3cc4a8a))
* **flow:** #[#315](https://github.com/diy-agent/diy/issues/315) review 收口 —— 副作用次序 / 边条件 / 宣布者 / 选项封闭 / 通知旁路 ([a3db73c](https://github.com/diy-agent/diy/commit/a3db73ca0bfd59c49656d73ac7afb3ee712935d8))
* **flow:** #[#315](https://github.com/diy-agent/diy/issues/315) review2 收口 —— 边条件两侧共用 / 系统节点死锁组合期报 / 诊断与卫生 ([ea280ce](https://github.com/diy-agent/diy/commit/ea280ce1876e443437b68e0db8115a7d390c4ba3))
* **flow:** #[#316](https://github.com/diy-agent/diy/issues/316) review1 收口 —— 快照期补三条不变量 / hint 占位符定义期校验 / renderHint 定位 ([c034ee3](https://github.com/diy-agent/diy/commit/c034ee3f4689cc5ea3cacc1819c7a3da4d12701a))
* **flow:** #[#318](https://github.com/diy-agent/diy/issues/318) review1 —— 清 P2-1（契约类型导出）+ P3-1（README 与代码相反） ([67a5e14](https://github.com/diy-agent/diy/commit/67a5e14244fdf05e34e6ea017827a6f60d813660))
* **flow:** #[#319](https://github.com/diy-agent/diy/issues/319) review1 收口 —— pkgDeps 共享真源（P2-A）+ 终态语义 finish（P2-B）+ URI 闸门（P3-A） ([b4b2001](https://github.com/diy-agent/diy/commit/b4b200110f32110238a9e7cb2d1a01aae86310c3))
* **flow:** #[#320](https://github.com/diy-agent/diy/issues/320) review1 处置 —— 产物逐驻留取数（P1-1）+ 产物区确定态判据（P3-1） ([8b29096](https://github.com/diy-agent/diy/commit/8b2909639fd6414fe04d195bf06089bcb5e9b081))
* **flow:** #[#333](https://github.com/diy-agent/diy/issues/333) review1 收口 —— 堵住「已进入却没记参数值」的静默窗口（P2-1）+ 清 P3 五条 ([b9c2851](https://github.com/diy-agent/diy/commit/b9c28517fd1353fd5ccbb2780954eb4df3f609e1))
* **flow:** #[#333](https://github.com/diy-agent/diy/issues/333) review2 收口 —— 领域推进正路承载 params（P1，正路闭环）+ 清 P3-6/P3-7 ([358fffb](https://github.com/diy-agent/diy/commit/358fffbf5a55148fb2f3aecfc94c58fff5a3e8f5))
* **flow:** #[#333](https://github.com/diy-agent/diy/issues/333) review3 收口 —— 正路不许静默换配置（P2-1）+ index 头注补 params（P3-1） ([2986c67](https://github.com/diy-agent/diy/commit/2986c6711baebdb44f28975ff96455fd5e564da3))
* **flow:** #[#337](https://github.com/diy-agent/diy/issues/337) review1 收口 —— doc 产物形状（P2-A）+ 坏袋不拖垮领域读（P2-B）+ 失配闸门单测（P3-1） ([af22ab2](https://github.com/diy-agent/diy/commit/af22ab27bb6a74812ccf595aaba13aa3b731cae9))
* **flow:** #[#341](https://github.com/diy-agent/diy/issues/341) review1 —— 会话忙不替用户插话（session-busy）+ human 优先 + 落袋失败不挡轮次 ([2e5bff9](https://github.com/diy-agent/diy/commit/2e5bff9fd09d949cfdc5124a96b87e5feecc6fec))
* **flow:** #[#341](https://github.com/diy-agent/diy/issues/341) review2 P1-1 收窄执行者类型（route.exec）+ P3-1 落袋失败并入用例 ([d11c838](https://github.com/diy-agent/diy/commit/d11c83870613ed7e62c5a38e1edf2c2a4dbf954f))
* **flow:** #[#342](https://github.com/diy-agent/diy/issues/342) review1 —— 空发言闸门收成一处真源 + 打回边判据单源 ([0d6c9cc](https://github.com/diy-agent/diy/commit/0d6c9cc98f4537dedde759aa1a59d7e35b7531be))
* **instance:** 实例身份靠活体自报，不靠端口（#[#328](https://github.com/diy-agent/diy/issues/328)） ([640f6d7](https://github.com/diy-agent/diy/commit/640f6d76616b6bd3036879b67a1706de0413d47d))
* **instance:** 实例身份靠活体自报，不靠端口（#[#328](https://github.com/diy-agent/diy/issues/328)） ([398506a](https://github.com/diy-agent/diy/commit/398506a9a9aa380bd2258321dbd79e6e0860c799))
* **local-agent:** bash spawn/IO 失败改抛错，工具行不再误标 ✓（#[#332](https://github.com/diy-agent/diy/issues/332) ③） ([571f7df](https://github.com/diy-agent/diy/commit/571f7df13dd64ac10388de31ad88a464ea66039c))
* **local-agent:** read 工具失败仍显示成功 ✓ —— catch-and-return 吞错致错误不可见 (#[#329](https://github.com/diy-agent/diy/issues/329)) ([fc18c98](https://github.com/diy-agent/diy/commit/fc18c983884df56a0badd90cf7b77fc7dfd499d7))
* **local-agent:** read 工具失败改抛错，交 SDK 发 tool-error（#[#329](https://github.com/diy-agent/diy/issues/329)） ([00c220f](https://github.com/diy-agent/diy/commit/00c220f347c6100aeab584b1ce874d058c7530c4))
* **local-agent:** review306 review2 处置 —— A/B 注释腐坏与文档落层、C 回执 id 结构性唯一、D 上限注入用例、G.3 缺省时机常量上移（#[#306](https://github.com/diy-agent/diy/issues/306)(发消息排队化)） ([032472d](https://github.com/diy-agent/diy/commit/032472d89647f4c01ca41e85504047b6327dfb65))
* **local-blocks:** tool-result 失败改 error-text，成败落到结构位（#[#329](https://github.com/diy-agent/diy/issues/329) 的 b） ([c47fc38](https://github.com/diy-agent/diy/commit/c47fc3837dd37ed69eb91d809a190891fdf47b4f))
* **local-chat:** #[#306](https://github.com/diy-agent/diy/issues/306) 收编 —— 排队回执降级为普通提示条（非红色 ErrorBox） ([8a69adb](https://github.com/diy-agent/diy/commit/8a69adb4e3b6de5cf7a2d46498eec7bef70bbd1f))
* **local-chat:** #[#307](https://github.com/diy-agent/diy/issues/307) review2 处置 —— R1 首建 feed 水位基线、R2 停止收尾时钟、R3 断线重连、R4 洞即重订、R5 文档实名 ([9f17b41](https://github.com/diy-agent/diy/commit/9f17b41c8880acd9419771359a043c44b76b379a))
* **local-chat:** #[#307](https://github.com/diy-agent/diy/issues/307) review3 处置 —— R6 停止时钟同步收口、R7 轮末边界绕节流、R8 锈注释、OpsFrame 上移 shared ([021439c](https://github.com/diy-agent/diy/commit/021439ce2aa7160b4cf62af95a55d2520d047763))
* **local-chat:** #[#326](https://github.com/diy-agent/diy/issues/326) review1 —— 游标策略收口 mergeWindow + 测试强度/覆盖补强 ([902e829](https://github.com/diy-agent/diy/commit/902e829b9e93e27ba7896ba2e5d171c51c9aa67d))
* **local-chat:** #[#326](https://github.com/diy-agent/diy/issues/326) stale 后 tailCursor 粘全量致轮末永久退全量 + pit/find 投影订正 ([6533cf9](https://github.com/diy-agent/diy/commit/6533cf921f93ee124d2d010c9e5fbd696e041037))
* **local-chat:** #[#326](https://github.com/diy-agent/diy/issues/326) stale 后丢弃末段游标，杜绝轮末永久退全量（R9）+ 投影订正（R10） ([7847f77](https://github.com/diy-agent/diy/commit/7847f77570f3564b9a3e834fdfb996af84df9132))
* **local-chat:** #[#327](https://github.com/diy-agent/diy/issues/327)(会话实时输出叠字) 块树唯一 apply 通道 + 订阅可见性兜底 ([a1772b2](https://github.com/diy-agent/diy/commit/a1772b2afe221a07467a71b0b33d3261b5be29e1))
* **models:** review1 —— 启动刷新开关与 env 叠加、TDZ、注释精度（#[#385](https://github.com/diy-agent/diy/issues/385) / [#295](https://github.com/diy-agent/diy/issues/295)） ([c97e5c0](https://github.com/diy-agent/diy/commit/c97e5c02feeb7c1d3420a2374924f99bf05e34ca))
* **observability:** 冷读中断按现场证据命名（#[#416](https://github.com/diy-agent/diy/issues/416)） ([2901cb2](https://github.com/diy-agent/diy/commit/2901cb279d06d4b965a867ce84c9d2cbef6f837d))
* **observability:** 异常出口统一落盘，errText 归一（#[#411](https://github.com/diy-agent/diy/issues/411)） ([e6e9016](https://github.com/diy-agent/diy/commit/e6e9016f91cb55ad48a8967621d8fb570d66a0e1))
* **process-health:** CPU 按进程树聚合 + timeout 包装器识别（#[#401](https://github.com/diy-agent/diy/issues/401) review1） ([bb48da8](https://github.com/diy-agent/diy/commit/bb48da83611f592a5392b42a44ef6183f4cfc0d4))
* **renderer:** 过程行状态判据抽成纯函数 + 源码护栏（#[#329](https://github.com/diy-agent/diy/issues/329) review1 R1/R2） ([1d5b95b](https://github.com/diy-agent/diy/commit/1d5b95b7ec85b84d3188a36ef9478922ca30b35b))
* **repo:** oxfmt 配置改用各包 .oxfmtrc.json（#[#323](https://github.com/diy-agent/diy/issues/323)(oxfmt 配置腐坏)） ([329948a](https://github.com/diy-agent/diy/commit/329948a9f8fe7a715036c33086c9b563a4e34a89))
* **room:** #[#266](https://github.com/diy-agent/diy/issues/266) review1 —— R1 证据更正 + R2 回归测试 + R3.2 位次注释（#[#377](https://github.com/diy-agent/diy/issues/377) / #[#166](https://github.com/diy-agent/diy/issues/166) §41） ([ba7e1a8](https://github.com/diy-agent/diy/commit/ba7e1a8979b053033219a2643d45624f016288ee))
* **room:** #[#266](https://github.com/diy-agent/diy/issues/266) review1 —— R1 证据更正 + R2 回归测试（#[#377](https://github.com/diy-agent/diy/issues/377) / #[#166](https://github.com/diy-agent/diy/issues/166) §41） ([bdb5a55](https://github.com/diy-agent/diy/commit/bdb5a55f4f85c71de70cb44cdba07396dc8198c4))
* **room:** 事件流跟随态 —— room 会话可上翻 + 任务会话不再周期性跳（#[#377](https://github.com/diy-agent/diy/issues/377) 第 19 刀） ([7901bd3](https://github.com/diy-agent/diy/commit/7901bd378b2de0d64f4289f5b058bb511b00da49))
* **room:** 事件流跟随态 —— room 会话可上翻 + 任务会话不再周期性跳（#[#377](https://github.com/diy-agent/diy/issues/377) 第 19 刀） ([b5a05c4](https://github.com/diy-agent/diy/commit/b5a05c4f55cf67fce842f916db537216231f713d))
* **room:** 单人任务右栏不再默认展开 —— 「成员&gt;1」须排除人成员（#[#166](https://github.com/diy-agent/diy/issues/166) §44.1 ② 判据 7） ([177c774](https://github.com/diy-agent/diy/commit/177c774c8f1ce667fac06c6bf9305cdb8a92bf3f))
* **room:** 忙时投递入队后复判 —— 轮次恰在收尾则用队列内容醒来一轮（#[#377](https://github.com/diy-agent/diy/issues/377) 第 27 刀 · review1 R1） ([85633d3](https://github.com/diy-agent/diy/commit/85633d3332f151e42d3c8e85c908b49af3dc5c6e))
* **room:** 投递期间上翻不再被拽回 + @ 短名寻址与打错名提示（#[#377](https://github.com/diy-agent/diy/issues/377) 第 20 刀） ([e86944c](https://github.com/diy-agent/diy/commit/e86944c1a5e8711e7946025217a5726f378c2897))
* **room:** 投递期间上翻不再被拽回 + @ 短名寻址与打错名提示（#[#377](https://github.com/diy-agent/diy/issues/377) 第 20 刀） ([244d624](https://github.com/diy-agent/diy/commit/244d62427331b579a3751342bcb1a8ac86cf06d2))
* **room:** 投递那条 say 不再进自己的 recent + 补齐 sourceSayId（#[#377](https://github.com/diy-agent/diy/issues/377) 第 27 刀 · lab 抓出） ([0bbf48d](https://github.com/diy-agent/diy/commit/0bbf48de0c3800a1c4c211b1dc1ff51f0be52a4d))
* **room:** 提示里的名字必须真能打中（#[#377](https://github.com/diy-agent/diy/issues/377) 第 22 刀 · review3 R2/R3/R5/R6） ([93960de](https://github.com/diy-agent/diy/commit/93960de8f0f673ce35c4dda752e0470e45751f22))
* **session:** error:llm 归 unknown + nav 行集抽纯函数（#[#393](https://github.com/diy-agent/diy/issues/393) review1 R1/R2） ([014b266](https://github.com/diy-agent/diy/commit/014b2662a4b087c96456ad7c56d839b4be4903fd))
* **session:** 会话状态机收口——运行状态三值 ⊥ 未读属性 + 唯一图标（#[#393](https://github.com/diy-agent/diy/issues/393)） ([500714f](https://github.com/diy-agent/diy/commit/500714f9458d42d478db95a61315db183458c070))
* **session:** 会话状态机收口——运行状态三值 ⊥ 未读属性 + 唯一图标（#[#393](https://github.com/diy-agent/diy/issues/393)） ([efce14d](https://github.com/diy-agent/diy/commit/efce14dbcbad4e30d36231b7407acc062fd920e4))
* **t331:** review1 R1/R2 —— 锚点连校的「用户接管」必须 latch，否则滚一下就被拽回锚点 ([d851b8b](https://github.com/diy-agent/diy/commit/d851b8b8e7960de6142928dd066b9a8532f312a1))
* **t331:** 聊天页阅读体验三条 —— 末条 text 滚屏 / user 无时间 label / 切回丢阅读定位 ([99bf743](https://github.com/diy-agent/diy/commit/99bf743e4630a80d6c5f261a81f327d48a277f3f))
* **t331:** 聊天页阅读体验三条 —— 末条 text 滚屏 / user 无时间 label / 切回丢阅读定位 ([89cee2e](https://github.com/diy-agent/diy/commit/89cee2e09552f798b21aba975b29781abb980aeb))
* **talk:** #[#314](https://github.com/diy-agent/diy/issues/314) 装配器 review1 收口 —— 入参形状封闭 + window 类型校验 + 需求对齐/边界文档 ([708cc5c](https://github.com/diy-agent/diy/commit/708cc5c924ad2e7271fe9a809d39d64b96ab5387))
* **talk:** 收口 review1+review2 —— kind/at 校验、pinsRevision 三态、thread 同锚点、未知字段策略、replyTo 显式、compact 单行（#[#312](https://github.com/diy-agent/diy/issues/312)(内核包@diy/talk)） ([cfcc53f](https://github.com/diy-agent/diy/commit/cfcc53f40447e1374c7ece5458f7bc2815b177d0))
* **talk:** 收口 review3 —— allowUnknown 只读契约（决策11）、ISO 只校形态（决策12）、assertThreadRefs 入口自检（决策13）；测试 40→42（#[#312](https://github.com/diy-agent/diy/issues/312)(内核包@diy/talk)） ([2eb3081](https://github.com/diy-agent/diy/commit/2eb3081f4f4f2709812acb6ba980b3ce749631ae))
* **task:** 任务写侧改原子写 —— 低磁盘不再把正文清成 0 字节（抽 core/atomic-write.ts） ([8f53a5d](https://github.com/diy-agent/diy/commit/8f53a5d01b093e60e26167ef61b95ebe94a15a3e))
* **task:** 任务写侧改原子写 —— 低磁盘不再把正文清成 0 字节（抽 core/atomic-write.ts） ([000c183](https://github.com/diy-agent/diy/commit/000c1837b765f90b042b12282e29bc0b276f3fb8))
* **task:** 任务文件头读写对称 —— 暴露 frontmatter · 追加原语 --append-body · 整份文件剥头（#[#322](https://github.com/diy-agent/diy/issues/322)） ([f981f5d](https://github.com/diy-agent/diy/commit/f981f5d7e8b3279a53c76c2f4dda40c0d69dd8d0))
* **task:** 任务文件头读写对称 —— 暴露 frontmatter · 追加原语 · 整份文件剥头（#[#322](https://github.com/diy-agent/diy/issues/322)） ([501e233](https://github.com/diy-agent/diy/commit/501e2334006d2c2cab76d2b6bf9b4d0dce461f69))
* **test:** #[#364](https://github.com/diy-agent/diy/issues/364) view-registry 断言不再硬编码 pages[7].icon ([d4091ba](https://github.com/diy-agent/diy/commit/d4091baf7a458dfc3638f0ca96d54d7605306a48))
* **tests:** ui-tabs 缩进断言量到 #[#302](https://github.com/diy-agent/diy/issues/302) 色条（12&gt;12 恒红）→ 语义钩子定点 ([da022e9](https://github.com/diy-agent/diy/commit/da022e9379d2f0b6f9a665e21c9dd9db1a15a285))
* **tests:** ui-tabs 缩进断言量到 #[#302](https://github.com/diy-agent/diy/issues/302) 色条（12&gt;12 恒红）→ 语义钩子定点 ([c5488d4](https://github.com/diy-agent/diy/commit/c5488d40a1b442b8d87ef22e6bad4e2f3f71f105))
* **toolchain:** workbench-plugin/sha.sh 补回可执行位 ([8bbaf0b](https://github.com/diy-agent/diy/commit/8bbaf0b67cfc49e00f763cb64a32280cbc8c9101))
* **toolchain:** 修 diy-ui/sha.sh 丢可执行位 + 加可执行位护栏（#[#304](https://github.com/diy-agent/diy/issues/304)(Windows 提交丢可执行位)） ([126f59f](https://github.com/diy-agent/diy/commit/126f59f08a0eb768c6eac9fcba98c3b21254cf52))
* **traffic:** review 修正 —— 去冗余徽标 · 凭据脱敏补全 · 快照按需带记录（#[#309](https://github.com/diy-agent/diy/issues/309)） ([b71c805](https://github.com/diy-agent/diy/commit/b71c805cda460e67417cb8b721e88822f8e86f80))
* **traffic:** 流量页可用性三处 —— 查找条对比度 · 预览选中态 · 嵌套底色分层（#[#309](https://github.com/diy-agent/diy/issues/309)） ([90c92ee](https://github.com/diy-agent/diy/commit/90c92eedeb070f43d372e5ec44719b2800a8f984))
* **traffic:** 记录拆出步号与重试链（#[#409](https://github.com/diy-agent/diy/issues/409)） ([a98e1fe](https://github.com/diy-agent/diy/commit/a98e1fe9f9610256e62ec178e6aabb99fbb5e945))
* **traffic:** 记录拆出步号与重试链（#[#409](https://github.com/diy-agent/diy/issues/409)） ([7bf2f2f](https://github.com/diy-agent/diy/commit/7bf2f2fa33d46373194969c7b380cb24071e0bf7))
* **ui:** #[#298](https://github.com/diy-agent/diy/issues/298) 轮尾状态行截断纪律 —— 各段可缩可截 + 按行宽排队退场 ([e925258](https://github.com/diy-agent/diy/commit/e9252588ee4a52ac704fac78b9c21bf4e1a045c4))
* **ui:** #[#298](https://github.com/diy-agent/diy/issues/298) 轮尾状态行截断纪律 —— 各段可缩可截 + 按行宽排队退场 ([53f0f8b](https://github.com/diy-agent/diy/commit/53f0f8b4938bdbc879dedd1f2f32f22d027a7ff1))
* **ui:** #[#308](https://github.com/diy-agent/diy/issues/308) review3 P1-1 —— markViewed 的水位读 untrack，止住 effect 自触发递归 ([1aedffd](https://github.com/diy-agent/diy/commit/1aedffd4bd1fb5647147af4a5e9fb253997d7754))
* **ui:** #[#348](https://github.com/diy-agent/diy/issues/348) 聊天页渲染层 —— MD reconcile 保住 DOM、code 块恒常滚动外壳、`<>` 单按钮、收起时空间去向 ([f94d4d6](https://github.com/diy-agent/diy/commit/f94d4d6fc367b9e72594f2c978fd62aeef515d20))
* **ui:** #[#348](https://github.com/diy-agent/diy/issues/348) 聊天页渲染层 —— MD reconcile 保住 DOM、code 块恒常滚动外壳、`<>` 单按钮、收起时空间去向 ([158a3f7](https://github.com/diy-agent/diy/commit/158a3f719f5c77b6da26101baf9a2fb515035f1b))
* **ui:** #[#350](https://github.com/diy-agent/diy/issues/350) review1 — R1 子页面 icon 升成注册表不变量 + R2 跳转居中/高亮 ([0e9c949](https://github.com/diy-agent/diy/commit/0e9c949ff332ae6abd49b583f887f2c2ece182f9))
* **ui:** #[#350](https://github.com/diy-agent/diy/issues/350) 页面标识与定位 —— 子页面 tab 不标任务状态 + URI 上移 + 缺省人物跳转 ([e77d6fa](https://github.com/diy-agent/diy/commit/e77d6fadaff6243abad0a483277645ffb25cbd9d))
* **ui:** #[#350](https://github.com/diy-agent/diy/issues/350) 页面标识与定位 —— 子页面图标 / task URI 上移 / 缺省人物跳转 ([c229201](https://github.com/diy-agent/diy/commit/c229201bdbc57bf6441229c21b4248f6262e0386))
* **ui:** #[#351](https://github.com/diy-agent/diy/issues/351) 面板与控件 —— 1 级拖高 / 工具框最大化 / app 信息 copy / 流量页 viewset ([811f087](https://github.com/diy-agent/diy/commit/811f0878c58e73dd57f70a4fdb454460920c3d0b))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) 排队回执投递后降级为历史回执（不再谎称「待投递」） ([8e20a8d](https://github.com/diy-agent/diy/commit/8e20a8d5f9c9a91ee2d8a83bc3ca65e109fa686a))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) 正在跑的轮次不再被"排队回执轮"顶掉（「⚠ 本轮未完成」假警报） ([e82884a](https://github.com/diy-agent/diy/commit/e82884a0275fd297460c595a2ddfd6a6f69a1d59))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) 水位吃掉「在跑的那一轮」—— 收尾（尤其异常收尾）后 +N 恒 0 ([9872a11](https://github.com/diy-agent/diy/commit/9872a1172dde2742729b29b8685751770cb15c05))
* **ui:** #[#361](https://github.com/diy-agent/diy/issues/361) 任务被删后 nav/tab 残留 + 「永远加载中…」 ([f73aceb](https://github.com/diy-agent/diy/commit/f73aceb326ac665478d476b782cc49de6112e78e))
* **ui:** #[#361](https://github.com/diy-agent/diy/issues/361) 任务被删后 nav/tab 残留 + 「永远加载中…」 ([55b696f](https://github.com/diy-agent/diy/commit/55b696feb1cb507dc5bceb7a924786fe83df1a39))
* **ui:** rail 皮肤改成「一条线贯穿」——线挂在块树容器上，不是每块一条边线 ([7999dfd](https://github.com/diy-agent/diy/commit/7999dfd4f124e6a2bfc69b0d8b94769e6da0a71c))
* **ui:** token 速度改「按步」口径（总输出 ÷ 响应耗时−TTFT）+ 状态栏常驻留最后一次值 + 用量表加速度列 ([3e53f32](https://github.com/diy-agent/diy/commit/3e53f32aa5904f206a4cfa7cd749223f61e4c302))
* **ui:** YAML 预览先剥整体缩进再解析（首行缩进/后续行参差场景） ([0634acf](https://github.com/diy-agent/diy/commit/0634acfbc882e9f0978faf88abe5aa40048c59fa))
* **ui:** 关会话 tab 不再弹确认框 —— 直接关，轮次照跑（#[#405](https://github.com/diy-agent/diy/issues/405)） ([a7cd9f5](https://github.com/diy-agent/diy/commit/a7cd9f5745a0f54b9118ec4b70c214b2e943d4c6))
* **ui:** 关会话 tab 不再弹确认框 —— 直接关，轮次照跑（#[#405](https://github.com/diy-agent/diy/issues/405)） ([b0b4da5](https://github.com/diy-agent/diy/commit/b0b4da5437b037ee802a3f9cc6c85dfd90b5d957))
* **ui:** 卡片改包含关系（卡 = 块自己）+ 折叠条合一（一根条、一个点击区） ([27137a4](https://github.com/diy-agent/diy/commit/27137a43aec8f9917bfda105ea441cee0da672bb))
* **ui:** 压缩预览页有界 —— 超长文本/大数组只留头尾，默认折叠 2 层（#[#406](https://github.com/diy-agent/diy/issues/406) 刀 1） ([11efa83](https://github.com/diy-agent/diy/commit/11efa83cba0de7cb1303b5b112685ac7838c668c))
* **ui:** 压缩预览页有界 —— 长文本/大数组只留头尾（#[#406](https://github.com/diy-agent/diy/issues/406) 刀 1） ([055cfd9](https://github.com/diy-agent/diy/commit/055cfd9a68784b91bd223ede64ffa1c59cedf2b3))
* **ui:** 处理 review #[#253](https://github.com/diy-agent/diy/issues/253) 四点 + 待办 B（输入框底部 ⚡ 实时速度） ([8df02f6](https://github.com/diy-agent/diy/commit/8df02f63bda71f20b94818db900d33f662e6f43c))
* **ui:** 处理 review2 —— RV-5 接线 / RV-6 判据同源 + 五项小项 ([3746ab0](https://github.com/diy-agent/diy/commit/3746ab0fc01ad9b20d96ceada324b8b834aef9e6))
* **ui:** 处理 review3 —— RV-7（无 endReason 也先问 notice）+ find.turn-end 计数更正 ([7116534](https://github.com/diy-agent/diy/commit/71165342cfb696c89866736e8d60cc9fc11e73b3))
* **ui:** 外观设置加皮肤实时小样 —— 修「切样式像没反应」（设置页会顶掉聊天区） ([17e4692](https://github.com/diy-agent/diy/commit/17e4692346b0f3c127bd011d90aad55810061699))
* **ui:** 差异视图缺省关闭，按需一键开启（#[#406](https://github.com/diy-agent/diy/issues/406) 刀 1b · 用户口径「先禁用掉」） ([1502bc2](https://github.com/diy-agent/diy/commit/1502bc24f98dfb0fe601afba2b04339a275fef57))
* **ui:** 皮肤小样补齐轮尾状态行钩子（#[#365](https://github.com/diy-agent/diy/issues/365)） ([d482fae](https://github.com/diy-agent/diy/commit/d482fae14887d898f5c4f43ed0c6ad3488bc913b))
* **ui:** 皮肤细节对齐草图 v4（子层位移 / 卡内留白 / 结尾槽手柄落点） ([6670aa0](https://github.com/diy-agent/diy/commit/6670aa0abce353279b4651da2cc8f451c41a9cc7))
* **ui:** 页内查找升为顶层贴片 + 查找范围随最前浮层（#[#309](https://github.com/diy-agent/diy/issues/309)） ([03f798f](https://github.com/diy-agent/diy/commit/03f798f50b370110794e09a389cd70ca0800a42c))
* **variant:** #[#381](https://github.com/diy-agent/diy/issues/381) review1 R1/R2 —— serve 入口补 preview 守卫 + 文档口径订正为 5 处 ([53d4e09](https://github.com/diy-agent/diy/commit/53d4e091d108e4b7ef651a00a1a091b63b21d388))
* **window:** 内缩只作用于高度、宽度保住 lg 断点 —— 976px 让侧栏不可达致 nav 全挂（#[#297](https://github.com/diy-agent/diy/issues/297)） ([6026913](https://github.com/diy-agent/diy/commit/6026913172acc7ee0d154dad1c29549ed0757541))
* **window:** 双击标题栏塌成 1×29 且无法恢复（#[#292](https://github.com/diy-agent/diy/issues/292)） ([59ac23d](https://github.com/diy-agent/diy/commit/59ac23d5ce92f6ad5dfff526004fc5846609608b))


### Performance Improvements

* **agent:** ops 读起点 = 压缩账本字节偏移（#[#420](https://github.com/diy-agent/diy/issues/420)） ([4e352cc](https://github.com/diy-agent/diy/commit/4e352ccaf4716a20a888583f5b39c744f4cb6232))
* **agent:** ops 读起点 = 压缩账本字节偏移（#[#420](https://github.com/diy-agent/diy/issues/420)） ([aff6b32](https://github.com/diy-agent/diy/commit/aff6b329476e1fb341cea6a925702bf94697e37a))
* **agent:** 大会话历史折叠 + 增量并入 —— 消 74MB 会话的加载卡死（#[#290](https://github.com/diy-agent/diy/issues/290)） ([9108598](https://github.com/diy-agent/diy/commit/9108598ddd846d07630fbb4544afca19a24c65dc))
* **agent:** 大会话历史折叠 + 增量并入 —— 消 74MB 会话的加载卡死（#[#290](https://github.com/diy-agent/diy/issues/290)） ([b885efc](https://github.com/diy-agent/diy/commit/b885efcda0269f08d291617d7053101574691465))
* **chat:** #[#301](https://github.com/diy-agent/diy/issues/301) 会话块树视口虚拟化 —— 只挂视口附近的轮 + 实测高度账 ([cf23cd7](https://github.com/diy-agent/diy/commit/cf23cd7d09654b8c61f5af8821294f0e227a6901))
* **chat:** #[#301](https://github.com/diy-agent/diy/issues/301) 会话块树视口虚拟化 —— 只挂视口附近的轮 + 实测高度账 ([4c490c3](https://github.com/diy-agent/diy/commit/4c490c3c2b89a26e5e29bcf30ac0714bd8edc66e))
* **chat:** 桥接探针不再随滚动重扫、同查询去重（#[#389](https://github.com/diy-agent/diy/issues/389)） ([bda0364](https://github.com/diy-agent/diy/commit/bda03643b2da4daf0e2a109abc5fff140847a0ae))
* **context:** 工具结果默认裁剪放大到 100KB / 100 行 / 单行 2000 字符；read 单次 100KB ([0331eba](https://github.com/diy-agent/diy/commit/0331eba27c2dd17274e00873d8c61569ba4920db))
* **local-chat:** #[#321](https://github.com/diy-agent/diy/issues/321)(打开会话卡 main 8~16s) 压缩预览懒算 + 消陈旧 uri + 去重复读 ([34db2cd](https://github.com/diy-agent/diy/commit/34db2cd5fd8c13f81cbcd810d8bd8cfc60eec3b7))
* **test:** unit 测试并行化（约 2.9x）—— 与 intent 的串行策略分离 ([186e12c](https://github.com/diy-agent/diy/commit/186e12cd735f6b7f323f4f7fe466f459664a27d4))
* **test:** unit 测试并行化（约 2.9x）—— 与 intent 的串行策略分离 ([ce4f37c](https://github.com/diy-agent/diy/commit/ce4f37c7b0721945f40e7833a823f23a4fcf49e2))
* **test:** 消灭 vi.mock + 开 --no-isolate（unit 127.95s → ~13s，#[#402](https://github.com/diy-agent/diy/issues/402)） ([2a4d9eb](https://github.com/diy-agent/diy/commit/2a4d9eb953e6b766879af27bd1136124f61b917d))
* **test:** 消灭 vi.mock + 开 --no-isolate（unit 127.95s → ~13s） ([41f278f](https://github.com/diy-agent/diy/commit/41f278f2fa73f450746d617d002300875dadb5a6))
* **ui:** #[#358](https://github.com/diy-agent/diy/issues/358) §10 开机扫账本改「热点优先 + 冷账本 idle 切片」 ([10e00e2](https://github.com/diy-agent/diy/commit/10e00e22f67c6a8501e1164da64e01ab0c7d8e34))


### Code Refactoring

* **rpc:** 改名 @diy-agent/rpc 并规范相对导入扩展名 ([2079d04](https://github.com/diy-agent/diy/commit/2079d04870635811d84a305ce87dc8af5296c486))

## [Unreleased]


### ⚠ BREAKING CHANGES

* **rpc:** 包名 `@diy/rpc` → `@diy-agent/rpc`（导入路径随之改变；仓内 diy-app / diy-dev 已同步）

### Features

* **release:** npm 发布能力 —— `@diy-agent/rpc@0.1.0` 与 `@diy-agent/ui@0.1.0` 首次发布到 npm（`./sha.sh publish`；dist 打包 + 发行版 package.json 见 `scripts/npm-publish.mjs`） ([327be71](https://github.com/diy-agent/diy/commit/327be710a000bba3fe44a7565e2e0a39f1e1f606))
* **ui:** diy-ui 改名为 `@diy-agent/ui` 并补齐 main/exports/files；DOM provider 自取 DOM 类型；纳入 `tsconfig.all.json`（此前根 check 不覆盖它） ([327be71](https://github.com/diy-agent/diy/commit/327be710a000bba3fe44a7565e2e0a39f1e1f606))
* **rpc:** 相对导入补显式 `.js` 扩展名（NodeNext 发布构建要求；vite/vitest 映回 `.ts`）；electron 改为可选 peer ([2079d04](https://github.com/diy-agent/diy/commit/2079d04870635811d84a305ce87dc8af5296c486))


## [0.1.24](https://github.com/diy-agent/diy/compare/diy-v0.1.23...diy-v0.1.24) (2026-09-10)


### Features

* **acp:** listModels 支持 force refresh + UI 刷新按钮 ([faa4276](https://github.com/diy-agent/diy/commit/faa42763d3ef2076e2b6cdba1703c0aa2168ff9d))
* **acp:** V2 官方 SDK 会话池 + 常驻可观测性 + CDP 调试能力 ([ef43c5c](https://github.com/diy-agent/diy/commit/ef43c5c5a11f8df3b28f33590048005d583ec994))
* **acp:** 串行队列支持取消 + 聊天停止/队列撤回 ([a95ede5](https://github.com/diy-agent/diy/commit/a95ede5daf72f87ef585d819c45aea6b042f8d60))
* **acp:** 任务级 ACP 会话 + 聊天面板（Solid） ([3370bd4](https://github.com/diy-agent/diy/commit/3370bd4d20d74a68239a8fd4c76e2a6e12d8df69))
* **agent-local:** ai-sdk 自定义 agent 通道（块协议 G） ([1cbee83](https://github.com/diy-agent/diy/commit/1cbee8302b4f79bf5e79425a378cadee54aa3806))
* **agent-local:** ai-sdk 自定义 agent 通道（块协议 G） ([0c7c22b](https://github.com/diy-agent/diy/commit/0c7c22b9f741966bc000d4f6726ef8bfb083d845))
* **agent-local:** 新增 muse-spark 1.2/1.3 contributor 模型 ([9e55def](https://github.com/diy-agent/diy/commit/9e55def6ba13bc31f524ff310d6637823d352b31))
* **agent-observability:** [#93](https://github.com/diy-agent/diy/issues/93) 剩余项全部完成 ([61b5445](https://github.com/diy-agent/diy/commit/61b5445ffee518e575fbc0066be55cd19841d130))
* **agent:** task 级 ACP session 池 + 持久化恢复 ([1ba86d7](https://github.com/diy-agent/diy/commit/1ba86d703f8542af06379f8f446e403f6fbb5051))
* **agent:** 支持后端选择 pi/hermes + session 历史重载 ([0e4a515](https://github.com/diy-agent/diy/commit/0e4a515eb85f91991141bb61c3004cc9d66b6655))
* **agent:** 添加 opencode ACP 后端支持 ([3ec7aa5](https://github.com/diy-agent/diy/commit/3ec7aa5a9701b4ee1a0f19d4427c39665d7065c1))
* **agent:** 重写 acp-agent 为真正 ACP 客户端（stdio + JSON-RPC） ([0f1651a](https://github.com/diy-agent/diy/commit/0f1651afeaf31a94eddc3f5f5c9bc7bc21183f1a))
* **chat:** 合并发送/停止按钮 + 工作中指示器移至 Assistant 侧 ([ea64bab](https://github.com/diy-agent/diy/commit/ea64babab8ad4ac6f85c1f1d58de8748d593646f))
* **chat:** 增加 effort/mode 配置选项到聊天界面 ([dbe8d94](https://github.com/diy-agent/diy/commit/dbe8d94fbee01fd661a15cbdc63295422b4703da))
* **chat:** 完整聊天页面 — Markdown 渲染 + 代码高亮 + ACP 全事件支持 ([30c149d](https://github.com/diy-agent/diy/commit/30c149d0782586f6b1b58e6c701027a761966348))
* **chat:** 进入任务详情即建会话，会话装配一次到位 ([b4b1b6a](https://github.com/diy-agent/diy/commit/b4b1b6aa4550324817aab966f6f0285aaff4f5e2))
* CLI → Main bridge → Renderer RpcServer 贯通 ([f913956](https://github.com/diy-agent/diy/commit/f9139569037610586071bae6934cea076d61e784))
* **cli-outcome:** CLI 输出增强与 RPC 重构 ([8be0991](https://github.com/diy-agent/diy/commit/8be0991febfab81bc730935cf15b8186c39f4a1b))
* **cli-takeover:** CLI 接管基建 + 旧任务迁移 + 路径显示 + ACP 会话目录 ([#135](https://github.com/diy-agent/diy/issues/135)) ([75507b8](https://github.com/diy-agent/diy/commit/75507b899f8b4c431f836ca103528c94f2b0ae64))
* **diy-app:** 窗口定位到非主工作屏（DIY_MIRROR_DISPLAY=1 时） ([944e2eb](https://github.com/diy-agent/diy/commit/944e2eb8d40daef75f18535a7aeb415340fddc64))
* **diy-clirpc:** 移植 cli_rpc 为独立包 + 意图测试 ([14827bf](https://github.com/diy-agent/diy/commit/14827bfbcf47f1bc0571b2673c5c2a3f7de6cd2d))
* **diy-dev:** ref source 支持浏览器地址形式（/tree/、releases、commit） ([80c829d](https://github.com/diy-agent/diy/commit/80c829dcaf5f7d898465979a560f03d91ba4f836))
* **diy-dev:** 新增 dev CLI 包，实现 ref 源码镜像（add/sync/list/remove） ([e37646a](https://github.com/diy-agent/diy/commit/e37646a7b479a861b4eb0b9aad14b6f0de53afd4))
* **diy-dev:** 本地源码镜像 ref 管理（add/sync/list/remove）+ CLI usage 增强 ([91205e9](https://github.com/diy-agent/diy/commit/91205e99ed5de4265a3bc34116371885e1a1ec73))
* **diy-rpc:** CLI 帮助体系改为由 RPC meta 单一驱动 ([37b6d4e](https://github.com/diy-agent/diy/commit/37b6d4e6116da021f0ae3a584f2f95e339c3bb9b))
* **diy-rpc:** onForward 支持 client-stream / bidi 转发 ([7665087](https://github.com/diy-agent/diy/commit/76650872334adc0cfe1310a5d7856ea455d2f8c3))
* **diy-rpc:** ProcedureMeta/Def 分离 + output schema + createMetaHandler ([7244754](https://github.com/diy-agent/diy/commit/724475442a275d15e387d1615df4bec28456d49f))
* **diy-rpc:** 新增 createTypedClient — 从 meta 的 zod schema 推导强类型 client ([ec88dfc](https://github.com/diy-agent/diy/commit/ec88dfc7086d76ce7515f3542d7cf1e42db5e080))
* **pkgs.ts:** RpcGateway 路由边界 + RpcForward 转发后端 ([db44ca7](https://github.com/diy-agent/diy/commit/db44ca7b0e8c314dea07fc961db06c720239f72e))
* **pkgs.ts:** 导入 TypeScript monorepo 包（diy-desktop2, diy-rpc, rpc-transport, rpc-transport-electron） ([334576c](https://github.com/diy-agent/diy/commit/334576ccacf5d22347ee02e54695e1030fe2a393))
* **project:** 任务列表占满右侧 + 浮动详情面板 ([68ac9a2](https://github.com/diy-agent/diy/commit/68ac9a2614695b1f1dcaa289f04535a1b2174dc0))
* **project:** 任务按项目聚合 + 表格化任务树 + 拖拽改父专用 move ([0baca67](https://github.com/diy-agent/diy/commit/0baca6723663606f0a8522ad070b373ad3ac0fec))
* **project:** 任务树交互增强 — 子任务创建/拖拽改父/ui.tree 结构化返回 ([866490a](https://github.com/diy-agent/diy/commit/866490ae2e76064bbef37ed4d00c7c7a115ebc17))
* **project:** 任务树表格化 + 拖拽改父走专用 move RPC ([5628a9c](https://github.com/diy-agent/diy/commit/5628a9c62da1690cf2d8190903e81ae07f92139c))
* **project:** 用 project 替代 subject 作为任务组织单元 ([6dd3bcd](https://github.com/diy-agent/diy/commit/6dd3bcdca71fcc279e2198bd269b5b1e0131a65a))
* **project:** 项目数据按目录聚合 + UI 创建项目入口 ([76ca06f](https://github.com/diy-agent/diy/commit/76ca06fafbbbc79dcce718545e81da9b8f7818f8))
* **ref:** diy init 命令 + ref add 自动初始化模板 ([64b9ee2](https://github.com/diy-agent/diy/commit/64b9ee232a7b6d4d0046e778a183bb7b3cfda557))
* root 加统一 build/clean 命令 ([8fd7044](https://github.com/diy-agent/diy/commit/8fd70441ae960d715d494ae2764f3f1cffd20fe9))
* **rpc/cli:** usage 行带上位置参数（[options] &lt;arg&gt;） ([6f86457](https://github.com/diy-agent/diy/commit/6f864575de58f1e5fb585b1973fec197eb09e6fc))
* **rpc:** 新增 RpcClient 对称客户端入口 ([d7f5007](https://github.com/diy-agent/diy/commit/d7f50078e9514d8f2762cb2f78c3b21d510450e2))
* **rpc:** 新增 RpcServer 统一第3层服务端入口 ([4e04a6a](https://github.com/diy-agent/diy/commit/4e04a6a857cb47b178b3c7128fd49f977578ae43))
* **rpc:** 给 HttpRawServer 注册方法加 meta 强类型重载 + router 回写 meta.name ([3cf3b8d](https://github.com/diy-agent/diy/commit/3cf3b8d5a9fe6315818a8d26d6f6bfdc182a3af7))
* **scripts:** 新增 ui-smoke/dnd-smoke.py 拖拽冒烟脚本 + AGENTS.md 索引 ([28295a0](https://github.com/diy-agent/diy/commit/28295a077e7bbb754e7711a5478f4d6d59e79b88))
* **solid:** agentStore 补齐 autoApprove + closeSession，AgentChatPanel 完整化 ([b0c10e2](https://github.com/diy-agent/diy/commit/b0c10e2a9b73016bc21df3ce6aae13ae19ba681f))
* **solid:** Solid renderer 迁移 + UI 意图测试 + DaisyUI 高阶组件优化 ([458558b](https://github.com/diy-agent/diy/commit/458558b410c9eadffdd2b72440b826063fc990ef))
* **solid:** Solid renderer 迁移 + 交互增强(拖拽/详情/侧栏/inspect) ([f35ae68](https://github.com/diy-agent/diy/commit/f35ae68b096053c391147e2895f3846fc428c704))
* **ui:** chatStore actor 化 — 命令邮箱 + 状态投影 + 单写者 ([72306bc](https://github.com/diy-agent/diy/commit/72306bc291c62837e128c2f13bd1b423374cddf2))
* **ui:** Solid TaskTree 拖拽改父级 — 原生 HTML5 DnD + task.move ([809b52c](https://github.com/diy-agent/diy/commit/809b52cf47eb76d3862aca72f177e13ac3ca7234))
* **ui:** 任务拖拽改用 @dnd-kit/solid — 与 React dnd-kit 同源 ([39c3364](https://github.com/diy-agent/diy/commit/39c3364d1519e7402ee9364fa135ce25ac932673))
* **ui:** 任务详情面板点击外部空白取消显示 ([bd7cba8](https://github.com/diy-agent/diy/commit/bd7cba8bf1e2e7a222105f28e52ac19e9b73c23e))
* **ui:** 拖拽子任务到项目节点 → 提升为一级任务 ([472475e](https://github.com/diy-agent/diy/commit/472475e8ca3aaeca2cb9aa7b46a32b5279fed1ca))
* **ui:** 新增 diy ui inspect 命令 — 无障碍树诊断 UI 全貌 ([384e6c9](https://github.com/diy-agent/diy/commit/384e6c9b33ffbf863fe9af745a3e11e7b0e2e19f))
* **ui:** 聊天排队可视化 — DeepSeek Web 式排队消息上屏 + 单条撤回 ([c1a4730](https://github.com/diy-agent/diy/commit/c1a4730139c60e43ae1ca20a97a62dbe9f4cdbba))


### Bug Fixes

* **acp:** ACP 事件解析与崩溃处理修正 ([fc4c281](https://github.com/diy-agent/diy/commit/fc4c281dd74e18c2503646191db28fa7c43f9ade))
* **acp:** autoApprove 不再假开关 — 运行时切换真正生效 ([59358a6](https://github.com/diy-agent/diy/commit/59358a62725871b0cfbff65288da2848d9aa5553))
* **acp:** ensure 并发去重 + 流级互斥 — 同 task 并发调用不再串扰 ([51c1209](https://github.com/diy-agent/diy/commit/51c120964659dfbddbf3f13bd75de5c9119276dc))
* **acp:** prompt 互斥链 — 同一会话并发 prompt 不再交叉 ([67148c4](https://github.com/diy-agent/diy/commit/67148c4c0a6f09e26fef9dd07d1bf1516e98a4d4))
* **acp:** 更新泵常驻化 — loadSession 后事件路由不再死 ([94a60e9](https://github.com/diy-agent/diy/commit/94a60e91dd63f70b2f5e55f82aba4051b7f22480))
* **acp:** 锁定 SDK 精确版本 + attachSession 能力探测 ([b07fe7b](https://github.com/diy-agent/diy/commit/b07fe7bbe5d86edc9d9ea00899b0438cd4ad979f))
* **build:** electron-builder 添加 electronVersion 精确版本锁定 ([30d908a](https://github.com/diy-agent/diy/commit/30d908a67b0c9c9cbb7e968d080a9acf310196f8))
* **chat:** set_task 同 URI 时允许切换 backend ([5ef5e8e](https://github.com/diy-agent/diy/commit/5ef5e8e2805484eb1f6663e209fa13c2126cfe90))
* **chat:** 修复假确认逻辑 + 竞态 ([863069d](https://github.com/diy-agent/diy/commit/863069d27e7409498b6547e74fdf94697d469804))
* **chat:** 修复消息不完整 — thought→assistant 同 messageId 升级 + stop 事件处理 ([403e648](https://github.com/diy-agent/diy/commit/403e6487ec7102771fed6683dba9667416067ac6))
* **chat:** 对标 DeepSeek Harness 布局 — Agent 全宽 + 用户气泡 + 模型列表修复 ([9c45443](https://github.com/diy-agent/diy/commit/9c45443b299da5e010f2a8489dbf63584dda08b6))
* **chat:** 消息持久化到文件，重启后历史不丢失 ([2038c36](https://github.com/diy-agent/diy/commit/2038c36b73bba233060e9a8312d2d3f5149f61f5))
* **diy-app:** 修复 CLI 启动与 AppConfig 隔离细节 ([4a1fa4e](https://github.com/diy-agent/diy/commit/4a1fa4e6ce8d70a21929d94c889c22140b1b9f2f))
* **diy-app:** 恢复 renderer/preload fs 与 Sync 调用 lint 防护 ([8fb982c](https://github.com/diy-agent/diy/commit/8fb982c641b0f9096ae213f1dcb4483c3b500bb6))
* **diy-clirpc:** 服务端 fixture 改用 uv run + 添加 pytest-asyncio ([a35fbc8](https://github.com/diy-agent/diy/commit/a35fbc8c327f71c7ce3e9a72abdb9604fc97a3e6))
* **diy-dev:** bin 保持调用者 cwd；sync 改流式 + git 超时；list 展示未同步 source ([5caf645](https://github.com/diy-agent/diy/commit/5caf6454411f5215b2ca352913d6808340660c66))
* **diy-dev:** git 命令输出直接透到 stderr ([8b2ae9e](https://github.com/diy-agent/diy/commit/8b2ae9e7caa915ef3cba4a476b0a0caacb358178))
* **persist:** YAML 读写加 try/except，损坏文件/磁盘满不再崩溃 ([eb03a91](https://github.com/diy-agent/diy/commit/eb03a91b479b4d02cb6096d5fc176bbfab0abf8a))
* **pi-agent:** _read_loop 捕获 BaseException 防止 task 崩溃 ([824ef50](https://github.com/diy-agent/diy/commit/824ef506907a1532fc8be76982edb4ee5527d13f))
* **pi-agent:** 解决 chat 发消息不回和二次对话无响应 ([8e4fd2a](https://github.com/diy-agent/diy/commit/8e4fd2a85911863bb76dbf136ee106e08a5625b6))
* **pkgs.ts/diy-rpc:** CLI 的 readline 裸导入改 node:readline，防被 vite browser-externalize ([254777a](https://github.com/diy-agent/diy/commit/254777ae66a90865257726b307a18279d24068e5))
* **pkgs.ts/diy-rpc:** setImmediate→queueMicrotask 实现运行时无关 + check:browser 升级为 tsc 编译验证 ([deea728](https://github.com/diy-agent/diy/commit/deea7283b99dc9d25a75bc6e70ebb649e06e2329))
* **pkgs.ts:** check 分离 fmt；WsLike 删 removeEventListener 死字段；rpc 测试类型修正 ([561a78f](https://github.com/diy-agent/diy/commit/561a78f8e820b67d310a136bb3925aee0aa8b79b))
* **pkgs.ts:** 修 npm test 失败——CLI 缺 node:http2 外部化 + 并发 flake ([a1dcaeb](https://github.com/diy-agent/diy/commit/a1dcaeb7f97e2236f8c2ac55926e713ee8b12186))
* **ref:** ref list 显示子项目 source + sync 扫描所有子项目依赖 ([d93f093](https://github.com/diy-agent/diy/commit/d93f0937f245797e6e186f171324b91036a2616d))
* **ref:** 项目边界识别 + 递归收集 + git 进度可见 + 超时友好报错 ([577d7a0](https://github.com/diy-agent/diy/commit/577d7a051d9468263532bf2a12aed7fd340f1b7a))
* **review:** 合入前 5 个 major 修完 ([4876561](https://github.com/diy-agent/diy/commit/487656151aa9c74b0ba0de3ccf77e64cb61ac4b5))
* rpc-port 双模式 — Main RpcServer + Renderer 桥接 ([c3949fa](https://github.com/diy-agent/diy/commit/c3949fab8004b526bedc87af938d3d15d05b69c9))
* **solid:** ACP 语义移植到活跃 renderer + 主题固化 dark ([1daeb05](https://github.com/diy-agent/diy/commit/1daeb057142cddd62f367ffef7ed2dbe10d3a149))
* **solid:** Agent 页面独立选任务 + main onClick 不再跨页面取消选中 ([530023f](https://github.com/diy-agent/diy/commit/530023fea39e6134ab1c68a3fc3e495b84abee80))
* **task:** 新增任务按钮常显 + 复用 renderer 创建入口 ([ec55546](https://github.com/diy-agent/diy/commit/ec55546998cb538e8afd849c44671c059ee815bc))
* test:bridge 用 tsx 而非 node（rpc-transport 是 TS 源码） ([7c664d1](https://github.com/diy-agent/diy/commit/7c664d1a8d986b09634b1601e5f05c3192a8ea0e))
* typecheck 报错 + 移除调试 console.log ([2b9a153](https://github.com/diy-agent/diy/commit/2b9a153fc33f872c14cc9e992c7c0e5013f0543e))
* **ui:** 修复 DaisyUI drawer 侧栏丢失 — 缺 drawer-toggle checkbox ([fef5966](https://github.com/diy-agent/diy/commit/fef5966ff15b74edce926f6c2ba0ca56f589ccab))
* **ui:** 执行中的消息不属于排队 — 撤回/计数语义修正 ([82b10a4](https://github.com/diy-agent/diy/commit/82b10a492d116fd2bca8434155e16bbd826a0a09))
* **ui:** 拖到项目提升后不再折叠整个项目 ([5c2510a](https://github.com/diy-agent/diy/commit/5c2510ac7a1d0558afe0b3d086e84c6813cabd9c))
* **ui:** 拖拽后自动展开 drop 目标，避免子任务"消失"误解 + select-none ([934dbcd](https://github.com/diy-agent/diy/commit/934dbcda0ec6f6050df5b1a4613e194695483ace))
* **ui:** 拖拽改用 setDragImage 小型幽灵，修复"整个界面被拖出" ([2577fb2](https://github.com/diy-agent/diy/commit/2577fb2e9545bd4cb2fb72e2ba17f95489846ddf))
* **ui:** 收起按钮真正折叠侧栏 — 宽度 w-56↔w-14 ([661a5a8](https://github.com/diy-agent/diy/commit/661a5a80852eca471a1f97f395f5619e4fde503d))
* **ui:** 禁用 KeyboardSensor，回车不再触发拖拽 ([fc32203](https://github.com/diy-agent/diy/commit/fc3220339cf5e09a96354c369269f46bc9716e98))
* **ui:** 详情面板交互改事件协调 — 点任务切换、点空白关闭 ([3bda7f6](https://github.com/diy-agent/diy/commit/3bda7f62ba23594a6af8943fe706f919917afc8d))
* **ui:** 通知弹窗添加关闭按钮，移除 WA_TransparentForMouseEvents ([60403f4](https://github.com/diy-agent/diy/commit/60403f496adb4ce24b608c0d23dccd8451463bd6))
* **ui:** 项目行补 CreateTaskSheet + 按钮 — 对齐 React 老 UI ([793d99d](https://github.com/diy-agent/diy/commit/793d99db96aa2c1324efc6d3b34ea03629f68851))
* 外部命令缺失时给出明确提示，避免裸异常 ([dd1d954](https://github.com/diy-agent/diy/commit/dd1d9540ca535243b94f41a756d38af7ad04c1bf))

## [0.1.23](https://github.com/diy-agent/diy/compare/diy-v0.1.22...diy-v0.1.23) (2026-06-26)


### Features

* **diy-app:** 添加 LLM 管理页面及本地代理集成 ([fce7b01](https://github.com/diy-agent/diy/commit/fce7b01c42d548e503f1024dd250e5f694eca934))
* **diy-cli:** 添加 google-gemini provider 支持及协议映射架构 ([1a20878](https://github.com/diy-agent/diy/commit/1a208788569c81c12999651a6599d8b533e55a96))

## [0.1.22](https://github.com/diy-agent/diy/compare/diy-v0.1.21...diy-v0.1.22) (2026-06-20)


### Features

* add diy-llm ([a714ca8](https://github.com/diy-agent/diy/commit/a714ca8e9ddfb9e2f71e132011a6295ae596365c))
* diy llm AGENTS.md + deepseek provider, cleanup uv.lock ([b585b80](https://github.com/diy-agent/diy/commit/b585b806264d23789c3bc1fc95f3cdc33eed3b7f))
* **diy-llm-gui:** PySide6 托盘管理程序 MVP ([39f9122](https://github.com/diy-agent/diy/commit/39f9122e124234ca9a1902028310b509a31cfc7e)), closes [#120](https://github.com/diy-agent/diy/issues/120)
* **diy-llm-gui:** QtAsyncio async 基础设施 ([c798dc1](https://github.com/diy-agent/diy/commit/c798dc1a879f303b6fd10d793920de99bf4bfe9e))
* **diy-llm-gui:** 启动日志 + 退出说明 ([41be8b6](https://github.com/diy-agent/diy/commit/41be8b6912bc7c1bfb3c8ef8e533010f9b347a07))
* **diy-llm:** auth.json 合并 + editable 块设计 + 意图测试 ([03427b3](https://github.com/diy-agent/diy/commit/03427b33f24d01a284cc525b16fc359fc0df3e1c))
* **diy-ui:** Phase 1 — ScopeProxy 委托层 ([ded6f67](https://github.com/diy-agent/diy/commit/ded6f6730e9274a2744fb23bc6df211a311d7062))
* merge diy-llm into diy-cli as 'diy llm' subcommand ([68960fa](https://github.com/diy-agent/diy/commit/68960fa8e49705785690f1c561b8cf7b84df0ef2))
* **ref:** diy ref 子命令 — list/add/remove/sync/status ([cde6902](https://github.com/diy-agent/diy/commit/cde6902987efd2b1941fdf21f23a34aa06492cba))
* **ref:** diy ref 子命令 + TOML 解析重构 ([5761908](https://github.com/diy-agent/diy/commit/5761908e0f26b746ccd13f8480cf37f6e02da1cf))


### Bug Fixes

* **diy-cli:** diy sync writes sources to ref.lock.json ([#115](https://github.com/diy-agent/diy/issues/115)) ([7f57b20](https://github.com/diy-agent/diy/commit/7f57b2036e94710a14b1aafcafb53b07719cbda0))
* **diy-llm-gui:** pgrep 检测放宽，匹配不带 --daemon 的旧实例 ([72bb1a2](https://github.com/diy-agent/diy/commit/72bb1a24839800a664e60aff021a9f36e49c001e))
* **diy-llm-gui:** QtAsyncio 未实现 subprocess_exec，改用 asyncio.to_thread + subprocess.run ([e0c5d93](https://github.com/diy-agent/diy/commit/e0c5d93f79008addb545e9f581e1612038a7fbbf))
* **diy-llm-gui:** relative import 改绝对导入，兼容 python app.py 直接运行 ([4619aac](https://github.com/diy-agent/diy/commit/4619aacdbb002e696fa39bd80a80dce28f609b9f))
* **diy-llm-gui:** SP_ComputerIcon 用 QStyle 枚举访问，修正 AttributeError ([dd94a05](https://github.com/diy-agent/diy/commit/dd94a051a6e773b14ce16c8aa7fa8b23602b96fd))
* **diy-ui:** _meta.py 去掉 sorted()——保留 Panel 原生 param 顺序 ([f406f1f](https://github.com/diy-agent/diy/commit/f406f1f6ea3d82e16458aa6fcd540e5ce705cf20))
* **diy-ui:** Phase 3a _ancestor_ids 统一用 host id ([d3a475a](https://github.com/diy-agent/diy/commit/d3a475a8164ccfd11320257984fa9499b4a684b1))
* **diy-ui:** Phase 3a _signal_name 兼容 __slots__ ([5b479bb](https://github.com/diy-agent/diy/commit/5b479bb6fbbd177d66fe33c81212407ed03aaa2f))
* **diy-ui:** Phase 3a EventLog hook ScopeProxy._execute_cell ([7fd9b99](https://github.com/diy-agent/diy/commit/7fd9b994efa35d5e81cbdc4897f3edd942c51832))
* **diy-ui:** Phase 3a unit test 全过 + _ancestor_ids 修复 ([7ef3b96](https://github.com/diy-agent/diy/commit/7ef3b96b0ca3f655a8ab929abf0716ef18095cc6))
* **diy-ui:** Phase 3a 修复 _ancestor_ids / on_signal_read / cell() ([4e6ebc8](https://github.com/diy-agent/diy/commit/4e6ebc868ea0940c91446a676dd7c893dfeb75bd))
* **diy-ui:** 修复 async cell 不执行 — _execute_cell 未 await coroutine ([50607f3](https://github.com/diy-agent/diy/commit/50607f3f26d21426a875f7d416c7108239ba6f71))
* **diy-ui:** 修复动态类 param 顺序 + default 表示 ([4d3fd60](https://github.com/diy-agent/diy/commit/4d3fd60a4a2f50720fd3da786c4afc34658aa94c))
* **reactivity:** _add_child 即时同步 Panel，恢复逐步更新 ([2a3f4fd](https://github.com/diy-agent/diy/commit/2a3f4fd43a92c044ec8846b8faa9044aa700e7ed))
* **reactivity:** 修复跨 scope 误判和 Panel children 不同步 ([859cca5](https://github.com/diy-agent/diy/commit/859cca5af1cb1eaf5164fbad6ec10a827e1667af))
* switch from custom_openai to openai provider to handle think param ([98a35d2](https://github.com/diy-agent/diy/commit/98a35d2241a9f5d0fdac2b9a28fed7abd7fa98e3))
* **sync:** workspace 正则缺少 re.DOTALL，diy-ui 未被识别为本地包 ([870984c](https://github.com/diy-agent/diy/commit/870984c76a0f1b351f8db0161e9ca3bfe7cebde1))


### Reverts

* **diy-llm-gui:** 回退为 relative import，文档化正确运行方式 ([86f6e8a](https://github.com/diy-agent/diy/commit/86f6e8ab00499e30e4f7f63f54232f88eb071b0e))

## [0.1.21](https://github.com/diy-agent/diy/compare/diy-v0.1.20...diy-v0.1.21) (2026-06-01)


### Bug Fixes

* **diy-cli:** bump版本至0.1.19并添加release-please标记，修复重复发布失败 ([36604b8](https://github.com/diy-agent/diy/commit/36604b82cafeb9586291b5a85876558f8b64680a))

## [0.1.20](https://github.com/diy-agent/diy/compare/diy-v0.1.19...diy-v0.1.20) (2026-05-31)


### Bug Fixes

* 删除 __version__ 硬编码，diy-cli 增加 -V/--version 支持 ([c3bde85](https://github.com/diy-agent/diy/commit/c3bde85573b259e984a2cb891ec0339efe027cb6))

## [0.1.19](https://github.com/diy-agent/diy/compare/diy-v0.1.18...diy-v0.1.19) (2026-05-31)


### Features

* add @vue/reactivity use case ([68ae1fc](https://github.com/diy-agent/diy/commit/68ae1fcdfd20749cbd87be3aac21d780848371f4))
* add all mono project test stub ([2cb59bb](https://github.com/diy-agent/diy/commit/2cb59bbf5f6a8a5ba2bf6917fb6a03fdca5741ea))
* add dao tui terminal UI ([f3e83b3](https://github.com/diy-agent/diy/commit/f3e83b3203fa4fd8cc2df4486f48b6b6994d62f1))
* add README for diyui package ([39a07df](https://github.com/diy-agent/diy/commit/39a07dfc4b54d6bde2157d1a471b41263aa3e1ff))
* add release doctor script, doctor system design doc, and dev flow commit-publish guide ([8d7b251](https://github.com/diy-agent/diy/commit/8d7b251ba5c269f2f32ba46567aa98beb12af9f5))
* add release-please config for diyui.py package ([4de1482](https://github.com/diy-agent/diy/commit/4de14824a7b38d60d19d71d47d21729cd611ce0a))
* add vue/reactivity, add style ([da4fed3](https://github.com/diy-agent/diy/commit/da4fed399081c3595d83726fb73adcee3611d141))
* add xxui ([caa1831](https://github.com/diy-agent/diy/commit/caa1831bc293f730185a6fe640548e15a632cf21))
* **agent:** add pi ([f9f9f84](https://github.com/diy-agent/diy/commit/f9f9f84a5ca4e2b918bf10221e87a8bcb0f28f28))
* **agent:** add pi ([ac79f5d](https://github.com/diy-agent/diy/commit/ac79f5df3e163c2541850408651e6f8a15b91131))
* **cli:** port sync functionality to Python with deterministic resolution ([5fd9c29](https://github.com/diy-agent/diy/commit/5fd9c29aac95e974ff41bc8aa287b0d0516f17cb))
* **dao-tui:** integrate @vue/reactivity and simplify component model ([ea74814](https://github.com/diy-agent/diy/commit/ea748147b5c385f2fd9e4d3da77cdbb45415759b))
* **deep-research:** add some ideas ([9807530](https://github.com/diy-agent/diy/commit/98075306fcccd0c1810a9c0c73131bc11958cbae))
* **devui:** add panel more widgets ([#74](https://github.com/diy-agent/diy/issues/74)) ([5b78e7d](https://github.com/diy-agent/diy/commit/5b78e7dda747747cbc0c5bf348d720c75cbe41a7))
* **diy-ref:** diy-ref 改造升级，增加:预处理，增加动态skill ([#83](https://github.com/diy-agent/diy/issues/83)) ([8fd0e76](https://github.com/diy-agent/diy/commit/8fd0e7631221d470b0a274d8d65c154cc668943d))
* **diydev:** feat(diydev):  ([e89064c](https://github.com/diy-agent/diy/commit/e89064ca74f07e13ecabcf505b58cce9e97db6f9))
* **diydev:** feat(diydev):  ([eb49113](https://github.com/diy-agent/diy/commit/eb4911326fbf08eb46657e04c33f69e2d98871ca))
* **diydev:** add diy-project-manager skill with Goal-based issue organization ([c199014](https://github.com/diy-agent/diy/commit/c199014115b00d4a900ebe4cd0aee688d5e884bc))
* **diydev:** add find-context and win-file-unlock skills ([d28ec6b](https://github.com/diy-agent/diy/commit/d28ec6b086fcab7acf4caf9b0ece667b4f3cf9f7))
* **diydev:** Python CLI - issue 与 worktree 统一管理 ([64d1a34](https://github.com/diy-agent/diy/commit/64d1a344cdc142a61c0796958ada3638b37a308a))
* **diydev:** 分离出去变为一个独立的项目，作为专门进行定制化diy系列项目开发的规范和工具集合，不适合直接放在diy项目里 ([#107](https://github.com/diy-agent/diy/issues/107)) ([86053e7](https://github.com/diy-agent/diy/commit/86053e78e4cc12b116c67ef8f0cc27d7c029c250))
* **diyui:** redesign system_monitor with side-by-side layout, add panel-debug skill ([dba2e7f](https://github.com/diy-agent/diy/commit/dba2e7fdc2a925923977654272274c853e3ebf06))
* new ts-xui design docs ([713cd37](https://github.com/diy-agent/diy/commit/713cd374b5146326232bcc7e8e43b22dc4a8a3b2))
* Panel 参数对照工具 — 内省原生类签名，驱动强类型化 ([7981f54](https://github.com/diy-agent/diy/commit/7981f54d823196329c2ce25fefd21b775ce83116))
* panel-params skill + AGENTS.md 引用 ([99b0694](https://github.com/diy-agent/diy/commit/99b0694a9b2c5495ae1494206a4a80e5c9169afb))
* **panel-provider:** complete wrapper generation, demo files, and debug infra ([23c1745](https://github.com/diy-agent/diy/commit/23c17454f44ee25bcf691fdc4f1d4ece357020a6))
* prettier and sha.sh ([91aea6d](https://github.com/diy-agent/diy/commit/91aea6de6691dbab34c798dbb67bfadd878ec8be))
* **py-xxui:** 添加 Ruff 配置和 lint 脚本 ([9470433](https://github.com/diy-agent/diy/commit/94704337d20d9860346af91c400564bfdd079669))
* sync dao.yaml add: sources ([459b18e](https://github.com/diy-agent/diy/commit/459b18e93c8eb99377f971507cf98f1437766825))
* trigger release-please workflow ([f5ac874](https://github.com/diy-agent/diy/commit/f5ac87495674179bd90b52e3c09eb6f1573467d3))
* ts-xxui first version ([ec500c7](https://github.com/diy-agent/diy/commit/ec500c7ac81d1933f43ddb7c19e7a813ce495cf2))
* warn when branch has merged PR ([#53](https://github.com/diy-agent/diy/issues/53)) ([b2ed71a](https://github.com/diy-agent/diy/commit/b2ed71a293825494623e80e29ac5c001290a24bb))
* 添加 Playwright headless 浏览器集成测试 ([0875081](https://github.com/diy-agent/diy/commit/087508158224582068395b8307c0beee39941f7a))
* 类型注解完善 + Panel 场景集成测试 ([9246208](https://github.com/diy-agent/diy/commit/9246208cd19aa43eabcf092faf13c603ee0ee362))


### Bug Fixes

* bin/dao tsconfig ([84e5c3f](https://github.com/diy-agent/diy/commit/84e5c3f77a842036c8799e650256f4861a202803))
* bug ([28f5563](https://github.com/diy-agent/diy/commit/28f5563a0ba35c9eabdf1ba96b58c8bf5219efb3))
* **ci:** git submodule SSH→HTTPS 重写，修复 Actions 无法 clone 公开仓库 ([709f416](https://github.com/diy-agent/diy/commit/709f416b70638ea8f1643016f02a459d4f6373f1))
* **ci:** 安装 dev 依赖与 Playwright 浏览器，修复 publish 触发时缺少 playwright ([5ba07d1](https://github.com/diy-agent/diy/commit/5ba07d10b3d8ab5a20b6631ba9558ae2dfe23c68))
* clean old evolution.json ([36baeda](https://github.com/diy-agent/diy/commit/36baeda5b637dbe19f4f827b75bc0b9056cc501b))
* dev doctor check ([4f11785](https://github.com/diy-agent/diy/commit/4f11785a95a8c2963457167fa9b84737c9c5370d))
* **diyui:** __version__ 改用 importlib.metadata 动态读取，避免硬编码不同步 ([039c000](https://github.com/diy-agent/diy/commit/039c000d75ff2620735eb057baf2f7d386d031f8))
* **diyui:** ensure async-safety using contextvars and fix concurrent cell interference ([3c54132](https://github.com/diy-agent/diy/commit/3c5413297ed750d28faa46b127ffc0d9d91f4870))
* **diyui:** fix DataFrame comparison in Signal, add Tabulator widget ([632cb16](https://github.com/diy-agent/diy/commit/632cb16c31fc16feac7af42a5bd9523922f9005a))
* **diyui:** 修复 ./sha.sh test 全部测试错误 ([e5b5ac0](https://github.com/diy-agent/diy/commit/e5b5ac04075d60439cf462f2183f936ab10b1783))
* **diyui:** 修复 widget 类型注解、scheduler 测试变量名、暴露 _scope 内部属性 ([3f61d49](https://github.com/diy-agent/diy/commit/3f61d493267d43280646438fb0ad6b7355ea3251))
* **diyui:** 修复代码规范 + 统一测试辅助类 + PEP 695 泛型标注 ([2f80660](https://github.com/diy-agent/diy/commit/2f8066094ed5f951812ed9efcfcb546314b395d3))
* escape regex in release-please config ([1b43f70](https://github.com/diy-agent/diy/commit/1b43f7019e831713a6e59e16627cf3ff1e97e858))
* npm i --_workspaces, last day error edit this command ([1a61e1b](https://github.com/diy-agent/diy/commit/1a61e1bffae4722ad3918a47345424f9f9210880))
* **panel-provider:** fix wrapper runtime errors and demo rendering ([414fe93](https://github.com/diy-agent/diy/commit/414fe93564da79cb2f2a63b866e1938f03deeef7))
* **publish:** github-actions-cicd add :uv run playwright install ([2f5677a](https://github.com/diy-agent/diy/commit/2f5677adc213d3a5b9044a5f9fc2d37e9f47d712))
* **publish:** publish script ([01e6b41](https://github.com/diy-agent/diy/commit/01e6b41bd2df98b0fb92a4463a0928e449d232bb))
* **publish:** 配置全局 git url 为 https 以避免 ssh 认证问题,action环境没有ssh key无法clone ([b0e6b03](https://github.com/diy-agent/diy/commit/b0e6b03c187ab505943fba61e89a4e9a1c29d1cd))
* **py-xxui:** 修 ruff E402 + pyright 类型错误，配置 pre-commit hook ([2f42ee8](https://github.com/diy-agent/diy/commit/2f42ee8c6f7b19b6027e4dc8e80e66e3f0f945fb))
* simplify release-please config for python ([8f78ca2](https://github.com/diy-agent/diy/commit/8f78ca20dd3f3be950dc222d2eec446ccdea07a8))
* update init docstring ([2549d56](https://github.com/diy-agent/diy/commit/2549d56dce5d376e11af67601133b598d74ab0a1))
* vscode can not use ctrl+c exit ([8875633](https://github.com/diy-agent/diy/commit/887563360f0ad336cb4d80bae9be1ed52138f17e))
* 对齐子包版本号 0.1.10，添加 x-release-please-version 标记使 extra-files 自动更新生效 ([80f0f86](https://github.com/diy-agent/diy/commit/80f0f86019eaff2797fb1770d07eb144ae245325))

## [0.1.17](https://github.com/diy-agent/diy/compare/diy-v0.1.16...diy-v0.1.17) (2026-05-31)


### Bug Fixes

* dev doctor check ([4f11785](https://github.com/diy-agent/diy/commit/4f11785a95a8c2963457167fa9b84737c9c5370d))

## [0.1.16](https://github.com/diy-agent/diy/compare/diy-v0.1.15...diy-v0.1.16) (2026-05-28)


### Features

* **diydev:** 分离出去变为一个独立的项目，作为专门进行定制化diy系列项目开发的规范和工具集合，不适合直接放在diy项目里 ([#107](https://github.com/diy-agent/diy/issues/107)) ([86053e7](https://github.com/diy-agent/diy/commit/86053e78e4cc12b116c67ef8f0cc27d7c029c250))

## [0.1.15](https://github.com/diy-agent/diy/compare/diy-v0.1.14...diy-v0.1.15) (2026-05-28)


### Features

* **diydev:** add diy-project-manager skill with Goal-based issue organization ([c199014](https://github.com/diy-agent/diy/commit/c199014115b00d4a900ebe4cd0aee688d5e884bc))
* **panel-provider:** complete wrapper generation, demo files, and debug infra ([23c1745](https://github.com/diy-agent/diy/commit/23c17454f44ee25bcf691fdc4f1d4ece357020a6))


### Bug Fixes

* **diyui:** 修复 ./sha.sh test 全部测试错误 ([e5b5ac0](https://github.com/diy-agent/diy/commit/e5b5ac04075d60439cf462f2183f936ab10b1783))
* **diyui:** 修复 widget 类型注解、scheduler 测试变量名、暴露 _scope 内部属性 ([3f61d49](https://github.com/diy-agent/diy/commit/3f61d493267d43280646438fb0ad6b7355ea3251))
* **panel-provider:** fix wrapper runtime errors and demo rendering ([414fe93](https://github.com/diy-agent/diy/commit/414fe93564da79cb2f2a63b866e1938f03deeef7))

## [0.1.14](https://github.com/diy-agent/diy/compare/diy-v0.1.13...diy-v0.1.14) (2026-05-27)


### Features

* **diy-ref:** diy-ref 改造升级，增加:预处理，增加动态skill ([#83](https://github.com/diy-agent/diy/issues/83)) ([8fd0e76](https://github.com/diy-agent/diy/commit/8fd0e7631221d470b0a274d8d65c154cc668943d))

## [0.1.13](https://github.com/diy-agent/diy/compare/diy-v0.1.12...diy-v0.1.13) (2026-05-27)


### Features

* **diyui:** redesign system_monitor with side-by-side layout, add panel-debug skill ([dba2e7f](https://github.com/diy-agent/diy/commit/dba2e7fdc2a925923977654272274c853e3ebf06))


### Bug Fixes

* **diyui:** ensure async-safety using contextvars and fix concurrent cell interference ([3c54132](https://github.com/diy-agent/diy/commit/3c5413297ed750d28faa46b127ffc0d9d91f4870))
* **diyui:** fix DataFrame comparison in Signal, add Tabulator widget ([632cb16](https://github.com/diy-agent/diy/commit/632cb16c31fc16feac7af42a5bd9523922f9005a))

## [0.1.12](https://github.com/diy-agent/diy/compare/diy-v0.1.11...diy-v0.1.12) (2026-05-26)


### Bug Fixes

* 对齐子包版本号 0.1.10，添加 x-release-please-version 标记使 extra-files 自动更新生效 ([80f0f86](https://github.com/diy-agent/diy/commit/80f0f86019eaff2797fb1770d07eb144ae245325))

## [0.1.11](https://github.com/diy-agent/diy/compare/diy-v0.1.10...diy-v0.1.11) (2026-05-26)


### Bug Fixes

* **ci:** 安装 dev 依赖与 Playwright 浏览器，修复 publish 触发时缺少 playwright ([5ba07d1](https://github.com/diy-agent/diy/commit/5ba07d10b3d8ab5a20b6631ba9558ae2dfe23c68))

## [0.1.10](https://github.com/diy-agent/diy/compare/diy-v0.1.9...diy-v0.1.10) (2026-05-26)


### Bug Fixes

* **publish:** github-actions-cicd add :uv run playwright install ([2f5677a](https://github.com/diy-agent/diy/commit/2f5677adc213d3a5b9044a5f9fc2d37e9f47d712))

## [0.1.9](https://github.com/diy-agent/diy/compare/diy-v0.1.8...diy-v0.1.9) (2026-05-26)


### Bug Fixes

* **ci:** git submodule SSH→HTTPS 重写，修复 Actions 无法 clone 公开仓库 ([709f416](https://github.com/diy-agent/diy/commit/709f416b70638ea8f1643016f02a459d4f6373f1))
* **publish:** 配置全局 git url 为 https 以避免 ssh 认证问题,action环境没有ssh key无法clone ([b0e6b03](https://github.com/diy-agent/diy/commit/b0e6b03c187ab505943fba61e89a4e9a1c29d1cd))

## [0.1.8](https://github.com/diy-agent/diy/compare/diy-v0.1.7...diy-v0.1.8) (2026-05-26)


### Bug Fixes

* **publish:** publish script ([01e6b41](https://github.com/diy-agent/diy/commit/01e6b41bd2df98b0fb92a4463a0928e449d232bb))

## [0.1.7](https://github.com/diy-agent/diy/compare/diy-v0.1.6...diy-v0.1.7) (2026-05-26)


### Features

* **devui:** add panel more widgets ([#74](https://github.com/diy-agent/diy/issues/74)) ([5b78e7d](https://github.com/diy-agent/diy/commit/5b78e7dda747747cbc0c5bf348d720c75cbe41a7))
* **diydev:** add find-context and win-file-unlock skills ([d28ec6b](https://github.com/diy-agent/diy/commit/d28ec6b086fcab7acf4caf9b0ece667b4f3cf9f7))


### Bug Fixes

* **diyui:** 修复代码规范 + 统一测试辅助类 + PEP 695 泛型标注 ([2f80660](https://github.com/diy-agent/diy/commit/2f8066094ed5f951812ed9efcfcb546314b395d3))

## [0.1.6](https://github.com/diy-agent/diy/compare/diy-v0.1.5...diy-v0.1.6) (2026-05-24)


### Features

* **diydev:** feat(diydev):  ([e89064c](https://github.com/diy-agent/diy/commit/e89064ca74f07e13ecabcf505b58cce9e97db6f9))

## [0.1.5](https://github.com/diy-agent/diy/compare/diy-v0.1.4...diy-v0.1.5) (2026-05-24)


### Features

* add @vue/reactivity use case ([68ae1fc](https://github.com/diy-agent/diy/commit/68ae1fcdfd20749cbd87be3aac21d780848371f4))
* add all mono project test stub ([2cb59bb](https://github.com/diy-agent/diy/commit/2cb59bbf5f6a8a5ba2bf6917fb6a03fdca5741ea))
* add dao tui terminal UI ([f3e83b3](https://github.com/diy-agent/diy/commit/f3e83b3203fa4fd8cc2df4486f48b6b6994d62f1))
* add README for diyui package ([39a07df](https://github.com/diy-agent/diy/commit/39a07dfc4b54d6bde2157d1a471b41263aa3e1ff))
* add release doctor script, doctor system design doc, and dev flow commit-publish guide ([8d7b251](https://github.com/diy-agent/diy/commit/8d7b251ba5c269f2f32ba46567aa98beb12af9f5))
* add release-please config for diyui.py package ([4de1482](https://github.com/diy-agent/diy/commit/4de14824a7b38d60d19d71d47d21729cd611ce0a))
* add vue/reactivity, add style ([da4fed3](https://github.com/diy-agent/diy/commit/da4fed399081c3595d83726fb73adcee3611d141))
* add xxui ([caa1831](https://github.com/diy-agent/diy/commit/caa1831bc293f730185a6fe640548e15a632cf21))
* **agent:** add pi ([f9f9f84](https://github.com/diy-agent/diy/commit/f9f9f84a5ca4e2b918bf10221e87a8bcb0f28f28))
* **agent:** add pi ([ac79f5d](https://github.com/diy-agent/diy/commit/ac79f5df3e163c2541850408651e6f8a15b91131))
* **dao-tui:** integrate @vue/reactivity and simplify component model ([ea74814](https://github.com/diy-agent/diy/commit/ea748147b5c385f2fd9e4d3da77cdbb45415759b))
* **deep-research:** add some ideas ([9807530](https://github.com/diy-agent/diy/commit/98075306fcccd0c1810a9c0c73131bc11958cbae))
* **diydev:** feat(diydev):  ([eb49113](https://github.com/diy-agent/diy/commit/eb4911326fbf08eb46657e04c33f69e2d98871ca))
* **diydev:** Python CLI - issue 与 worktree 统一管理 ([64d1a34](https://github.com/diy-agent/diy/commit/64d1a344cdc142a61c0796958ada3638b37a308a))
* new ts-xui design docs ([713cd37](https://github.com/diy-agent/diy/commit/713cd374b5146326232bcc7e8e43b22dc4a8a3b2))
* Panel 参数对照工具 — 内省原生类签名，驱动强类型化 ([7981f54](https://github.com/diy-agent/diy/commit/7981f54d823196329c2ce25fefd21b775ce83116))
* panel-params skill + AGENTS.md 引用 ([99b0694](https://github.com/diy-agent/diy/commit/99b0694a9b2c5495ae1494206a4a80e5c9169afb))
* prettier and sha.sh ([91aea6d](https://github.com/diy-agent/diy/commit/91aea6de6691dbab34c798dbb67bfadd878ec8be))
* **py-xxui:** 添加 Ruff 配置和 lint 脚本 ([9470433](https://github.com/diy-agent/diy/commit/94704337d20d9860346af91c400564bfdd079669))
* sync dao.yaml add: sources ([459b18e](https://github.com/diy-agent/diy/commit/459b18e93c8eb99377f971507cf98f1437766825))
* trigger release-please workflow ([f5ac874](https://github.com/diy-agent/diy/commit/f5ac87495674179bd90b52e3c09eb6f1573467d3))
* ts-xxui first version ([ec500c7](https://github.com/diy-agent/diy/commit/ec500c7ac81d1933f43ddb7c19e7a813ce495cf2))
* warn when branch has merged PR ([#53](https://github.com/diy-agent/diy/issues/53)) ([b2ed71a](https://github.com/diy-agent/diy/commit/b2ed71a293825494623e80e29ac5c001290a24bb))
* 添加 Playwright headless 浏览器集成测试 ([0875081](https://github.com/diy-agent/diy/commit/087508158224582068395b8307c0beee39941f7a))
* 类型注解完善 + Panel 场景集成测试 ([9246208](https://github.com/diy-agent/diy/commit/9246208cd19aa43eabcf092faf13c603ee0ee362))


### Bug Fixes

* bin/dao tsconfig ([84e5c3f](https://github.com/diy-agent/diy/commit/84e5c3f77a842036c8799e650256f4861a202803))
* bug ([28f5563](https://github.com/diy-agent/diy/commit/28f5563a0ba35c9eabdf1ba96b58c8bf5219efb3))
* clean old evolution.json ([36baeda](https://github.com/diy-agent/diy/commit/36baeda5b637dbe19f4f827b75bc0b9056cc501b))
* escape regex in release-please config ([1b43f70](https://github.com/diy-agent/diy/commit/1b43f7019e831713a6e59e16627cf3ff1e97e858))
* npm i --_workspaces, last day error edit this command ([1a61e1b](https://github.com/diy-agent/diy/commit/1a61e1bffae4722ad3918a47345424f9f9210880))
* **py-xxui:** 修 ruff E402 + pyright 类型错误，配置 pre-commit hook ([2f42ee8](https://github.com/diy-agent/diy/commit/2f42ee8c6f7b19b6027e4dc8e80e66e3f0f945fb))
* simplify release-please config for python ([8f78ca2](https://github.com/diy-agent/diy/commit/8f78ca20dd3f3be950dc222d2eec446ccdea07a8))
* update init docstring ([2549d56](https://github.com/diy-agent/diy/commit/2549d56dce5d376e11af67601133b598d74ab0a1))
* vscode can not use ctrl+c exit ([8875633](https://github.com/diy-agent/diy/commit/887563360f0ad336cb4d80bae9be1ed52138f17e))
