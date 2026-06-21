# Changelog

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
