# 符号/封装/器件库管理指令（lib.*，0.10.34 共 22 条）

> 本页表格/参数对象描述命令及 `params`，不是完整 HTTP 请求。发送 `/command` 时外层必须带 `cmd`、顶层 `instanceId` 和所需 `params`；宏仅外层路由，步骤继承实例。完整示例见 [setup](setup.md)。

个人库（默认）与系统库的元件库 CRUD。官方默认搜系统库，**本组指令默认个人库**（libraryUuid 留空=个人库）。

## 通用模式

三组（symbol/footprint/device）结构同构：`Create`（建空白→返回读回属性含 uuid）/ `UpdateSource`（源码写回）/ `Search`（空关键字列全部，`key`/`classification`/`page`/`itemsOfPage`）/ `Get` / `Copy`（目标库重名失败，`targetLibraryUuid` 必填）/ `Modify`（属性值设 null=清除）/ `Delete`。Search 返回 `[{uuid, name, description, ...}]`。

| 指令 | 说明 | 必填参数 |
| --- | --- | --- |
| `lib.symbolCreate` | 建空白符号 | `name`；`symbolType?`（ELIB_SymbolType，如 2）、`classification?`、`otherProperty?` |
| `lib.symbolUpdateSource` | 符号文档源码写回库 | `symbolUuid`, `documentSource` |
| `lib.symbolSearch` / `symbolGet` / `symbolCopy` / `symbolModify` / `symbolDelete` | 同构五件套 | search: 无必填；get/delete: `symbolUuid`；copy: +`targetLibraryUuid` |
| `lib.footprintCreate` / `footprintUpdateSource` / `footprintSearch` / `footprintGet` / `footprintCopy` / `footprintModify` / `footprintDelete` | 封装同构七件套 | 同上（uuid 名为 footprintUuid） |
| `lib.deviceCreate` | **组装器件**：已有符号+封装(+3D) 绑成完整器件（不绑符号无法创建） | `name`, `symbolUuid`（必填）；`footprintUuid?`、`model3DUuid?`、`property?`（designator/addIntoBom/addIntoPcb/manufacturer/supplier 等） |
| `lib.deviceSearch` / `deviceGet` / `deviceGetByLcscIds` / `deviceCopy` / `deviceModify` / `deviceDelete` | 器件六件套 | get/delete: `deviceUuid`；copy: +`targetLibraryUuid` |
| `lib.symbolOpenInEditor` / `lib.footprintOpenInEditor` | 在符号/封装编辑器中打开库元件（编辑内容用；打开后配合 project.getDocumentSource 读源码） | `symbolUuid*`/`footprintUuid*`，`libraryUuid?` |

特例：

- `lib.deviceGetByLcscIds`：`lcscIds` 支持单值或数组批量查（如 "C1523" 或 ["C1523","C17168"]）；`allowMultiMatch?` 同 C 号多匹配时全返回。⚠️ 私有化部署环境不可用。
- `lib.deviceModify` 支持改绑：`symbolUuid`/`footprintUuid` 换绑，`property` 改 designator/manufacturer/supplier 等。

⚠️ 要点：

- 库 UUID 来源：`cbb.listLibraries`（个人库/系统库同一套 UUID）。
- 普通放置别走这里：从立创商城选料用 `library.searchDevice`/`library.getDeviceByLcsc`（工程内放置）；本组管的是**自建库元件**的沉淀与维护。
- 建库流程：symbolCreate →（在编辑器画）→ symbolUpdateSource 写回 → footprint 同理 → deviceCreate 组装绑定 → 之后 `library.searchDevice` 能在工程里搜到。

## 工程内选料（官方库，非自建）

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `library.searchDevice` | 搜索器件库（立创商城料） | `keyword`, `limit?` |
| `library.getDeviceByLcsc` | 按立创编号查器件 | `lcscId` |
