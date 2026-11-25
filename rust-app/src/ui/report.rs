use super::theme::*;
use crate::{
    app::{App, View},
    model::*,
    platform::printing,
    pricing, quotation,
};
use eframe::egui::{self, RichText};
use serde_json::json;

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    let complete = app.plan.as_ref().is_some_and(Plan::is_complete);
    page_heading(
        ui,
        "CUTTING REPORT",
        "统计报告",
        "核对计费比例与材料税率，生成可复制、可导出的正式报价。",
        220.0,
        |ui| {
            if ui
                .add_enabled(complete, egui::Button::new("导出 CSV"))
                .clicked()
            {
                app.export_report();
            }
            if ui
                .add_enabled(
                    complete,
                    egui::Button::new(RichText::new("打印报告").color(egui::Color32::WHITE))
                        .fill(BLUE),
                )
                .clicked()
            {
                app.preview_page = 0;
                app.print_document = app
                    .plan
                    .as_ref()
                    .map(|plan| printing::report_document(plan, &app.project, &app.quote_rows));
            }
        },
    );
    ui.add_space(20.0);
    let Some(plan) = &app.plan else {
        card().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            empty_state(
                ui,
                if app.job.is_some() {
                    "优化进行中"
                } else {
                    "完成优化后，报价会在这里生成"
                },
                "先录入板材与零件，再生成完整排版。试排不能生成正式报价。",
            );
            ui.vertical_centered(|ui| {
                if dark(ui, "前往零件清单").clicked() {
                    app.view = View::Parts;
                }
            });
        });
        return;
    };
    let totals = quotation::totals(plan, &app.project, &app.quote_rows);
    let incomplete = !complete;
    let stats = [
        (
            "税后总报价",
            if incomplete {
                "暂不可报价".into()
            } else {
                pricing::currency(totals.taxed_final_total)
            },
            format!("未税合计 {}", pricing::currency(totals.final_total)),
        ),
        (
            "板材报价",
            pricing::currency(totals.panel),
            format!("使用板材 {} 张", plan.layouts.len()),
        ),
        (
            "加工与物流",
            pricing::currency(totals.cutting + totals.packaging + totals.logistics.fee),
            "含切割、打包与物流费用".into(),
        ),
        (
            "材料税额",
            pricing::currency(totals.taxed_panel - totals.panel),
            format!(
                "材料税率 {}% · 仅应用于板材",
                string(&app.project["taxRate"])
            ),
        ),
    ];
    let count = if ui.available_width() < 900.0 { 2 } else { 4 };
    for (group, chunk) in stats.chunks(count).enumerate() {
        ui.columns(chunk.len(), |cols| {
            for (i, (label, value, note)) in chunk.iter().enumerate() {
                metric(&mut cols[i], label, value, note, group == 0 && i == 0);
            }
        });
        ui.add_space(16.0);
    }
    if incomplete {
        notice(
            ui,
            if plan.unplaced.is_empty() {
                "排版零件数量与清单不一致，请重新优化。正式报价、复制、打印和报告导出已禁用。"
            } else {
                "有零件未排入，当前仅显示已排入部分的费用。正式报价、复制、打印和报告导出已禁用。"
            },
        );
        ui.add_space(16.0);
    }
    let mut tax = pricing::normalize_tax_rate(&app.project["taxRate"]);
    let mut tax_changed = false;
    let mut adjusted = app.quote_rows.clone();
    let mut selected = app.selected_quote.min(adjusted.len().saturating_sub(1));
    let mut changed = false;
    let draw_table = |ui: &mut egui::Ui, adjusted: &[quotation::QuoteRow], selected: &mut usize| {
        let totals = quotation::totals(plan, &app.project, adjusted);
        card().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new("逐板计费明细").size(17.0).strong());
            ui.label(
                RichText::new("选择排版可在上方的本单报价调整中修改费用")
                    .color(MUTED)
                    .small(),
            );
            egui::ScrollArea::horizontal()
                .id_salt("report-horizontal")
                .show(ui, |ui| {
                    egui::Grid::new("quote-table")
                        .striped(true)
                        .spacing([16.0, 16.0])
                        .show(ui, |ui| {
                            for label in [
                                "排版",
                                "板材规格 mm",
                                "实际利用率",
                                "计价利用率",
                                "计费比例",
                                "整张成本价",
                                "利润比例",
                                "实际重量",
                                "材料税后价",
                                "切割费",
                                "税后小计",
                            ] {
                                header(ui, label);
                            }
                            ui.end_row();
                            for (index, (layout, row)) in
                                plan.layouts.iter().zip(adjusted).enumerate()
                            {
                                ui.selectable_value(selected, index, format!("{:02}", index + 1));
                                ui.label(format!(
                                    "{} · {} mm\n{} × {}{}",
                                    if layout.panel.material.is_empty() {
                                        "默认材质"
                                    } else {
                                        &layout.panel.material
                                    },
                                    layout.panel.thickness,
                                    layout.width,
                                    layout.height,
                                    if layout.is_full_sheet {
                                        " · 整板件"
                                    } else {
                                        ""
                                    }
                                ));
                                ui.label(percent(layout.usage));
                                ui.label(percent(number(
                                    layout
                                        .pricing
                                        .get("billingUsage")
                                        .unwrap_or(&serde_json::Value::Null),
                                    0.0,
                                )));
                                ui.label(percent(number(
                                    layout
                                        .pricing
                                        .get("billingRate")
                                        .unwrap_or(&serde_json::Value::Null),
                                    0.0,
                                )));
                                ui.label(pricing::currency(layout.panel.cost));
                                ui.label(format!(
                                    "{}%",
                                    string(&app.project["settings"]["profitRate"])
                                ));
                                ui.label(format!(
                                    "{} kg",
                                    pricing::format_number(
                                        number(
                                            layout
                                                .pricing
                                                .get("actualWeight")
                                                .unwrap_or(&serde_json::Value::Null),
                                            0.0
                                        ),
                                        2,
                                        false,
                                        false
                                    )
                                ));
                                ui.label(pricing::currency(row.taxed_panel_charge));
                                ui.label(pricing::currency(row.cutting_fee));
                                ui.label(
                                    RichText::new(pricing::currency(
                                        row.taxed_panel_charge + row.cutting_fee,
                                    ))
                                    .strong(),
                                );
                                ui.end_row();
                            }
                        });
                });
            ui.separator();
            ui.label(
                RichText::new(format!(
                    "打包 {} · 物流 {} · {} → {}",
                    pricing::currency(totals.packaging),
                    pricing::currency(totals.logistics.fee),
                    totals.logistics.origin,
                    if totals.logistics.destination.is_empty() {
                        "待选择发货目的地"
                    } else {
                        &totals.logistics.destination
                    }
                ))
                .small()
                .color(MUTED),
            );
            ui.label(
                RichText::new(format!(
                    "税后合计  {}",
                    pricing::currency(totals.taxed_final_total)
                ))
                .size(22.0)
                .strong()
                .color(BLUE),
            );
        });
    };
    // Quote text, material usage and project adjustments form the second row.
    let quote = quotation::build_quotation(plan, &app.project, &adjusted).unwrap_or_else(|e| e);
    let wide = ui.available_width() >= 900.0;
    let width = ui.available_width();
    let mut editor = |ui: &mut egui::Ui| {
        card().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new("本单报价调整").size(17.0).strong());
            ui.horizontal(|ui| {
                header(ui, "材料税率");
                tax_changed = ui
                    .add_sized(
                        [100.0, INPUT_HEIGHT],
                        egui::DragValue::new(&mut tax)
                            .range(0.0..=100.0)
                            .speed(0.01)
                            .suffix("%"),
                    )
                    .changed();
            });
            ui.label(
                RichText::new("仅材料计税，切割、打包及物流不参与税率加成。")
                    .small()
                    .color(MUTED),
            );
            ui.separator();
            if tax_changed {
                for row in &mut adjusted {
                    row.taxed_panel_charge = pricing::material_after_tax(row.panel_charge, tax);
                }
            }
            if let (Some(row), Some(layout)) =
                (adjusted.get_mut(selected), plan.layouts.get(selected))
            {
                badge(ui, &format!("排版 {:02} · 修改即时生效", selected + 1));
                for (label, field) in [
                    ("板材报价（未税 / 元）", 0),
                    ("材料税后价（元）", 1),
                    ("切割费（元）", 2),
                ] {
                    header(ui, label);
                    let value = match field {
                        0 => &mut row.panel_charge,
                        1 => &mut row.taxed_panel_charge,
                        _ => &mut row.cutting_fee,
                    };
                    let edit = ui.add_enabled(
                        field != 2 || !layout.is_full_sheet,
                        egui::DragValue::new(value)
                            .range(0.0..=f64::MAX)
                            .fixed_decimals(2)
                            .speed(0.1),
                    );
                    if edit.changed() {
                        if field == 0 {
                            row.taxed_panel_charge =
                                pricing::material_after_tax(row.panel_charge, tax);
                        }
                        changed = true;
                    }
                }
                ui.label(
                    RichText::new(format!(
                        "实际利用率 {} · 整张成本 {}",
                        percent(layout.usage),
                        pricing::currency(layout.panel.cost)
                    ))
                    .small()
                    .color(MUTED),
                );
                if ui.button("恢复此板自动计价").clicked() {
                    let mut project = app.project.clone();
                    project["taxRate"] = json!(tax);
                    project
                        .as_object_mut()
                        .unwrap()
                        .shift_remove("quotationAdjustment");
                    if let Some(original) =
                        quotation::initialize_adjustments(plan, &project).get(selected)
                    {
                        *row = original.clone();
                        changed = true;
                    }
                }
                ui.label(
                    RichText::new("修改不会覆盖全局成本；重新优化后请重新核对。")
                        .small()
                        .color(MUTED),
                );
            }
        });
    };
    if wide {
        // Measure adjustments first and fit both read-only cards to the same height.
        // Render right-to-left to keep quote / usage / adjustments in visual order.
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
            let adjustment = ui.allocate_ui_with_layout(
                egui::vec2(300.0, 0.0),
                egui::Layout::top_down(egui::Align::Min),
                &mut editor,
            );
            ui.add_space(12.0);
            ui.allocate_ui_with_layout(
                egui::vec2(260.0, adjustment.response.rect.height()),
                egui::Layout::top_down(egui::Align::Min),
                |ui| material_usage(ui, plan, adjustment.response.rect.height()),
            );
            ui.add_space(12.0);
            ui.allocate_ui_with_layout(
                egui::vec2(width - 608.0, adjustment.response.rect.height()),
                egui::Layout::top_down(egui::Align::Min),
                |ui| quote_text(ui, &quote, incomplete, adjustment.response.rect.height()),
            );
        });
    } else {
        quote_text(ui, &quote, incomplete, 420.0);
        ui.add_space(16.0);
        material_usage(ui, plan, 420.0);
        ui.add_space(16.0);
        editor(ui);
    }
    ui.add_space(20.0);
    draw_table(ui, &adjusted, &mut selected);
    app.selected_quote = selected;
    if tax_changed {
        app.project["taxRate"] = json!(tax);
    }
    if changed || tax_changed {
        app.quote_rows = adjusted;
        app.save_quote_adjustments();
    }
}
#[derive(Default)]
struct MaterialUsage {
    sheets: usize,
    pieces: usize,
    panel_area: f64,
    parts_area: f64,
}

