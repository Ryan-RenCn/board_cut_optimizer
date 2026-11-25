use super::theme::*;
use crate::{app::App, logistics, model::*, project, quotation};
use eframe::egui::{self, RichText};
use serde_json::json;

fn parameter(
    app: &mut App,
    ui: &mut egui::Ui,
    key: &str,
    label: &str,
    suffix: &str,
    invalidate: bool,
) {
    ui.vertical(|ui| {
        header(ui, label);
        let mut value = field_number(&app.project["settings"], key, 0.0);
        if ui
            .add_sized(
                [112.0, INPUT_HEIGHT],
                egui::DragValue::new(&mut value)
                    .range(0.0..=f64::MAX)
                    .speed(0.1)
                    .suffix(suffix),
            )
            .changed()
        {
            app.project["settings"][key] = json!(value);
            app.commit(invalidate);
        }
    });
}
pub fn render(app: &mut App, ui: &mut egui::Ui) {
    page_heading(
        ui,
        "GLOBAL SETTINGS",
        "全局设置",
        "统一管理报价规则、加工参数、物流、优化策略及连续录入方式。",
        280.0,
        |ui| {
            if ui.button("恢复默认设置").clicked() {
                app.project["settings"] = project::defaults()["settings"].clone();
                app.editing.clear();
                app.commit(true);
            }
            if dark(ui, "保存全局设置").clicked() {
                app.save_global();
            }
        },
    );
    ui.add_space(16.0);
    ui.horizontal(|ui| {
        ui.selectable_value(&mut app.settings_template, false, "参数与规则");
        ui.selectable_value(&mut app.settings_template, true, "报价文本模板");
    });
    ui.add_space(16.0);
    if app.settings_template {
        template(app, ui);
        return;
    }
    if ui.available_width() >= 900.0 {
        ui.columns(2, |cols| {
            quote(app, &mut cols[0]);
            processing(app, &mut cols[1]);
        });
        ui.add_space(20.0);
        ui.columns(2, |cols| {
            shipping(app, &mut cols[0]);
            optimization(app, &mut cols[1]);
        });
    } else {
        quote(app, ui);
        ui.add_space(16.0);
        processing(app, ui);
        ui.add_space(16.0);
        shipping(app, ui);
        ui.add_space(16.0);
        optimization(app, ui);
    }
    ui.add_space(20.0);
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.label(RichText::new("05  连续录入").size(17.0).strong());
        ui.label(
            RichText::new("方向键导航，末行末格自动新增；Shift + 所选按键反向移动。").color(MUTED),
        );
        ui.add_space(16.0);
        let mut key = string(&app.project["settings"]["partEntryKey"]);
        ui.horizontal(|ui| {
            ui.radio_value(&mut key, "tab".into(), "Tab 键");
            ui.radio_value(&mut key, "enter".into(), "回车键");
        });
        if app.project["settings"]["partEntryKey"] != key {
            app.project["settings"]["partEntryKey"] = json!(key);
            app.commit(false);
        }
    });
}
fn quote(app: &mut App, ui: &mut egui::Ui) {
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.set_min_height(156.0);
        ui.label(RichText::new("01  报价与费用").size(17.0).strong());
        ui.label(
            RichText::new("材料税率与本单损耗在报告、排版中调整。")
                .small()
                .color(MUTED),
        );
        ui.add_space(14.0);
        ui.horizontal_wrapped(|ui| {
            parameter(app, ui, "profitRate", "利润比例", "%", true);
            parameter(app, ui, "cuttingFee", "整张切割费", " 元/张", true);
            parameter(app, ui, "packagingFee", "全局打包费", " 元/单", false);
        });
        ui.add_space(12.0);
        ui.label(
            RichText::new("计费板材成本 × 利润比例 = 板材报价；120% 表示成本的 1.2 倍。")
                .small()
                .color(MUTED),
        );
    });
}
fn processing(app: &mut App, ui: &mut egui::Ui) {
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.set_min_height(156.0);
        ui.label(RichText::new("02  加工参数").size(17.0).strong());
        ui.label(
            RichText::new("尺寸均为 mm；旋转角度仅支持 0° / 90°。")
                .small()
                .color(MUTED),
        );
        ui.add_space(14.0);
        ui.horizontal_wrapped(|ui| {
            for (key, label) in [
                ("sawWidth", "锯缝宽度"),
                ("panelMarginX", "左右裁边"),
                ("panelMarginY", "上下裁边"),
            ] {
                parameter(app, ui, key, label, " mm", true);
            }
        });
        ui.add_space(12.0);
        ui.label(
            RichText::new("可用区域扣除裁边，零件之间预留锯缝。")
                .small()
                .color(MUTED),
        );
    });
}
fn shipping(app: &mut App, ui: &mut egui::Ui) {
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.set_min_height(142.0);
        ui.label(RichText::new("03  物流方案").size(17.0).strong());
        ui.label(
            RichText::new("按实际用量重量计算，目的地在零件清单选择。")
                .small()
                .color(MUTED),
        );
        ui.add_space(12.0);
        let mut provider = string(&app.project["settings"]["logisticsProvider"]);
        egui::ComboBox::from_id_salt("provider")
            .popup_style(compact_dropdown.into())
            .width(240.0)
            .selected_text(if provider == logistics::PROVIDER {
                logistics::PROVIDER_LABEL
            } else {
                "不计算物流"
            })
            .show_ui(ui, |ui| {
                ui.selectable_value(&mut provider, "none".into(), "不计算物流");
                ui.selectable_value(
                    &mut provider,
                    logistics::PROVIDER.into(),
                    logistics::PROVIDER_LABEL,
                );
            });
        if app.project["settings"]["logisticsProvider"] != provider {
            app.project["settings"]["logisticsProvider"] = json!(provider);
            app.commit(false);
        }
        ui.label(
            RichText::new("运价 × 120%，向上取整到整十元。")
                .small()
                .color(MUTED),
        );
    });
}
fn optimization(app: &mut App, ui: &mut egui::Ui) {
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.set_min_height(142.0);
        ui.label(RichText::new("04  优化策略").size(17.0).strong());
        let mut level = string(&app.project["settings"]["optimizationLevel"]);
        ui.horizontal_wrapped(|ui| {
            ui.radio_value(&mut level, "full".into(), "深度优化");
            ui.radio_value(&mut level, "quick".into(), "快速估算");
        });
        if app.project["settings"]["optimizationLevel"] != level {
            app.project["settings"]["optimizationLevel"] = json!(level);
            app.commit(true);
        }
        let mut rotate = app.project["settings"]["allowRotation"] != false;
        if ui.checkbox(&mut rotate, "批量允许旋转").changed() {
            project::set_all_parts_rotation(&mut app.project, rotate);
            app.commit(true);
        }
        ui.label(
            RichText::new("修改时统一应用到全部零件，之后可逐件调整。")
                .small()
                .color(MUTED),
        );
    });
}
fn template(app: &mut App, ui: &mut egui::Ui) {
    let wide = ui.available_width() >= 900.0;
    if wide {
        let width = ui.available_width();
        ui.horizontal_top(|ui| {
            ui.allocate_ui_with_layout(
                egui::vec2(width - 340.0, 0.0),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    template_editor(app, ui);
                },
            );
            ui.allocate_ui_with_layout(
                egui::vec2(320.0, 0.0),
                egui::Layout::top_down(egui::Align::Min),
                placeholders,
            );
        });
    } else {
        template_editor(app, ui);
        ui.add_space(16.0);
        placeholders(ui);
    }
}
fn template_editor(app: &mut App, ui: &mut egui::Ui) {
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new("报价明细文本模板").size(17.0).strong());
            if ui.button("恢复默认模板").clicked() {
                app.project["settings"]["quotationTemplate"] = json!(quotation::DEFAULT_TEMPLATE);
                app.commit(false);
            }
        });
        ui.label(
            RichText::new("用占位符组合工程、加工明细与报价信息。")
                .small()
                .color(MUTED),
        );
        let mut value = string(&app.project["settings"]["quotationTemplate"]);
        if ui
            .add(
                egui::TextEdit::multiline(&mut value)
                    .id_salt("quotation-template")
                    .desired_width(f32::INFINITY)
                    .desired_rows(18)
                    .char_limit(20000),
            )
            .changed()
        {
            app.project["settings"]["quotationTemplate"] = json!(value);
            app.commit(false);
        }
        ui.label(
            RichText::new("占位符会在生成报价时替换为当前工程数据。")
                .small()
                .color(MUTED),
        );
    });
}
fn placeholders(ui: &mut egui::Ui) {
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.label(RichText::new("可用占位符").size(17.0).strong());
        ui.label(
            RichText::new("点击复制，再粘贴到模板。")
                .small()
                .color(MUTED),
        );
        for (heading, fields) in [
            ("工程信息", &["工程名称", "工程说明", "发货目的地"][..]),
            (
                "加工明细",
                &["零件明细", "总重量", "切割费用", "油漆费用"][..],
            ),
            (
                "费用与合计",
                &[
                    "板材报价",
                    "材料税率",
                    "材料税后价格",
                    "打包费用",
                    "物流费用",
                    "未税合计",
                    "最终合计",
                    "税后合计",
                    "分隔线",
                ][..],
            ),
        ] {
            ui.add_space(8.0);
            header(ui, heading);
            ui.horizontal_wrapped(|ui| {
                for field in fields {
                    let token = format!("{{{{{field}}}}}");
                    if ui.button(RichText::new(&token).color(BLUE)).clicked() {
                        ui.ctx().copy_text(token);
                    }
                }
            });
        }
    });
}
