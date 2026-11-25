use board_cut_optimizer::{
    app::{App, View},
    ui,
};
use eframe::egui::{self, Rect, Vec2};

#[test]
fn adding_parts_reveals_the_last_row_once_at_different_window_sizes() {
    for size in [Vec2::new(1440.0, 920.0), Vec2::new(1000.0, 700.0)] {
        for focus in [false, true] {
            let mut app = App::new(true, false);
            app.invalidate(false);
            app.view = View::Parts;
            let ctx = egui::Context::default();
            ui::theme::configure(&ctx);
            let frame = |app: &mut App| {
                let _ = ctx.run(
                    egui::RawInput {
                        screen_rect: Some(Rect::from_min_size(egui::Pos2::ZERO, size)),
                        ..Default::default()
                    },
                    |ctx| ui::render(app, ctx),
                );
            };
            for _ in 0..25 {
                app.add_part(false);
            }
            for _ in 0..3 {
                frame(&mut app);
            }
            for _ in 0..2 {
                app.add_part(focus);
                assert!(app.parts_scroll_to_bottom);
                for _ in 0..3 {
                    frame(&mut app);
                }
                assert!(!app.parts_scroll_to_bottom);
                let id = app.cell_ids.last().unwrap().0;
                let response = ctx.read_response(id).unwrap();
                assert!(
                    response.rect.bottom() <= size.y && response.rect.top() >= 0.0,
                    "last row must be visible at {size:?}: {:?}",
                    response.rect
                );
            }
        }
    }
}
