use super::theme::*;
use crate::{app::App, engine, model::*, platform::printing, pricing, quotation};
use eframe::egui::{self, Color32, RichText};
use serde_json::json;
pub fn render(app: &mut App, ui: &mut egui::Ui) {
    let description = app.notice.clone();
    page_heading(
        ui,
        "CUTTING LAYOUT",
        "开料排版",
        &description,
        560.0,
        |ui| {
            ui.label("本单损耗率");
            let mut loss = field_number(&app.project, "lossRate", 0.0);
            if ui
                .add(
                    egui::DragValue::new(&mut loss)
                        .range(0.0..=100.0)
                        .speed(0.1)
                        .suffix("%"),
                )
                .changed()
            {
                app.project["lossRate"] = json!(loss);
                app.reprice_loss();
            }

            if ui
                .add_enabled(
                    app.plan.as_ref().is_some_and(Plan::is_complete),
                    egui::Button::new("打印排版"),
                )
                .clicked()
            {
                app.preview_page = 0;
                app.print_document = app
                    .plan
                    .as_ref()
                    .map(|plan| printing::layout_document(plan, &app.project));
            }
            if app.job.is_none() && dark(ui, "重新优化").clicked() {
                app.start_optimization();
            }
            if app.job.is_some() {
                if ui.button(RichText::new("停止优化").color(DANGER)).clicked() {
                    app.stop_optimization();
                }
                if let Some(started) = app.job_started {
                    ui.label(format!("正在计算… {} 秒", started.elapsed().as_secs()));
                }
            }
        },
    );
    ui.add_space(12.0);
    if let Some(plan) = &app.plan {
        let complete = plan.is_complete();
        let totals = quotation::totals(plan, &app.project, &app.quote_rows);
        let count = if ui.available_width() < 800.0 { 2 } else { 4 };
        let stats = [
            (
                "平均利用率",
                percent(number(&plan.stats["averageUsage"], 0.0)),
                format!(
                    "含损耗计价 {}",
                    percent(number(&plan.stats["averageBillingUsage"], 0.0))
                ),
            ),
            (
                "使用板材",
                format!("{} 张", plan.layouts.len()),
                format!(
                    "总重量 {} kg",
                    pricing::format_number(
                        number(&plan.stats["totalWeight"], 0.0),
                        2,
                        false,
                        false
                    )
                ),
            ),
            (
                if complete {
                    "税后报价"
                } else {
                    "已排入部分税后价"
                },
                if complete {
                    pricing::currency(totals.taxed_final_total)
                } else {
                    "暂不可报价".into()
                },
                format!("未税 {}", pricing::currency(totals.final_total)),
            ),
            (
                "完成零件",
                format!(
                    "{} / {}",
                    plan.stats["placedCount"], plan.stats["requestedCount"]
                ),
                if complete {
                    "全部排入".into()
                } else if plan.unplaced.is_empty() {
                    "零件数量与清单不一致".into()
                } else {
                    format!("{} 件未排入", plan.unplaced.len())
                },
            ),
        ];
        for (chunk_index, chunk) in stats.chunks(count).enumerate() {
            ui.columns(chunk.len(), |cols| {
                for (i, (label, value, note)) in chunk.iter().enumerate() {
                    let accent = chunk_index == 0 && i == 0;
                    metric(&mut cols[i], label, value, note, accent);
                }
            });
            ui.add_space(10.0);
        }
        if !plan.unplaced.is_empty() {
            let mut reasons: Vec<(String, usize)> = Vec::new();
            for p in &plan.unplaced {
                let reason = p.reason.clone().unwrap_or_default();
                if let Some((_, count)) = reasons.iter_mut().find(|(r, _)| r == &reason) {
                    *count += 1;
                } else {
                    reasons.push((reason, 1));
                }
            }
            notice(
                ui,
                &format!(
                    "有 {} 件零件未能排入：{}。",
                    plan.unplaced.len(),
                    reasons
                        .iter()
                        .map(|(r, c)| format!("{r} {c} 件"))
                        .collect::<Vec<_>>()
                        .join("；")
                ),
            );
        }
        let groups = engine::group_identical_layouts(&plan.layouts);
        app.selected_layout = app.selected_layout.min(groups.len().saturating_sub(1));
        if ui.available_width() >= 950.0 && !groups.is_empty() {
            let width = ui.available_width();
            ui.horizontal_top(|ui| {
                ui.allocate_ui_with_layout(
                    egui::vec2(232.0, 0.0),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        card().show(ui, |ui| {
                            ui.set_min_width(ui.available_width());
                            ui.label(RichText::new("板材分组").size(16.0).strong());
                            badge(ui, &format!("全部 {} 张", plan.layouts.len()));
                            egui::ScrollArea::vertical()
                                .id_salt("layout-groups")
                                .min_scrolled_height(440.0)
                                .max_height(490.0)
                                .show(ui, |ui| {
                                    for (position, (index, count)) in groups.iter().enumerate() {
                                        if thumbnail(
                                            ui,
                                            &plan.layouts[*index],
                                            position,
                                            *count,
                                            app.selected_layout == position,
                                        )
                                        .clicked()
                                        {
                                            app.selected_layout = position;
                                        }
                                        ui.add_space(12.0);
                                    }
                                });
                        });
                    },
                );
                ui.add_space(12.0);
                ui.allocate_ui_with_layout(
                    egui::vec2(width - 260.0, 0.0),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        let (index, count) = groups[app.selected_layout];
                        draw_layout(ui, &plan.layouts[index], count, false, &app.project);
                    },
                );
            });
        } else if !groups.is_empty() {
            ui.horizontal_wrapped(|ui| {
                for (position, (_, count)) in groups.iter().enumerate() {
                    ui.selectable_value(
                        &mut app.selected_layout,
                        position,
                        format!("排版 {:02} × {count}", position + 1),
                    );
                }
            });
            let (index, count) = groups[app.selected_layout];
            draw_layout(ui, &plan.layouts[index], count, false, &app.project);
        }
    } else if app.job.is_some() {
        notice(
            ui,
            &format!(
                "深度优化进行中 · {} · 以下为实时试排，不是最终方案，暂不可正式报价。",
                app.notice
            ),
        );
        for layout in &app.preview {
            draw_layout(ui, layout, 1, true, &app.project);
            ui.add_space(16.0);
        }
    } else {
        card().show(ui, |ui| {
            empty_state(ui, "尚未生成排版", "先录入板材和零件，然后开始优化。");
            ui.vertical_centered(|ui| {
                if dark(ui, "前往零件清单").clicked() {
                    app.view = crate::app::View::Parts;
                }
            });
        });
    }
}
fn thumbnail(
    ui: &mut egui::Ui,
    layout: &Layout,
    index: usize,
    count: usize,
    selected: bool,
) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), 166.0),
        egui::Sense::click(),
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::SelectableLabel,
            true,
            selected,
            format!("排版 {}，{count} 张", index + 1),
        )
    });
    let painter = ui.painter();
    painter.rect_filled(rect, 7.0, if selected { SELECTED } else { Color32::WHITE });
    painter.rect_stroke(
        rect,
        7.0,
        egui::Stroke::new(
            if response.has_focus() {
                2.0_f32
            } else {
                1.0_f32
            },
            if selected || response.has_focus() {
                BLUE
            } else {
                LINE
            },
        ),
        egui::StrokeKind::Inside,
    );
    painter.text(
        rect.min + egui::vec2(12.0, 20.0),
        egui::Align2::LEFT_CENTER,
        format!("排版 {:02} · × {count} 张", index + 1),
        egui::FontId::proportional(13.0),
        INK,
    );
    let area = rect.shrink2(egui::vec2(12.0, 42.0));
    let scale = (area.width() / layout.width as f32).min(area.height() / layout.height as f32);
    let origin =
        area.center() - egui::vec2(layout.width as f32 * scale, layout.height as f32 * scale) / 2.0;
    painter.rect_filled(
        egui::Rect::from_min_size(
            origin,
            egui::vec2(layout.width as f32 * scale, layout.height as f32 * scale),
        ),
        0.0,
        LINE,
    );
    for p in &layout.placements {
        let r = egui::Rect::from_min_size(
            origin + egui::vec2(p.x as f32 * scale, p.y as f32 * scale),
            egui::vec2(
                p.placed_length as f32 * scale,
                p.placed_width as f32 * scale,
            ),
        );
        painter.rect_filled(r, 0.0, PALETTE[p.part.source_index % PALETTE.len()]);
        painter.rect_stroke(
            r,
            0.0,
            egui::Stroke::new(0.5_f32, MUTED),
            egui::StrokeKind::Inside,
        );
    }
    painter.text(
        rect.left_bottom() + egui::vec2(12.0, -17.0),
        egui::Align2::LEFT_CENTER,
        format!("利用率 {}", percent(layout.usage)),
        egui::FontId::proportional(11.0),
        MUTED,
    );
    response
}

