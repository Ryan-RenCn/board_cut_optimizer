use board_cut_optimizer::{
    app::{App, View},
    project, ui,
};
use eframe::egui::{self, Event, Key, Modifiers, Pos2, Rect, Vec2};
use serde_json::json;

fn pointer(pos: Pos2, pressed: bool) -> Vec<Event> {
    vec![
        Event::PointerMoved(pos),
        Event::PointerButton {
            pos,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: Modifiers::NONE,
        },
    ]
}
fn key(key: Key) -> Event {
    Event::Key {
        key,
        physical_key: None,
        pressed: true,
        repeat: false,
        modifiers: Modifiers::NONE,
    }
}
fn raw(events: Vec<Event>) -> egui::RawInput {
    egui::RawInput {
        screen_rect: Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(1440.0, 920.0))),
        events,
        ..Default::default()
    }
}
fn input_frame(ctx: &egui::Context, value: &mut String, events: Vec<Event>) -> egui::Response {
    let mut response = None;
    let _ = ctx.run(raw(events), |ctx| {
        egui::CentralPanel::default().show(ctx, |ui| {
            response = Some(
                ui::theme::singleline(value)
                    .id_salt("input")
                    .desired_width(240.0)
                    .show(ui)
                    .response,
            );
        });
    });
    response.unwrap()
}
fn selection(ctx: &egui::Context, id: egui::Id) -> std::ops::Range<usize> {
    egui::TextEdit::load_state(ctx, id)
        .unwrap()
        .cursor
        .char_range()
        .unwrap()
        .as_sorted_char_range()
}
#[test]
fn mouse_focus_selects_unicode_text_then_typing_replaces_it() {
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let mut value = "中文备注 ABC 123".to_string();
    let response = input_frame(&ctx, &mut value, vec![]);
    let pos = response.rect.right_center() - egui::vec2(12.0, 0.0);
    input_frame(&ctx, &mut value, pointer(pos, true));
    input_frame(&ctx, &mut value, pointer(pos, false));
    assert_eq!(selection(&ctx, response.id), 0..value.chars().count());
    input_frame(&ctx, &mut value, vec![Event::Text("新备注".into())]);
    assert_eq!(value, "新备注");
    // Wait beyond the double-click interval so this is an ordinary caret click.
    for _ in 0..40 {
        input_frame(&ctx, &mut value, vec![]);
    }
    // Once already focused, another click should position the caret, not reselect all.
    input_frame(&ctx, &mut value, pointer(pos, true));
    input_frame(&ctx, &mut value, pointer(pos, false));
    assert!(selection(&ctx, response.id).is_empty());
}
#[test]
fn keyboard_focus_selects_once_without_interrupting_editing_or_ime() {
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let mut value = "2440".to_string();
    let response = input_frame(&ctx, &mut value, vec![]);
    ctx.memory_mut(|m| m.request_focus(response.id));
    input_frame(&ctx, &mut value, vec![]);
    assert_eq!(selection(&ctx, response.id), 0..4);
    input_frame(&ctx, &mut value, vec![Event::Text("900".into())]);
    input_frame(&ctx, &mut value, vec![]);
    assert_eq!(value, "900");
    assert!(selection(&ctx, response.id).is_empty());
    input_frame(&ctx, &mut value, vec![key(Key::Home)]);
    input_frame(&ctx, &mut value, vec![Event::Text("A".into())]);
    assert_eq!(value, "A900");
    input_frame(
        &ctx,
        &mut value,
        vec![
            Event::Ime(egui::ImeEvent::Enabled),
            Event::Ime(egui::ImeEvent::Preedit("木".into())),
        ],
    );
    input_frame(
        &ctx,
        &mut value,
        vec![Event::Ime(egui::ImeEvent::Commit("木".into()))],
    );
    assert!(value.contains('木'));
    assert!(value.contains("900"));
}
#[test]
fn table_tab_focus_allows_direct_numeric_replacement() {
    let mut app = App::new(true, false);
    app.invalidate(false);
    app.view = View::Parts;
    app.project = project::normalize(
        &json!({"panels":[{"length":2440,"width":1220,"thickness":18}],"parts":[{"length":720,"width":560,"thickness":18,"quantity":2}]}),
        None,
    );
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let frame = |app: &mut App, events: Vec<Event>| {
        let _ = ctx.run(raw(events), |ctx| {
            app.keyboard(ctx);
            ui::render(app, ctx);
        });
    };
    for _ in 0..3 {
        frame(&mut app, vec![]);
    }
    let length = app
        .cell_ids
        .iter()
        .find(|(_, r, c)| (*r, *c) == (0, 0))
        .unwrap()
        .0;
    let width = app
        .cell_ids
        .iter()
        .find(|(_, r, c)| (*r, *c) == (0, 1))
        .unwrap()
        .0;
    ctx.memory_mut(|m| m.request_focus(length));
    frame(&mut app, vec![]);
    assert_eq!(selection(&ctx, length), 0..3);
    frame(&mut app, vec![Event::Text("900".into())]);
    assert_eq!(app.project["parts"][0]["length"], 900.0);
    frame(&mut app, vec![key(Key::Tab)]);
    frame(&mut app, vec![]);
    assert_eq!(ctx.memory(|m| m.focused()), Some(width));
    assert_eq!(selection(&ctx, width), 0..3);
    frame(&mut app, vec![Event::Text("450".into())]);
    assert_eq!(app.project["parts"][0]["width"], 450.0);
}
#[test]
fn dropdown_rows_are_compact_and_closed_control_height_is_unchanged() {
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let mut rows = Vec::new();
    let mut control = None;
    let mut frame = |events| {
        rows.clear();
        let _ = ctx.run(raw(events), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                // Match the taller controls inherited by part-table cells.
                ui.spacing_mut().interact_size.y = ui::theme::INPUT_HEIGHT;
                let output = egui::ComboBox::from_id_salt("compact-test")
                    .popup_style(ui::theme::compact_dropdown.into())
                    .selected_text("胡桃木")
                    .show_ui(ui, |ui| {
                        for label in ["胡桃木", "白橡木", "多层板"] {
                            rows.push(ui.selectable_label(false, label).rect);
                        }
                    });
                control = Some(output.response.rect);
            });
        });
        (control.unwrap(), rows.clone())
    };
    let (closed, _) = frame(vec![]);
    frame(pointer(closed.center(), true));
    frame(pointer(closed.center(), false));
    frame(vec![]);
    let (open, rows) = frame(vec![]);
    assert_eq!(rows.len(), 3);
    assert!((closed.height() - open.height()).abs() < 0.1);
    for row in &rows {
        assert!(row.height() <= 26.0, "row too tall: {row:?}");
    }
    for pair in rows.windows(2) {
        assert!((pair[1].top() - pair[0].bottom() - 2.0).abs() < 0.1);
    }
}

