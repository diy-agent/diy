# Changelog

## [0.1.24](https://github.com/diy-agent/diy/compare/diy-v0.1.23...diy-v0.1.24) (2026-09-06)


### Features

* **acp:** listModels 支持 force refresh + UI 刷新按钮 ([faa4276](https://github.com/diy-agent/diy/commit/faa42763d3ef2076e2b6cdba1703c0aa2168ff9d))
* **acp:** V2 官方 SDK 会话池 + 常驻可观测性 + CDP 调试能力 ([ef43c5c](https://github.com/diy-agent/diy/commit/ef43c5c5a11f8df3b28f33590048005d583ec994))
* **acp:** 串行队列支持取消 + 聊天停止/队列撤回 ([a95ede5](https://github.com/diy-agent/diy/commit/a95ede5daf72f87ef585d819c45aea6b042f8d60))
* **acp:** 任务级 ACP 会话 + 聊天面板（Solid） ([3370bd4](https://github.com/diy-agent/diy/commit/3370bd4d20d74a68239a8fd4c76e2a6e12d8df69))
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
