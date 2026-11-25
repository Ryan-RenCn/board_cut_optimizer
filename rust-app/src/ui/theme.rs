use crate::{app::App, model::*, pricing};
use eframe::egui::{self, Color32, RichText, Stroke};
use serde_json::{Value, json};
pub const INK: Color32 = Color32::from_rgb(21, 43, 41);
pub const MUTED: Color32 = Color32::from_rgb(83, 103, 99);
pub const LINE: Color32 = Color32::from_rgb(223, 231, 227);
pub const CANVAS: Color32 = Color32::from_rgb(243, 246, 244);
pub const ACCENT: Color32 = Color32::from_rgb(198, 240, 172);
// Slightly deeper than the static proposal so green text on SELECTED meets AA.
pub const BLUE: Color32 = Color32::from_rgb(8, 123, 87);
pub const DANGER: Color32 = Color32::from_rgb(180, 35, 50);
pub const NAV: Color32 = Color32::from_rgb(19, 44, 41);
pub const NAV_TEXT: Color32 = Color32::from_rgb(199, 216, 208);
pub const SELECTED: Color32 = Color32::from_rgb(232, 245, 239);
pub const PALETTE: [Color32; 8] = [
    Color32::from_rgb(214, 231, 194),
    Color32::from_rgb(189, 220, 209),
    Color32::from_rgb(207, 219, 239),
    Color32::from_rgb(232, 220, 198),
    Color32::from_rgb(215, 208, 231),
    Color32::from_rgb(199, 220, 220),
    Color32::from_rgb(237, 211, 215),
    Color32::from_rgb(222, 229, 199),
];
pub fn configure(ctx: &egui::Context) {
    ctx.set_theme(egui::Theme::Light);
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "chinese".into(),
        egui::FontData::from_static(crate::resources::CHINESE_FONT).into(),
    );
    for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
        fonts
            .families
            .entry(family)
            .or_default()
            .insert(0, "chinese".into());
    }
    ctx.set_fonts(fonts);
    let mut style = (*ctx.style()).clone();
    style.visuals = egui::Visuals::light();
    style.visuals.override_text_color = Some(INK);
    style.visuals.panel_fill = CANVAS;
    style.visuals.window_fill = Color32::WHITE;
    style.visuals.widgets.inactive.bg_fill = Color32::WHITE;
    style.visuals.widgets.inactive.weak_bg_fill = Color32::WHITE;
    style.visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, LINE);
    style.visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, LINE);
    style.visuals.selection.bg_fill = SELECTED;
    style.visuals.selection.stroke = Stroke::new(1.5_f32, BLUE);
    style.visuals.widgets.hovered.weak_bg_fill = SELECTED;
    style.visuals.widgets.hovered.bg_fill = SELECTED;
    style.visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, BLUE);
    style.visuals.widgets.active.bg_fill = SELECTED;
    style.visuals.widgets.active.weak_bg_fill = SELECTED;
    style.visuals.widgets.active.bg_stroke = Stroke::new(2.0_f32, BLUE);
    style.visuals.widgets.active.fg_stroke = Stroke::new(1.5_f32, INK);
    style.visuals.widgets.hovered.fg_stroke = Stroke::new(1.5_f32, INK);
    style.visuals.window_corner_radius = egui::CornerRadius::same(12);
    style.visuals.window_stroke = Stroke::new(1.0_f32, LINE);
    style.visuals.striped = true;
    style.visuals.faint_bg_color = Color32::from_rgb(247, 249, 247);
    style.spacing.window_margin = egui::Margin::same(24);
    for widget in [
        &mut style.visuals.widgets.inactive,
        &mut style.visuals.widgets.hovered,
        &mut style.visuals.widgets.active,
    ] {
        widget.corner_radius = egui::CornerRadius::same(6);
    }
    style.spacing.item_spacing = egui::vec2(8.0, 8.0);
    style.spacing.button_padding = egui::vec2(12.0, 9.0);
    style
        .text_styles
        .insert(egui::TextStyle::Body, egui::FontId::proportional(13.0));
    style
        .text_styles
        .insert(egui::TextStyle::Button, egui::FontId::proportional(12.0));
    style
        .text_styles
        .insert(egui::TextStyle::Small, egui::FontId::proportional(11.0));
    ctx.set_style(style);
}
pub fn card() -> egui::Frame {
    egui::Frame::new()
        .fill(Color32::WHITE)
        .stroke(Stroke::new(1.0_f32, LINE))
        .inner_margin(20)
        .corner_radius(10)
}
pub fn heading(ui: &mut egui::Ui, eyebrow: &str, title: &str, description: &str) {
    ui.label(
        RichText::new(format!(
            "{}  /  {title}",
            if eyebrow.contains("GLOBAL") || eyebrow.contains("INVENTORY") {
                "全局资源"
            } else {
                "工程工作台"
            }
        ))
        .size(11.0)
        .color(MUTED),
    );
    ui.label(RichText::new(title).size(28.0).strong());
    ui.label(RichText::new(description).size(13.0).color(MUTED));
    ui.add_space(12.0);
}
pub fn page_heading(
    ui: &mut egui::Ui,
    eyebrow: &str,
    title: &str,
    description: &str,
    actions_width: f32,
    actions: impl FnOnce(&mut egui::Ui),
) {
    ui.label(
        RichText::new(format!(
            "{}  /  {title}",
            if eyebrow.contains("GLOBAL") || eyebrow.contains("INVENTORY") {
                "全局资源"
            } else {
                "工程工作台"
            }
        ))
        .size(11.0)
        .color(MUTED),
    );
    ui.horizontal(|ui| {
        ui.label(RichText::new(title).size(28.0).strong());
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.allocate_ui_with_layout(
                egui::vec2(actions_width.min(ui.available_width()), 40.0),
                egui::Layout::left_to_right(egui::Align::Center),
                actions,
            );
        });
    });
    ui.label(RichText::new(description).size(13.0).color(MUTED));
    ui.add_space(14.0);
}

