# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## Recent updates and new features: v0.21.7 (compared with v0.21.6)

### Added and improved

- **PCB design rules:** read settings and preview changes before explicitly applying them. Apply net-class rules to current members while preserving unselected fields. Explicit per-net overrides take priority; identical repeated requests skip writes.
- **Board-outline zoom:** `pcb.zoomToBoardOutline` fits the actual outline without distant silkscreen affecting the view or moving design objects. Rectangular and concave outlines passed visual checks.
- **Single-PCB source restore:** `pcb.sourceRollback` verifies backup identity, reads back the complete restored source and confirms saving, followed by close/reopen comparison. Repeating the same restore skips the source write.
- **Complete native DRC results:** retain the raw tree, categories, severity and unknown items; Physical and Track object categories are not treated as electrical nets.
- **Fanout verification:** report actual readback counts, partial coverage and geometry precision sources. Related commands bind the project, drawing and tab and reject incorrect targets before writes.

### Installed-host verification scope

Installed v0.21.7 on Windows / JLCEDA Pro 4.1.99 passed configuration writes, class-member assignment, explicit per-net priority, repeated zero-write requests and targeted native DRC effects in an independent test project. Full effective rule source matched after save/close/reopen. Rectangular and concave outline zoom passed visual checks without moving design objects. One new track and one through via passed per-ID readback and save/reopen comparison. Single-PCB restore recovered saved net, endpoint and width changes; repeated restore skipped writing. Deliberate test violations remain, so this is not whole-board DRC or manufacturing acceptance.

### Conditions

Complete physical stackup remains dependent on supported host APIs. `Track:"default"` follows the default profile. Saving may normalize a binding to the current default profile name into `default`; fixed named binding after future default changes is not proven. The observed profile was the current default copperThickness1oz, not a lost non-default 2oz profile.

Filled-copper coordinate units and concave-outline fanout planning remain limited; concave zoom support does not establish concave routing support. Whole-project restore remains SDK merge import rather than exact replacement. Object-specific getter rounding and the combined fixture's `FILL.refs` save difference (`[null] → null`) remain disclosed without a general tolerance. Other existing unverified cases retain their documented conditions.

**Update the complete companion skill to 2026.11.14.1.** Download the [bilingual ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.14.1), preserve personal settings, install the complete `ai-command-engine/` folder in your AI tool's skill directory and reload it. First-install instructions follow below.

See the actual [GitHub release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.7) and [marketplace status](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine). Marketplace approval and public availability may follow GitHub publication.

## What it does

- Query and edit schematic components, wires, labels, and project pages.
- Inspect and edit PCB components, tracks, vias, copper, supported pads and holes, and silkscreen.
- Run supported differential-pair, length-tuning, pad-branch, silkscreen, and manufacturing checks.
- Export DSN, call an external routing service, and explicitly import SES results.
- Search and maintain component-library resources and inspect project data.

### Module reuse

Module reuse adds module extraction, library management, restoration, PCB composition, and component replacement to the AI Command Engine menu and `module.*` command family. Use the matching companion skill's module-reuse guide for the required order; query the target instance's `__help` for parameters. See the companion skill for operation-specific verification scope and conditions.

The selected library directory is remembered. If none is selected, the default is `module-library` under the actual JLCEDA installation directory, not the EDA documents directory. Before using the merged extension, finish any in-flight task in the standalone module-reuse extension and stop its bridge. Existing library files are not moved, overwritten, or automatically migrated.

### Feature demos

The following GIFs illustrate feature workflows. They are not evidence that every feature passed v0.21.7 host acceptance.

![Schematic feature demo](images/demo-schematic.gif)

![PCB feature demo](images/demo-pcb.gif)

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

The extension, proxy skill, and AI tool are separate parts. Installing `.eext` does not install Node.js or the skill.

1. **Skill and proxy:** download the [v2026.11.14.1 skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.14.1/ai-command-engine-skill_v2026.11.14.1_en-zh.zip) from the [skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.14.1), then install the complete `ai-command-engine/` folder. Keep its references and scripts. Use Node.js >=20.17.0 and run `npm ci --omit=dev` in the skill root.
2. **Background startup:** ask the AI to follow the skill's [connection guide](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/setup.md) and run `scripts/start-proxy.ps1`. Windows starts it hidden and reports the actual endpoint; compatible services are reused.
3. **EDA extension:** get the `.eext` from the [v0.21.7 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.7), import and enable it, and allow external interaction.
4. **Verify:** use the port reported by the launcher (within `49720–49729`) to check `/health` and `/connections`, confirm the target instance and project, then make a read-only `project.getInfo` call.

See the [first-install guide](docs/QUICKSTART.md). After upgrading, handle and save pending work in every EDA window, then reload each window that still runs the old extension; importing into one window does not update all open windows. Plugin and skill versions are independent. Updating the skill does not overwrite proxy user data or force replacement of a compatible running proxy.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
