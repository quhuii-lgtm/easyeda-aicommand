# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## v0.21.2 update (compared with v0.20.136)

Module reuse is integrated into AI Command Engine with 27 module.* commands. The release includes extraction, library management, restoration, PCB composition and component replacement interfaces, plus the follow-up routing-state fixes from v0.21.1. Query the connected instance’s help and follow the module-reuse guide before using a command.

A user-selected module directory takes priority. Without a selection, the default is module-library under the actual EDA installation directory. Ordinary ACE functions work independently of the module library. The standalone module extension and existing module files remain available.

Windows / JLCEDA Pro 4.1.99 verification covered idle proxy failure followed by Reconnect and background proxy startup, restoring the same instance without restarting EDA. Normal Stop/Start and read-only project, PCB component, module-library and task queries passed. The 20-component readback was identical. Earlier integrated-version checks covered extraction, automatic library saving, search/readback, directory settings and restored documents after save/reopen.

The local 52-case client lifecycle suite, 19-case owner suite, module integration, registry timeout, type checking and build passed. A real in-flight host write was not deliberately hung. Not all 27 module commands were host-tested. Representative PCB combination/replacement, formal schematic per-pin net names and DRC/DFM remain unverified.

For one resistor sample, official New Project import retained DEVICE/SYMBOL/FOOTPRINT META.tags through save/reopen. Existing Project import/rebuild/export returned empty tags before any drawing page was opened or saved, with resource UUIDs remapped. Bytes supplied to the SDK File matched the original archive. The observed difference is limited to that mode and sample; the SDK internal stage remains unknown, and no tags patch is included.

**Update the complete companion skill to 2026.11.12.5.** Download the [bilingual skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.12.5), install the complete ai-command-engine folder, preserve personal settings, then reload the skill. The skill proxy retains its external user-data directory adapter.

Open a PCB drawing to see 16 AI Command Engine menu entries. The start page and schematic pages show seven entries. Module reuse is available through the same plugin, menu and proxy.

See the [plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.2), [marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine) and [release notes](docs/releases/v0.21.2-en.md) for channel status.

## What it does

- Query and edit schematic components, wires, labels, and project pages.
- Inspect and edit PCB components, tracks, vias, copper, supported pads and holes, and silkscreen.
- Run supported differential-pair, length-tuning, pad-branch, silkscreen, and manufacturing checks.
- Export DSN, call an external routing service, and explicitly import SES results.
- Search and maintain component-library resources and inspect project data.

### Module reuse

Follow the complete companion skill’s module-reuse guide and connected command help.

### Feature demos

The following GIFs illustrate feature workflows. They are not evidence that every feature passed v0.21.2 host acceptance.

![Schematic feature demo](images/demo-schematic.gif)

![PCB feature demo](images/demo-pcb.gif)

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

The extension, proxy skill, and AI tool are separate parts. Installing `.eext` does not install Node.js or the skill.

1. **Skill and proxy:** download the [v2026.11.12.5 skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.12.5/ai-command-engine-skill_v2026.11.12.5_en-zh.zip) from the [skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.12.5), then install the complete `ai-command-engine/` folder. Keep its references and scripts. Use Node.js >=20.17.0 and run `npm ci --omit=dev` in the skill root.
2. **Background startup:** ask the AI to follow the skill's [connection guide](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/setup.md) and run `scripts/start-proxy.ps1`. Windows starts it hidden and reports the actual endpoint; compatible services are reused.
3. **EDA extension:** get the `.eext` from the [v0.21.2 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.2), import and enable it, and allow external interaction.
4. **Verify:** use the port reported by the launcher (within `49720–49729`) to check `/health` and `/connections`, confirm the target instance and project, then make a read-only `project.getInfo` call.

See the [first-install guide](docs/QUICKSTART.md). After upgrading, handle and save pending work in every EDA window, then reload each window that still runs the old extension; importing into one window does not update all open windows. Plugin and skill versions are independent. Updating the skill does not overwrite proxy user data or force replacement of a compatible running proxy.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
