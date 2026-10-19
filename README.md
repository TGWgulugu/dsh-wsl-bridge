# dsh-wsl-bridge

在 Windows 上给 DSH 一个**原生的 WSL（Linux）执行面**：不额外启动 web 服务、不在 WSL 里安装 dsh，Windows 会话与 WSL 会话在同一个桌面端窗口里用。

> 当前版本 **0.2.3**（Phase 1 + Phase 2 + 发布准备）：Host-only、零依赖、零构建。
> - Phase 1：host 级 `wsl_*` 工具 + 默认开启的路由提示词。
> - Phase 2：声明式 **`WSL` agent preset** —— 新建会话选 `WSL` 模式，整会话的 `bash`/`read`/`write`/`edit`/`grep`/`glob` 都是 WSL 版本，路径全是 Linux 路径。

## 两种用法

### 1. 任意会话里的 WSL 工具（Phase 1）

| 工具 | 说明 |
|---|---|
| `wsl_bash` | 在 WSL 执行 bash；每会话一个持久 shell（`cd`/export 跨调用保留）；`[exit code: N]` 结尾 |
| `wsl_read` | 读 Linux 路径（base64 往返、支持 offset/limit 行窗口） |
| `wsl_write` | 原子写入 Linux 路径（临时文件 + rename，可带 sha256 版本守卫） |
| `wsl_edit` | 字符串替换，读改写之间 sha256 围栏 |
| `wsl_path` | Windows ↔ Linux 路径互转（`wslpath` 优先，失败回退内置映射） |
| `wsl_env` | 发行版/内核/用户/工具链体检 |

另有一段默认开启的系统提示词路由：WSL 工作优先 `wsl_bash`、用 Linux 路径、Windows 文件在 `/mnt/<drive>`。不隐藏、不禁用宿主工具。

`bash`/`wsl_bash` 都支持 `runInBackground: true`：命令会注册成宿主后台任务（`job_output` / `job_kill` 可读可停），并**独享一个 WSL 进程**——它不继承持久 shell 的 `cd`/export，也不会随会话 shell 的回收被杀。

### 2. `WSL` 会话模式（Phase 2）

新建会话时在模式选择器里选 **WSL**。该 preset 把会话的世界换成 WSL：

| 工具 | 说明 |
|---|---|
| `bash` | WSL 内的持久 bash（Linux 内核、bash 语法） |
| `read` / `write` / `edit` | 直接读写 Linux 路径；相对路径按会话目录解析 |
| `grep` | 发行版内 GNU grep -E，`path:line: text` |
| `glob` | 发行版内 find + 匹配，按修改时间旧→新 |
| `wsl_env` | 发行版信息 |

其余能力（persona、skill、goal、plan、compaction、subagent、todo、web、present）沿用宿主 standard preset 的同一套行。Windows 文件仍可从 Linux 侧 `/mnt/<drive>` 访问。

## 安装（开发期，隔离 profile）

```powershell
$env:DSH_HOME = 'D:\try\experiment\_scratch\p0\env\testhome'
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' plugin --profile probe add 'D:\try\experiment\plugins\dsh-wsl-bridge'
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' --profile probe --dump-config      # 应看到 wsl-bridge 与 preset-wsl
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' --profile probe --no-open --port 62010
```

## 安装（桌面端，需要重启）

```powershell
# 普通终端里执行（不要在 DSH 会话的工具沙箱里跑）
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\try\experiment\plugins\dsh-wsl-bridge'
# 然后从托盘完全退出 DSH Desktop 再打开。
```

重启后：
- 任意会话里出现 `wsl_*` 工具；
- 新建会话的模式选择器里出现 **WSL**。

