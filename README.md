# EasyEDA AI Command

**English:** [README.md](README.md) | **简体中文：** [README_ZH.md](README_ZH.md)

**Repositories and downloads:** [Plugin and Node proxy](https://github.com/quhuii-lgtm/easyeda-aicommand) | [Plugin releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases) | [Standalone AI skill](https://github.com/quhuii-lgtm/easyeda-aicommand-skill) | [Latest skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/latest)

EasyEDA AI Command is an AI operation extension for JLCEDA Pro. An AI uses concise instructions from the companion skill, and a local proxy forwards them to a connected EDA window. The extension supports schematic, PCB, project, and component-library queries and editing. Always check the results against the project requirements; the user remains responsible for final acceptance.

Describe a task to your AI tool, such as “check this chip’s stock and price breaks,” “group the PCB components by schematic function block,” “combine this symbol and footprint into a library component,” or “place the MCU and its supporting parts, wire them, and organize the net labels.” The AI can inspect the current project, look up components and pins, call drawing commands, and read back the results. The extension brings **parts lookup, custom component libraries, batch drawing, PCB functional grouping, and result checks** into one workflow.

> This README is the primary English guide. Some linked documents and captions embedded in the demonstration animations may be in Chinese. This describes the documentation language only; it does not claim that the extension interface supports an English language switch.

<a id="first-install-ai"></a>

## First installation: ask your AI to set up and connect

Use an AI coding tool that can read local files and run terminal commands. A chat-only tool can explain the steps, but cannot install dependencies or start the proxy on your computer. The extension, local proxy, and AI skill are separate installs.

Copy the entire prompt below into your AI tool. If you already downloaded the source or extension, also provide its local path. No companion skill needs to be installed before asking for this initial setup.

```text
Help me install AI Command Engine for JLCEDA Pro for the first time. Set up the local environment, connect EDA, and verify the connection using read-only operations. Repository: https://github.com/quhuii-lgtm/easyeda-aicommand .

Inspect the current setup first. Work one step at a time and report the result, any blocker, and the next action. Do not just give me a list of commands or claim completion after installing the extension.

1. Confirm that you can access local files and a terminal. Identify the operating system and check Node.js and npm against package.json; the current requirement is Node.js >=20.17.0. If a tool is missing, guide me through installation from its official source and check again. Git is optional; Python is not required for direct HTTP access.
2. Identify the extension version I have or plan to install and obtain the corresponding complete source repository. Read README.md, docs/QUICKSTART.md, package.json, and package-lock.json. Identify the extension, proxy, and skill sources and versions. If channels differ or matching source is unavailable, explain the mismatch instead of inventing a download URL or assuming compatibility.
3. Use a fixed source directory. Inspect existing repositories, skills, and settings before making changes; preserve personal edits and credentials. Confirm that package.json, package-lock.json, and bridge/command-proxy.mjs exist.
4. Run npm ci in that directory and check that dependencies installed successfully. Do not add --omit=dev; installing a downloaded extension does not require a build. Install the complete ai-command-engine/ directory from the standalone skill repository or its skill ZIP. Keep references/, scripts/, and SKILL.md. Do not copy a skills/ directory from this plugin repository.
5. Check http://127.0.0.1:49720/health. If the proxy is absent, start node bridge/command-proxy.mjs and keep it running. If the port is occupied, identify the service first; do not terminate an unknown process or change the port. Check the health response and proxy version. Resolve failures before continuing. Windows URL-based automatic startup is optional.
6. Guide me through importing or installing the .eext in JLCEDA Pro, enabling it, allowing external interaction, and opening a trial project and document. Explain where I must complete login, verification codes, system confirmations, or manual EDA actions, then wait for me. Do not create or modify a circuit.
7. Guide me to the Chinese menu “AI 指令引擎 → 启动桥接” (AI Command Engine → Start Bridge). Query GET /connections and verify the extension version and project identity. If no instance appears, inspect extension enablement, external interaction, bridge state, and the proxy. When multiple instances exist, use my intended project instead of choosing the first entry.
8. Use the freshly verified instanceId at the top level of POST /command to call project.getInfo. Check that JSON ok is true and that the project identity is correct; HTTP 200 alone is insufficient. Inspect document identities with read-only queries as needed. Use help for the selected instance version rather than guessing parameters.
9. Report the Node/npm versions, source directory and revision, skill location, proxy health, EDA/extension versions, target instanceId, project/document identities, and read-only call result. State any missing evidence. An installed extension alone is not a verified EDA connection.

Only set up the environment and verify connectivity. Do not place components, route tracks, modify libraries, configure SMT credentials, or upload files publicly. Wait for a separate drawing request after the read-only check succeeds.
```

A successful first connection means the proxy is healthy, `/connections` contains the intended EDA instance, and `project.getInfo` returns `ok:true` with the correct project. It does not establish drawing correctness or save/reopen persistence. See the [installation guide](docs/QUICKSTART.md) for manual commands and troubleshooting.

## Key features

### 1. Component stock, pricing, and SMT parts lookup

During component selection, look up JLC SMT parts by **part number, model, package, brand, stock, reference unit price, and price breaks**. You can also query details for multiple part numbers at once to compare availability and prices for different order quantities.

- **AI lookup:** Ask the AI to find parts by keywords or query stock, parameter descriptions, and price breaks for a list of part numbers.
- **Separate lookup window:** Open the SMT parts lookup page from the extension menu and view results directly.
- **Lookup while drawing:** Combine parts-library search with placement by JLC part number to use candidate parts in a schematic.

Stock and pricing come from the JLC Open Platform query results. The response at the time of the query and the information shown when ordering are authoritative; a reference unit price is not the transaction price for every order quantity. This feature requires separate Open Platform credentials. See [Parts lookup setup](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md#5-可选-smt-物料查询). These credentials are not needed for ordinary drawing features.

### 2. PCB grouping and initial placement by schematic function blocks

Convert rectangular function blocks in a schematic, such as “Power,” “MCU,” “Driver,” and “Interface,” into corresponding PCB component groups. The extension reads the block boundaries and component membership, groups and arranges components, and creates group borders and names to help organize a scattered board.

- Includes PCB component grouping, with a placement engine adapted from the official `eext-pcb-component-grouping` project, callable by AI.
- Reads function blocks across schematic pages or from a specified page; components are arranged in rows by category within each group, and groups are arranged in separate regions.
- **Preview before execution:** By default, the extension returns a grouping and placement plan. During execution it checks the board boundary, avoids existing components, creates a backup before writing, and reads component positions back for verification.

This feature is intended for grouping and initial placement after importing a schematic into a PCB. Function blocks must first be drawn in the schematic. After grouping, continue adjusting the layout for decoupling, return paths, heat, RF, and mechanical constraints. Grouping does not complete final placement or automatic routing.

### 3. Custom component libraries: symbols, footprints, and complete components

Use AI to manage personal symbol, footprint, and component libraries alongside existing marketplace parts. Save custom components for reuse in later projects. Library operations target the personal library by default, or another library the user is authorized to access.

- **Create and edit symbols and footprints:** Create library entries, open the corresponding editor, and write edited symbol or footprint content back to the library.
- **Combine complete components:** Link an existing schematic symbol to a PCB footprint, optionally attach an existing 3D model, and set reference designator prefix, manufacturer, supplier, BOM, and PCB conversion properties.
- **Copy and derive variants:** Copy an existing symbol, footprint, or component to a specified library under a new name to maintain a project-specific version.
- **Search and maintain:** Search, read, modify, or delete library entries; change component-to-symbol and component-to-footprint links; and maintain commonly used parts.

For example, combine a custom connector symbol with a footprint whose dimensions have been checked, then place that library component in a schematic. Creating a library entry does not design its pins or footprint automatically. Before use, check pin numbers, pad mapping, and dimensions. Attaching a 3D model also does not generate a model automatically.

### 4. Batch schematic drawing from a parts list and connection relationships

Place components by JLC part number, read their actual pins, edit reference designators and properties, and create function blocks in batches. Given a parts list and connection relationships, AI can place, connect, name, and check components step by step, reducing repetitive searching, clicking, and typing.

For an existing schematic, preview an organization plan for selected components or regions before rearranging them and rebuilding connections. This is suitable for repeated channels, MCU peripherals, interface modules, and other drawing tasks with clear connection relationships.

Complete component replacement uses a temporary new instance and the companion skill's full verification, deletion, property-update, identity-transfer, and persistence procedure. It does not preserve the old instance ID through an in-place update; follow the [current schematic workflow](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/commands-schematic.md#complete-component-replacement) for the exact steps and field sources. The v0.10.143 update commands are removed. If an existing PCB must reflect schematic changes, the user starts and confirms import in the EDA interface; AI only performs read-only checks before and after.

### 5. Batch wiring, net labels, and connection checks

Create direct pin-to-pin wires, short wires with net labels, or a mixture of both. Manage net-label names, mark pins as no-connect, query net members, and export netlists.

When wiring, the extension can use actual pin locations to form paths. After creating a label, it checks whether the label is attached to a wire. Batch wiring checks the resulting netlist connections. This helps create a readable drawing and confirm whether the intended pins really belong to the same net. The MCU demonstration below shows short wire stubs, aligned labels on both sides, and a save/reopen check.

### 6. PCB drawing, copper areas, and net management

Draw board outlines, move and rotate components, create tracks from coordinates, place vias, create or modify copper areas, and read back fill status after rebuilding copper. Manage net classes and differential pairs, query net lengths, read tracks and pads on a net, and use highlighting or schematic-to-PCB cross-probing to help investigate issues.

Use these features for batches of operations with clear rules, such as “route along these coordinates,” “create and rebuild GND copper in this region,” or “add these signals to a net class.” An external autorouter workflow can use DSN export and SES import. The resulting routing still needs inspection.

### 7. Project checks, exports, and multi-window operation

- **Result checks:** Read component, pin, wire, label, and copper-fill states; run schematic and PCB DRC; and export a netlist to check connections. The available DRC details depend on the EDA host version.
- **Exports:** Export BOMs, schematic images, PCB Gerber files, pick-and-place coordinates, and other design materials for review and manufacturing preparation.
- **Multi-window targeting:** Select the operation target by instance and document identity when several projects are open.
- **Combined operations:** Macro commands can run component placement, wiring, and checks in sequence and return each step’s result. If a write result is uncertain, later dependent operations stop.

These capabilities work together with the local proxy and companion AI skill. The extension provides project operations and result readback; circuit design decisions and final acceptance still depend on the actual project requirements.

### 8. JLC manufacturing checks (DFM)

PCB DFM, SMT, and same-net spacing checks return 18, 7, and 1 check items respectively, along with completeness and geometry coverage information. A DFM run requires explicit outer and inner copper thickness inputs: `outerCopperOz` and `innerCopperOz`. Copper thickness read from the design is reported separately and does not replace these inputs. Results do not constitute manufacturing approval or a complete online DFM service. See [DFM check details](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/commands-frequency.md).

### 9. Pad fanout and local copper generation

`pcb.getFanoutPlan` and `pcb.getAutoCopperPlan` first produce read-only plans. `pcb.fanout` and `pcb.autoCopper` execute the complete plans. Fanout length, track width, via outer diameter, drill diameter, and clearance must all be specified explicitly in mils. Supported geometry, conservative approximations, and rejection conditions are described in [Geometry command details](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/commands-pcb-special.md). Historical isolated-project checks cover selected larger-MCU fanout samples; they do not establish a pass for every package shape, every board, or a complete MCU fanout workflow. The separate fill-readback path has also been verified on a specific copper area after save/close/reopen. These records are scoped to those tested objects and do not replace review of the current plan, geometry, or manufacturing output.

### 10. Pad expansion and net-name silkscreen text

Use `pcb.getPadExpansionPlan` / `pcb.expandPads` to plan and perform pad expansion. Use `pcb.getNetSilkscreenPlan` / `pcb.generateNetSilkscreen` to create editable silkscreen text for pad nets. Supported shapes, region splitting and persistence limits for expansion, and placement and clearance limits for net text are described in [Geometry command details](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/commands-pcb-special.md). These features do not replace checks of the actual graphics, clearances, or manufacturing output.

## Operation demonstrations

Both animations were recorded with extension v0.10.89 and EDA Pro 4.1.60. They demonstrate existing operations and are not acceptance records for v0.20.50.

### Schematic: multi-pin MCU, supporting parts, short wires, and labels

![48-pin MCU schematic: place supporting parts, add short wires, align net labels, and check after save and reopen](images/demo-schematic.gif)

The demonstration draws an STM32F103C8T6 and six supporting components. Short wires connect the reset and BOOT0 branches; equal-length short stubs extend from the other pins, and net labels are aligned in columns. After saving and reopening, **all 57 labels remained attached and the 60 pin-to-net memberships remained consistent**. This demonstrates drawing operations; it is not a complete MCU minimum system. The DRC reported 0 fatal errors and 37 warnings. Recorded with extension v0.10.89 and EDA Pro 4.1.60. See [steps and verification details](docs/DEMO-SCHEMATIC.md).

### PCB: board outline, tracks, vias, and copper

![AI-directed PCB drawing: board outline, tracks, vias, copper, and checks after save and reopen](images/demo-pcb.gif)

In a separate demonstration PCB, AI commands create a board outline, draw top-layer tracks, place a via and continue routing on the bottom layer, create and rebuild a copper area, then save, close, reopen, and read back the results. After reopening, **six track segments were read back and the copper area was filled**.

The animation uses screenshots from real EDA operations; command descriptions are later-added captions. Account details and the project list were cropped out. A GND pad and net were set up in advance. This is a feature demonstration board, not a complete circuit design. It was recorded on **2026-10-09 with extension v0.10.89 and EDA Pro 4.1.60**; verification applies only to the demonstration objects described. The animation is about 18 seconds long. See the [demonstration notes](docs/DEMO.md) for steps and verification scope.

## Before installation

**You must separately install Node.js >=20.17.0, the local command proxy, and the AI skill.** Installing the extension from the marketplace does not install or start the proxy, or install the skill for you. After enabling the extension, allow external interaction in EDA, start the local proxy, install the corresponding skill, and check the connection target.

The extension, proxy, and AI skill are installed separately. The proxy runs locally by default at `http://127.0.0.1:49720`. An optional issue-reporting tool can collect the information needed for a report and submit a GitHub Issue using the user’s authenticated local [GitHub CLI](https://cli.github.com/). The AI informs the user before submission. Issue reporting is never triggered automatically by an EDA command and does not upload project data in the background.

## Release status

The original plugin repository's current formal release is **v0.20.50**. This documentation split does not change plugin functionality or its release version. The v0.20.50 package has not been reinstalled for host verification. The marketplace listing and version can change; check the [marketplace page](https://lceda.cn/page/extensions) for its current status. See the [v0.20.50 release notes](docs/releases/v0.20.50.md) and [Chinese release notes](docs/releases/v0.20.50_ZH.md) for the preserved feature history and verification scope.

Current compatibility and operation boundaries include:

- On EDA 4.1.78, 14 commands requiring EDA 4.2 are disabled and rejected at the version boundary. Positive execution and persistence on EDA 4.2 have not been accepted.
- `routeTrack` and SES segment inputs are subject to a plugin policy that rejects any segment shorter than 1 mil before writing. This is not an SDK minimum-length limit.
- `pcb.connectComponentPadDirect` is temporarily disabled; the compatibility entry point rejects calls before project or SDK access.
- `modifyPour` requests that change a pour's net or name are rejected before writing. Automatic autorouter SES reinjection is disabled; review and explicit import remain separate steps.

These controls and scoped checks do not mean that all underlying issues, geometry, copper-fill results, or persistence behavior are fixed. See the release notes for the limits and evidence scope.

The “little robot drawing a circuit board” shown on the page is the project logo. The marketplace icon file is `images/logo-marketplace.png`.

## Downloads and installation

The plugin repository provides the extension package and the source needed to run the local Node proxy. Its formal v0.20.50 release contains the plugin package and a source ZIP; the source repository does not provide the complete AI skill. Historical tag archives may contain earlier skill files. The current main-branch source ZIP contains the plugin/proxy and migration documentation only. Local candidate v0.20.124 has not been published and is not a download option.

- [Plugin GitHub Releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases): extension package and plugin/proxy source ZIP.
- [Standalone skill repository](https://github.com/quhuii-lgtm/easyeda-aicommand-skill): skill documentation.
- [Latest standalone skill release](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/latest): download the skill ZIP, then install its complete `ai-command-engine/` directory.
- [Skill entry on main](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/SKILL.md).

The skill repository uses its own date-based versions; the current split is dated 2026.10.28. Skill versioning is independent of plugin releases. The English `SKILL.md` and Chinese `SKILL_ZH.md` share one installed directory; keep `references/zh/` and scripts. Do not copy a skills directory from the plugin repository.

The extension, proxy, and AI skill are separate installs. Follow the [installation and usage guide](docs/QUICKSTART.md) for the Node.js proxy. The extension marketplace does not install the proxy or AI skill.
## First use

Follow the [installation and usage guide](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md) to install Node.js and proxy dependencies, install the EDA extension, allow external interaction, perform the first read-only check, and install the AI skill. To run the proxy, execute these commands in the repository directory:

```powershell
git clone https://github.com/quhuii-lgtm/easyeda-aicommand.git
Set-Location easyeda-aicommand
npm ci
node bridge/command-proxy.mjs
```

If you downloaded a ZIP, run `npm ci` and `node bridge/command-proxy.mjs` from the extracted repository directory. Keep the proxy terminal open. Then download the `.eext` package from [Releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases), import and enable it in the EDA extension manager, and allow external interaction. Download the complete `ai-command-engine/` directory from the [standalone skill repository](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/latest) and install it in your AI tool skill directory, then use the Chinese EDA menu AI 指令引擎 → 启动桥接. Installing the extension does not deploy the proxy locally or install the skill in your AI tool. See the [first-use guide](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md) for complete instructions.

Windows users can optionally start the proxy through a URL protocol. See the [bridge lifecycle documentation](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/BRIDGE-LIFECYCLE.md) for registration and lifecycle details. GitHub CLI is not needed for ordinary use; it is needed only if you choose the optional issue-reporting feature. SMT parts lookup also requires [JLC Open Platform](https://open.jlc.com) credentials; see the [parts lookup guide](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md#5-可选-smt-物料查询).

## Safety and verification limits

- Every `/command` request must include a top-level `instanceId`. First query the connections and confirm the target window. For schematic-page operations, also confirm the page identity.
- A write timeout does not mean the operation was cancelled. If the result is unknown or the document is write-protected, verify using read-only operations before proceeding; do not retry blindly.
- Plugin/API responses, readback after saving, readback after closing and reopening, and manufacturing acceptance are different levels of evidence. A successful command, DRC result, or simulation regression alone does not prove that a circuit is correct.
- Issue reports use only necessary evidence that has already been obtained and can be made public. Inform the user before submission. GitHub CLI, issue creation, and sign-in are optional. The submission entry point is [GitHub Issues](https://github.com/quhuii-lgtm/easyeda-aicommand/issues).

## Developer resources

See the [plugin repository](https://github.com/quhuii-lgtm/easyeda-aicommand) for plugin source and the Node proxy; use the [standalone skill repository](https://github.com/quhuii-lgtm/easyeda-aicommand-skill) for the complete AI skill. Local regression, build, and host verification details are stated separately in the relevant release notes. See the project [CHANGELOG](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/CHANGELOG.md) and [SDK changelog](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/SDK-CHANGELOG.md) for project and build-framework history.

[Apache-2.0 License](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/LICENSE).
