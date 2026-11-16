# CAD导入后预览：REA分析与板优排实现（1.0.20）

## 1.0.21补充

文件选择与参数修改现自动触发解析。宽容预览与严格加工导入分离：失败实体、开放连接组、无法分类的轮廓和失败文件均提供灰色不可导入项；坐标可读取时仅画参考形状，无法定位时不伪造SVG。相邻/包含的失败加工边界会使关联组一起不可导入，防止有效外环因为漏掉坏内孔而被误当作实心板。未受影响的独立组和其它文件可正常选择。旧版“整次拒绝”等描述属于严格接口及历史行为，不再用于交互预览。

目标为用户提供的se2dnest.exe，沿用SHA256 `09c5f718a017323ef5f085a3708229c1dea7c0efbd2f55896622ae6fc7667b53`、MVID `34db1f37-e00f-404a-8b4d-5ac3e3200a93`。本次读取文件元数据与CIL，未执行原程序，未复制商业控件或DLL。

## 已观察证据

通过本地只读PE元数据定位预览类型，再由REA选择6类、73方法、38字段、451条调用边，覆盖声明完整且没有未匹配类型。父证据 `ev_b54a28556edd7c1797574830a8eb725cf66313b94b40d76989b196f926c4cbdb`；方法页 `ev_a300ea98da3e959479e981fb185fd6f0b3bffbf29d99a703d1e744757c60e903`；字段页 `ev_eed39029850ec88a6031de168c7d4f0cf599533f95979ab44623cb0301252a8b`；调用页 `ev_7ad4b36ffddff39f980ee3e655a0ec5254a735cfa99884deb9cc12c2d26b49af`。

|原软件构件|直接观察|板优排对应|
|---|---|---|
|ImportWPF.AutoCadControl|Model/CurrentCadView、Redraw、ViewChanged|解析后的整图SVG、重绘和视图状态|
|Canvas_MouseWheel / ProcessExternalMouseWheel（0x060009a0/a1）|构造WW.Actions.CanonicalMouseEventArgs，随后AdjustStrokeThickness及SendViewChanged|鼠标位置为中心缩放、保持屏幕线宽|
|RightButtonDown/Up、MouseMove、LostMouseCapture（0x9a3–0x9aa）|鼠标事件及字段_bExternalPanController|右键拖动，另兼容中键或空白处左键拖动；结束释放指针|
|ImportWPF.LayerControl（0xa18–0xa21）|VisibilityCheckBox_Checked/Unchecked、UpdateVisibilities；读取LayerColorItem|来源图层筛选，保持实际零件几何不变|
|ImportWPF.PartsGrid|partsDataGrid、XDimColumn、YDimColumn、QuantityColumn|尺寸、数量及零件列表|
|ImportWPF.PartWithImage（0xa41）|创建System.Windows.Controls.Image、set_Source并监听PropertyChanged|轮廓小图及修改数量|

以上为静态结构和调用观察，不证明原软件每个按钮的实际视觉效果。精确缩放倍率、像素布局、原厂全部选中规则未动态验证。适合窗口、跨文件排开、图形与列表联动和批量勾选为本项目的独立兼容交互设计，不声称照搬原厂内部实现。

## 实现过程

1. CAD解析器在局部轮廓归一化前保留 `cadSource.origin=[x,y]`，单位毫米且已完成Y向上到Y向下转换。shape仍是零件局部坐标，排版、报价与计量不变。
2. `cad-preview.mjs/buildCadPreviewScene` 将局部路径加回来源位置，绘制外环与内孔。同一文件保留原相对距离；多个文件在总览中水平排开，单文件视图恢复其独立坐标。旧数据缺少origin时按不重叠位置兜底显示。
3. 使用SVG viewBox缩放和平移，鼠标滚轮围绕指针位置；线宽用non-scaling-stroke。提供放大、缩小及适合窗口。
4. 图纸与来源图层筛选仅改变可见零件，不把零件的内孔删除，也不自动改动勾选。总选中数跨隐藏项显示，并明确提示导入以勾选为准。
5. 点击图形定位列表，图形与卡片同步高亮。可全选/取消当前可见项，逐件修改数量；只将有效且勾选的记录追加清单，未提交时不改原工程。
6. 重解析、修改参数、关闭弹窗均销毁控制器、移除事件并清空待导入记录；异步解析仍受revision保护，旧结果不能覆盖新文件。SOLID和DWG转换提示继续显示。

预览显示已识别的可导入加工轮廓，按现有导入规则忽略的文字、标注不作为图形显示；它不是原始DWG的完整通用CAD查看器。图层筛选当前以零件来源图层为单位，不破坏已经识别的完整外环及内孔。

## 验证

23组回归通过。新scene回归验证原图间距、内孔、不修改原件、旧数据及文件标识。真实Electron验证两文件四件的整图、图层筛选、勾选和数量、缩放复位、实际右键拖动、仅导入一件三份、来源坐标保存、关闭重开清理。截图cad-preview-interactive.png，脚本tests/ui-cad-preview-smoke.mjs。
