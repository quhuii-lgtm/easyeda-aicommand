# 复用模块指令（cbb.*，0.10.34 共 12 条）

复用模块（CBB，官方"模块"功能）的库管理、放置与导出。库 UUID 一律先 `cbb.listLibraries` 获取（system/personal/project/favorite 四类）；官方默认搜系统库，个人库是自己沉淀的模块。

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `cbb.listLibraries` | 四类库 UUID（其他 cbb.* 的 libraryUuid 来源） | 无 |
| `cbb.search` | 搜模块（空关键字列全部） | `key?`, `libraryUuid?`, `page?`, `itemsOfPage?` |
| `cbb.get` | 模块详细属性 | `cbbUuid`, `libraryUuid?` |
| `cbb.create` | 指定库建空白模块工程（之后 openProject 打开往里画） | `libraryUuid`, `name`, `description?` |
| `cbb.copy` | 模块复制到另一库（如官方模块复制到个人库再改造；目标库重名失败） | `cbbUuid`, `libraryUuid`, `targetLibraryUuid`, `newName?` |
| `cbb.delete` | 删模块 | `cbbUuid`, `libraryUuid` |
| `cbb.openProject` | ⚠️ 打开模块工程（**会切换当前工程，未保存修改丢失**；打开后 editor.listTabs 拿图页/PCB uuid） | `cbbUuid`, `libraryUuid` |
| `cbb.placeSymbol` | 当前原理图放模块符号（层次化设计入口；SCH 坐标 10mil 单位、需 5 的倍数） | `libraryUuid`, `cbbUuid`, `x`, `y`, `rotation?`, `mirror?` |
| `cbb.placeSchematicPage` | 把模块的原理图图页内容铺进当前图页（uuid 先 openProject+listTabs 获取） | `libraryUuid`, `cbbUuid`, `uuid`, `x`, `y`, `reimportWhenNameRepeated?` |
| `cbb.placePcb` | **复用价值最大的一条**：把模块的 PCB（含布局布线）整体铺进当前 PCB——电源/最小系统等成熟布局直接搬入（坐标 mil） | `libraryUuid`, `cbbUuid`, `uuid`, `x`, `y`, `reimportWhenNameRepeated?` |
| `cbb.openSymbolInEditor` | 打开模块符号编辑（⚠️ 须先 openProject） | `cbbUuid`, `libraryUuid`, `splitScreenId?` |
| `cbb.exportFile` | 导出模块为 epro（base64；需团队模块下载权限） | `cbbUuid`, `libraryUuid?`, `fileName?` |

⚠️ 要点：

- `cbb.openProject`/`cbb.openSymbolInEditor` 会切工程/焦点，用完回自己工程要重新 `editor.openDocument` 激活。
- `reimportWhenNameRepeated` 默认 true：重名模块重新引入而不是复用旧实例；跨板重复放置同模块时留意网络命名。
- 放置后读回核对：`cbb.placePcb` 后用 `pcb.listComponents`+`getComponentPads` 审计网络。
