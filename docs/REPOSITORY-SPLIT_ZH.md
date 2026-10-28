# 插件与技能分仓库发布

[English](REPOSITORY-SPLIT.md)

[原插件仓库](https://github.com/quhuii-lgtm/easyeda-aicommand)只维护扩展源码、Node.js代理、构建配置、测试和插件说明；[独立技能仓库](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)只维护完整 `ai-command-engine/` 技能、英文说明、中文备用、参考文件和助手脚本。技能不包含扩展或代理程序。

插件继续使用自身版本号，如 `0.20.50`；技能使用独立日期版本，从 `2026.10.28` 开始。技能更新不等于插件升级或新增运行能力。技能文档包含123的限定实机记录与124准备修正，但124尚未公开发布或进行新版宿主验收。实际可用指令以连接实例的版本和帮助为准。

插件eext及源码ZIP从原仓库下载，技能ZIP从技能仓库下载。技能必须安装完整 `ai-command-engine/` 目录。安装技能不会自动安装Node.js、启动代理、安装扩展或修改工程。

旧提交、标签、Release与附件保持。旧发布可能包含捆绑技能，属于历史快照。当前原仓库 `skills/` 和根 `SKILL.md` 只保留迁移导航，不进入新扩展包和独立源码附件。旧深层文件可在历史标签读取；新安装入口在技能仓库。此次整理没有改变插件运行代码或代理行为。

## 独立打包

插件仓库安装锁定依赖后执行 `npm run package:source`，在 `build/dist/` 生成插件及代理源码ZIP，排除技能、迁移导航、已安装依赖和构建输出。`npm run build` 继续生成EDA扩展包，不再捆绑技能。

技能仓库执行 `python tools/package-skill.py`，在 `dist/` 生成技能ZIP及校验值，版本读取 `ai-command-engine/VERSION`；插件版本仍读取 `extension.json`。只有该打包工具需要Python，安装技能及直接HTTP操作不要求Python。
