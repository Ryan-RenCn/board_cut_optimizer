use super::theme::*;
use crate::{
    app::{App, Confirm},
    model::*,
    project,
};
use eframe::egui::{self, RichText};
use serde_json::json;
pub fn render(app: &mut App, ctx: &egui::Context) {
    if app.library_open {
        let mut load = None;
        let mut delete = None;
        let mut close = false;
        egui::Modal::new(egui::Id::new("project-library"))
            .frame(card().inner_margin(24))
            .show(ctx, |ui| {
                ui.set_width((ctx.content_rect().width() - 100.0).clamp(560.0, 960.0));
                ui.horizontal(|ui| {
                    ui.label(RichText::new("工程库").size(24.0).strong());
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("关闭").clicked() {
                            close = true;
                        }
                    });
                });
                ui.label(
                    RichText::new(
                        "工程保存在本机 SQLite 中；打开工程将使用当前全局板材库存和配置。",
                    )
                    .small()
                    .color(MUTED),
                );
                ui.separator();
                egui::ScrollArea::vertical()
                    .max_height((ctx.content_rect().height() * 0.55).min(500.0))
                    .show(ui, |ui| {
                        for item in &app.library {
                            ui.horizontal(|ui| {
                                ui.allocate_ui_with_layout(
                                    egui::vec2((ui.available_width() - 170.0).max(240.0), 70.0),
                                    egui::Layout::top_down(egui::Align::Min),
                                    |ui| {
                                        ui.set_min_width(ui.available_width());
                                        ui.style_mut().wrap_mode =
                                            Some(egui::TextWrapMode::Truncate);
                                        ui.label(RichText::new(string(&item["name"])).strong());
                                        ui.label(
                                            RichText::new(format!(
                                                "{} 种零件 · {}",
                                                rows(item, "parts").len(),
                                                string(&item["updatedAt"])
                                            ))
                                            .small()
                                            .color(MUTED),
                                        );
                                    },
                                );
                                if dark(ui, "打开").clicked() {
                                    load = Some(item.clone());
                                }
                                if ui.button(RichText::new("删除").color(DANGER)).clicked() {
                                    delete = Some(string(&item["id"]));
                                }
                            });
                            ui.separator();
                        }
                        if app.library.is_empty() {
                            empty_state(
                                ui,
                                "还没有保存的工程",
                                "保存当前工程后，就可以在这里重新打开。",
                            );
                        }
                    });
                ui.add_space(12.0);
                ui.label(
                    RichText::new("打开工程前，请先保存当前工程。删除操作需要二次确认。")
                        .small()
                        .color(MUTED),
                );
            });
        if close || (app.confirmation.is_none() && ctx.input(|i| i.key_pressed(egui::Key::Escape)))
        {
            app.library_open = false;
        }
        if let Some(project) = load {
            app.set_project(&project);
            app.library_open = false;
            app.notify("工程已打开");
        }
        if let Some(id) = delete {
            app.confirmation = Some(Confirm::DeleteProject(id));
        }
    }
    if let Some(confirmation) = app.confirmation.take() {
        let mut confirmed = false;
        let mut cancelled = false;
        let question = match &confirmation {
            Confirm::NewProject => "新建工程会清空当前未保存的数据，是否继续？".into(),
            Confirm::ClearParts => "确定清空零件清单吗？清空后将保留一行空白数据。".into(),
            Confirm::ReplaceParts(parts) => format!(
                "CSV 的 {} 种零件将替换当前清单中的 {} 种零件，不会追加。",
                parts.len(),
                rows(&app.project, "parts").len()
            ),
            Confirm::DeleteProject(_) => "确定从工程库删除这个工程吗？".into(),
        };
        let confirm_label = if matches!(&confirmation, Confirm::ReplaceParts(_)) {
            "替换清单"
        } else {
            "确认操作"
        };
        egui::Modal::new(egui::Id::new("confirmation"))
            .frame(card().inner_margin(24))
            .show(ctx, |ui| {
                ui.set_width(500.0);
                ui.label(
                    RichText::new(match &confirmation {
                        Confirm::NewProject => "确认新建工程？",
                        Confirm::ClearParts => "确认清空零件清单？",
                        Confirm::ReplaceParts(_) => "确认替换零件清单？",
                        Confirm::DeleteProject(_) => "确认删除工程？",
                    })
                    .size(22.0)
                    .strong(),
                );
                ui.add_space(16.0);
                notice(ui, &question);
                ui.add_space(12.0);
                ui.label(
                    RichText::new("建议先保存或备份需要保留的数据。此操作不能直接撤销。")
                        .color(MUTED),
                );
                ui.add_space(20.0);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add(
                            egui::Button::new(RichText::new(confirm_label).color(DANGER))
                                .fill(egui::Color32::from_rgb(253, 236, 238)),
                        )
                        .clicked()
                    {
                        confirmed = true;
                    }
                    if ui.button("取消").clicked() {
                        cancelled = true;
                    }
                });
            });
        if confirmed {
            match confirmation {
                Confirm::NewProject => app.set_project(&project::defaults()),
                Confirm::ClearParts => {
                    app.project["parts"] = json!([]);
                    app.editing.clear();
                    app.add_part(true);
                }
                Confirm::ReplaceParts(parts) => app.apply_parts_import(parts),
                Confirm::DeleteProject(id) => match app
                    .store
                    .as_ref()
                    .ok_or("数据库不可用".to_string())
                    .and_then(|s| s.delete_project(&id))
                {
                    Ok(_) => {
                        app.open_library();
                        app.notify("工程已删除");
                    }
                    Err(error) => app.notify(format!("删除失败：{error}")),
                },
            }
        } else if !cancelled && !ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            app.confirmation = Some(confirmation);
        }
    }
}
