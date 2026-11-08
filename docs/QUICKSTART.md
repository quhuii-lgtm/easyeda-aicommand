# First installation and use

English | [简体中文](QUICKSTART_ZH.md)

Updated: 2026-11-09 for v0.20.128 and skill v2026.11.08. Windows host acceptance on JLCEDA Pro 4.1.93 covers hidden proxy startup, port discovery, automatic connection, SMT entry and read-only queries. Linux host behavior remains untested; this is not full drawing or production acceptance.

## Ask your AI to set up the connection

Give this request to an AI tool that can access local files and run terminal commands:

```text
Install and connect AI Command Engine for JLCEDA Pro. Set up the environment and verify a read-only call; do not edit drawings.
1. Check the OS, Node.js and npm. Node.js >=20.17.0 is required.
2. Download https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.08/ai-command-engine-skill_v2026.11.08_en-zh.zip and install the complete ai-command-engine folder in this AI tool's skills directory. Preserve personal changes and references. Read SKILL.md and references/setup.md.
3. Run npm ci --omit=dev in the skill root. On Windows ask the skill to run scripts/start-proxy.ps1 hidden. Do not open a console window or the legacy startup URL.
4. Let the launcher select an available port in 49720–49729 or reuse a compatible proxy. Keep the actual endpoint it reports. Do not stop unknown processes or change system port settings. Explicit -Port/PORT uses only that port.
5. Guide me to install the companion .eext from https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.128, enable it and allow external interaction in EDA.
6. Query /health and /connections at the returned endpoint; verify the version/project and call read-only project.getInfo with the intended instanceId. Confirm ok:true. Do not automatically choose the first of multiple windows.
7. Report the environment, skill version, actual port, plugin instance and read-only result. State missing checks; connection is not drawing acceptance.
```

## 1. Install the skill and runtime dependency

Get the complete skill from [skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases). Install `ai-command-engine/` in your AI tool's skills directory. Keep the entry points, `references/`, `scripts/`, `package.json`, `package-lock.json`, `VERSION`, and `LICENSE` together and reload the skill.

For v2026.11.08, download the [English/Chinese ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.08/ai-command-engine-skill_v2026.11.08_en-zh.zip) from its [release page](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.08).

In the skill root, run once:

```powershell
npm ci --omit=dev
```

Only the proxy runtime dependency is installed. The complete plugin source and build are not required. Reinstall dependencies from the new lockfile after a skill update.

## 2. Start hidden in the background

The AI runs this through its terminal tool, using the actual installed skill path:

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<skill-directory>/scripts/start-proxy.ps1"
```

The launcher reuses a compatible proxy, or starts Node hidden and verifies health. It searches `49720–49729` and reports the actual endpoint. Explicit `-Port` / `PORT` values remain pinned. It does not open the legacy URL, terminate unknown services, or change system port settings.

Newly launched proxy data is stored in `%LOCALAPPDATA%/ai-command-engine`, outside the skill. Skill updates do not overwrite credentials, logs, or backups. A compatible older proxy can keep running with its original data directory; credentials are not migrated automatically. Legacy `bridge/` scripts in the plugin source remain for compatibility. The new workflow does not require those scripts or URL registration.

## 3. Install the EDA extension

Get the companion `.eext` from the [v0.20.128 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.128), import and enable it, and allow external interaction. Plugin and skill are installed separately and use independent versions. The extension discovers proxies in the port range and rediscovers after disconnection.

The extension connects automatically, including when the proxy starts later. If manually stopped, use Start Bridge to resume. Installing the extension does not install Node.js or the skill.

## 4. Verify a read-only call

```powershell
$ProxyPort = 49721  # replace with the port returned by the launcher
Invoke-RestMethod "http://127.0.0.1:$ProxyPort/health"
Invoke-RestMethod "http://127.0.0.1:$ProxyPort/connections" | ConvertTo-Json -Depth 8
```

Confirm `service:"ai-command-proxy"` and `lifecycleProtocol:1`. Select by version and project. Send each request to `POST http://127.0.0.1:<actual-port>/command` with the target `instanceId` at the top level:

```json
{"instanceId":"<current-target-instance>","cmd":"project.getInfo","params":{}}
```

Confirm JSON `ok:true` and the intended project. HTTP 200 alone is insufficient. Query target command help instead of guessing parameters. Do not create or edit a circuit during this check.

## Troubleshooting and upgrades

- Missing dependencies: run `npm ci --omit=dev` in the complete skill root.
- No EDA connection: check extension enablement, external interaction, and bridge state.
- Unknown or incompatible listener: identify the service and preserve its process and tasks.
- Replacing files does not upgrade a running instance. Finish active work before changing running components.
- After upgrading the extension, first handle and save pending work in each EDA window. Then reload every window that still runs the old extension; importing the package in one window does not guarantee that all open windows use the new version.
- A timeout does not cancel a write. Check the task and actual content before resending.

Windows startup, port discovery, SMT menu entry and read-only connection checks passed on JLCEDA Pro 4.1.93. Linux host startup has not been tested. This is not all-command or drawing acceptance. Historical issues #12, #17 and #18 remain open; this release does not establish the unresolved Linux behavior or historical stall root causes. SMT credentials are optional and not needed for ordinary drawing.
