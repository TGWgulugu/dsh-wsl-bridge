# dsh-wsl-bridge

[English](README.en.md)

在 Windows 上给 [DSH](https://github.com/deepseek-ai/DeepSeek-Harness) 一个原生的 WSL（Linux）执行面。不额外启动 web 服务，也不在 WSL 里安装 dsh。Windows 会话和 WSL 会话在同一个桌面端里使用。

当前版本 **0.4.6**。需要 **Windows**、一个可用的 WSL 发行版，以及 **DSH `>= 0.2.1-rc.2`**。源码：<https://github.com/TGWgulugu/dsh-wsl-bridge>

## 安装

在普通终端里执行（不要在 DSH 会话的工具沙箱里跑）。`dsh` 不在 PATH 上时，换成 Desktop 自带的 `dsh.cmd` 完整路径。

```powershell
dsh plugin --profile desktop add dsh-wsl-bridge
```

尚未发布、或要装当前目录的源码时：

```powershell
dsh plugin --profile desktop add .
```

也可以在仓库根目录运行 `pwsh -File scripts/install-desktop.ps1`。装完后从托盘**完全退出** DSH Desktop，再打开。刷新页面不够。

重启后：

- 任意会话里出现 `wsl_bash`、`wsl_read`、`wsl_write`、`wsl_edit`、`wsl_path`、`wsl_env`。
- 新建会话的模式选择器里出现 **WSL**。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-wsl-bridge
```

如果卸载后应用起不来，在该 profile 目录里执行一次 `pnpm install`。

## 两种用法

### 任意会话里的 WSL 工具

这些工具加在现有会话上，不替换 Windows 自己的 shell 和文件工具。

| 工具 | 作用 |
|---|---|
| `wsl_bash` | 在 WSL 里执行 bash。每个会话一个持久 shell，`cd` 和 `export` 会保留。输出以 `[exit code: N]` 结尾 |
| `wsl_read` | 读 Linux 路径，支持按行 `offset` / `limit` |
| `wsl_write` | 原子写入 Linux 路径。可带 `expectedSha256`，文件在你读过之后被改过就拒绝写入 |
| `wsl_edit` | 按字符串替换。读和写之间用 sha256 核对内容 |
| `wsl_path` | Windows 路径和 Linux 路径互转。优先用发行版里的 `wslpath` |
| `wsl_env` | 查看发行版、内核、用户和是否有 node / python3 / git |

默认有一段路由提示：Linux 上的工作优先用 `wsl_bash` 和 Linux 路径，Windows 文件在 `/mnt/<盘符>`。它不隐藏、也不禁用宿主工具。

`wsl_bash` 可以传 `runInBackground: true`。命令会登记成宿主后台任务，用 `job_output` 看输出、用 `job_kill` 停止。这个任务独占一个 WSL 进程：不继承持久 shell 的 `cd` / `export`，会话 shell 退出时也不会把它杀掉。

### WSL 会话模式

新建会话时选择 **WSL**。这一会话里的 `bash`、`read`、`write`、`edit`、`grep`、`glob` 都在 Linux 里执行，参数是 Linux 路径。persona、skill、goal、plan、compaction、subagent、todo、web、present 仍用 DSH 标准会话的那一套。

**默认工作区是当前发行版的家目录（`$HOME`）。** 第一次 `bash` 从家目录开始；相对路径按家目录解析；`grep` 和 `glob` 不传 `path` 时也搜索家目录。要搜 Windows 目录时，显式传入 `/mnt/<盘符>/...`。

| 工具 | 作用 |
|---|---|
| `bash` | 发行版里的持久 bash，语法是 bash，不是 PowerShell |
| `read` / `write` / `edit` | 读写 Linux 路径。相对路径相对 `$HOME` |
| `grep` | 发行版内的 GNU grep。结果是 `path:line: text`。不传 `path` 时搜 `$HOME` |
| `glob` | 按 glob 列出文件，旧文件在前。不传 `path` 时列 `$HOME` |
| `wsl_env` | 发行版信息 |

家目录只查询一次。登录脚本如果往标准输出打字，不会被当成路径。查询失败时，搜索不会退回 Windows 会话目录。

## 配置

改插件行的 `config`（`cordis.patch.yml`，或 profile 里覆盖它的补丁）。字段都可以省略。

| 字段 | 默认 | 说明 |
|---|---|---|
| `distro` | `''` | 发行版名。空字符串表示系统默认发行版 |
| `timeoutMs` | `120000` | `bash` / `wsl_bash` 的默认时限（毫秒） |
| `fileTimeoutMs` | `30000` | 读、写、搜索的单次时限（毫秒） |
| `maxFileBytes` | `2097152` | `read` / `edit` 最多读取的字节数 |
| `defaultWorkdir` | 宿主工具是 `session`；WSL 模式是 `home` | `session` 把 Windows 会话目录译成 `/mnt/...`。`home` 使用当前发行版的 `$HOME`。也可以填绝对 Linux 路径 |
| `dangerGuard` | `true` | 拒绝明显的破坏性命令，除非该次调用带 `allowDangerous: true` |
| `backgroundJobs` | `true` | 是否允许 `runInBackground`。宿主没有任务注册表时会明确拒绝 |
| `promptSection` | `true` | 是否加入宿主会话的路由提示 |
| `promptOrder` | `3260` | 这段提示的排序 |
| `promptText` | `''` | 用来替换内置路由提示。空字符串表示用内置文本 |
| `selfCheck` | `false` | 挂载时探测一次 WSL。也可以设环境变量 `DSH_WSL_BRIDGE_SELFCHECK=1` |
| `selfCheckMarker` | `''` | 把探测结果追加到这个文件。也可以设 `DSH_WSL_BRIDGE_MARKER` |

破坏性命令清单包括递归删除、写块设备、关机、`find -delete`、`git clean -fdx`。这是固定名单，不是内核隔离；换一种写法仍可能绕过。

## 边界

- 只支持 Windows。其他系统上这两行配置会禁用。
- 工具通过 `wsl.exe` 执行，**不受** DSH 的 Windows 文件沙箱约束。把它看成：发行版里该用户能写的路径，以及通过 `/mnt/<盘符>` 能碰到的 Windows 路径，都可以写。详见 [docs/SECURITY.md](docs/SECURITY.md)。
- `grep` / `glob` 使用 GNU grep 和 find，不读 `.gitignore`。隐藏文件、`node_modules` 和版本库元数据会跳过。
- 桌面端选中的 Windows 文件夹仍然是界面上的工作区。WSL 模式的工具默认不再搜那个目录。技能目录和界面上的文件引用仍按 Windows 路径解析。
- 第一次调用要等发行版冷启动，可能要数秒。`timeoutMs` 默认 120 秒。
- 本插件不在发行版里安装 Node 或其他工具链。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：宿主工具和 WSL 模式怎么分层，以及为什么不替换 shell / fs 服务。
- [docs/SECURITY.md](docs/SECURITY.md)：沙箱边界和危险命令守卫做不到什么。
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)：装完没出现、`EPERM`、模式缺失、冷启动、卸载。

## 开发

```powershell
npm test
npm run test:integration
pwsh -NoProfile -File test/release.test.ps1
pwsh -File scripts/release.ps1 -DryRun
```

`npm test` 不需要 WSL。`npm run test:integration` 会在真实 WSL 里跑，并删掉自己的临时目录。发布脚本的检查不会真的发布。正式发布要先提交干净的工作区，再执行 `pwsh -File scripts/release.ps1`。

代码是纯 ESM，没有构建步骤。`index.js` 注册宿主工具，`wsl-world.js` 注册 WSL 会话模式，实现在 `src/`。

## 许可证

[MIT](LICENSE)
