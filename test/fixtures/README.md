# 回归测试样本

这里保存回归测试实际读取的设计源记录和制造几何。测试从仓库内读取，不依赖同级开发目录。

- `b2-native-rangeA.dsn`：DSN 物理焊盘形状选择样本，保留原始文件字节。
- `ses-arc-*`：ARC 导出覆盖与 SES 重复导入测试样本。源记录仅保留 `result.data.source`；布线基线仅保留 `result.data.routeBaseline`。
- `silkscreen-gerber-*`：丝印 Gerber 解析样本，仅包含测试读取的顶／底丝印、顶／底阻焊和板框层。订单、钻孔和其他生产附件未纳入。
- `footprint-*`：封装丝印几何测试样本。源记录保留回归使用的源文本；几何预期仅保留实际比较的字段。
- `silkscreen-source-*`：丝印源记录比较样本，保留 `result.data.source`。
- `manifest.json`：记录样本来源、源文件 SHA-256、样本 SHA-256 和字段提取范围。运行日志中的请求、实例和时间信息已去除。

准备方式：从项目独立验收资料提取上述字段，DSN、SES 与 Gerber 几何样本保留原始几何；只将运行时 JSON 外层包装移除。各文件的来源与校验值见清单。

运行回归：在仓库根目录执行 `node test/<回归脚本名>.mjs`。部分测试使用 `esbuild`、`jszip` 和 `typescript`，先按锁文件安装项目依赖。

其他本机验收样本已抽取到本目录：DSN/SES、原理图源码和读回模型、走线规则与过孔端点。JSON 仅保留测试读取的源码、模型或请求参数；原始哈希与样本哈希见 `manifest.json`。

- `regression-baselines/`：冻结的处理器负对照，仅供对应回归测试使用，不参与生产构建。
