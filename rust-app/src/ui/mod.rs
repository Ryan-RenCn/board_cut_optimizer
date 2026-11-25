pub mod inventory;
pub mod layouts;
pub mod parts;
pub mod project_library;
pub mod report;
pub mod settings;
pub mod theme;
use crate::{
    app::{App, View},
    model::string,
};
use eframe::egui::{self, Color32, RichText};
use theme::*;

pub fn render(app: &mut App, ctx: &egui::Context) {
    if let Some(error) = &app.fatal {
        egui::CentralPanel::default().show(ctx, |ui| {
            empty_state(ui, "板优排启动失败", "为保护原始数据，保存操作已禁用。");
            notice(ui, error);
            ui.label("请检查数据库路径和写入权限。原始数据未被默认工程覆盖。");
        });
        return;
    }
    let compact = ctx.content_rect().width() < 1200.0;
    egui::SidePanel::left("sidebar")
        .exact_width(if compact { 184.0 } else { 224.0 })
        .resizable(false)
        .frame(egui::Frame::new().fill(NAV).inner_margin(12))
        .show(ctx, |ui| {
            egui::ScrollArea::vertical()
                .id_salt("sidebar-scroll")
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    ui.style_mut().visuals.widgets.noninteractive.bg_stroke =
                        egui::Stroke::new(1.0_f32, Color32::from_rgb(48, 74, 66));
                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        let (rect, _) =
                            ui.allocate_exact_size(egui::vec2(36.0, 36.0), egui::Sense::hover());
                        ui.painter().rect_filled(rect, 8.0, ACCENT);
                        for (x, y, w, h) in [
                            (7.0, 7.0, 14.0, 10.0),
                            (23.0, 7.0, 6.0, 22.0),
                            (7.0, 19.0, 14.0, 10.0),
                        ] {
                            ui.painter().rect_filled(
                                egui::Rect::from_min_size(
                                    rect.min + egui::vec2(x, y),
                                    egui::vec2(w, h),
                                ),
                                1.0,
                                NAV,
                            );
                        }
                        ui.label(
                            RichText::new("板优排")
                                .size(22.0)
                                .strong()
                                .color(Color32::WHITE),
                        );
                    });
                    ui.add_space(8.0);
                    ui.label(RichText::new("精于每一寸板材").size(12.0).color(NAV_TEXT));
                    ui.add_space(18.0);
                    ui.separator();
                    ui.add_space(12.0);
                    ui.label(RichText::new("工程工作台").size(11.0).color(NAV_TEXT));
                    ui.add_space(8.0);
                    for (index, view) in View::ALL.into_iter().enumerate() {
                        if index == 3 {
                            ui.add_space(12.0);
                            ui.separator();
                            ui.add_space(12.0);
                        }
                        let selected = app.view == view;
                        let (rect, response) = ui.allocate_exact_size(
                            egui::vec2(ui.available_width(), 46.0),
                            egui::Sense::click(),
                        );
                        response.widget_info(|| {
                            egui::WidgetInfo::selected(
                                egui::WidgetType::SelectableLabel,
                                true,
                                selected,
                                view.label(),
                            )
                        });
                        let hover = response.hovered() || response.has_focus();
                        if selected || hover {
                            ui.painter()
                                .rect_filled(rect, 7.0, Color32::from_rgb(36, 74, 62));
                        }
                        if selected {
                            ui.painter().rect_filled(
                                egui::Rect::from_min_size(
                                    rect.min + egui::vec2(0.0, 12.0),
                                    egui::vec2(3.0, 22.0),
                                ),
                                1.0,
                                ACCENT,
                            );
                        }
                        if response.has_focus() {
                            ui.painter().rect_stroke(
                                rect,
                                7.0,
                                egui::Stroke::new(2.0_f32, ACCENT),
                                egui::StrokeKind::Inside,
                            );
                        }
                        paint_icon(
                            ui.painter(),
                            egui::Rect::from_min_size(
                                rect.min + egui::vec2(16.0, 13.0),
                                egui::vec2(20.0, 20.0),
                            ),
                            index,
                            if selected { ACCENT } else { NAV_TEXT },
                        );
                        ui.painter().text(
                            rect.min + egui::vec2(48.0, 23.0),
                            egui::Align2::LEFT_CENTER,
                            view.label(),
                            egui::FontId::proportional(14.0),
                            Color32::WHITE,
                        );
                        if !compact && index < 3 {
                            ui.painter().text(
                                rect.right_center() - egui::vec2(16.0, 0.0),
                                egui::Align2::RIGHT_CENTER,
                                format!("{:02}", index + 1),
                                egui::FontId::proportional(11.0),
                                NAV_TEXT,
                            );
                        }
                        if response.clicked() {
                            app.view = view;
                        }
                        ui.add_space(10.0);
                    }
                    ui.add_space(
                        (ctx.content_rect().bottom() - ui.cursor().top() - 168.0).max(0.0),
                    );
                    ui.label(RichText::new("LOCAL FIRST").color(ACCENT).size(10.0));
                    egui::Frame::new()
                        .fill(Color32::from_rgb(28, 57, 49))
                        .inner_margin(12)
                        .corner_radius(8)
                        .show(ui, |ui| {
                            ui.set_min_width(ui.available_width());
                            ui.label(RichText::new("数据仅保存在本机").color(NAV_TEXT).size(12.0));
                            ui.label(
                                RichText::new("离线可用 · 无需账号")
                                    .color(NAV_TEXT)
                                    .size(11.0),
                            );
                        });
                    ui.add_space(12.0);
                    if ui
                        .add(
                            egui::Button::new(RichText::new("关于与许可证").color(NAV_TEXT))
                                .frame(false),
                        )
                        .clicked()
                    {
                        app.show_license = true;
                    }
                });
        });
    egui::TopBottomPanel::top("topbar")
        .frame(
            egui::Frame::new()
                .fill(Color32::WHITE)
                .inner_margin(egui::Margin::symmetric(24, 14)),
        )
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.label(RichText::new("当前工程").size(10.0).color(MUTED));
                    if text(
                        ui,
                        &mut app.project["name"],
                        if compact { 170.0 } else { 220.0 },
                    )
                    .changed()
                    {
                        app.commit(false);
                    }
                });
                if !compact {
                    ui.label(RichText::new(app.save_status()).size(11.0).color(MUTED));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let mut actions = |ui: &mut egui::Ui| {
                        if dark(ui, "保存工程").clicked() {
                            app.save_project();
                        }
                        if ui.button("工程库").clicked() {
                            app.open_library();
                        }
                        if ui.button("＋ 新建").clicked() {
                            app.confirmation = Some(crate::app::Confirm::NewProject);
                        }
                    };
                    if ui.available_width() < 300.0 {
                        ui.menu_button("工程操作", &mut actions);
                    } else {
                        actions(ui);
                    }
                });
            });
        });
    egui::TopBottomPanel::bottom("statusbar")
        .frame(
            egui::Frame::new()
                .fill(Color32::WHITE)
                .inner_margin(egui::Margin::symmetric(24, 7)),
        )
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("矩形开料 · 仅支持 0° / 90° 旋转")
                        .size(11.0)
                        .color(MUTED),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        RichText::new(format!(
                            "缩放 {:.0}%  |  Rust 原生桌面版",
                            ctx.zoom_factor() * 100.0
                        ))
                        .size(11.0)
                        .color(MUTED),
                    );
                });
            });
        });
    egui::CentralPanel::default()
        .frame(
            egui::Frame::new()
                .fill(CANVAS)
                .inner_margin(if compact { 20 } else { 32 }),
        )
        .show(ctx, |ui| {
            egui::ScrollArea::both()
                .id_salt(("page", app.view.name()))
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    ui.set_min_width(ui.available_width().max(720.0));
                    match app.view {
                        View::Parts => parts::render(app, ui),
                        View::Layouts => layouts::render(app, ui),
                        View::Report => report::render(app, ui),
                        View::Inventory => inventory::render(app, ui),
                        View::Settings => settings::render(app, ui),
                    }
                    if app.view == View::Parts && app.parts_scroll_to_bottom {
                        app.parts_scroll_to_bottom = false;
                        // Wait until the new row is laid out; only move the vertical axis.
                        ui.scroll_with_delta_animation(
                            egui::vec2(0.0, -ui.min_rect().height()),
                            egui::style::ScrollAnimation::none(),
                        );
                    }
                });
        });
    project_library::render(app, ctx);
    layouts::print_preview(app, ctx);
    if app.show_license {
        let mut open = true;
        egui::Window::new("关于板优排")
            .open(&mut open)
            .default_width(640.0)
            .collapsible(false)
            .show(ctx, |ui| {
                ui.label(RichText::new("板优排 · 精于每一寸板材").size(24.0).strong());
                ui.label(RichText::new("矩形板材开料优化与报价 · Windows 原生桌面版").color(MUTED));
                ui.add_space(16.0);
                badge(ui, "Rust / egui / SQLite · 离线可用");
                ui.add_space(16.0);
                ui.label(format!("当前工程：{}", string(&app.project["name"])));
                ui.label("数据保存在 EXE 同级 data/ 文件夹中的 SQLite 数据库。");
                ui.label("仅支持矩形零件与 0° / 90° 旋转，不支持 CAD 异形。");
                ui.separator();
                egui::ScrollArea::vertical()
                    .max_height(350.0)
                    .show(ui, |ui| {
                        ui.collapsing("应用程序许可证 · MIT", |ui| {
                            ui.label(include_str!("../../../LICENSE"));
                        });
                        ui.collapsing("Noto Sans SC 字体许可证 · SIL OFL", |ui| {
                            ui.label(include_str!("../../resources/OFL.txt"));
                        });
                        ui.collapsing("第三方软件声明", |ui| {
                            ui.label(include_str!(concat!(
                                env!("OUT_DIR"),
                                "/third-party-notices.txt"
                            )));
                        });
                    });
            });
        app.show_license = open;
    }
    if let Some((message, when)) = &app.notification {
        if when.elapsed().as_secs_f32() > 3.2 {
            app.notification = None;
        } else {
            egui::Area::new(egui::Id::new("toast"))
                .anchor(egui::Align2::RIGHT_BOTTOM, [-24.0, -48.0])
                .order(egui::Order::Foreground)
                .show(ctx, |ui| {
                    egui::Frame::new()
                        .fill(NAV)
                        .stroke(egui::Stroke::new(1.0_f32, ACCENT))
                        .corner_radius(8)
                        .inner_margin(16)
                        .show(ui, |ui| {
                            ui.set_max_width(400.0);
                            ui.label(RichText::new(message).color(Color32::WHITE));
                        });
                });
        }
    }
}
