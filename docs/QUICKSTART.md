# First installation · EDA 0.21.22 / AI packages

## Three packages and installation

| Package | Purpose and download | Install into |
| --- | --- | --- |
| EDA extension 0.21.22 `.eext` | [GitHub extension release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.22) or the [JLCEDA marketplace](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine) | JLCEDA Professional |
| Standalone bilingual skill 2026.11.24.1 | [Complete skill ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.24.1/ai-command-engine-skill_v2026.11.24.1_en-zh.zip) | Your AI tool's skill directory |
| Portable AI companion plugin 0.1.0 | [Portable plugin ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.24.1/ai-command-engine-companion_v0.1.0_portable.zip) | An AI client with local plugin/skill import |

**Install the EDA extension first. For AI access, choose either the standalone skill or the AI companion plugin.** Marketplace installation does not install either AI ZIP, Node.js or proxy dependencies.

1. Install the EDA extension from the marketplace, or download `.eext` and use EDA's Advanced → Extension Manager → Import, then enable it and allow external interaction. Check the actual marketplace approval state.
2. Standalone route: extract and install the complete `ai-command-engine/` folder in your AI tool's skill directory. Keep scripts, references and personal settings, then reload the skill.
3. Companion route: extract and import the root using the client's supported local-plugin mechanism. A skill-only client can import the packaged `skills/` directories using its skill mechanism. Preserve existing global instructions. Merging the extra collaboration policy into unrelated tasks is a user choice.
4. Use Node.js >=20.17.0 on the computer running EDA. Run `npm ci --omit=dev` in standalone `ai-command-engine/` or companion `skills/ai-command-engine/`. Use the complete included proxy rather than copying a generic `bridge/` script from the source repository.
5. Ask AI to read the chosen skill and connection guide, start the proxy in the background, and verify the actual EDA instance, project and drawing with a read-only query before editing. On Windows follow the guide for `scripts/start-proxy.ps1` and use its returned endpoint. Do not terminate an existing shared bridge merely to check a package.

The companion plugin 0.1.0 is offline-package checked only; **installation in Codex, Claude, Kimi and OpenCode has not been tested**. Compatibility manifests do not establish working host installations. Its embedded skill version marker is 2026.11.22.3; the standalone skill is 2026.11.24.1. Shared runtime scripts and references match, while plugin entry points additionally load collaboration rules. Versions are managed separately.

See the [first-install guide](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md). SMT platform queries require separate credentials; ordinary drawing does not. Preserve personal settings, projects and in-flight tasks. File updates do not replace a running old proxy automatically. Marketplace approval/public versions can differ from GitHub.
