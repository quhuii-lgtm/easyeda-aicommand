# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## v0.20.135 update (compared with v0.20.128)

Open a PCB drawing page to see all 15 entries in the AI Command Engine menu, including DFM, same-net pad spacing, grouping, and auto-routing. The start page and schematic pages show six general entries.

Compared with v0.20.128, v0.20.135 adds the schematic audit's source-segment review, document-bound PCB helper menus, and an explicit interface workflow for persistent deletion of standalone schematic TEXT. The API deletion result may still revert after save and reopen. For persistent removal, select the requested TEXT in EDA, verify that `schematic.getSelection` contains only its original ID, use the interface Delete command, save and close the page, reopen it, then verify that ID with `schematic.listTexts`. This interface path was tested on EDA 4.1.93. The API persistence issue remains unresolved.

The Windows host check used EDA 4.1.93 and plugin v0.20.133. It confirmed one PCB-specific “AI Command Engine” menu containing 15 entries and passed the eight-page structure audit with no blocking findings. The v0.20.135 help output has not yet been read back from EDA. No claim is made that every command, drawing workflow, whole-board DRC, save/reopen behavior, or production use has passed.

See the [v0.20.135 GitHub release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.135), [skill v2026.11.11 release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.11), and [marketplace listing](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine) for channel status. Read the [release notes](docs/releases/v0.20.135-en.md) for installation and scope.

## What it does

- Query and edit schematic components, wires, labels, and project pages.
- Inspect and edit PCB components, tracks, vias, copper, supported pads and holes, and silkscreen.
- Run supported differential-pair, length-tuning, pad-branch, silkscreen, and manufacturing checks.
- Export DSN, call an external routing service, and explicitly import SES results.
- Search and maintain component-library resources and inspect project data.

### Feature demos

The following GIFs illustrate feature workflows. They are not evidence that every feature passed v0.20.135 host acceptance.

![Schematic feature demo](images/demo-schematic.gif)

![PCB feature demo](images/demo-pcb.gif)

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

The extension, proxy skill, and AI tool are separate parts. Installing `.eext` does not install Node.js or the skill.

1. **Skill and proxy:** download the [v2026.11.11 skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.11/ai-command-engine-skill_v2026.11.11_en-zh.zip) from the [skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.11), then install the complete `ai-command-engine/` folder. Keep its references and scripts. Use Node.js >=20.17.0 and run `npm ci --omit=dev` in the skill root.
2. **Background startup:** ask the AI to follow the skill's [connection guide](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/setup.md) and run `scripts/start-proxy.ps1`. Windows starts it hidden and reports the actual endpoint; compatible services are reused.
3. **EDA extension:** get the `.eext` from the [v0.20.135 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.135), import and enable it, and allow external interaction.
4. **Verify:** use the port reported by the launcher (within `49720–49729`) to check `/health` and `/connections`, confirm the target instance and project, then make a read-only `project.getInfo` call.

See the [first-install guide](docs/QUICKSTART.md). After upgrading, handle and save pending work in every EDA window, then reload each window that still runs the old extension; importing into one window does not update all open windows. Plugin and skill versions are independent. Updating the skill does not overwrite proxy user data or force replacement of a compatible running proxy.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
