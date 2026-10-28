# 更新日志

## 2026-10-28 — Separate source and skill distribution / 源码与技能分开发布

- Move the installable AI skill to [its own repository](https://github.com/quhuii-lgtm/easyeda-aicommand-skill), with independent documentation versions and skill-only ZIPs.
- Keep plugin source and the proxy here. Exclude skill contents and migration notices from new plugin/source packages; preserve existing tags and release assets.
- Update installation and migration links. This is a repository/documentation change, not a plugin runtime version change. See [migration notes](docs/REPOSITORY-SPLIT.md).
- 完整技能迁至独立仓库，使用自己的文档版本和ZIP；原仓库仅维护插件及代理，旧标签和附件保留。此次不修改插件运行程序。详见[中文迁移说明](docs/REPOSITORY-SPLIT_ZH.md)。


## 0.20.50 — 中文正式发布

0.20.50 是中文菜单与文档打包版，核心逻辑继承 0.20.49，本版不新增核心写入功能。以下内容汇总 0.20.11–0.20.49 期间完成的修正和已明确的能力边界；本次发布包尚未在 EDA 中重新安装实测。

- 参数与结果处理：补充无效参数预检、SDK 失败结果处理及写后读回。写入结果不明确时明确报告部分状态并停止依赖操作，不自动重试或把空结果当作成功。
- PCB 走线保护：对 `routeTrack` 和相关自动布线段执行 1 mil 最短长度写前检查。短于策略值的输入整批拒绝；这是插件保护策略，不代表 SDK 的最小长度限制。
- 工程导入与复制：在线 `.epro2` 导入可使用根 `project2.json` 的 `title` 派生工程名，并传递 `description`，保留空白和换行。原理图页复制继续保留；SDK 未给出可接受的新 UUID 时报告失败证据，不重试。离线导入与其他格式不因本项改变。
- PCB 变更边界：`modifyPour` 对改网、改名请求在写入前拒绝，不用删除重建冒充无损替代。自动布线结果不再自动回灌；需检查外部结果时使用明确的导入流程。参数读回与部分状态仍须逐项核对。
- 兼容与诊断：当前 EDA 4.1.78 的 14 条 4.2+ 指令暂停使用，并在执行前提示版本边界，4.2 正向能力尚未验收。保留铜皮规则、焊盘热焊配置等只读诊断；单位或实际规则选择未知时不作推断，并同步更新自有技能说明。
- 焊盘直连：因当前实测宿主的公开接口无法可靠读回配置，`pcb.connectComponentPadDirect` 暂时停用；兼容入口会在访问工程或 SDK 前拒绝。该结论不表示所有版本的 setter 都失效，也不代表小铜区未接触焊盘的问题已解决。

本版本收录的是分项验证结果与防护，不表示所有底层问题、几何结果或持久性问题均已修复。实际覆铜接触和保存重开仍需分别核验。
