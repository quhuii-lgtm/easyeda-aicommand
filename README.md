# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## v0.20.125 update

Compared with v0.20.124, the additional ARC duplicate/split check now compares only routes with the same `layerName` and `net`. It no longer rejects legitimate cross-layer or different-net routes through that candidate check. Existing geometry checks still reject same-layer, same-net width or type changes.

The source archive now includes the 37 regression samples, their manifest and instructions, and seven test scripts. These files are for source tests and are not included in either `.eext` package or the skill ZIP.

Seventeen focused regression groups, TypeScript checking, and the production build passed locally. v0.20.125 has not been installed on an EDA host. v0.20.124 is publicly listed on the marketplace. Check the [GitHub v0.20.125 release page](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.125) and [marketplace listing](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine) for the current v0.20.125 release and review status.

## What it does

- Query and edit schematic components, wires, labels, and project pages.
- Inspect and edit PCB components, tracks, vias, copper, supported pads and holes, and silkscreen.
- Run supported differential-pair, length-tuning, pad-branch, silkscreen, and manufacturing checks.
- Export DSN, call an external routing service, and explicitly import SES results.
- Search and maintain component-library resources and inspect project data.

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

The EDA extension, complete proxy source with its dependencies, and AI skill are separate parts. Installing the extension does not install Node.js, proxy dependencies, or the skill.

1. **Proxy:** download this complete source repository and install Node.js >=20.17.0. In the repository directory, run `npm ci`, then `node bridge/command-proxy.mjs`. Do not copy only the proxy script.
2. **EDA extension:** download the v0.20.125 `.eext` from the [GitHub release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.125), import and enable it in JLCEDA Pro, and allow external interaction.
3. **AI skill:** download [skill v2026.10.28.3](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.28.3) or the [complete bilingual ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.28.3/ai-command-engine-skill_v2026.10.28.3_en-zh.zip). Install the complete `ai-command-engine/` directory in your AI tool's skills directory. Keep `SKILL.md`, `SKILL_ZH.md`, `references/`, `scripts/`, `VERSION`, and `LICENSE` together. Reload the AI tool and ask it to read `SKILL.md` and report the skill version. Plugin and skill versions are independent.

Follow the [first-install guide](docs/QUICKSTART.md). Start the proxy in a local terminal from the complete source directory. In EDA, import and enable the extension, allow external interaction, then choose “AI Command Engine → Start bridge”. Check `http://127.0.0.1:49720/health` and `http://127.0.0.1:49720/connections`, verify the target project and `instanceId`, and make a read-only `project.getInfo` request before editing a document.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
