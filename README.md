# EasyEDA AI Command Engine

[简体中文](README_ZH.md)

AI Command Engine connects AI tools to JLCEDA Pro through a local Node.js proxy. It provides structured commands for reading and editing schematics, PCB layouts, projects, and component libraries.

## v0.20.136 update (compared with v0.20.135)

Grouping now reports a partial result when a write has started and recovery cannot be verified. Dependent macro writes stop, and the result retains the backup ID and recovery evidence.

The auto-routing menu retains an operation ID before sending a start request. If the response is lost, status and stop can recover the job using that operation ID, the original PCB and its tab. Recovery refuses mismatched operations and PCBs.

On Windows / JLCEDA Pro 4.1.93, installed v0.20.136 grouped two components, verified its backup and readback, saved, and retained the result after closing and reopening. Existing tracks, vias and network records were preserved. Operation-bound job recovery succeeded and incorrect operations and PCBs were rejected. The stop entry recovered a job that had already completed and reported that cancellation was unnecessary. No SES was imported during these checks.

Controlled fault injection and macro regressions cover uncertain recovery and lost responses. Full live triggers for switching tabs during a write and losing the menu start response remain unverified. Running-job cancellation and menu/silkscreen visual checks were not repeated. Standalone TEXT API persistence retains the limitation documented in v0.20.135.

Open a PCB drawing page to see all 15 AI Command Engine menu entries, including DFM, same-net pad spacing, grouping and auto-routing. The start page and schematic pages show six general entries.

**Update the complete companion skill to 2026.11.12 together with the extension.** Download the [bilingual skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.12), replace the complete ai-command-engine directory in the AI tool’s skill folder while preserving personal settings, then reload the skill.

See the [plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.136), [marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine), and [release notes](docs/releases/v0.20.136-en.md) for channel status and scope.

## What it does

- Query and edit schematic components, wires, labels, and project pages.
- Inspect and edit PCB components, tracks, vias, copper, supported pads and holes, and silkscreen.
- Run supported differential-pair, length-tuning, pad-branch, silkscreen, and manufacturing checks.
- Export DSN, call an external routing service, and explicitly import SES results.
- Search and maintain component-library resources and inspect project data.

### Feature demos

The following GIFs illustrate feature workflows. They are not evidence that every feature passed v0.20.136 host acceptance.

![Schematic feature demo](images/demo-schematic.gif)

![PCB feature demo](images/demo-pcb.gif)

Available commands depend on the installed extension and EDA version. Query the connected instance's help before using a command. A successful command does not by itself establish saved persistence, electrical correctness, whole-board DRC, or manufacturing acceptance. Auxiliary autorouting does not promise a complete route for every board.

## First installation

The extension, proxy skill, and AI tool are separate parts. Installing `.eext` does not install Node.js or the skill.

1. **Skill and proxy:** download the [v2026.11.12 skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.12/ai-command-engine-skill_v2026.11.12_en-zh.zip) from the [skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.12), then install the complete `ai-command-engine/` folder. Keep its references and scripts. Use Node.js >=20.17.0 and run `npm ci --omit=dev` in the skill root.
2. **Background startup:** ask the AI to follow the skill's [connection guide](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/setup.md) and run `scripts/start-proxy.ps1`. Windows starts it hidden and reports the actual endpoint; compatible services are reused.
3. **EDA extension:** get the `.eext` from the [v0.20.136 plugin release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.136), import and enable it, and allow external interaction.
4. **Verify:** use the port reported by the launcher (within `49720–49729`) to check `/health` and `/connections`, confirm the target instance and project, then make a read-only `project.getInfo` call.

See the [first-install guide](docs/QUICKSTART.md). After upgrading, handle and save pending work in every EDA window, then reload each window that still runs the old extension; importing into one window does not update all open windows. Plugin and skill versions are independent. Updating the skill does not overwrite proxy user data or force replacement of a compatible running proxy.

## Project links

- [GitHub releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)
- [JLCEDA extension marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [AI skill releases](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases)
- [Issues and feedback](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- License: [Apache-2.0](LICENSE)
