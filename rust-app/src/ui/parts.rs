use super::theme::*;
use crate::{
    app::{App, Confirm},
    logistics,
    model::*,
    project,
};
use eframe::egui::{self, RichText};
use serde_json::json;

const ROW_HEIGHT: f32 = 45.0;
const COLUMNS: [(&str, f32); 11] = [
    ("", 20.0),
    ("小图", 72.0),
    ("长度 (mm)", 88.0),
    ("宽度 (mm)", 88.0),
    ("材质", 110.0),
    ("厚度 (mm)", 95.0),
    ("数量", 88.0),
    ("允许旋转", 60.0),
    ("备注", 120.0),
    ("零件编号", 100.0),
    ("", 32.0),
];

fn cell<R>(
    ui: &mut egui::Ui,
    column: usize,
    height: f32,
    contents: impl FnOnce(&mut egui::Ui) -> R,
) -> egui::InnerResponse<R> {
    let width = COLUMNS[column].1;
    let align = if matches!(column, 0 | 1 | 7 | 10) {
        egui::Align::Center
    } else {
        egui::Align::Min
    };
    // Reserve the same rectangle for headers and rows. A bare scope in a Grid
    // can position ComboBox contents relative to the entire remaining row.
    ui.allocate_ui_with_layout(
        egui::vec2(width, height),
        egui::Layout::left_to_right(egui::Align::Center).with_main_align(align),
        |ui| {
            ui.set_min_size(egui::vec2(width, height));
            ui.set_max_width(width);
            ui.style_mut().wrap_mode = Some(egui::TextWrapMode::Truncate);
            let content_height = ui
                .text_style_height(&egui::TextStyle::Button)
                .max(ui.spacing().icon_width);
            ui.spacing_mut().interact_size.y = INPUT_HEIGHT;
            ui.spacing_mut().button_padding =
                egui::vec2(8.0, ((INPUT_HEIGHT - content_height) / 2.0).max(0.0));
            contents(ui)
        },
    )
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    page_heading(
        ui,
        "DATA ENTRY",
        "零件清单",
        "录入矩形零件，或通过 CSV 导入；原始板材在“板材库存”中维护。尺寸统一为毫米。",
        350.0,
        |ui| {
            if ui.button("导入 CSV").clicked() {
                app.import_parts();
            }
            if ui.button("导出 CSV").clicked() {
                app.export_parts();
            }
            let can_optimize = app.job.is_none()
                && rows(&app.project, "parts")
                    .iter()
                    .any(|p| field_number(p, "quantity", 0.0) > 0.0);
            if ui
                .add_enabled(
                    can_optimize,
                    egui::Button::new(
                        RichText::new(if app.job.is_some() {
                            "正在计算…"
                        } else {
                            "开始优化 →"
                        })
                        .color(egui::Color32::WHITE),
                    )
                    .fill(BLUE)
                    .min_size(egui::vec2(112.0, 40.0)),
                )
                .clicked()
            {
                app.start_optimization();
            }
            if app.job.is_some() && ui.button("停止优化").clicked() {
                app.stop_optimization();
            }
        },
    );
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.horizontal_wrapped(|ui| {
            ui.vertical(|ui| {
                header(ui, "工程说明");
                if text(
                    ui,
                    &mut app.project["description"],
                    350.0_f32.min(ui.available_width()),
                )
                .changed()
                {
                    app.commit(false);
                }
            });
            ui.vertical(|ui| {
                header(ui, "发货目的地");
                let mut destination = string(&app.project["shippingDestination"]);
                egui::ComboBox::from_id_salt("destination")
                    .popup_style(compact_dropdown.into())
                    .width(220.0)
                    .selected_text(if destination.is_empty() {
                        "请选择目的地"
                    } else {
                        &destination
                    })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut destination, String::new(), "请选择目的地");
                        for d in logistics::destinations() {
                            ui.selectable_value(&mut destination, d.clone(), d);
                        }
                    });
                if app.project["shippingDestination"] != destination {
                    app.project["shippingDestination"] = json!(destination);
                    app.commit(false);
                }
            });
        });
    });
    ui.add_space(20.0);
    if ui.available_width() >= 1250.0 {
        let width = ui.available_width();
        ui.horizontal_top(|ui| {
            ui.allocate_ui_with_layout(
                egui::vec2(width - 280.0, 0.0),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    editor(app, ui);
                },
            );
            ui.add_space(12.0);
            ui.allocate_ui_with_layout(
                egui::vec2(256.0, 0.0),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    summary(app, ui);
                },
            );
        });
    } else {
        editor(app, ui);
    }
}