pub fn primary(ui: &mut egui::Ui, label: &str) -> egui::Response {
    ui.add(
        egui::Button::new(RichText::new(label).color(Color32::WHITE))
            .fill(BLUE)
            .min_size(egui::vec2(112.0, 40.0)),
    )
}
pub fn dark(ui: &mut egui::Ui, label: &str) -> egui::Response {
    ui.add(
        egui::Button::new(RichText::new(label).color(Color32::WHITE))
            .fill(BLUE)
            .min_size(egui::vec2(100.0, 36.0)),
    )
}
pub fn header(ui: &mut egui::Ui, text: &str) {
    ui.label(RichText::new(text).size(11.0).color(MUTED));
}
pub fn notice(ui: &mut egui::Ui, text: &str) {
    egui::Frame::new()
        .fill(Color32::from_rgb(255, 245, 224))
        .inner_margin(14)
        .corner_radius(8)
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new(text).color(DANGER));
        });
}
pub fn badge(ui: &mut egui::Ui, label: &str) {
    egui::Frame::new()
        .fill(SELECTED)
        .corner_radius(5)
        .inner_margin(egui::Margin::symmetric(10, 5))
        .show(ui, |ui| {
            ui.label(RichText::new(label).size(12.0).color(BLUE));
        });
}

pub fn metric(ui: &mut egui::Ui, label: &str, value: &str, note: &str, accent: bool) {
    card().inner_margin(16).show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.set_min_height(82.0);
        ui.label(RichText::new(label).size(12.0).color(MUTED));
        ui.label(
            RichText::new(value)
                .size(28.0)
                .strong()
                .color(if accent { BLUE } else { INK }),
        );
        ui.label(RichText::new(note).size(11.0).color(MUTED));
    });
}

pub fn empty_state(ui: &mut egui::Ui, title: &str, description: &str) {
    ui.add_space(48.0);
    ui.vertical_centered(|ui| {
        let (rect, _) = ui.allocate_exact_size(egui::vec2(72.0, 72.0), egui::Sense::hover());
        ui.painter().rect_filled(rect, 18.0, SELECTED);
        paint_icon(ui.painter(), rect.shrink(19.0), 2, BLUE);
        ui.add_space(16.0);
        ui.label(RichText::new(title).size(22.0).strong());
        ui.add_space(8.0);
        ui.label(RichText::new(description).color(MUTED));
    });
    ui.add_space(40.0);
}

/// A compact, dependency-free vector icon family for the native navigation.
pub fn paint_icon(painter: &egui::Painter, rect: egui::Rect, kind: usize, color: Color32) {
    let pt =
        |x: f32, y: f32| rect.min + egui::vec2(x * rect.width() / 24.0, y * rect.height() / 24.0);
    let stroke = Stroke::new(1.5_f32, color);
    let segment = |a: (f32, f32), b: (f32, f32)| {
        painter.line_segment([pt(a.0, a.1), pt(b.0, b.1)], stroke);
    };
    let box_at = |x, y, w, h| {
        painter.rect_stroke(
            egui::Rect::from_min_max(pt(x, y), pt(x + w, y + h)),
            2.0,
            stroke,
            egui::StrokeKind::Inside,
        );
    };
    match kind {
        0 => {
            box_at(4.0, 3.0, 16.0, 18.0);
            for y in [8.0, 12.0, 16.0] {
                segment((8.0, y), (16.0, y));
            }
        }
        1 => {
            for (x, y) in [(3.0, 3.0), (14.0, 3.0), (3.0, 14.0), (14.0, 14.0)] {
                box_at(x, y, 7.0, 7.0);
            }
        }
        2 => {
            segment((4.0, 3.0), (4.0, 21.0));
            segment((4.0, 21.0), (21.0, 21.0));
            for (x, y) in [(9.0, 11.0), (14.0, 6.0), (19.0, 9.0)] {
                segment((x, 17.0), (x, y));
            }
        }
        3 => {
            for (a, b) in [
                ((3.0, 7.0), (12.0, 3.0)),
                ((12.0, 3.0), (21.0, 7.0)),
                ((21.0, 7.0), (21.0, 17.0)),
                ((21.0, 17.0), (12.0, 21.0)),
                ((12.0, 21.0), (3.0, 17.0)),
                ((3.0, 17.0), (3.0, 7.0)),
                ((3.0, 7.0), (12.0, 11.0)),
                ((12.0, 11.0), (21.0, 7.0)),
                ((12.0, 11.0), (12.0, 21.0)),
            ] {
                segment(a, b);
            }
        }
        _ => {
            for (y, x) in [(6.0, 9.0), (12.0, 15.0), (18.0, 8.0)] {
                segment((3.0, y), (21.0, y));
                painter.circle_filled(pt(x, y), 2.5, color);
            }
        }
    }
}

