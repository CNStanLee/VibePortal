# Running VibePortal on Windows: pitfalls and tips

[中文](windows.zh-CN.md)

What it takes to run VibePortal on Windows 10 / 11, and the traps the Windows port ran into — for users setting it up and for anyone touching the code that starts processes.

## For users

### Install

- `VibePortal Setup x.y.z.exe` is an installer that lets you pick the folder; `VibePortal x.y.z.exe` is portable. Both are **unsigned**, so SmartScreen asks first: **More info → Run anyway**.
- Settings and data live in `%USERPROFILE%\.vibeportal\` (`config.json`, `runs\`, …). Windows has no POSIX file modes, so the `0600` VibePortal asks for has no effect there; the files are protected by your user profile's own permissions.
- From source: Node.js ≥ 20, then `npm install` and `npm run app`. In a VS Code terminal `ELECTRON_RUN_AS_NODE=1` is set (VS Code is itself Electron); `npm run app` / `npm start` clear it, a bare `npx electron .` doesn't.

### Claude Code / Codex not found

VibePortal looks for `claude` / `codex` (`.exe`, `.cmd`, `.bat`) in, in order:

1. `PATH` as it was when VibePortal started, plus `~\.claude\local`, `%APPDATA%\npm` (npm global installs), `~\.npm-global\bin`
2. package managers: `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `~\scoop\shims`, `%ProgramData%\chocolatey\bin`
3. the user and machine `PATH` **as stored in the registry now** — so a CLI installed after VibePortal started is found without restarting it
4. the CLI bundled with the **Claude Code / Codex editor extension** (VS Code, Insiders, Cursor, Windsurf, VSCodium): the newest version that VS Code hasn't marked obsolete

"Not found" is retried after a minute; a found path is checked again before each use (extensions move when they update). If it still isn't found, set it in `config.json` — remember that JSON needs doubled backslashes, or use forward slashes:

```json
{ "claudeBin": "C:/Users/me/AppData/Roaming/npm/claude.cmd", "codexBin": "C:\\tools\\codex.exe" }
```

### Hooks

Copy the hook snippet from **Settings** rather than writing it by hand: on Windows it uses the `curl.exe` that ships with Windows 10+, writes to `NUL` and uses only double quotes, so it works whether Claude Code runs hooks through cmd or Git Bash. The POSIX snippet (`>/dev/null`, single quotes) fails under cmd.

### Open in terminal

- Found automatically: **Windows Terminal, PowerShell 7, Windows PowerShell, Command Prompt, Git Bash**. "Automatic" picks Windows Terminal → PowerShell → cmd.
- Windows Terminal is used only when a PowerShell is there to run the command in.
- Git Bash opens in its own window (mintty) in the task's folder, not in your home folder.
- The window comes up through `Start-Process`: it has a console of its own (on Windows 11 in your default terminal app) and stays open when VibePortal quits.
- Command Prompt refuses arguments containing `"` or `%` (cmd has no way to quote them safely) — a path like that needs another terminal.

### Remote access and plan limits

- `ngrok` / `cloudflared` installed with `winget` are found right away (WinGet links and the registry `PATH`), no VibePortal restart needed.
- "ChatGPT token expired on …": open Codex (the app or `codex` in a terminal) once to refresh the sign-in.
- A dropped or stalled connection (VPN coming up, wake from sleep) is retried twice before the limits show an error; the error then names the cause (`ECONNRESET`, `ENOTFOUND`, `network timeout`…).

## For developers

### Starting a CLI: never `spawn()` a `.cmd` directly

npm installs `claude`, `codex` and `ngrok` as `.cmd` shims. Since Node's fix for CVE-2024-27980, `spawn('x.cmd', …)` without a shell fails with `EINVAL`, and `shell: true` would hand the whole command line to cmd unquoted. Use the helpers in `src/core/actions.ts`:

- `spawnCli(bin, args, opts)` / `cliCommand(bin, args)` route `.cmd` / `.bat` through `cmd.exe /d /s /c "<quoted line>"` with `windowsVerbatimArguments`, and leave everything else alone. `cliCommand` is for `execFile` (see `tunnel.ts`).
- Only fixed flags, session ids and paths go on that command line. **Prompts go through stdin**, never argv: cmd expands `%VAR%` even inside quotes.

### Stopping a CLI: kill the tree