impl MaterialUsage {
    fn add(&mut self, layout: &Layout) {
        self.sheets += 1;
        self.pieces += layout.placements.len();
        self.panel_area += layout.width * layout.height;
        self.parts_area += layout.used_area;
    }

    fn remaining_area(&self) -> f64 {
        (self.panel_area - self.parts_area).max(0.0)
    }

    fn usage(&self) -> f64 {
        if self.panel_area > 0.0 {
            self.parts_area / self.panel_area
        } else {
            0.0
        }
    }
}

fn area_text(area: f64) -> String {
    format!(
        "{} m²",
        pricing::format_number(area / 1_000_000.0, 4, false, false)
    )
}

fn material_usage(ui: &mut egui::Ui, plan: &Plan, height: f32) {
    let mut total = MaterialUsage::default();
    for layout in &plan.layouts {
        total.add(layout);
    }
    let frame = card();
    let content_height = (height - frame.total_margin().sum().y).max(1.0);
    frame.show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.set_min_height(content_height);
        let title = ui.label(RichText::new("板材总量使用").size(17.0).strong());
        let body_height =
            (content_height - title.rect.height() - ui.spacing().item_spacing.y).max(1.0);
        egui::ScrollArea::vertical()
            .id_salt("material-usage-scroll")
            .min_scrolled_height(body_height)
            .max_height(body_height)
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.label(
                    RichText::new(format!("{} 张板材 · {} 件零件", total.sheets, total.pieces))
                        .strong()
                        .color(BLUE),
                );
                for (label, value) in [
                    ("板材实际总面积", area_text(total.panel_area)),
                    ("零件实际占用面积", area_text(total.parts_area)),
                    ("未占用面积（含锯缝）", area_text(total.remaining_area())),
                    ("综合实际利用率", percent(total.usage())),
                ] {
                    header(ui, label);
                    ui.label(RichText::new(value).size(18.0).strong());
                }
            });
    });
}