pub fn percent(value: f64) -> String {
    format!("{}%", pricing::format_number(value * 100.0, 1, true, false))
}
pub const INPUT_HEIGHT: f32 = 32.0;

/// Compact popup rows without changing closed controls or table geometry.
pub fn compact_dropdown(style: &mut egui::Style) {
    style.spacing.item_spacing.y = 2.0;
    style.spacing.button_padding = egui::vec2(8.0, 3.0);
    style.spacing.interact_size.y = 24.0;
}

/// Shared single-line editor: centered text and select-all on initial focus.
/// Subsequent clicks preserve ordinary caret placement and drag selection.
pub struct Singleline<'a> {
    inner: egui::TextEdit<'a>,
    interactive: bool,
}
impl Singleline<'_> {
    pub fn desired_width(mut self, width: f32) -> Self {
        self.inner = self.inner.desired_width(width);
        self
    }
    pub fn id_salt(mut self, id: impl std::hash::Hash) -> Self {
        self.inner = self.inner.id_salt(id);
        self
    }
    pub fn interactive(mut self, interactive: bool) -> Self {
        self.interactive = interactive;
        self.inner = self.inner.interactive(interactive);
        self
    }
    pub fn show(self, ui: &mut egui::Ui) -> egui::text_edit::TextEditOutput {
        let mut output = self.inner.show(ui);
        let composing = ui.input(|i| {
            i.events
                .iter()
                .any(|event| matches!(event, egui::Event::Ime(_)))
        });
        // Track focus as well as gained_focus: table navigation can request it
        // before the pass starts, which egui does not report as gained_focus.
        let focus_key = output.response.id.with("singleline-focus");
        let focused = output.response.has_focus();
        let previously_focused = ui.ctx().data_mut(|data| {
            let previous = data.get_temp::<bool>(focus_key).unwrap_or(false);
            data.insert_temp(focus_key, focused);
            previous
        });
        if self.interactive
            && focused
            && (output.response.gained_focus() || !previously_focused)
            && !output.response.changed()
            && !composing
        {
            let range = egui::text::CCursorRange::two(
                egui::text::CCursor::new(0),
                egui::text::CCursor::new(output.galley.text().chars().count()),
            );
            output.state.cursor.set_char_range(Some(range));
            output.state.clone().store(ui.ctx(), output.response.id);
            output.cursor_range = Some(range);
            ui.ctx().request_repaint();
        }
        output
    }
}
impl egui::Widget for Singleline<'_> {
    fn ui(self, ui: &mut egui::Ui) -> egui::Response {
        self.show(ui).response
    }
}
pub fn singleline(value: &mut String) -> Singleline<'_> {
    Singleline {
        inner: egui::TextEdit::singleline(value)
            .vertical_align(egui::Align::Center)
            .min_size(egui::vec2(0.0, INPUT_HEIGHT)),
        interactive: true,
    }
}

pub fn numeric(
    app: &mut App,
    ui: &mut egui::Ui,
    value: &mut Value,
    key: String,
    integer: bool,
    readonly: bool,
) -> (egui::Response, bool) {
    let mut text = app
        .editing
        .get(&key)
        .cloned()
        .unwrap_or_else(|| string(value));
    let response = ui.add_sized(
        [88.0, INPUT_HEIGHT],
        singleline(&mut text).id_salt(&key).interactive(!readonly),
    );
    let n = number(&json!(text), f64::NAN);
    let valid = if integer {
        valid_quantity(&json!(text))
    } else {
        n.is_finite()
    };
    let changed = response.changed() && valid && !readonly;
    if changed {
        *value = json!(n);
    }
    if response.lost_focus() && !valid {
        if integer {
            app.notify("零件数量必须为有效的非负整数");
        }
        text = string(value);
    }
    app.editing.insert(key, text);
    (response, changed)
}
pub fn text(ui: &mut egui::Ui, value: &mut Value, width: f32) -> egui::Response {
    let mut text = string(value);
    let response = ui.add_sized([width, INPUT_HEIGHT], singleline(&mut text));
    if response.changed() {
        *value = json!(text);
    }
    response
}
