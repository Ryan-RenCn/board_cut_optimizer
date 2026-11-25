use board_cut_optimizer::{
    app::{App, View},
    project, ui,
};
use eframe::egui::{self, Rect, Vec2};
use serde_json::json;

#[test]
fn singleline_text_is_vertically_centered_for_editable_and_readonly_fields() {
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    for content in [
        "",
        "中文备注 ABC 123",
        "很长的零件编号 ABC-1234567890-1234567890",
    ] {
        for interactive in [true, false] {
            let mut value = content.to_string();
            let _ = ctx.run(egui::RawInput::default(), |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    let output = ui::theme::singleline(&mut value)
                        .desired_width(140.0)
                        .interactive(interactive)
                        .show(ui);
                    let text_center = output.galley_pos.y + output.galley.size().y / 2.0;
                    assert!(
                        (text_center - output.response.rect.center().y).abs() <= 0.6,
                        "{content:?}: text at {text_center}, field {:?}",
                        output.response.rect
                    );
                    assert_eq!(output.response.rect.height(), ui::theme::INPUT_HEIGHT);
                });
            });
        }
    }
}

#[test]
fn parts_controls_share_row_centers_and_stable_columns_at_both_window_sizes() {
    for size in [Vec2::new(1440.0, 920.0), Vec2::new(1000.0, 700.0)] {
        let mut app = App::new(true, false);
        app.invalidate(false);
        let material = "特别长的材质名称不应撑宽列或挤歪后面的输入框";
        app.project = project::normalize(
            &json!({
                "panels":[{"material":material,"length":2440,"width":1220,"thickness":18}],
                "parts":[
                    {"material":material,"length":720,"width":560,"quantity":2,"thickness":18,"description":"侧板","code":"SIDE-01"},
                    {"material":material,"length":1120,"width":420,"quantity":2,"thickness":18,"description":"门板","code":"DOOR-02"}
                ]
            }),
            None,
        );
        app.view = View::Parts;
        let ctx = egui::Context::default();
        ui::theme::configure(&ctx);
        // Grids cache column geometry after their first sizing pass.
        for _ in 0..3 {
            let _ = ctx.run(
                egui::RawInput {
                    screen_rect: Some(Rect::from_min_size(egui::Pos2::ZERO, size)),
                    ..Default::default()
                },
                |ctx| ui::render(&mut app, ctx),
            );
        }
        assert_eq!(app.cell_ids.len(), 16);
        let rects: Vec<Vec<Rect>> = (0..2)
            .map(|row| {
                (0..8)
                    .map(|column| {
                        let id = app
                            .cell_ids
                            .iter()
                            .find(|(_, r, c)| (*r, *c) == (row, column))
                            .unwrap()
                            .0;
                        ctx.read_response(id).unwrap().rect
                    })
                    .collect()
            })
            .collect();
        for rects in &rects {
            let center = rects[0].center().y;
            for (column, rect) in rects.iter().enumerate() {
                assert!(
                    (rect.center().y - center).abs() <= 0.6,
                    "window {size:?}, column {column}: {rect:?} vs row center {center}"
                );
                assert!(
                    (rect.height() - ui::theme::INPUT_HEIGHT).abs() <= 0.6,
                    "window {size:?}, column {column}: unexpected control height {rect:?}"
                );
            }
            assert!(
                (rects[5].center().x - (rects[4].right() + 8.0 + 30.0)).abs() <= 0.6,
                "rotation checkbox should be centered under its header"
            );
            for pair in rects.windows(2) {
                assert!(
                    pair[0].right() < pair[1].left(),
                    "controls must not overlap"
                );
            }
        }
        for column in 0..8 {
            assert!((rects[0][column].left() - rects[1][column].left()).abs() <= 0.6);
            assert!((rects[0][column].width() - rects[1][column].width()).abs() <= 0.6);
        }
        assert!((rects[1][0].center().y - rects[0][0].center().y - 52.0).abs() <= 0.6);
        assert!(
            rects[0][2].width() <= 110.6,
            "long material must be truncated"
        );
    }
}
