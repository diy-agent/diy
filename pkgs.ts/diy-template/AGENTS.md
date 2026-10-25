# @diy/template — 提示词模版引擎

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**零依赖纯内核**（不认识文件系统，`include` 由宿主注入
> resolver），Node / 浏览器 / Electron 通用。
>
> 需求真源是意图测试（`tests/intent.template.test.ts` R1–R15 + `tests/parser.test.ts`），`SPEC.md` 只作索引。

## 正文在知识库，本节只留目录

原先写在下面的 11 条正文已整体迁进**项目知识库**（真源 `knowledge/facts/`，逐条带
`evidence.at: 818d342a:pkgs.ts/diy-template/AGENTS.md:<行>` —— rev 钉住版本，本文件瘦身后行号仍可核）。
本文件 1.9 KB → 1.6 KB。

| 主题 | 是什么 | 条数 |
|---|---|---|
| `template.find` | 包内定位：SPEC / parser+ast / render+trace / scope / analyze / barrel / 宿主装配入口 | 7 |
| `template.rule` | 硬约束：**不做表达式语言** / 逐字节保真不转义 / 意图测试优先 / IO 归宿主 | 4 |

**取法**：

- `diy facts brief template.rule` — 该主题全部条目 + 每条首句
- `diy facts get 'template.rule#no-expr'` — 单条完整值
- `diy facts brief 'template.*'` — 全包一次拿

⚠️ **想给模版加语法前，先 brief 一次 `template.rule`**。`no-expr` 那条写着「为什么不支持 `==` / `&&`」
—— 它是决策不是缺口，`SPEC.md` 里有取舍依据。第二容易破的是 `byte-faithful`：模版里**行首缩进会
原样进提示词**（控制标记本身不产出字符），靠缩进排版的美感会在 prompt 里变成多余空白。
