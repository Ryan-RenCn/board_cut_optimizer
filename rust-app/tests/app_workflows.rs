use board_cut_optimizer::{
    app::{App, View},
    engine,
    model::*,
    project, quotation, ui,
};
use eframe::egui::{self, Event, Key, Modifiers};
use serde_json::{Value, json};
use std::{
    thread,
    time::{Duration, Instant},
};
fn base() -> Value {
    json!({"name":"回归工程","panels":[{"id":"panel","length":1000,"width":1000,"thickness":18,"cost":100}],"parts":[{"id":"part","length":500,"width":500,"thickness":18,"quantity":1}],"settings":{"sawWidth":0,"panelMarginX":0,"panelMarginY":0,"optimizationLevel":"quick"}})
}
fn app() -> App {
    let mut app = App::new(true, false);
    app.invalidate(false);
    app.project = project::normalize(&base(), None);
    app.view = View::Parts;
    app
}
fn frame(app: &mut App, ctx: &egui::Context, events: Vec<Event>) {
    let _ = ctx.run(
        egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(1440.0, 920.0),
            )),
            events,
            ..Default::default()
        },
        |ctx| {
            app.keyboard(ctx);
            ui::render(app, ctx);
        },
    );
}
fn key(key: Key, modifiers: Modifiers) -> Event {
    Event::Key {
        key,
        physical_key: None,
        pressed: true,
        repeat: false,
        modifiers,
    }
}
fn wait(app: &mut App) {
    let start = Instant::now();
    while app.job.is_some() {
        app.poll_job();
        assert!(start.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn demo_session_ignores_user_database_path_and_discards_edits() {
    const PROBE_PATH: &str = "BOARD_CUT_TEST_DEMO_PROBE_PATH";
    if let Some(path) = std::env::var_os(PROBE_PATH) {
        let path = std::path::PathBuf::from(path);
        let mut demo = App::new(false, true);
        assert!(demo.fatal.is_none());
        assert_eq!(
            demo.store.as_ref().unwrap().path,
            std::path::Path::new(":memory:")
        );
        assert!(!rows(&demo.project, "panels").is_empty());
        demo.project["description"] = json!("演示编辑");
        demo.commit(false);
        assert!(demo.flush());
        demo.save_project();
        drop(demo);
        let next = App::new(false, true);
        assert_eq!(next.project["description"], project::demo()["description"]);
        assert!(next.store.as_ref().unwrap().draft().unwrap().is_none());
        assert!(!path.exists());
        return;
    }
    let path = std::env::temp_dir().join(format!(
        "board-cut-demo-test-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "demo_session_ignores_user_database_path_and_discards_edits",
        ])
        .env(PROBE_PATH, &path)
        .env("BOARD_CUT_OPTIMIZER_DB_PATH", &path)
        .env("SMARTCUT_DB_PATH", &path)
        .output()
        .unwrap();
    if path.exists() {
        std::fs::remove_file(path).unwrap();
    }
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn save_ordering_and_scoped_global_configuration() {
    let mut app = app();
    app.commit(false);
    app.save_project();
    let saved = app.store.as_ref().unwrap().list_projects().unwrap()[0].clone();
    assert!(!saved["id"].is_null());
    assert!(saved.get("panels").is_none());
    assert!(saved.get("settings").is_none());
    assert_eq!(
        app.store.as_ref().unwrap().draft().unwrap().unwrap()["id"],
        saved["id"]
    );
    app.project["name"] = json!("后续编辑");
    app.commit(false);
    assert!(app.flush());
    assert_eq!(
        app.store.as_ref().unwrap().draft().unwrap().unwrap()["name"],
        "后续编辑"
    );
    assert_eq!(
        app.store.as_ref().unwrap().list_projects().unwrap().len(),
        1
    );
    app.save_global();
    assert_eq!(
        app.store
            .as_ref()
            .unwrap()
            .global_settings()
            .unwrap()
            .unwrap()["panels"][0]["cost"]
            .as_f64(),
        Some(100.0)
    );
    app.set_project(&project::defaults());
    assert_eq!(app.project["panels"][0]["cost"].as_f64(), Some(100.0));
    assert!(rows(&app.project, "parts").is_empty());
}
#[test]
fn current_loss_is_applied_when_background_search_finishes() {
    let mut app = app();
    app.start_optimization();
    app.project["lossRate"] = json!(20);
    wait(&mut app);
    let plan = app.plan.as_ref().unwrap();
    assert_eq!(plan.stats["lossRate"].as_f64(), Some(20.0));
    assert_eq!(plan.layouts[0].pricing["billingUsage"], 0.45);
    assert_eq!(app.quote_rows[0].panel_charge, 50.0);
}
#[test]
fn switching_project_invalidates_worker_and_preserves_legacy_geometry() {
    let mut app = app();
    app.project["parts"][0]["quantity"] = json!(1_000_000);
    app.start_optimization();
    let next = json!({"name":"旧工程","parts":[{"id":"legacy","length":100,"width":100,"quantity":1,"thickness":18,"shape":{"outer":[[0,0],[100,0],[0,100]]},"rotationAngles":[17],"cadSource":{"fileName":"old.dxf"}}]});
    app.set_project(&next);
    assert!(app.job.is_none());
    assert!(app.plan.is_none());
    assert!(app.preview.is_empty());
    let expected = project::normalize(&next, None)["parts"].clone();
    assert_eq!(app.project["parts"][0], expected[0]);
    app.flush();
    assert_eq!(
        app.store.as_ref().unwrap().draft().unwrap().unwrap()["parts"],
        expected
    );
}
#[test]
fn added_part_uses_a_valid_thickness_and_preserves_rotation_preference() {
    for (panels, parts, expected) in [
        (
            json!([{"material":"A","thickness":18},{"material":"B","thickness":9}]),
            json!([{"material":"B","thickness":9,"allowRotate":false}]),
            json!(18),
        ),
        (
            json!([{"material":"A","thickness":18},{"material":"A","thickness":9}]),
            json!([{"material":"A","thickness":18}]),
            json!(18),
        ),
        (
            json!([]),
            json!([{"material":"removed","thickness":9}]),
            json!(""),
        ),
    ] {
        let mut value = project::normalize(&json!({"panels":panels,"parts":parts}), None);
        project::add_part(&mut value);
        let added = rows(&value, "parts").last().unwrap();
        if expected.is_number() {
            assert_eq!(added["thickness"].as_f64(), expected.as_f64());
        } else {
            assert_eq!(added["thickness"], expected);
        }
        assert_eq!(
            added["material"],
            if panels.as_array().unwrap().is_empty() {
                json!("")
            } else {
                json!("A")
            }
        );
        assert_eq!(added["allowRotate"], parts[0]["allowRotate"] != false);
    }
}
#[test]
fn native_table_keyboard_navigation_and_end_of_row_append() {
    let mut app = app();
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    frame(&mut app, &ctx, vec![]);
    assert_eq!(app.cell_ids.len(), 8);
    let id = app.cell_ids[0].0;
    ctx.memory_mut(|m| m.request_focus(id));
    frame(&mut app, &ctx, vec![key(Key::Tab, Modifiers::NONE)]);
    assert_eq!(ctx.memory(|m| m.focused()), Some(app.cell_ids[1].0));
    let id = app.cell_ids.last().unwrap().0;
    ctx.memory_mut(|m| m.request_focus(id));
    frame(&mut app, &ctx, vec![key(Key::Tab, Modifiers::NONE)]);
    assert_eq!(rows(&app.project, "parts").len(), 2);
    assert_eq!(
        ctx.memory(|m| m.focused()),
        Some(
            app.cell_ids
                .iter()
                .find(|(_, r, c)| (*r, *c) == (1, 0))
                .unwrap()
                .0
        )
    );
    app.project["settings"]["partEntryKey"] = json!("enter");
    frame(&mut app, &ctx, vec![key(Key::Enter, Modifiers::SHIFT)]);
    assert_eq!(
        ctx.memory(|m| m.focused()),
        Some(
            app.cell_ids
                .iter()
                .find(|(_, r, c)| (*r, *c) == (0, 7))
                .unwrap()
                .0
        )
    );
    frame(&mut app, &ctx, vec![key(Key::ArrowDown, Modifiers::NONE)]);
    assert_eq!(
        ctx.memory(|m| m.focused()),
        Some(
            app.cell_ids
                .iter()
                .find(|(_, r, c)| (*r, *c) == (1, 7))
                .unwrap()
                .0
        )
    );
}
#[test]
fn numeric_quantity_edit_rejects_fractional_input() {
    let mut app = app();
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    frame(&mut app, &ctx, vec![]);
    let id = app
        .cell_ids
        .iter()
        .find(|(_, r, c)| (*r, *c) == (0, 4))
        .unwrap()
        .0;
    ctx.memory_mut(|m| m.request_focus(id));
    frame(&mut app, &ctx, vec![]);
    frame(
        &mut app,
        &ctx,
        vec![
            key(
                Key::A,
                Modifiers {
                    ctrl: true,
                    command: true,
                    ..Modifiers::NONE
                },
            ),
            Event::Text("1.5".into()),
        ],
    );
    assert_eq!(app.project["parts"][0]["quantity"], 1);
    frame(&mut app, &ctx, vec![key(Key::Tab, Modifiers::NONE)]);
    assert_eq!(app.editing["part-0-quantity"], "1");
}
#[test]
fn native_zoom_and_ime_keys_do_not_append_rows() {
    let mut app = app();
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    frame(&mut app, &ctx, vec![key(Key::Equals, Modifiers::CTRL)]);
    frame(&mut app, &ctx, vec![]);
    assert!((ctx.zoom_factor() - 1.1).abs() < 0.001);
    frame(&mut app, &ctx, vec![key(Key::Num0, Modifiers::CTRL)]);
    frame(&mut app, &ctx, vec![]);
    assert!((ctx.zoom_factor() - 1.0).abs() < 0.001);
    let last = app.cell_ids.last().unwrap().0;
    ctx.memory_mut(|m| m.request_focus(last));
    app.project["settings"]["partEntryKey"] = json!("enter");
    frame(
        &mut app,
        &ctx,
        vec![
            Event::Ime(egui::ImeEvent::Enabled),
            Event::Ime(egui::ImeEvent::Commit("胡桃木".into())),
            key(Key::Enter, Modifiers::NONE),
        ],
    );
    assert_eq!(rows(&app.project, "parts").len(), 1);
}
#[test]
fn manual_quotes_round_trip_through_native_state_and_sqlite() {
    let mut app = app();
    app.plan = Some(engine::optimize(&app.project, true).unwrap());
    app.quote_rows = quotation::initialize_adjustments(app.plan.as_ref().unwrap(), &app.project);
    app.quote_rows[0].panel_charge = 77.0;
    app.quote_rows[0].taxed_panel_charge = 90.0;
    app.save_quote_adjustments();
    assert!(app.flush());
    let saved = app.store.as_ref().unwrap().draft().unwrap().unwrap();
    let plan = app.plan.take().unwrap();
    let restored = quotation::initialize_adjustments(&plan, &saved);
    assert_eq!(restored[0].panel_charge, 77.0);
    assert_eq!(restored[0].taxed_panel_charge, 90.0);
}