fn summary(app: &App, ui: &mut egui::Ui) {
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.label(RichText::new("本单概况").size(17.0).strong());
        ui.label(RichText::new("录入完成后开始优化").small().color(MUTED));
        ui.add_space(16.0);
        let parts = rows(&app.project, "parts");
        for (label, value) in [
            ("零件种类", format!("{} 种", parts.len())),
            (
                "加工数量",
                format!(
                    "{} 件",
                    parts
                        .iter()
                        .map(|p| field_number(p, "quantity", 0.0))
                        .sum::<f64>()
                ),
            ),
        ] {
            ui.horizontal(|ui| {
                ui.label(RichText::new(label).color(MUTED));
                ui.label(RichText::new(value).strong());
            });
            ui.add_space(12.0);
        }
        ui.separator();
        header(ui, "库存规格");
        for panel in rows(&app.project, "panels")
            .iter()
            .filter(|panel| {
                parts.iter().any(|part| {
                    project::material_key(&part["material"])
                        == project::material_key(&panel["material"])
                        && field_number(part, "thickness", 0.0)
                            == field_number(panel, "thickness", 0.0)
                })
            })
            .take(4)
        {
            ui.label(
                RichText::new(format!(
                    "{} · {} × {} × {} mm",
                    string(&panel["material"]),
                    string(&panel["length"]),
                    string(&panel["width"]),
                    string(&panel["thickness"])
                ))
                .size(12.0),
            );
        }
    });
    ui.add_space(20.0);
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.label(RichText::new("优化规则").size(17.0).strong());
        badge(
            ui,
            if app.project["settings"]["optimizationLevel"] == "quick" {
                "快速估算"
            } else {
                "深度优化"
            },
        );
        ui.add_space(12.0);
        for (name, key) in [
            ("锯缝", "sawWidth"),
            ("左右裁边", "panelMarginX"),
            ("上下裁边", "panelMarginY"),
        ] {
            ui.label(format!(
                "{name}  {} mm",
                string(&app.project["settings"][key])
            ));
        }
        ui.label(RichText::new("旋转以单件设置为准").small().color(MUTED));
        ui.separator();
        ui.label(
            RichText::new("参数在「全局设置」中维护")
                .small()
                .color(BLUE),
        );
    });
}

