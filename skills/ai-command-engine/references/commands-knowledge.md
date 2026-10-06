### 知识库

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `knowledge.query` | 检索布线规则/经验 | `query`, `limit?` |
| `knowledge.listRules` | 列出全部规则主题 | 无 |
| `knowledge.widthForCurrent` | 载流→线宽换算 | `currentA` |

## 嘉立创开放平台（代理本地执行，无需 EDA 在线）

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `smt.queryComponent` | 查询 SMT 可贴装物料 | `queryString`, `pageNum?`, `pageSize?` |

- 返回 `components[].code` 即立创编号，可直接用于 `schematic.placeDevice`。
- 首次使用：让用户打开 `http://127.0.0.1:49720/smt` 填 appId / accessKey / secretKey（存于 `bridge/jlc-credentials.json`，升级不丢失）；该页面也支持人工查询。

