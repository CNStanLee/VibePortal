# 在 Windows 上运行 VibePortal：坑与技巧

[English](windows.md)

在 Windows 10 / 11 上运行 VibePortal 需要注意什么，以及 Windows 适配过程中踩过的坑——写给部署它的用户，也写给要改动“启动进程”相关代码的开发者。

## 用户篇

### 安装

- `VibePortal Setup x.y.z.exe` 是安装版（可选安装目录），`VibePortal x.y.z.exe` 是便携版。两者都**没有签名**，SmartScreen 会先拦一下：点 **更多信息 → 仍要运行**。
- 设置和数据在 `%USERPROFILE%\.vibeportal\`（`config.json`、`runs\` 等）。Windows 没有 POSIX 文件权限，VibePortal 设的 `0600` 不起作用；这些文件靠用户目录本身的权限保护。
- 从源码运行：Node.js ≥ 20，`npm install` 后 `npm run app`。VS Code 的终端里设置了 `ELECTRON_RUN_AS_NODE=1`（VS Code 本身就是 Electron）；`npm run app` / `npm start` 会清掉它，直接 `npx electron .` 不会。

### 找不到 Claude Code / Codex

VibePortal 按以下顺序查找 `claude` / `codex`（`.exe`、`.cmd`、`.bat`）：

1. VibePortal 启动时的 `PATH`，以及 `~\.claude\local`、`%APPDATA%\npm`（npm 全局安装）、`~\.npm-global\bin`
2. 包管理器目录：`%LOCALAPPDATA%\Microsoft\WinGet\Links`、`~\scoop\shims`、`%ProgramData%\chocolatey\bin`
3. **注册表里当前的**用户和系统 `PATH`——VibePortal 启动后才装的 CLI 也能找到，不用重启
4. **Claude Code / Codex 编辑器扩展**自带的 CLI（VS Code、Insiders、Cursor、Windsurf、VSCodium）：取最新且没被 VS Code 标记为待删除的版本

“没找到”会在一分钟后重试；找到的路径每次使用前都会再确认一次（扩展更新后会换目录）。还是找不到就在 `config.json` 里指定——注意 JSON 里反斜杠要写两个，或者直接用正斜杠：

```json
{ "claudeBin": "C:/Users/me/AppData/Roaming/npm/claude.cmd", "codexBin": "C:\\tools\\codex.exe" }
```

### Hooks

从**设置**页复制 hook 片段，别自己手写：Windows 版用的是 Windows 10+ 自带的 `curl.exe`，输出写到 `NUL`，只用双引号，所以不管 Claude Code 用 cmd 还是 Git Bash 执行 hook 都能用。POSIX 版（`>/dev/null`、单引号）在 cmd 下会失败。

### 在终端中打开

- 自动发现：**Windows Terminal、PowerShell 7、Windows PowerShell、命令提示符、Git Bash**。“自动”的顺序是 Windows Terminal → PowerShell → cmd。
- 只有装了 PowerShell（用来执行命令）时才会用 Windows Terminal。
- Git Bash 在自己的窗口（mintty）中打开，并停在任务目录，而不是跳回用户目录。
- 窗口通过 `Start-Process` 启动：有独立的控制台（Windows 11 上在默认终端应用中打开），VibePortal 退出后也不会关。
- 命令提示符拒绝包含 `"` 或 `%` 的参数（cmd 没法安全地给它们加引号）——这样的路径请换一个终端。

### 远程访问与额度

- 用 `winget` 安装的 `ngrok` / `cloudflared` 马上就能找到（WinGet 链接目录 + 注册表 `PATH`），不用重启 VibePortal。
- 提示 “ChatGPT token expired on …”：打开一次 Codex（应用或终端里的 `codex`）刷新登录即可。
- 连接断开或卡住（VPN 刚连上、睡眠唤醒）会先重试两次再报错；报错会写出原因（`ECONNRESET`、`ENOTFOUND`、`network timeout` 等）。

## 开发者篇

### 启动 CLI：不要直接 `spawn()` 一个 `.cmd`

npm 把 `claude`、`codex`、`ngrok` 装成 `.cmd` 包装脚本。Node 修复 CVE-2024-27980 之后，不带 shell 的 `spawn('x.cmd', …)` 直接报 `EINVAL`；而 `shell: true` 会把整行命令不加引号地交给 cmd。请用 `src/core/actions.ts` 里的工具函数：

- `spawnCli(bin, args, opts)` / `cliCommand(bin, args)`：`.cmd` / `.bat` 走 `cmd.exe /d /s /c "<加好引号的命令行>"` 并开启 `windowsVerbatimArguments`，其它程序照常启动。`cliCommand` 给 `execFile` 用（见 `tunnel.ts`）。
- 这行命令里只放固定参数、会话 id 和路径。**指令文本一律走 stdin**，不进 argv：cmd 即使在双引号里也会展开 `%VAR%`。

### 停止 CLI：要杀整棵进程树