回滚：`dsh plugin --profile desktop remove dsh-wsl-bridge`，或恢复 `_scratch/p1/desktop-backup/`
里的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` 后在 profile 目录 `pnpm install`。

## 验证

```powershell
$node = 'C:\Users\1\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node test\protocol.test.js     # 15
& $node test\shell.test.js        # 27
& $node test\tools.test.js        # 17
& $node test\world-tools.test.js  # 10
& $node test\guard.test.js        # 9
& $node test\jobs.test.js         # 9
```

隔离真实宿主自检：`DSH_WSL_BRIDGE_SELFCHECK=1`（host 工具）、`DSH_WSL_BRIDGE_WORLD_SELFCHECK=1`
（WSL preset）加 `DSH_WSL_BRIDGE_MARKER` / `DSH_WSL_BRIDGE_WORLD_MARKER`。结果见
`_scratch/p1/RESULTS.md` 与 `_scratch/p2/RESULTS.md`。

## 配置（`cordis.patch.yml` 的 row config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `distro` | `''` | 发行版名；空 = 系统默认 |
| `timeoutMs` | `120000` | `bash`/`wsl_bash` 默认 deadline |
| `fileTimeoutMs` | `30000` | 文件与搜索工具单次 deadline |
| `maxFileBytes` | `2097152` | `read`/`edit` 上限 |
| `defaultWorkdir` | `'session'` | 会话 cwd 翻译成 `/mnt/...`；或 `home` / 绝对 Linux 路径 |
| `dangerGuard` | `true` | 拒绝明显的破坏性命令（`rm -r`、写块设备、关机、`find -delete`、`git clean -fdx`），除非调用带 `allowDangerous: true` |
| `backgroundJobs` | `true` | 是否允许 `runInBackground`（需要宿主 job registry；后台任务独享一个 WSL 进程） |
| `promptSection` | `true` | Phase 1 路由段落开关 |
| `promptOrder` | `3260` | 段落排序 |
| `promptText` | `''` | 覆盖路由文本 |
| `selfCheck` | `false` | 挂载时跑一次宿主侧 WSL 探针（也可用环境变量） |
| `selfCheckMarker` | `''` | 探针结果追加文件（也可用环境变量） |

## 已知边界

- **只支持 Windows 宿主**（preset 与 row 都用 `!!js process.platform !== 'win32'` 禁用）。
- **WSL 不受 DSH 文件沙箱约束**：工具经宿主 subprocess 起 `wsl.exe`，Linux 侧写入无法被 Windows ACL 沙箱围栏 —— 把它当作 WSL 内可写任意路径的能力对待。
- **危险命令守卫只是提示性防护**：它是固定的拒绝清单而非内核边界；确实需要时用 `allowDangerous: true`，不同拼写仍可能绕过。
- `grep`/`glob` 是 GNU grep/find 语义：**不读 `.gitignore`**，跳过隐藏项与 `node_modules`/VCS 目录；与宿主 ripgrep 的差异写在工具描述里。
- `WSL` 模式的工作区仍由桌面端选择（通常是 Windows 目录），只是工具以 Linux 路径工作；技能目录、文件引用等 UI 侧仍按 Windows 路径解析（Phase 3 再收敛）。
- 会话里第一次 WSL 调用会付出 Ubuntu 冷启动成本（实测 5.6–7.1s，热 1.2s）；`timeoutMs` 已按此留足。
- WSL 内没有 node/pnpm（本机实测），需要 Node 工具链的工作请自行在发行版内安装。
- 暂无 client 半（无设置面板）；配置走 patch 行或环境变量。

## 文档

- `docs/ARCHITECTURE.md`：两层结构（host 工具 / WSL preset）、执行路径、为什么不动 shell/fs 服务。
- `docs/SECURITY.md`：沙箱边界、危险命令守卫的定位、不做什么。
- `docs/TROUBLESHOOTING.md`：没出现、EPERM、模式缺失、冷启动、卸载。

## 开发

- `npm test` 一次跑完全部单测（当前 78 个用例）；也可单独 `node test/<name>.test.js`。
- 纯 ESM，无构建；代码在 `index.js`（Phase 1 入口）、`wsl-world.js`（Phase 2 preset 入口）、`src/`。
- 桌面端一键安装：`pwsh -File scripts/install-desktop.ps1`（可 `-Cli` 覆盖 CLI 路径）。
- 单测直接用宿主 node 跑单个文件（**不要** `node --test test/`，sandbox 下 runner 会 EPERM）。
- 隔离集成 harness：`_scratch/p1/it/run-integration.ps1`（Phase 2 会复用）。

## 许可证

MIT。
