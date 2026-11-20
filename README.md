# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## Recent updates and new features: v0.21.18 (compared with v0.21.7)

### Changes

- **Native autorouting is the default entry.** FreeRouting and KiRouting remain optional. Select target nets, preview and confirm the scope. Calculation or fetching does not establish import or connectivity. Prepare optional engine environments separately as documented.
- **Optional copper-path keepouts.** `pcb.planCopperKeepouts` and `pcb.applyCopperKeepouts` let AI choose protection using the current PCB's actual filled copper, contacts, clearances and preview, then verify the created regions.
- **Power/ground connectivity protection after repouring.** Use `protectNets` to review actual connectivity after repouring. New disconnections return partial completion and stop dependent macro steps. Check flylines, DRC and actual copper after routing and repouring, not only when the router finishes.
- **Stronger target and modification checks.** Macro steps inherit the outer project, PCB and tab; explicit conflicts are rejected before starting. Placement checks affected branches before movement. Library modifications verify actual fields and object identity. The routing menu permits engine changes only after the original task is confirmed finished.
- **This release also includes earlier PCB additions.** Native placement, assembly preflight, local routing and copper-shape review, plus supported arcs, polylines, solid fills, slots, regions, length/angle dimensions, PNG-to-vector placement, single test points and stitching vias. Use the target instance's help and complete skill for supported parameters and limits.

### Installed v0.21.18 verification scope

On 2026-11-20, Windows / JLCEDA Pro 4.1.99 was confirmed running installed v0.21.18 in an independent test project. Macro PCB inheritance and conflicting-target zero-write checks passed. A medium two-layer board preview identified two filled-copper groups. An invalid plan made no writes; applying the valid plan created two keepout regions, and repeating it reused them. Native routing connected six nets using 14 bottom-layer segments and no new vias. After repour, save, close and reopen, flylines and DRC findings remained zero and effective design source matched.

A deliberate simple-board counterexample routed through actual copper. It had zero flylines when routing ended, but repouring added one 3.3 V and one ground flyline. Protection correctly returned partial completion and stopped later macro steps. The original project was not written. Schematic operations, library modifications and menu switching were not repeated in the host this round; targeted regressions and installed entry checks do not establish new host acceptance for them.

### Requirements and limits

**Exclude crystal signals and their local branches from every automatic routing engine.** Follow the confirmed crystal/load-capacitor placement, short direct same-layer routes and local grounding requirements in the complete skill.

Copper-path keepouts are selected by AI from the current filled copper, contacts, clearances and preview, rather than applied as a fixed recipe to every board. Complex-copper and CP66 BOOT0 incomplete results describe tested samples, not general prohibitions on a board type. Preserve the scene and stop dependent work on new disconnections or uncertain results.

These sample results do not guarantee arbitrary whole-board completion or manufacturing acceptance. Copper-shape review does not prove coverage of every narrow neck or electrical island. True elliptical pads, mesh fills, radius-dimension writes, custom fill/region outline widths, bulk automatic stitching and dynamic native stackup tables remain limited. Existing current-default rule binding, object getter rounding and whole-project merge-import restoration conditions still apply.

**Update the complete companion skill to 2026.11.20.3.** Download the [English/Chinese ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.20.3), preserve personal settings, install the complete `ai-command-engine/` folder in your AI tool's skill directory and reload it. Marketplace installation does not update the skill or proxy dependencies automatically. First-install instructions follow below.

Check the actual [GitHub release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.18) and [marketplace status](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine); approval and public availability may follow GitHub publication.

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

The following GIFs illustrate feature workflows. They are not evidence that every feature passed v0.21.18 host acceptance.

![Schematic feature demo](images/demo-schematic.gif)

![PCB feature demo](images/demo-pcb.gif)

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

The extension, proxy skill, and AI tool are separate parts. Installing `.eext` does not install Node.js or the skill.

1. **Skill and proxy:** download the [v2026.11.20.3 skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.20.3/ai-command-engine-skill_v2026.11.20.3_en-zh.zip) from the [skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.20.3), then install the complete `ai-command-engine/` folder. Keep its references and scripts. Use Node.js >=20.17.0 and run `npm ci --omit=dev` in the skill root.
2. **Background startup:** ask the AI to follow the skill's [connection guide](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/setup.md) and run `scripts/start-proxy.ps1`. Windows starts it hidden and reports the actual endpoint; compatible services are reused.
3. **EDA extension:** get the `.eext` from the [v0.21.18 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.18), import and enable it, and allow external interaction.
4. **Verify:** use the port reported by the launcher (within `49720–49729`) to check `/health` and `/connections`, confirm the target instance and project, then make a read-only `project.getInfo` call.

See the [first-install guide](docs/QUICKSTART.md). After upgrading, handle and save pending work in every EDA window, then reload each window that still runs the old extension; importing into one window does not update all open windows. Plugin and skill versions are independent. Updating the skill does not overwrite proxy user data or force replacement of a compatible running proxy.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
