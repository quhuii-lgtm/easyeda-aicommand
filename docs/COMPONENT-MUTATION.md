# 原理图器件属性修改与移动

## 完整属性修改

使用 `schematic.modifyComponent` 修改原理图器件属性。`params` 需要提供器件 `primitiveId` 和完整的 `property` 对象。在 EDA 4.1.60 的实测中，`sch_PrimitiveComponent.modify` 省略 `otherProperty` 会清空该属性表。为避免不完整属性对象造成数据丢失，封装统一要求下面 14 项全部作为对象自有字段明确提供：

`x`、`y`、`rotation`、`mirror`、`addIntoBom`、`addIntoPcb`、`designator`、`name`、`uniqueId`、`manufacturer`、`manufacturerId`、`supplier`、`supplierId`、`otherProperty`。

坐标和角度必须是有限数值；镜像、BOM、PCB 开关必须是布尔值；位号、名称、唯一 ID、厂家和供应商字段必须是字符串或 `null`。`otherProperty` 必须是对象，其中每项只能是字符串、布尔值或有限数值。它必须包含器件当前已有的全部键，可以增加新键；缺少旧键时命令在写入前拒绝，不会替用户补字段。

例如：

```json
{
  "cmd": "schematic.modifyComponent",
  "params": {
    "primitiveId": "gge123",
    "property": {
      "x": 400,
      "y": 300,
      "rotation": 0,
      "mirror": false,
      "addIntoBom": true,
      "addIntoPcb": true,
      "designator": "R4",
      "name": "Resistor",
      "uniqueId": "component-uuid",
      "manufacturer": null,
      "manufacturerId": null,
      "supplier": null,
      "supplierId": null,
      "otherProperty": { "Resistance": "10k", "Tolerance": "1%" }
    }
  }
}
```

命令只调用一次官方 `modify`，随后读回全部请求字段和 `otherProperty` 键值。null 字段按官方空值读回语义允许表现为空字符串或 `undefined`。属性不符、器件读回失败，或操作前后焦点图页/所属工程变化时，命令报错；若官方写入已经尝试，错误会带 `cause.partial: true`、`cause.retryable: false`。这表示结果可能已部分写入，调用方应先检查图页状态再决定后续操作。

## 安全移动

只移动、旋转或镜像时使用 `schematic.moveComponent`。它通过当前器件对象的 `toAsync()`，只设置请求中提供的 `x`、`y`、`rotation`、`mirror`，再调用一次 `done()`。读回会核对请求几何、未请求的几何，以及名称、位号、唯一 ID、库器件/符号/封装关联、BOM/PCB 设置、网络、子部件名、厂家/供应商和 `otherProperty`。

```json
{
  "cmd": "schematic.moveComponent",
  "params": { "primitiveId": "gge123", "x": 500, "y": 350 }
}
```

`schematic.autoLayout` 使用同一移动路径。它在规划开始时记录图页和工程 UUID，后续每次移动都检查这两个身份；任何一次移动读回失败都会停止剩余移动和布线步骤。错误会包含已完成移动清单，并在已有写入或写入结果不确定时标记 `partial`。
