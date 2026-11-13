# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## Recent updates and new features in v0.21.6 (compared with v0.21.2)

### Recent fixes

Device replacement now verifies the effective Device association, including inherited association data. This release also includes replacement stop protection, unknown-result replay handling, routing-layer continuity checks and linked module-library root support developed after v0.21.2.

### New features

Mark Regions adds PCB borders and names without moving components. Locate / Highlight selects all region members, including locked components. These operations are separate from Group by Schematic Region, which moves components.

### Installed-host verification scope

Installed v0.21.6 on Windows / JLCEDA Pro 4.1.99 passed three borders, three names and 20-member region checks. Menu marking, cancel without writes, repeat updates, locating/highlighting and save/close/reopen passed. Component positions were preserved and the user confirmed the visible regions.

An independent two-pin resistor test changed a 10 kΩ Device to a different 2.2 kΩ Device with the same footprint. Designator, UID, pin nets and pad geometry were preserved. Effective Device association passed after saving, closing both target tabs and reopening. Final formal schematic and PCB netlists agreed on Device, Footprint, designator and per-pin nets for all 20 shared components.

This test covers two pins, the same footprint and different Devices. Other components and different-footprint combinations remain unverified. The parent schematic gained two TRACK rules physically equivalent to existing PCB widths, so field-for-field archive identity is not claimed. Earlier unknown/partial scenes remain historical failures. Linux and earlier unverified host/API limits remain. The prior Existing Project META.tags sample and standalone TEXT persistence limits still apply. Per-component silkscreen display colors are not a delivered feature.

**Update the complete companion skill to 2026.11.13.4.** Download the [bilingual skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.13.4), preserve personal settings, install the complete ai-command-engine folder and reload the skill.

Open a PCB drawing for the 18-entry AI Command Engine menu. Start and schematic pages have seven general entries including module reuse. See the [plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.6), [marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine) and [release notes](docs/releases/v0.21.6-en.md) for status.

## What it does

- Query and edit schematic components, wires, labels, and project pages.
- Inspect and edit PCB components, tracks, vias, copper, supported pads and holes, and silkscreen.
- Run supported differential-pair, length-tuning, pad-branch, silkscreen, and manufacturing checks.
- Export DSN, call an external routing service, and explicitly import SES results.
- Search and maintain component-library resources and inspect project data.

### Module reuse — local 0.21.1 candidate

The local integration candidate adds module extraction, library management, restoration, PCB composition, and component replacement to the AI Command Engine menu and `module.*` command family. Use the matching companion skill's module-reuse guide for the required order; query the target instance's `__help` for parameters. The candidate has not yet been installed and accepted in EDA.

The selected library directory is remembered. If none is selected, the default is `module-library` under the actual JLCEDA installation directory, not the EDA documents directory. Before using the merged extension, finish any in-flight task in the standalone module-reuse extension and stop its bridge. Existing library files are not moved, overwritten, or automatically migrated.

### Feature demos

The following GIFs illustrate feature workflows. They are not evidence that every feature passed v0.21.6 host acceptance.

![Schematic feature demo](images/demo-schematic.gif)

![PCB feature demo](images/demo-pcb.gif)

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

The extension, proxy skill, and AI tool are separate parts. Installing `.eext` does not install Node.js or the skill.

1. **Skill and proxy:** download the [v2026.11.13.4 skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.13.4/ai-command-engine-skill_v2026.11.13.4_en-zh.zip) from the [skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.13.4), then install the complete `ai-command-engine/` folder. Keep its references and scripts. Use Node.js >=20.17.0 and run `npm ci --omit=dev` in the skill root.
2. **Background startup:** ask the AI to follow the skill's [connection guide](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/setup.md) and run `scripts/start-proxy.ps1`. Windows starts it hidden and reports the actual endpoint; compatible services are reused.
3. **EDA extension:** get the `.eext` from the [v0.21.6 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.6), import and enable it, and allow external interaction.
4. **Verify:** use the port reported by the launcher (within `49720–49729`) to check `/health` and `/connections`, confirm the target instance and project, then make a read-only `project.getInfo` call.

See the [first-install guide](docs/QUICKSTART.md). After upgrading, handle and save pending work in every EDA window, then reload each window that still runs the old extension; importing into one window does not update all open windows. Plugin and skill versions are independent. Updating the skill does not overwrite proxy user data or force replacement of a compatible running proxy.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
