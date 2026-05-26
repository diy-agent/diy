---
name: win-file-unlock
description: >
  Diagnose and resolve Windows file/directory "Permission denied" errors when
  renaming, moving, or deleting despite correct NTFS permissions and no Git locks.
  Covers handle64.exe scanning, handle closing, CWD handle traps, DLL module scanning,
  and process termination strategies.
---

# Win-File-Unlock

解决 Windows 文件/目录被进程占用导致的 `Permission denied` / `Access denied`。

## 场景

`mv`、`rm -rf`、`Rename-Item` 等操作报 `Permission denied`，但 `icacls` 确认有完全控制权限、无 `.git/index.lock` 等锁文件。

## 一键解决（推荐）

> ⚠️ 不要在目标目录或其子目录内运行！先 `cd` 到根目录或无关目录。

```powershell
# 诊断（只读，不修改任何东西）
powershell -ExecutionPolicy Bypass -File $SKILL_DIR/scripts/unlock.ps1 doctor <路径>

# 仅关闭句柄（不操作文件）
powershell -ExecutionPolicy Bypass -File $SKILL_DIR/scripts/unlock.ps1 unlock <路径>

# 解锁后重命名
powershell -ExecutionPolicy Bypass -File $SKILL_DIR/scripts/unlock.ps1 rename <路径> <新名字>

# 解锁后移动
powershell -ExecutionPolicy Bypass -File $SKILL_DIR/scripts/unlock.ps1 move <路径> <目标位置>

# 解锁后删除
powershell -ExecutionPolicy Bypass -File $SKILL_DIR/scripts/unlock.ps1 delete <路径>
```

示例：
```powershell
cd C:\
powershell -ExecutionPolicy Bypass -File $SKILL_DIR/scripts/unlock.ps1 doctor C:\projects\stuck-dir
powershell -ExecutionPolicy Bypass -File $SKILL_DIR/scripts/unlock.ps1 rename C:\projects\old-project new-name
```

脚本流程：
1. `doctor` — 纯诊断，报告路径信息、CWD 陷阱、NTFS 权限、句柄持有者、DLL 占用
2. `unlock` — 关闭句柄，不做文件操作
3. `rename`/`move`/`delete` — 关闭句柄 + 执行文件操作，失败自动重试

## 手动排查（脚本无法解决时）

### handle64.exe 下载

脚本自动从 `https://live.sysinternals.com/handle64.exe` 下载到 `~/.local/bin/`。
如果下载失败（网络限制等），必须让用户手动下载：

> https://learn.microsoft.com/en-us/sysinternals/downloads/handle
>
> 下载 Handle.zip，解压 `handle64.exe` 到 `~/.local/bin/`

**没有 handle64.exe 就无法扫描和关闭句柄，不要尝试其他替代方案。**

原因：Windows 没有暴露任何公开 API 来枚举其他进程的文件句柄，更无法关闭它们。
SysInternals handle 通过内核级 Native API (`NtQuerySystemInformation` / `NtDuplicateObject`)
实现，20 年来没有任何语言或库能替代它（Python `psutil`/`pywin32`、PowerShell、Node 都不行）。
自动下载失败只能让用户手动下载，不要绕路。

### CWD 句柄陷阱（最常见）

如果 `bash.exe` / `powershell.exe` 当前目录 (CWD) 在目标路径内，它们持有持久句柄。
handle64 关闭后会被立即重新获取。

**解法：** 先 `cd /`（Git Bash）或 `cd C:\`（PowerShell），再操作。

### handle64 手动扫描

```bash
cd C:\
handle64.exe -accepteula -a <目录路径>
```

关闭句柄（不杀进程）：
```bash
handle64.exe -accepteula -c <句柄号> -p <PID> -y
```

### 终止占用进程

```powershell
Stop-Process -Id <PID> -Force
```

某些进程（如 `XtMiniQmt`）可能自动重启，需多次终止或先停服务。

### 终极方案：从独立进程执行

```bash
cd C:\
# 方案 1：cmd start 新窗口（不继承 CWD 句柄）
cmd //c "start /wait \"\" powershell -ExecutionPolicy Bypass -File <脚本路径> delete <路径>"

# 方案 2：计划任务（以 SYSTEM 身份，完全隔离）
# 见脚本失败时的内置提示
```

## 常见占用进程

| 进程 | 来源 | 典型占用 |
|------|------|---------|
| `bash.exe` | Git Bash | ⚠️ CWD 句柄（最常踩坑） |
| `powershell.exe` | PowerShell | ⚠️ CWD 句柄 |
| `node.exe` | VS Code / Node | `.git` 目录句柄 |
| `Code.exe` | VS Code | 打开的项目根目录 |
| `explorer.exe` | 资源管理器 | 打开了该目录的窗口 |
| `python.exe` | 虚拟环境/脚本 | 加载了目录内 DLL |

## 原理

Windows 不允许重命名/删除正在被进程使用的目录。错误统一显示为 `Permission denied` 而非"文件被占用"，容易误导。
