# First installation and use

English | [简体中文](QUICKSTART_ZH.md)

Updated: 2026-11-04. v0.20.127 moves proxy distribution and background startup into the companion skill. The extension connects automatically. Installed-host acceptance is limited to startup and read-only connection checks; check the release pages for channel publication status.

## Ask your AI to set up the connection

Give this request to an AI tool that can access local files and run terminal commands:

```text
Install and connect AI Command Engine for JLCEDA Pro. Set up the environment and verify a read-only call; do not edit drawings.
1. Check the OS, Node.js and npm. Node.js >=20.17.0 is required.
2. Download https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.03/ai-command-engine-skill_v2026.11.03_en-zh.zip and install the complete ai-command-engine folder in this AI tool's skills directory. Preserve personal changes. Read SKILL.md and references/setup.md. The skill contains the proxy; the full plugin source and development dependencies are not needed.
3. Run npm ci --omit=dev in the skill root. On Windows run scripts/start-proxy.ps1 hidden through the terminal tool. Do not open a console window or register/open a custom URL.
4. Verify http://127.0.0.1:49720/health service identity and lifecycleProtocol. Reuse a compatible running proxy. Do not stop unknown processes or replace a proxy during active work.
5. Guide me to install the companion .eext from https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.127, enable it and allow external interaction in EDA. Wait for necessary manual clicks. The plugin connects automatically; choose Start Bridge only if previously stopped.
6. Query /connections, verify the version and project, then call read-only project.getInfo with the intended instanceId. Confirm ok:true and the project identity. Do not automatically choose the first of multiple windows.
7. Report the environment, skill version, proxy health, plugin instance and read-only result. State missing checks; installation or connection is not drawing acceptance.
```

## 1. Install the skill and runtime dependency

Get the complete skill from [skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases). Install `ai-command-engine/` in your AI tool's skills directory. Keep the entry points, `references/`, `scripts/`, `package.json`, `package-lock.json`, `VERSION`, and `LICENSE` together and reload the skill.

For the v2026.11.03 release, download the [English/Chinese ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.03/ai-command-engine-skill_v2026.11.03_en-zh.zip) from its [release page](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.03).

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

The launcher reuses a compatible proxy, or starts Node hidden and verifies health. It reports errors without opening a custom URL or an error dialog. Execution-policy bypass applies only to this invocation. The default port stays 49720; it does not terminate other services or silently change ports.

Newly launched proxy data is stored in `%LOCALAPPDATA%/ai-command-engine`, outside the skill. Skill updates do not overwrite credentials, logs, or backups. A compatible older proxy can keep running with its original data directory; credentials are not migrated automatically. Legacy `bridge/` scripts in the plugin source remain for compatibility. The new workflow does not require those scripts or URL registration.

## 3. Install the EDA extension

Get the companion `.eext` from the [v0.20.127 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.127), import and enable it, and allow external interaction. Plugin and skill are installed separately and use independent versions. Check the release description and current command help for compatibility.

The extension connects automatically, including when the proxy starts later. If manually stopped, use Start Bridge to resume. Installing the extension does not install Node.js or the skill.

## 4. Verify a read-only call

```powershell
Invoke-RestMethod http://127.0.0.1:49720/health
Invoke-RestMethod http://127.0.0.1:49720/connections | ConvertTo-Json -Depth 8
```

Confirm `service:"ai-command-proxy"` and `lifecycleProtocol:1`. Select by version and project. Send each request to `POST http://127.0.0.1:49720/command` with the target `instanceId` at the top level:

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

Hidden Windows startup is the implementation target of this update. Complete macOS/Linux startup has not been verified in this update. SMT credentials are optional and not needed for ordinary drawing. Save/reopen, DRC, and production acceptance remain separate drawing-task checks.