fn quote_text(ui: &mut egui::Ui, quote: &str, incomplete: bool, height: f32) {
    let frame = card();
    let content_height = (height - frame.total_margin().sum().y).max(1.0);
    frame.show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.set_min_height(content_height);
        let header = ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new("报价明细文本").size(17.0).strong());
            if ui
                .add_enabled(!incomplete, egui::Button::new("复制文本"))
                .clicked()
            {
                ui.ctx().copy_text(quote.to_owned());
            }
        });
        let text_height =
            (content_height - header.response.rect.height() - ui.spacing().item_spacing.y).max(1.0);
        egui::ScrollArea::vertical()
            .id_salt("quotation-text-scroll")
            .min_scrolled_height(text_height)
            .max_height(text_height)
            .auto_shrink([false, false])
            .show(ui, |ui| {
                let mut quote = quote.to_owned();
                ui.add(
                    egui::TextEdit::multiline(&mut quote)
                        .desired_width(f32::INFINITY)
                        .min_size(egui::vec2(0.0, text_height))
                        .desired_rows(12)
                        .interactive(false),
                );
            });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn material_usage_counts_repeated_sheets_and_uses_area_weighted_utilization() {
        let plan = crate::engine::optimize(&json!({
            "panels": [
                {"material":"A", "length":1000, "width":1000, "thickness":18},
                {"material":"B", "length":500, "width":500, "thickness":9}
            ],
            "parts": [
                {"material":"A", "length":1000, "width":1000, "thickness":18, "quantity":2},
                {"material":"B", "length":250, "width":250, "thickness":9, "quantity":1}
            ],
            "settings":{"sawWidth":0, "panelMarginX":0, "panelMarginY":0, "optimizationLevel":"quick"}
        }), true).unwrap();
        assert!(plan.unplaced.is_empty());
        let mut usage = MaterialUsage::default();
        for layout in &plan.layouts {
            usage.add(layout);
        }
        assert_eq!(usage.sheets, 3);
        assert_eq!(usage.pieces, 3);
        assert_eq!(usage.panel_area, 2_250_000.0);
        assert_eq!(usage.parts_area, 2_062_500.0);
        assert_eq!(usage.remaining_area(), 187_500.0);
        assert!((usage.usage() - 2_062_500.0 / 2_250_000.0).abs() < EPSILON);
        assert_eq!(area_text(usage.panel_area), "2.25 m²");
    }

    #[test]
    fn empty_material_usage_has_no_invalid_percentage() {
        let usage = MaterialUsage::default();
        assert_eq!(usage.usage(), 0.0);
        assert_eq!(usage.remaining_area(), 0.0);
    }
}
