# 工程与板子管理指令（project.*，0.10.37 共 23 条）

> 本页表格/参数对象描述命令及 `params`，不是完整 HTTP 请求。发送 `/command` 时外层必须带 `cmd`、顶层 `instanceId` 和所需 `params`；宏仅外层路由，步骤继承实例。完整示例见 [setup](setup.md)。

工程/板子/图页的创建、复制、删除、关联。文档树 uuid 一律从 `project.getInfo` 读，不猜。

## 工程级

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `project.getInfo` | 当前工程信息（名称+文档树 uuid） | 无 |
| `project.getInfoOf` | 指定工程信息 | `projectUuid` |
| `project.list` | 全部工程（`detail:true` 逐个查信息，较慢） | `detail?` |
| `project.create` | 新建工程 | `name`, `projectName?`（英文内部名）, `description?` |
| `project.open` | 打开指定工程（切换当前工程）。⚠️ **当前工程有未保存修改时官方直接返回失败**（"工程打开失败"）——先 `schematic.save` 再切 | `projectUuid` |
| `project.moveToFolder` | 移动工程到文件夹（留空=根目录） | `projectUuid`, `folderUuid?` |
| `project.exportFile` | 导出 .epro/.epro2（base64 自行落盘做备份/迁移） | `fileName?`, `fileType?`(epro\|epro2) |
| `project.importFile` | 导入外部文件成新工程（0.10.35；.PcbDoc/.SchDoc/.epro 等 fileType 自动推断；缺省自动取当前团队走 New Project） | `base64`, `fileName`, `fileType?`, `newProjectName?` |
| `project.getDocumentSource` | 读当前激活文档源数据 JSON（只读整体分析，比逐个查图元快） | 无 |
| `project.modifyTitleBlock` | 改标题栏（⚠️ data 键必须是图框已存在字段，先 getPageInfo 查 titleBlockData；Page Size/Symbol 不能接口切换） | `showTitleBlock?`, `data?` |

## 板子（Board）与关联

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `project.getBoardInfo` | 当前板子信息与原理图/PCB 关联状态；`pcb.importChanges` 返回 false 时用它排查游离 PCB | 无 |
| `project.associateBoard` | 关联原理图+PCB 到板子（修复游离 PCB） | `schematicUuid`, `pcbUuid` |
| `project.copyBoard` | 复制板子 | `boardName` |
| `project.deleteBoard` | 删除板子 | `boardName` |
| `project.renameBoard` | 重命名板子（⚠️ 按名字匹配，重名会改错——先 getBoardInfo 确认） | `boardName`, `newName` |

## 原理图与图页

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `project.createSchematic` | 新建原理图（`boardName` 必须是已存在板子名；新建省略后用 associateBoard 关联） | `boardName?` |
| `project.createSchematicPage` | 指定原理图下新建图页（uuid 是 Schematic 节点，非图页） | `schematicUuid` |
| `project.deleteSchematicPage` | 删图页 | `pageUuid` |
| `project.copySchematicPage` | 复制图页（留空=同原理图内；0.10.37 起复制后读回验证，返回 name/parentSchematicUuid/sourcePageUuid，归属异常带 warning；新页名官方自动派生"源名_N"属正常） | `pageUuid`, `schematicUuid?` |
| `project.renameSchematicPage` | 按 UUID 改图页名（0.10.59 加固：改名前后快照比对，renamed 只信快照）。⚠️ 目标页**须在本窗口打开激活、且所在文档在本窗口 save 过一次**，否则官方假失败；全新窗口从未改过页名时其他窗口的旧页会被永远拒绝——对本窗口新建页成功改名一次即解锁 | `pageUuid`, `name` |
| `project.listSchematicPages` | 列全部图页 | 无 |
| `project.reorderSchematicPages` | 调图页顺序（⚠️ 须包含全部图页） | `schematicUuid`, `pageUuids[]` |

## PCB

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `project.createPcb` | 新建 PCB（boardName 规则同上） | `boardName?` |
| `project.copyPcb` | 复制 PCB | `pcbUuid`, `boardName?` |
| `project.deletePcb` | 删除 PCB | `pcbUuid` |
| `project.listPcbs` | 列全部 PCB | 无 |
