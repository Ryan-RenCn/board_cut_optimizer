# Rust 原生版功能与验证

仓库仅保留 Rust 原生实现。旧网页/Electron 源码、启动入口、依赖、测试和安装包已移除；运行、构建与测试均不需要 Node.js。应用使用 Rust + egui + SQLite，没有 WebView 或 HTTP 服务。

## 自动回归覆盖

| 能力 | 实现 / 测试 |
|---|---|
| 数据模型、历史字段与数量校验 | src/model.rs、tests/engine_parity.rs、tests/storage_compat.rs |
| MaxRects、束搜索、锯缝、整板、重复排版 | src/engine.rs、src/beam_nesting.rs、tests/engine_parity.rs |
| 批量旋转、单件覆盖、保存后恢复 | tests/rotation.rs；快速/深度、普通件/整板、贴合/束搜索均覆盖 |
| 阶梯计费、损耗、利润、加工费、税率与物流 | src/pricing.rs、src/logistics.rs、tests/pricing_parity.rs |
| 报价模板、手动调整、CSV、未完成报告限制 | src/quotation.rs、src/parts_csv.rs、tests/pricing_parity.rs、tests/app_workflows.rs |
| SQLite 草稿、工程库、全局设置与旧库迁移 | src/storage.rs、tests/storage_compat.rs；含 WAL 一致性备份、失败回滚和损坏数据保护 |
| 实时试排、取消、超时与旧任务失效 | src/jobs.rs、tests/jobs.rs |
| 保存顺序、最新损耗率、表格连续录入与缩放 | tests/app_workflows.rs |
| 输入文字垂直居中、零件表格行列对齐 | tests/ui_alignment.rs；覆盖可编辑/只读、空值/长文字、两种窗口尺寸及长材质名 |
| 中文输入组合/提交事件 | tests/native_probe.rs、tests/app_workflows.rs |
| 打印分页与重复排版数量 | src/platform/printing.rs、tests/printing.rs |

## 静态历史兼容样例

`tests/fixtures/js-baseline.json` 保留 43 个优化/校验输入、12 个独立束搜索输入、160 个物流输入和 20 个税率输入，以及历史报价/CSV/手动调整工作流的预期结果。`tests/fixtures/js-store.sqlite` 是历史版本生成的数据库兼容样例。

这些文件仅为测试数据，不包含 JavaScript 实现，不需要运行旧版程序。原样例生成脚本随旧代码移除；新增业务规则通过 Rust 测试维护，不能将当前实现自动生成的结果当作独立正确性证明。旋转覆盖规则由 `tests/rotation.rs` 独立断言。

## 本地验证与发布

在 `rust-app/` 中运行：

```powershell
cargo fmt --check
cargo clippy --locked --all-targets --target x86_64-pc-windows-msvc -- -D warnings
cargo test --locked --target x86_64-pc-windows-msvc
```

仓库根目录的 `tools/build-rust-win.ps1` 在上述检查后构建 release，检查 AMD64 Windows GUI PE 及系统 DLL 依赖，启动原生 `--smoke` 生成七张界面截图。产物位于 `dist/rust-native/`；当前构建的大小、SHA-256 和检查结果以该目录的 `build-info.json` 为准。

历史人工/本机检查包括 1440×920 和 1000×700 窗口截图、单实例、隔离目录运行和 Microsoft Print to PDF。历史检查不等于当前版本的全部场景已经重新人工验收。

## 人工待验与边界

- 真实中文输入法候选框、第三方输入法、组词时 Enter/方向键交互。
- Windows 10、其他 DPI、完全干净的 Windows 系统；精简 PATH 和 PE 检查不能替代独立系统验收。
- 实体打印机、驱动差异与纸张边距；Microsoft Print to PDF 的部分数字文本提取可能异常，报价请使用应用复制文本或 CSV。
- 界面是原生近似布局，不承诺旧版逐像素一致；小窗口中工程说明位于零件清单页。
- 需要可用的 OpenGL 显卡驱动；单 EXE 仍会在同级 data/ 创建数据库、WAL 和备份。
- 兼容历史 SQLite，不直接迁移浏览器 localStorage。程序未进行可信代码签名。
