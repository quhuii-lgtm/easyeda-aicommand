# Separate plugin and skill repositories

[简体中文](REPOSITORY-SPLIT_ZH.md)

The [plugin repository](https://github.com/quhuii-lgtm/easyeda-aicommand) contains extension source, the Node.js proxy, build inputs, tests, and plugin documentation. The [skill repository](https://github.com/quhuii-lgtm/easyeda-aicommand-skill) contains the installable `ai-command-engine/` directory, its English instructions, Chinese fallback, references and helper scripts. The skill does not include the EDA extension or proxy.

Plugin versions continue to use their extension version, such as `0.20.50`. Skill versions use an independent documentation date, starting with `2026.10.28`. Updating documentation does not imply a new plugin build, new runtime capabilities, or host acceptance. The skill documentation includes scoped v0.20.123 evidence and v0.20.124 prepared changes; v0.20.124 has not been installed or host-accepted; its publication status is shown on the [release page](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.124). Always inspect the connected instance and its help.

Download plugin `.eext` and plugin-source ZIP files from this repository. Download skill ZIP files from the skill repository. Install the entire `ai-command-engine/` directory. Installing a skill does not install Node.js, start the proxy, install the EDA extension, or modify a design.

Existing tags, commits, releases, and their attachments are retained. Old releases may contain bundled skills; they are historical snapshots. The current `skills/` and root `SKILL.md` contain only migration notices and are excluded from future extension/source release packages. Old deep links can be read at their historical tag; the new install location is in the skill repository. Plugin code and proxy behavior did not change as part of the split.

## Independent packaging

In the plugin repository, install its locked dependencies and run `npm run package:source` to create a plugin/proxy-source ZIP under `build/dist/`. It excludes the skill, migration stubs, installed dependencies and build output. `npm run build` continues to build the EDA extension and excludes skill content.

In the skill repository, run `python tools/package-skill.py` to create the skill-only ZIP and its checksum under `dist/`. The ZIP version comes from `ai-command-engine/VERSION`; plugin versions still come from `extension.json`. The packaging tool needs Python, while installing the skill and direct HTTP operation do not require Python.