pub fn draw_layout(
    ui: &mut egui::Ui,
    layout: &Layout,
    count: usize,
    live: bool,
    project: &serde_json::Value,
) {
    card().show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.label(
                RichText::new(format!(
                    "{} · {} · {} mm",
                    layout
                        .panel
                        .extra
                        .get("description")
                        .map(string)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "板材".into()),
                    if layout.panel.material.is_empty() {
                        "默认材质"
                    } else {
                        &layout.panel.material
                    },
                    pricing::format_number(layout.panel.thickness, 1, false, false)
                ))
                .size(16.0)
                .strong(),
            );
            if count > 1 {
                ui.label(RichText::new(format!("数量 × {count} 张")).color(BLUE));
            }
            if live {
                ui.label("试排中 · 非最终方案");
            }
        });
        let note = if live {
            format!(
                "{} × {} mm · {} 件",
                layout.width,
                layout.height,
                layout.placements.len()
            )
        } else {
            format!(
                "{} × {} mm · 实际利用率 {} · 计费 {} · 板材报价 {} + 切割费 {}{}",
                layout.width,
                layout.height,
                percent(layout.usage),
                percent(number(
                    layout
                        .pricing
                        .get("billingRate")
                        .unwrap_or(&serde_json::Value::Null),
                    0.0
                )),
                pricing::currency(number(
                    layout
                        .pricing
                        .get("panelCharge")
                        .unwrap_or(&serde_json::Value::Null),
                    0.0
                )),
                pricing::currency(number(
                    layout
                        .pricing
                        .get("cuttingFee")
                        .unwrap_or(&serde_json::Value::Null),
                    0.0
                )),
                if layout.is_full_sheet {
                    " · 整板件无需切割"
                } else {
                    ""
                }
            )
        };
        ui.label(RichText::new(note).small().color(MUTED));
        ui.separator();
        let height = ((ui.available_width() as f64 - 32.0) * layout.height / layout.width)
            .clamp(220.0, 420.0) as f32;
        let (area, _) = ui.allocate_exact_size(
            egui::vec2(ui.available_width(), height),
            egui::Sense::hover(),
        );
        let scale = ((area.width() - 20.0) / layout.width as f32)
            .min((area.height() - 20.0) / layout.height as f32);
        let origin = area.center()
            - egui::vec2(layout.width as f32 * scale, layout.height as f32 * scale) / 2.0;
        let board = egui::Rect::from_min_size(
            origin,
            egui::vec2(layout.width as f32 * scale, layout.height as f32 * scale),
        );
        let painter = ui.painter();
        painter.rect_filled(board, 0.0, Color32::from_rgb(237, 240, 233));
        painter.rect_stroke(
            board,
            0.0,
            egui::Stroke::new(1.0_f32, INK),
            egui::StrokeKind::Inside,
        );
        let to_rect = |x: f64, y: f64, w: f64, h: f64| {
            egui::Rect::from_min_size(
                origin + egui::vec2(x as f32 * scale, y as f32 * scale),
                egui::vec2(w as f32 * scale, h as f32 * scale),
            )
        };
        if !live {
            for free in &layout.free_rects {
                let rect = to_rect(free.x, free.y, free.w, free.h);
                let clipped = painter.with_clip_rect(rect.intersect(board));
                clipped.rect_filled(rect, 0.0, Color32::from_rgb(238, 241, 238));
                let mut x = rect.left() - rect.height();
                while x < rect.right() {
                    clipped.line_segment(
                        [
                            egui::pos2(x, rect.bottom()),
                            egui::pos2(x + rect.height(), rect.top()),
                        ],
                        egui::Stroke::new(1.0_f32, Color32::from_rgb(215, 220, 216)),
                    );
                    x += 12.0;
                }
            }
        }
        for (index, p) in layout.placements.iter().enumerate() {
            let rect = to_rect(p.x, p.y, p.placed_length, p.placed_width);
            painter.rect_filled(rect, 0.0, PALETTE[p.part.source_index % PALETTE.len()]);
            painter.rect_stroke(
                rect,
                0.0,
                egui::Stroke::new(
                    if live && index + 1 == layout.placements.len() {
                        2.0
                    } else {
                        0.8_f32
                    },
                    Color32::from_rgb(140, 169, 151),
                ),
                egui::StrokeKind::Inside,
            );
            let code = if layout.is_full_sheet {
                "整板件".into()
            } else {
                p.part
                    .extra
                    .get("code")
                    .filter(|v| truthy(v))
                    .map(string)
                    .unwrap_or_else(|| format!("P{}", p.part.source_index + 1))
            };
            let dimensions = format!(
                "{} × {}{}",
                pricing::format_number(p.part.length, 1, false, false),
                pricing::format_number(p.part.width, 1, false, false),
                if p.rotated { " · 90°" } else { "" }
            );
            if rect.width() > 65.0 && rect.height() > 30.0 {
                painter.text(
                    rect.center() - egui::vec2(0.0, 7.0),
                    egui::Align2::CENTER_CENTER,
                    &code,
                    egui::FontId::proportional(13.0),
                    INK,
                );
                painter.text(
                    rect.center() + egui::vec2(0.0, 9.0),
                    egui::Align2::CENTER_CENTER,
                    &dimensions,
                    egui::FontId::proportional(10.0),
                    INK,
                );
            }
            ui.interact(
                rect,
                ui.id().with(("part", &layout.id, index)),
                egui::Sense::hover(),
            )
            .on_hover_text(format!("{code} · {dimensions} mm"));
        }
        ui.label(
            RichText::new(if layout.is_full_sheet {
                "整板件直接发货，不计切割费".into()
            } else {
                format!(
                    "余料区域 · 锯缝 {} mm · 边距 {} / {} mm",
                    string(&project["settings"]["sawWidth"]),
                    string(&project["settings"]["panelMarginX"]),
                    string(&project["settings"]["panelMarginY"])
                )
            })
            .small()
            .color(MUTED),
        );
    });
}
pub fn print_preview(app: &mut App, ctx: &egui::Context) {
    let Some(document) = app.print_document.take() else {
        return;
    };
    let mut open = true;
    egui::Window::new("打印预览")
        .open(&mut open)
        .collapsible(false)
        .default_size([
            (ctx.content_rect().width() - 100.0).min(1100.0),
            (ctx.content_rect().height() - 100.0).min(800.0),
        ])
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                if dark(ui, "打印…").clicked()
                    && let Err(error) = printing::print_document(&document, None)
                {
                    app.notify(format!("打印失败：{error}"));
                }
                if ui.button("保存 PDF…").clicked()
                    && let Some(path) = rfd::FileDialog::new()
                        .add_filter("PDF", &["pdf"])
                        .set_file_name("板优排报告.pdf")
                        .save_file()
                {
                    if let Err(error) = printing::print_document(&document, Some(&path)) {
                        app.notify(format!("打印失败：{error}"));
                    } else {
                        app.notify("PDF 已保存");
                    }
                }
                ui.label(format!("共 {} 页", document.pages.len()));
            });
            ui.add_space(12.0);
            ui.separator();
            app.preview_page = app.preview_page.min(document.pages.len().saturating_sub(1));
            let width = ui.available_width();
            ui.horizontal_top(|ui| {
                ui.allocate_ui_with_layout(
                    egui::vec2(180.0, 0.0),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        ui.label(RichText::new("预览选项").size(16.0).strong());
                        ui.add_space(16.0);
                        header(ui, "纸张");
                        badge(ui, "A4 · 纵向");
                        header(ui, "页码");
                        egui::ComboBox::from_id_salt("preview-page")
                            .popup_style(compact_dropdown.into())
                            .selected_text(format!(
                                "第 {} 页 / 共 {} 页",
                                app.preview_page + 1,
                                document.pages.len()
                            ))
                            .show_ui(ui, |ui| {
                                for index in 0..document.pages.len() {
                                    ui.selectable_value(
                                        &mut app.preview_page,
                                        index,
                                        format!("第 {} 页", index + 1),
                                    );
                                }
                            });
                        ui.add_space(20.0);
                        ui.label(RichText::new("输出方式").color(MUTED));
                        ui.label("系统打印 / 保存 PDF");
                    },
                );
                egui::ScrollArea::vertical()
                    .id_salt("print-preview")
                    .max_height((ctx.content_rect().height() - 250.0).max(220.0))
                    .show(ui, |ui| {
                        ui.set_width((width - 200.0).max(300.0));
                        egui::Frame::new()
                            .fill(LINE)
                            .inner_margin(20)
                            .show(ui, |ui| {
                                if let Some(page) = document.pages.get(app.preview_page) {
                                    printing::paint_preview(ui, page);
                                }
                            });
                    });
            });
        });
    if open {
        app.print_document = Some(document);
    }
}