- `.cmd` 包装脚本其实是一个 `cmd.exe` 再去跑真正的程序；`child.kill()` 只结束外层，`claude` 还在跑。用 `killTree(child)`（`taskkill /pid <pid> /T /F`）。
- Windows 没有信号：`SIGINT` / `SIGTERM` 都是直接结束进程，没有机会做清理（例如 Claude Remote Control 来不及注销环境）。
- 后台运行在 Windows 上用 `detached: false` 启动。Windows 上的 `detached` 意味着 `DETACHED_PROCESS`——完全没有控制台；而且父进程退出时 Windows 本来就不会杀子进程，所以运行照样能挺过 VibePortal 重启。

### 打开窗口：detached 启动没有控制台

detached 启动的 `cmd` / `powershell` 没有窗口。`src/core/terminals.ts` 改为让 `powershell.exe` 去 `Start-Process` 终端，就像资源管理器那样，并读回它的 pid。最容易出错的是引号，每一层有自己的规则：

| 层 | 规则 |
| --- | --- |
| 给 `powershell -EncodedCommand` 的脚本 | **UTF-16LE** 的 base64；传递过程中不会再被解析 |
| PowerShell 字符串 | 单引号，`'` 写两遍——PowerShell 也把弯引号 `‘ ’ ‚ ‛` 当引号（`psQuote`） |
| `Start-Process -ArgumentList` | 一整个字符串，按 CreateProcess / C 运行时的规则拆分：`"` 前的反斜杠要加倍（`winQuote`） |
| `wt.exe` | 会在 `;` 处拆命令行——转义成 `\;` |
| `cmd /s /k "…"` | 双引号里没有转义：拒绝 `"`、`%` 和换行（`cmdQuote`） |
| Git Bash | 用正斜杠；npm `.cmd` 包装脚本旁边有同名的 sh 版本，用它；`CHERE_INVOKING=1` 让登录 shell 留在当前目录；设置 `MSYSTEM`（新版 Git for Windows 是 `UCRT64`，否则 `MINGW64`） |

### 文件与路径

- `%LOCALAPPDATA%\Microsoft\WindowsApps` 里的 `wt.exe` 是**应用执行别名**（重解析点）：`fs.statSync` / `existsSync` 会说它不存在，要用 `fs.lstatSync` 判断。
- 进程会一直用它启动时的 `PATH`。要找到“刚装好的”程序，用 `reg query … /v Path` 读 `HKCU\Environment` 和 `HKLM\…\Session Manager\Environment`，自己展开 `%变量%`（`parseRegPath`）。环境变量名不区分大小写（`Path` 和 `PATH`）。
- `~/.claude.json` 里同一个目录可能记成 `C:\x\y`，**也可能**是 `C:/x/y`：查信任和写信任都要两种都处理（`officialRemote.ts` 里的 `projectKeys`）。
- `path.relative` 返回 `src\a.ts`；界面上显示的路径统一成 `/`，各平台看起来一样。
- Windows 路径比较不区分大小写（克隆目标目录、`realpath` 结果）。
- `chmod` / `mode: 0o600` 都不生效；测试里不要在 Windows 上断言文件权限。
- 打开 `vscode://` 链接用 `rundll32 url.dll,FileProtocolHandler <url>`——`start` 需要经过 cmd，而 cmd 会把 URL 里的 `&` 当成命令分隔符。
- `npx` 实际是 `npx.cmd`：`scripts/dev.mjs` 在 Windows 上用 `shell: true` 启动它（参数都是固定的）。

### 不能传下去的环境变量

启动任何子进程（后台运行、终端、Remote Control）都要清掉：`ELECTRON_RUN_AS_NODE`（否则 Electron 子进程会当成 Node 跑）、`CLAUDECODE` 和 `CLAUDE_CODE_ENTRYPOINT`（否则从 Claude Code 终端里启动的会话会被打上那个入口的标签）。

### 测试

- 不要写 `#!/bin/sh` 的替身脚本。`test/fakeCli.ts` 用 Node 写假 CLI，在 Windows 上再在旁边生成一个 `.cmd` 包装脚本——测试走的就是真实 npm 安装时的 cmd.exe 路径。
- 包装脚本用 `%~dp0name.cjs` 引用脚本，和 npm 的一样：cmd 按 OEM 代码页而不是 UTF-8 读 `.cmd` 文件，把含非 ASCII 字符的临时路径直接写进去会出错。
- `test/terminals.test.ts` 会真的打开找到的每个终端，结束后再关掉；mintty 会换一个 pid 重新启动自己，所以清理时按临时目录名匹配进程。

### CI 与打包

- `.github/workflows/build.yml` 在 `ubuntu-latest` **和** `windows-latest` 上做类型检查和测试（`fail-fast: false`，一个平台失败不会掩盖另一个平台的结果）。
- `npm run dist:win` 生成 NSIS 安装包和便携版 `.exe`；请在 Windows 上打包（Linux 上 electron-builder 需要 Wine）。`CSC_IDENTITY_AUTO_DISCOVERY=false` 保持不签名。
- `core.autocrlf=true` 时，提交会提示 “LF will be replaced by CRLF”，这是正常的，不影响。
