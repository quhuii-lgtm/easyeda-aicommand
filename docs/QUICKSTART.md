# First installation and use

English | [简体中文](QUICKSTART_ZH.md)

Updated: 2026-10-28.

GitHub Release v0.20.124 was published on 2026-10-28. Its three final fixes and help correction have local regression, type-check, and production-config compilation evidence, but have not been installed for EDA host acceptance. Existing major-feature acceptance remains based on installed v0.20.123 and applicable earlier records; see the [release notes](releases/v0.20.124-en.md).

Install the EDA extension, the local Node.js proxy, and the complete AI skill separately. The extension does not install Node.js, proxy dependencies, or the AI skill. The proxy requires Node.js >=20.17.0 and the full source repository; run `npm ci` and `node bridge/command-proxy.mjs` from that source. Download skill v2026.10.28.2 from the [skill release page](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.28.2) or the [complete ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.28.2/ai-command-engine-skill_v2026.10.28.2_en-zh.zip). Plugin and skill have independent version numbers; compare the skill's relevant command help with the plugin functionality.

## First-time setup prompt

You can copy the [first-install prompt](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/README.md#first-installation-ask-your-ai-to-set-up-and-connect) into an AI coding tool that can access local files and run terminal commands. It walks through environment checks, source setup, proxy startup, EDA extension enablement, skill installation, and a read-only connection check.

## 1. Get the complete source and install proxy dependencies

Download the complete repository from the [public GitHub repository](https://github.com/quhuii-lgtm/easyeda-aicommand), or clone it:

```powershell
git clone https://github.com/quhuii-lgtm/easyeda-aicommand.git
Set-Location easyeda-aicommand
npm ci
node bridge/command-proxy.mjs
```

Use Node.js >=20.17.0. For a ZIP download, run `npm ci` and the proxy command from the extracted source root. Keep the proxy terminal available. Do not use `--omit=dev`.

## 2. Install and connect the EDA extension

Download `ai-command-engine_v0.20.124_en.eext` or `ai-command-engine_v0.20.124_zh-CN.eext` from the [v0.20.124 GitHub Release](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.124), then import and enable it in JLCEDA Pro. Allow external interaction and open a trial project. In EDA, choose “AI Command Engine → Start bridge” (“AI 指令引擎 → 启动桥接” in Chinese).

The extension does not install or start the proxy, and it does not install the AI skill.

## 3. Verify the connection with a read-only call

Check `http://127.0.0.1:49720/health`, then query `GET /connections`. Verify the extension version and project identity. If multiple instances are listed, use the intended instance; do not choose the first automatically.

Send `POST /command` with the selected `instanceId` at the top level and call `project.getInfo`. Confirm the JSON response has `ok: true` and identifies the intended project. HTTP 200 alone does not prove success. Use the selected instance's command help rather than guessing parameters.

Do not create or modify a circuit during this first connection check.

## 4. Install the AI skill

Download [skill v2026.10.28.2](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.28.2) or its [complete ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.28.2/ai-command-engine-skill_v2026.10.28.2_en-zh.zip). Extract and install the complete `ai-command-engine/` folder in the AI tool's skill directory. Preserve English `SKILL.md`, alternate Chinese `SKILL_ZH.md`, `references/`, `scripts/`, and `VERSION`. Reload the AI tool, ask it to read `SKILL.md`, and confirm the skill version. Do not install only a repository-root `SKILL.md`; it is a navigation file. The skill version is independent of the plugin version, so check relevant functionality and help rather than matching version numbers.

Inspect an existing skill directory and preserve personal changes before updating it. Follow the AI tool's own skill installation procedure.

## 5. Optional SMT component lookup

Only `smt.queryComponent` requires credentials from the [JLC Open Platform](https://open.jlc.com). With the proxy running, open `http://127.0.0.1:49720/smt` and configure the app ID, access key, and secret key. Ordinary schematic and PCB operations do not require these credentials. Do not upload or paste credentials into issue reports.

## Troubleshooting

- If `/health` is unavailable, check that the proxy is running from the complete source tree and that its dependencies installed successfully.
- If `/connections` has no intended instance, check extension enablement, external interaction permission, and “Start Bridge” in EDA.
- If the port is occupied, identify the process before taking action. Do not stop an unknown process or change the port automatically.
- If a command result is uncertain after a timeout, read the current state before retrying a write.

## Upgrade, stop, and uninstall

Use the same complete source repository and version-matched skill for upgrades. Back up personal changes before replacing files. Stop the proxy from the terminal where it was started. Remove the extension through EDA's extension manager and remove the installed skill through the AI tool's skill manager.

## Feedback and verification limits

Report the operating system, EDA and extension versions, Node version, repository revision, steps to reproduce, and a sanitized error in [GitHub Issues](https://github.com/quhuii-lgtm/easyeda-aicommand/issues). Check logs and screenshots for project or personal information before sharing.

A read-only connection check does not verify drawing. API success, save/readback, close/reopen persistence, DRC, and production acceptance are separate checks.
