# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## v0.20.127 update

Compared with v0.20.126, the local proxy is distributed with the companion AI skill and can be started by the AI in the background on Windows. The extension connects automatically and no longer opens a custom URL to start an unavailable proxy. A manually stopped bridge can still be resumed from the EDA menu. Compatible running proxies are reused; the extension does not force-replace them.

Validation passed for 34 client lifecycle cases, 17 owner lifecycle cases, 8 Python cases, TypeScript checking, and a zero-warning build. On JLCEDA Pro 4.1.93, installed v0.20.127 connected automatically, reported 217 registered commands, and completed read-only `project.getInfo` and `task.list` calls. After the previous EDA window was reopened on November 4, v0.20.127 connected and read-only `project.getInfo` succeeded. These checks cover startup and connection only; they do not validate all 217 commands, a whole board, DRC, or production readiness. Full macOS/Linux startup has not been tested.

The public marketplace version before this update is v0.20.126. The companion skill is independently versioned as v2026.11.03. See the [v0.20.127 GitHub release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.127) and [marketplace listing](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine) for current channel status and attachments. Read the [release notes](docs/releases/v0.20.127-en.md) for upgrade guidance.

## What it does

- Query and edit schematic components, wires, labels, and project pages.
- Inspect and edit PCB components, tracks, vias, copper, supported pads and holes, and silkscreen.
- Run supported differential-pair, length-tuning, pad-branch, silkscreen, and manufacturing checks.
- Export DSN, call an external routing service, and explicitly import SES results.
- Search and maintain component-library resources and inspect project data.

### Feature demos

The following GIFs are illustrative feature examples. They are not evidence of full v0.20.127 functionality or host acceptance.

![Schematic feature demo](images/demo-schematic.gif)

![PCB feature demo](images/demo-pcb.gif)

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

v0.20.127 uses the companion skill to start the proxy in the background. The extension connects automatically without opening a Windows custom URL. Installed-host acceptance covers startup and read-only connection checks; it does not certify every command or drawing workflow.

1. **Skill and proxy:** download the [v2026.11.03 skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.03/ai-command-engine-skill_v2026.11.03_en-zh.zip) from the [standalone skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.03), then install the complete `ai-command-engine/` folder. Keep its `package.json`, `package-lock.json`, `scripts/`, and instructions together. Use Node.js >=20.17.0 and run `npm ci --omit=dev` in the skill root on first use.
2. **Background startup:** ask the AI to run `scripts/start-proxy.ps1` as described in the skill's [connection guide](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/setup.md). The Windows launcher runs the proxy hidden. The full plugin source and URL registration are not required.
3. **EDA extension:** get the companion `.eext` from the [v0.20.127 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.127), import and enable it, and allow external interaction. It connects automatically; choose Start Bridge if it was manually stopped.
4. **Verify:** check `http://127.0.0.1:49720/health` and `http://127.0.0.1:49720/connections`, confirm the version and project, then make a read-only `project.getInfo` call with the intended `instanceId`.

See the [first-install guide](docs/QUICKSTART.md). After upgrading, handle and save pending work in every EDA window, then reload each window that still runs the old extension; importing into one window does not update all open windows. Plugin and skill versions are independent. Updating the skill does not overwrite proxy user data or force replacement of a compatible running proxy.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