- A `.cmd` shim is a `cmd.exe` running the real program; `child.kill()` ends only the wrapper and leaves `claude` running. Use `killTree(child)` (`taskkill /pid <pid> /T /F`).
- Windows has no signals: `SIGINT` / `SIGTERM` end the process outright, so nothing gets to clean up (e.g. Claude Remote Control can't deregister its environment first).
- Background runs are spawned with `detached: false` on Windows. `detached` there means `DETACHED_PROCESS` — no console at all — and Windows doesn't kill children when the parent exits anyway, so runs still outlive a VibePortal restart.

### Opening a window: no console from a detached spawn

A detached `cmd` / `powershell` has no window. `src/core/terminals.ts` asks `powershell.exe` to `Start-Process` the terminal instead, the way Explorer would, and reads back its pid. Quoting is where it breaks, one rule per layer:

| Layer | Rule |
| --- | --- |
| The script for `powershell -EncodedCommand` | base64 of **UTF-16LE**; nothing in it is parsed again on the way |
| PowerShell strings | single quotes, doubling `'` — and the typographic `‘ ’ ‚ ‛`, which PowerShell also treats as quotes (`psQuote`) |
| `Start-Process -ArgumentList` | one string split by CreateProcess / the C runtime rules: backslashes before a `"` are doubled (`winQuote`) |
| `wt.exe` | splits its command line at `;` — escape it as `\;` |
| `cmd /s /k "…"` | no escape inside double quotes: refuse `"`, `%` and line breaks (`cmdQuote`) |
| Git Bash | forward slashes; use the sh twin of an npm `.cmd` shim; `CHERE_INVOKING=1` keeps the login shell in the folder; set `MSYSTEM` (`UCRT64` on newer Git for Windows, else `MINGW64`) |

### Files and paths

- `wt.exe` in `%LOCALAPPDATA%\Microsoft\WindowsApps` is an **app execution alias** (a reparse point): `fs.statSync` / `existsSync` say it isn't there. Check with `fs.lstatSync`.
- A process keeps the `PATH` it started with. For "installed a moment ago", read `HKCU\Environment` and `HKLM\…\Session Manager\Environment` with `reg query … /v Path` and expand `%VARIABLES%` yourself (`parseRegPath`). Environment variable names are case-insensitive (`Path` vs `PATH`).
- `~/.claude.json` may file a folder as `C:\x\y` **or** `C:/x/y`: look trust up, and write it, under both (`projectKeys` in `officialRemote.ts`).
- `path.relative` returns `src\a.ts`; labels shown in the UI are normalised to `/` so they read the same on every platform.
- Compare Windows paths case-insensitively (clone destinations, `realpath` results).
- `chmod` / `mode: 0o600` are no-ops; don't assert file modes in tests on Windows.
- Open `vscode://` links with `rundll32 url.dll,FileProtocolHandler <url>` — `start` needs cmd, and cmd treats `&` in the URL as a command separator.
- `npx` is `npx.cmd`: `scripts/dev.mjs` spawns it with `shell: true` on Windows (fixed arguments only).

### Environment that must not leak

Clear these for every child (runs, terminals, Remote Control): `ELECTRON_RUN_AS_NODE` (else an Electron child runs as Node), `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` (else a session started from a Claude Code terminal is labelled with that entrypoint).

### Tests

- Don't write `#!/bin/sh` stand-ins. `test/fakeCli.ts` writes the fake CLI in Node and, on Windows, a `.cmd` shim next to it — so the tests go through the same cmd.exe route as the real npm installs.
- The shim refers to its script as `%~dp0name.cjs`, like npm's: cmd reads a `.cmd` file in the OEM code page, not UTF-8, so a non-ASCII temp path written into it would break.
- `test/terminals.test.ts` really opens every terminal it finds and kills them afterwards; mintty restarts itself under another pid, so the cleanup matches on the temp folder's name.

### CI and packaging

- `.github/workflows/build.yml` type-checks and tests on `ubuntu-latest` **and** `windows-latest` (`fail-fast: false`, so one platform's failure doesn't hide the other's).
- `npm run dist:win` builds the NSIS installer and the portable `.exe`; build it on Windows (on Linux electron-builder needs Wine). `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps the build unsigned.
- With `core.autocrlf=true`, git warns "LF will be replaced by CRLF" on commit; that's expected and harmless.
