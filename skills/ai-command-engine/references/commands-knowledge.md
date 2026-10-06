### 知识库

> 本页表格/参数对象描述命令及 `params`，不是完整 HTTP 请求。发送 `/command` 时外层必须带 `cmd`、顶层 `instanceId` 和所需 `params`；宏仅外层路由，步骤继承实例。完整示例见 [setup](setup.md)。

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
- 首次使用：让用户打开 `http://127.0.0.1:49720/smt` 填 appId / accessKey / secretKey（存于 `bridge/jlc-credentials.json`，升级不丢失，保存即时生效不用重启代理）；该页面也支持人工查询。
- **密钥获取**（遇到"未配置嘉立创开放平台密钥"报错时引导用户）：https://open.jlc.com → 登录嘉立创账号 →「快速接入」→「创建应用」，一键生成三件套（appId / accessKey / secretKey），约 1 分钟；密钥只存本机（代理目录 jlc-credentials.json，.gitignore 已排除），勿提交 git、勿外发。