fn editor(app: &mut App, ui: &mut egui::Ui) {
    let unsupported = rows(&app.project, "parts")
        .iter()
        .filter(|p| project::unsupported(p))
        .count();
    if unsupported > 0 {
        notice(
            ui,
            &format!(
                "当前仅支持矩形零件；有 {unsupported} 行旧版轮廓或指定角度数据不再支持，请删除后重新录入矩形零件。"
            ),
        );
    }
    let panels = rows(&app.project, "panels").to_vec();
    let groups = project::groups(&panels);
    let mut data = rows(&app.project, "parts").to_vec();
    let mut changed = false;
    let mut remove = None;
    app.cell_ids.clear();
    card().show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new("加工零件").size(16.0).strong());
            let key = if app.project["settings"]["partEntryKey"] == "enter" {
                "回车"
            } else {
                "Tab"
            };
            ui.label(
                RichText::new(format!("方向键切换单元格，{key} 键连续录入"))
                    .small()
                    .color(MUTED),
            );
            ui.label(
                RichText::new(format!(
                    "{} 种 / {} 件",
                    data.len(),
                    data.iter()
                        .map(|p| field_number(p, "quantity", 0.0))
                        .sum::<f64>()
                ))
                .small()
                .color(MUTED),
            );
            if ui.button("＋ 添加零件").clicked() {
                app.add_part(false);
                data = rows(&app.project, "parts").to_vec();
            }
            if ui.button(RichText::new("清空清单").color(DANGER)).clicked() {
                app.confirmation = Some(Confirm::ClearParts);
            }
        });
        ui.separator();
        egui::ScrollArea::horizontal()
            .id_salt("parts-horizontal")
            .show(ui, |ui| {
                egui::Grid::new("parts-grid")
                    .num_columns(COLUMNS.len())
                    .min_col_width(0.0)
                    .min_row_height(0.0)
                    .striped(true)
                    .spacing([8.0, 7.0])
                    .show(ui, |ui| {
                        for (column, (title, _)) in COLUMNS.iter().enumerate() {
                            cell(ui, column, 28.0, |ui| {
                                ui.add_sized(
                                    [COLUMNS[column].1, 28.0],
                                    egui::Label::new(RichText::new(*title).size(11.0).color(MUTED))
                                        .halign(ui.layout().main_align),
                                );
                            });
                        }
                        ui.end_row();
                        for (index, row) in data.iter_mut().enumerate() {
                            let readonly = project::unsupported(row);
                            cell(ui, 0, ROW_HEIGHT, |ui| {
                                ui.label(RichText::new("••").color(MUTED));
                            });
                            cell(ui, 1, ROW_HEIGHT, |ui| {
                                let (rect, _) = ui.allocate_exact_size(
                                    egui::vec2(72.0, 45.0),
                                    egui::Sense::hover(),
                                );
                                ui.painter().rect_filled(rect, 3.0, SELECTED);
                                if readonly {
                                    ui.painter().text(
                                        rect.center(),
                                        egui::Align2::CENTER_CENTER,
                                        "不支持",
                                        egui::FontId::proportional(11.0),
                                        MUTED,
                                    );
                                } else {
                                    let l = field_number(row, "length", 0.0);
                                    let w = field_number(row, "width", 0.0);
                                    if l > 0.0 && w > 0.0 {
                                        let scale = (62.0 / l).min(35.0 / w) as f32;
                                        ui.painter().rect_filled(
                                            egui::Rect::from_center_size(
                                                rect.center(),
                                                egui::vec2(l as f32 * scale, w as f32 * scale),
                                            ),
                                            0.0,
                                            PALETTE[0],
                                        );
                                    }
                                }
                            });
                            for (column, field) in [(0, "length"), (1, "width")] {
                                let (response, c) = cell(ui, column + 2, ROW_HEIGHT, |ui| {
                                    numeric(
                                        app,
                                        ui,
                                        &mut row[field],
                                        format!("part-{index}-{field}"),
                                        false,
                                        readonly,
                                    )
                                })
                                .inner;
                                changed |= c;
                                app.register_cell(&response, index, column);
                            }
                            let mut material = string(&row["material"]);
                            let current = groups
                                .iter()
                                .any(|(key, _)| *key == project::material_key(&row["material"]));
                            let material_label = if current {
                                if material.is_empty() {
                                    "默认材质".into()
                                } else {
                                    material.clone()
                                }
                            } else {
                                format!("{}（库存中不可用）", material)
                            };
                            let combo = cell(ui, 4, ROW_HEIGHT, |ui| {
                                if groups.is_empty() {
                                    ui.disable();
                                }
                                egui::ComboBox::from_id_salt(("material", index))
                                    .popup_style(compact_dropdown.into())
                                    .width(COLUMNS[4].1)
                                    .truncate()
                                    .selected_text(&material_label)
                                    .show_ui(ui, |ui| {
                                        for (_, m) in &groups {
                                            ui.selectable_value(
                                                &mut material,
                                                m.clone(),
                                                if m.is_empty() { "默认材质" } else { m },
                                            );
                                        }
                                    })
                            });
                            if !groups.is_empty() {
                                app.register_cell(&combo.inner.response, index, 2);
                            }
                            if row["material"] != material {
                                row["material"] = json!(material);
                                app.editing.remove(&format!("part-{index}-thickness"));
                                row["thickness"] = project::thicknesses(&panels, &row["material"])
                                    .first()
                                    .map_or(json!(""), |v| json!(v));
                                changed = true;
                            }
                            let available = project::thicknesses(&panels, &row["material"]);
                            cell(ui, 5, ROW_HEIGHT, |ui| {
                                ui.spacing_mut().item_spacing.x = 2.0;
                                let key = format!("part-{index}-thickness");
                                let mut input = app.editing.get(&key).cloned()
                                    .unwrap_or_else(|| string(&row["thickness"]));
                                let response = ui.add_sized(
                                    [61.0, INPUT_HEIGHT],
                                    singleline(&mut input).id_salt(&key).desired_width(61.0),
                                ).on_hover_text("输入库存厚度自动匹配，或点击右侧箭头选择；不支持自定义厚度");
                                app.register_cell(&response, index, 3);
                                let thickness = number(&json!(input), f64::NAN);
                                let matched = available.iter().copied()
                                    .find(|t| (t - thickness).abs() < EPSILON);
                                if response.changed() && let Some(thickness) = matched {
                                    row["thickness"] = json!(thickness);
                                    changed = true;
                                }
                                if response.lost_focus() {
                                    if matched.is_none() {
                                        app.notify("当前材质的库存中没有该厚度，请重新输入或选择");
                                    }
                                    input = string(&row["thickness"]);
                                }
                                let mut selected = None;
                                ui.add_enabled_ui(!available.is_empty(), |ui| {
                                    egui::ComboBox::from_id_salt(("thickness", index))
                                        .popup_style(compact_dropdown.into())
                                        .width(32.0)
                                        .selected_text("")
                                        .show_ui(ui, |ui| {
                                            for t in &available {
                                                if ui.selectable_label(
                                                    (field_number(row, "thickness", -1.0) - t).abs() < EPSILON,
                                                    t.to_string(),
                                                ).clicked() {
                                                    selected = Some(*t);
                                                }
                                            }
                                        });
                                });
                                if let Some(thickness) = selected {
                                    row["thickness"] = json!(thickness);
                                    input = thickness.to_string();
                                    changed = true;
                                }
                                app.editing.insert(key, input);
                            });
                            let (response, c) = cell(ui, 6, ROW_HEIGHT, |ui| {
                                numeric(
                                    app,
                                    ui,
                                    &mut row["quantity"],
                                    format!("part-{index}-quantity"),
                                    true,
                                    false,
                                )
                            })
                            .inner;
                            changed |= c;
                            app.register_cell(&response, index, 4);
                            let mut rotate = row["allowRotate"]
                                .as_bool()
                                .unwrap_or(app.project["settings"]["allowRotation"] != false);
                            let response = cell(ui, 7, ROW_HEIGHT, |ui| {
                                ui.add_space((COLUMNS[7].1 - INPUT_HEIGHT) / 2.0);
                                ui.checkbox(&mut rotate, "")
                            })
                            .inner;
                            if response.changed() {
                                row["allowRotate"] = json!(rotate);
                                changed = true;
                            }
                            app.register_cell(&response, index, 5);
                            for (column, field, width) in
                                [(6, "description", 120.0), (7, "code", 100.0)]
                            {
                                let response = cell(ui, column + 2, ROW_HEIGHT, |ui| {
                                    text(ui, &mut row[field], width)
                                })
                                .inner;
                                changed |= response.changed();
                                app.register_cell(&response, index, column);
                            }
                            if cell(ui, 10, ROW_HEIGHT, |ui| {
                                ui.add_sized(
                                    [COLUMNS[10].1, INPUT_HEIGHT],
                                    egui::Button::new(RichText::new("×").color(DANGER)),
                                )
                            })
                            .inner
                            .clicked()
                            {
                                remove = Some(index);
                            }
                            ui.end_row();
                        }
                    });
            });
        if data.is_empty() {
            empty_state(
                ui,
                "从第一块零件开始",
                "手动添加矩形零件，或导入已有的 CSV 清单。",
            );
        }
    });
    if let Some(index) = remove {
        data.remove(index);
        changed = true;
        app.editing.clear();
    }
    if changed {
        app.project["parts"] = json!(data);
        app.commit(true);
    }
}