#[test]
fn thickness_input_only_selects_existing_stock_for_current_material() {
    let mut app = App::new(true, false);
    app.invalidate(false);
    app.view = View::Parts;
    app.project = project::normalize(
        &json!({
            "panels":[
                {"material":"A","length":2440,"width":1220,"thickness":18},
                {"material":"A","length":2440,"width":1220,"thickness":9.5},
                {"material":"B","length":2440,"width":1220,"thickness":12}
            ],
            "parts":[{"material":"A","length":720,"width":560,"thickness":18,"quantity":2}]
        }),
        None,
    );
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let frame = |app: &mut App, events: Vec<Event>| {
        let _ = ctx.run(raw(events), |ctx| {
            app.keyboard(ctx);
            ui::render(app, ctx);
        });
    };
    for _ in 0..3 {
        frame(&mut app, vec![]);
    }
    let thickness_id = app
        .cell_ids
        .iter()
        .find(|(_, r, c)| (*r, *c) == (0, 3))
        .unwrap()
        .0;
    for (input, expected) in [("9.5", 9.5), ("12", 9.5), ("20", 9.5), ("18", 18.0)] {
        ctx.memory_mut(|m| m.request_focus(thickness_id));
        frame(&mut app, vec![]);
        frame(&mut app, vec![Event::Text(input.into())]);
        assert_eq!(app.project["parts"][0]["thickness"], expected);
        frame(&mut app, vec![key(Key::Tab)]);
        frame(&mut app, vec![]);
        assert_eq!(app.editing["part-0-thickness"], expected.to_string());
    }
}
