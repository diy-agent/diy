# CLI 范例（`@diy-agent/rpc/cli`）

**同一份 api 树，两种消费方式**：`createTypedClient` 给代码用，`CliApp` 给人用。
本目录的每个例子都能直接跑，演示的是「怎么把一个 RPC 树变成一条好用的命令」。

```bash
npx tsx pkgs.ts/core/rpc/examples/cli/01-single-module/run.ts
```

| 目录 | 演示 | 对应 diy 的什么 |
|---|---|---|
| `01-single-module/` | 一个 `defineService` → 一棵命令树 | 单个域（如只做 `fact`） |
| `02-multi-module-root/` | **多个模块合并成同一个根命令**（模块无名字，前缀由使用方给；同一 api 可挂多个前缀） | `diy task …` / `diy agent …` |
| `03-global-options/` | 全局选项表、位置自由、help 同源 | `diy --json` / `diy -C <目录>` |
| `04-root-pitfalls/` | 根命令的四个坑，逐个可跑（旧 `rpcPrefix` 路线的历史包袱） | `rpcPrefix` 为什么曾经存在 |

## 一句话回顾（后面例子都靠它）

```
命令段     ←  RpcSchema.group 的 children 路径（task → list）
参数名     ←  zod 字段名（--limit、位置参数按 cliArg 声明顺序）
调用名     ← rpcPrefix + 命令路径（`diy.` + `task.list` = `diy.task.list`）
```

第三条是根命令所有麻烦的来源：**服务端按 `service.name + path` 注册，客户端按 `rpcPrefix + path` 调用**，
两边拼出来的字符串必须逐字相同。
