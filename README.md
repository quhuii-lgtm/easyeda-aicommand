# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## v0.20.126 update

Compared with v0.20.125, width-rule reading, rule decisions, and DSN layer-width conversion now follow the actual TRACK fields, units, enabled copper layers, and rule-binding structures read from the source and SDK. The implementation no longer assumes a fixed EDA 4.1.78 version check. `editorVersion` remains diagnostic; this does not remove other capability or geometry limits.

Scoped acceptance passed on JLCEDA Pro 4.1.93: converted widths matched on 4 nets across 4 copper layers; a 20 mil route against a 25 mil minimum was rejected before write; a legal legacy SES imported 10 tracks and 2 vias; rule bindings were preserved; repeat import added nothing; save/reopen readback passed; original ARC protection remained intact. The retained fixture still reports 9 DRC errors. Whole-board acceptance and production readiness have not passed or been established.

Twelve repository regression suites, two local retained-fixture helper suites, TypeScript checking, and a zero-warning build passed. The 2 helper suites are not additional independent repository suites. The independent AI skill is v2026.10.29. The current public marketplace version is v0.20.124; v0.20.125 was returned for revision. Check the [GitHub release page](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.126) and [marketplace listing](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine) for v0.20.126 status; it is not described as published until the channel confirms it.

## What it does

- Query and edit schematic components, wires, labels, and project pages.
- Inspect and edit PCB components, tracks, vias, copper, supported pads and holes, and silkscreen.
- Run supported differential-pair, length-tuning, pad-branch, silkscreen, and manufacturing checks.
- Export DSN, call an external routing service, and explicitly import SES results.
- Search and maintain component-library resources and inspect project data.

### Feature demos

The following GIFs are illustrative feature examples. They are not evidence of full v0.20.126 functionality or host acceptance.

![Schematic feature demo](images/demo-schematic.gif)

![PCB feature demo](images/demo-pcb.gif)

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

The EDA extension, complete proxy source with its dependencies, and AI skill are separate parts. Installing the extension does not install Node.js, proxy dependencies, or the skill.

1. **Proxy:** download this complete source repository and install Node.js >=20.17.0. In the repository directory, run `npm ci`, then `node bridge/command-proxy.mjs`. Do not copy only the proxy script.
2. **EDA extension:** download the v0.20.126 `.eext` from the [GitHub release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.126), import and enable it in JLCEDA Pro, and allow external interaction.
3. **AI skill:** download [skill v2026.10.29](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.29) or the [complete bilingual ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.29/ai-command-engine-skill_v2026.10.29_en-zh.zip). Install the complete `ai-command-engine/` directory in your AI tool's skills directory. Keep `SKILL.md`, `SKILL_ZH.md`, `references/`, `scripts/`, `VERSION`, and `LICENSE` together. Reload the AI tool and ask it to read `SKILL.md` and report the skill version. Plugin and skill versions are independent.

Follow the [first-install guide](docs/QUICKSTART.md). Start the proxy in a local terminal from the complete source directory. In EDA, import and enable the extension, allow external interaction, then choose “AI Command Engine → Start bridge”. Check `http://127.0.0.1:49720/health` and `http://127.0.0.1:49720/connections`, verify the target project and `instanceId`, and make a read-only `project.getInfo` request before editing a document.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
