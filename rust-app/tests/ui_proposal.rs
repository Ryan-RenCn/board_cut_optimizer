use board_cut_optimizer::{
    app::{App, Confirm, View},
    engine,
    model::Part,
    project, quotation, ui,
};
use eframe::egui::{self, Event, Pos2, Rect, Vec2};
use serde_json::json;

fn app() -> App {
    let mut app = App::new(true, false);
    app.invalidate(false);
    app.project = project::normalize(&project::demo(), None);
    let plan = engine::optimize(&app.project, true).unwrap();
    app.quote_rows = quotation::initialize_adjustments(&plan, &app.project);
    app.plan = Some(plan);
    app.view = View::Parts;
    app
}
fn frame(app: &mut App, ctx: &egui::Context, size: Vec2, events: Vec<Event>) -> egui::FullOutput {
    ctx.run(
        egui::RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, size)),
            events,
            ..Default::default()
        },
        |ctx| ui::render(app, ctx),
    )
}
fn text_center(output: &egui::FullOutput, label: &str) -> Pos2 {
    fn find(shape: &egui::Shape, label: &str) -> Option<Pos2> {
        match shape {
            egui::Shape::Text(t) if t.galley.text() == label => Some(t.pos + t.galley.size() / 2.0),
            egui::Shape::Vec(shapes) => shapes.iter().find_map(|s| find(s, label)),
            _ => None,
        }
    }
    output
        .shapes
        .iter()
        .find_map(|s| find(&s.shape, label).filter(|p| s.clip_rect.contains(*p)))
        .unwrap_or_else(|| panic!("visible text missing: {label}"))
}
fn click(app: &mut App, ctx: &egui::Context, size: Vec2, pos: Pos2) -> egui::FullOutput {
    frame(
        app,
        ctx,
        size,
        vec![
            Event::PointerMoved(pos),
            Event::PointerButton {
                pos,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: Default::default(),
            },
        ],
    );
    frame(
        app,
        ctx,
        size,
        vec![Event::PointerButton {
            pos,
            button: egui::PointerButton::Primary,
            pressed: false,
            modifiers: Default::default(),
        }],
    )
}
#[test]
fn pages_and_modal_states_render_without_mutating_business_data() {
    for size in [
        Vec2::new(1000.0, 700.0),
        Vec2::new(1440.0, 920.0),
        Vec2::new(1600.0, 1000.0),
    ] {
        let mut app = app();
        let before = app.project.clone();
        let ctx = egui::Context::default();
        ui::theme::configure(&ctx);
        for view in View::ALL {
            app.view = view;
            for _ in 0..3 {
                frame(&mut app, &ctx, size, vec![]);
            }
        }
        app.settings_template = true;
        app.view = View::Settings;
        frame(&mut app, &ctx, size, vec![]);
        app.open_library();
        frame(&mut app, &ctx, size, vec![]);
        app.library_open = false;
        app.confirmation = Some(Confirm::ClearParts);
        frame(&mut app, &ctx, size, vec![]);
        app.confirmation = None;
        app.show_license = true;
        frame(&mut app, &ctx, size, vec![]);
        app.show_license = false;
        app.print_document = app
            .plan
            .as_ref()
            .map(|p| board_cut_optimizer::platform::printing::layout_document(p, &app.project));
        app.preview_page = usize::MAX;
        frame(&mut app, &ctx, size, vec![]);
        app.print_document = None;
        assert!(app.preview_page < usize::MAX);
        assert_eq!(
            app.project, before,
            "presentation must not change project at {size:?}"
        );
        // Stale selection state is clamped after loading a different plan.
        app.selected_layout = usize::MAX;
        app.selected_quote = usize::MAX;
        app.view = View::Layouts;
        frame(&mut app, &ctx, size, vec![]);
        app.view = View::Report;
        frame(&mut app, &ctx, size, vec![]);
        assert!(app.selected_layout < usize::MAX && app.selected_quote < usize::MAX);
        let part = Part::from_source(&json!({"length":9999,"width":500,"quantity":1}), 0, 0);
        app.plan.as_mut().unwrap().unplaced.push(part);
        frame(&mut app, &ctx, size, vec![]);
        app.view = View::Layouts;
        frame(&mut app, &ctx, size, vec![]);
        app.invalidate(false);
        app.project["parts"] = json!([]);
        for view in [View::Parts, View::Layouts, View::Report] {
            app.view = view;
            frame(&mut app, &ctx, size, vec![]);
        }
    }
}
#[test]
fn csv_replacement_changes_the_draft_only_after_confirmation() {
    for size in [Vec2::new(1000.0, 700.0), Vec2::new(1440.0, 920.0)] {
        let mut app = app();
        app.commit(false);
        assert!(app.flush());
        let original = app.project.clone();
        let before = app.store.as_ref().unwrap().draft().unwrap();
        assert!(
            app.prepare_parts_import("数量,长度,宽度,厚度\n1,oops,200,18")
                .is_err()
        );
        assert!(app.confirmation.is_none());
        assert_eq!(app.project, original);
        assert!(app.plan.is_some());
        let csv = "数量,长度,宽度,厚度\n1,100,200,18";
        let ctx = egui::Context::default();
        ui::theme::configure(&ctx);
        app.prepare_parts_import(csv).unwrap();
        assert!(matches!(app.confirmation, Some(Confirm::ReplaceParts(_))));
        let mut output = frame(&mut app, &ctx, size, vec![]);
        for _ in 0..2 {
            output = frame(&mut app, &ctx, size, vec![]);
        }
        text_center(
            &output,
            "CSV 的 1 种零件将替换当前清单中的 5 种零件，不会追加。",
        );
        click(&mut app, &ctx, size, text_center(&output, "取消"));
        assert!(app.confirmation.is_none());
        assert_eq!(app.project, original);
        assert!(app.plan.is_some());
        assert!(app.flush());
        assert_eq!(app.store.as_ref().unwrap().draft().unwrap(), before);

        app.prepare_parts_import(csv).unwrap();
        let mut output = frame(&mut app, &ctx, size, vec![]);
        for _ in 0..2 {
            output = frame(&mut app, &ctx, size, vec![]);
        }
        assert_eq!(app.project, original);
        click(&mut app, &ctx, size, text_center(&output, "替换清单"));
        assert!(app.confirmation.is_none());
        assert!(app.plan.is_none());
        assert_eq!(app.project["parts"].as_array().unwrap().len(), 1);
        assert_eq!(app.project["parts"][0]["length"].as_f64(), Some(100.0));
        assert!(app.flush());
        assert_eq!(
            app.store.as_ref().unwrap().draft().unwrap().unwrap()["parts"],
            app.project["parts"]
        );
    }
}

#[test]
fn pages_render_at_supported_zoom_extremes() {
    let mut app = app();
    let original = app.project.clone();
    for zoom in [0.5, 1.5, 2.0] {
        let ctx = egui::Context::default();
        ui::theme::configure(&ctx);
        ctx.set_zoom_factor(zoom);
        for view in View::ALL {
            app.view = view;
            for _ in 0..3 {
                frame(&mut app, &ctx, Vec2::new(1000.0, 700.0), vec![]);
            }
        }
    }
    assert_eq!(original, app.project);
}

#[test]
fn template_tab_and_placeholder_copy_work_without_changing_template() {
    let mut app = app();
    app.view = View::Settings;
    let original = app.project["settings"]["quotationTemplate"].clone();
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let size = Vec2::new(1600.0, 1200.0);
    let mut output = frame(&mut app, &ctx, size, vec![]);
    for _ in 0..2 {
        output = frame(&mut app, &ctx, size, vec![]);
    }
    let pos = text_center(&output, "报价文本模板");
    click(&mut app, &ctx, size, pos);
    assert!(app.settings_template);
    for _ in 0..3 {
        output = frame(&mut app, &ctx, size, vec![]);
    }
    let pos = text_center(&output, "{{工程名称}}");
    let output = click(&mut app, &ctx, size, pos);
    assert!(
        output
            .platform_output
            .commands
            .iter()
            .any(|c| matches!(c,egui::OutputCommand::CopyText(t) if t=="{{工程名称}}"))
    );
    assert_eq!(app.project["settings"]["quotationTemplate"], original);
}
#[test]
fn quote_reset_restores_selected_board_and_preserves_other_boards() {
    let mut app = app();
    app.view = View::Report;
    app.project["taxRate"] = json!(13);
    let expected = quotation::initialize_adjustments(app.plan.as_ref().unwrap(), &app.project);
    app.quote_rows[0].panel_charge = 999.0;
    app.quote_rows[0].taxed_panel_charge = 1128.87;
    app.quote_rows[1].panel_charge = 1234.0;
    app.save_quote_adjustments();
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let size = Vec2::new(1600.0, 1600.0);
    let mut output = frame(&mut app, &ctx, size, vec![]);
    for _ in 0..3 {
        output = frame(&mut app, &ctx, size, vec![]);
    }
    let pos = text_center(&output, "恢复此板自动计价");
    click(&mut app, &ctx, size, pos);
    assert_eq!(app.quote_rows[0].panel_charge, expected[0].panel_charge);
    assert_eq!(
        app.quote_rows[0].taxed_panel_charge,
        expected[0].taxed_panel_charge
    );
    assert_eq!(app.quote_rows[1].panel_charge, 1234.0);
    let restored = quotation::initialize_adjustments(app.plan.as_ref().unwrap(), &app.project);
    assert_eq!(restored[0].panel_charge, expected[0].panel_charge);
}
#[test]
fn incomplete_report_blocks_print_and_copy_and_empty_parts_block_optimization() {
    let mut app = app();
    app.plan.as_mut().unwrap().unplaced.push(Part::from_source(
        &json!({"length":9999,"width":500,"quantity":1}),
        0,
        0,
    ));
    app.view = View::Report;
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let size = Vec2::new(1600.0, 1600.0);
    let mut output = frame(&mut app, &ctx, size, vec![]);
    for _ in 0..3 {
        output = frame(&mut app, &ctx, size, vec![]);
    }
    let pos = text_center(&output, "打印报告");
    click(&mut app, &ctx, size, pos);
    assert!(app.print_document.is_none());
    let output = frame(&mut app, &ctx, size, vec![]);
    let pos = text_center(&output, "复制文本");
    let output = click(&mut app, &ctx, size, pos);
    assert!(
        !output
            .platform_output
            .commands
            .iter()
            .any(|c| matches!(c, egui::OutputCommand::CopyText(_)))
    );
    app.invalidate(false);
    app.project["parts"] = json!([]);
    app.view = View::Parts;
    let mut output = frame(&mut app, &ctx, size, vec![]);
    for _ in 0..2 {
        output = frame(&mut app, &ctx, size, vec![]);
    }
    let pos = text_center(&output, "开始优化 →");
    click(&mut app, &ctx, size, pos);
    assert!(app.job.is_none() && app.plan.is_none());
}

#[test]
fn report_second_row_contains_quote_and_adjustments_with_tax_inside() {
    fn assert_removed_usage_details(shape: &egui::Shape) {
        match shape {
            egui::Shape::Text(text) => {
                assert!(!text.galley.text().contains("按材质 / 厚度 / 规格汇总"));
                assert!(!text.galley.text().contains("按已使用整张板材统计"));
            }
            egui::Shape::Vec(shapes) => {
                for shape in shapes {
                    assert_removed_usage_details(shape);
                }
            }
            _ => {}
        }
    }
    for size in [Vec2::new(1440.0, 1200.0), Vec2::new(1600.0, 1200.0)] {
        let mut app = app();
        app.view = View::Report;
        let ctx = egui::Context::default();
        ui::theme::configure(&ctx);
        let mut output = frame(&mut app, &ctx, size, vec![]);
        for _ in 0..3 {
            output = frame(&mut app, &ctx, size, vec![]);
        }
        for shape in &output.shapes {
            assert_removed_usage_details(&shape.shape);
        }
        let metrics = text_center(&output, "税后总报价");
        let quote = text_center(&output, "报价明细文本");
        let usage = text_center(&output, "板材总量使用");
        let adjustment = text_center(&output, "本单报价调整");
        let tax = text_center(&output, "材料税率");
        let table = text_center(&output, "逐板计费明细");
        assert!(metrics.y < quote.y && (quote.y - adjustment.y).abs() < 1.0);
        assert!(quote.x < usage.x && usage.x < adjustment.x);
        assert!((usage.y - adjustment.y).abs() < 1.0);
        assert!(tax.x >= adjustment.x - 100.0);
        for label in [
            "板材实际总面积",
            "零件实际占用面积",
            "未占用面积（含锯缝）",
            "综合实际利用率",
        ] {
            text_center(&output, label);
        }
        assert!(tax.y > adjustment.y && tax.y < table.y && table.y > quote.y);
    }
}

#[test]
fn quote_text_card_matches_adjustment_height_for_short_and_long_quotes() {
    fn containing_card(output: &egui::FullOutput, point: Pos2) -> Rect {
        fn collect(shape: &egui::Shape, point: Pos2, rects: &mut Vec<Rect>) {
            match shape {
                egui::Shape::Rect(r)
                    if r.fill == egui::Color32::WHITE
                        && r.rect.contains(point)
                        && r.rect.width() > 200.0 =>
                {
                    rects.push(r.rect)
                }
                egui::Shape::Vec(shapes) => {
                    for shape in shapes {
                        collect(shape, point, rects);
                    }
                }
                _ => {}
            }
        }
        let mut rects = Vec::new();
        for shape in &output.shapes {
            collect(&shape.shape, point, &mut rects);
        }
        rects
            .into_iter()
            .min_by(|a, b| a.area().total_cmp(&b.area()))
            .expect("card background")
    }
    for size in [Vec2::new(1440.0, 1200.0), Vec2::new(1600.0, 1200.0)] {
        for template in [
            "{{税后合计}}".to_owned(),
            "很长的报价明细 {{板材报价}}\n".repeat(120),
        ] {
            let mut app = app();
            app.view = View::Report;
            app.project["settings"]["quotationTemplate"] = json!(template);
            let ctx = egui::Context::default();
            ui::theme::configure(&ctx);
            let mut output = frame(&mut app, &ctx, size, vec![]);
            for _ in 0..3 {
                output = frame(&mut app, &ctx, size, vec![]);
            }
            let quote = containing_card(&output, text_center(&output, "报价明细文本"));
            let adjustment = containing_card(&output, text_center(&output, "本单报价调整"));
            let usage = containing_card(&output, text_center(&output, "板材总量使用"));
            assert!((usage.top() - adjustment.top()).abs() < 1.0);
            assert!((usage.bottom() - adjustment.bottom()).abs() < 1.0);
            assert!(quote.right() < usage.left() && usage.right() < adjustment.left());
            assert!((quote.top() - adjustment.top()).abs() < 1.0);
            assert!(
                (quote.bottom() - adjustment.bottom()).abs() < 1.0,
                "quote {quote:?}, adjustment {adjustment:?}"
            );
            assert!(
                quote.height() < 700.0,
                "long text must scroll instead of growing the card"
            );
        }
    }
}

#[test]
fn tax_in_adjustment_panel_reprices_all_boards_and_persists() {
    let mut app = app();
    app.view = View::Report;
    app.project["taxRate"] = json!(0);
    let original = app.quote_rows.clone();
    let settings = app.project["settings"].clone();
    let ctx = egui::Context::default();
    ui::theme::configure(&ctx);
    let size = Vec2::new(1600.0, 1400.0);
    let mut output = frame(&mut app, &ctx, size, vec![]);
    for _ in 0..3 {
        output = frame(&mut app, &ctx, size, vec![]);
    }
    let pos = text_center(&output, "0.00%");
    click(&mut app, &ctx, size, pos);
    frame(&mut app, &ctx, size, vec![]);
    frame(
        &mut app,
        &ctx,
        size,
        vec![
            egui::Event::Key {
                key: egui::Key::A,
                physical_key: None,
                pressed: true,
                repeat: false,
                modifiers: egui::Modifiers {
                    ctrl: true,
                    command: true,
                    ..Default::default()
                },
            },
            egui::Event::Text("13".into()),
        ],
    );
    frame(
        &mut app,
        &ctx,
        size,
        vec![egui::Event::Key {
            key: egui::Key::Enter,
            physical_key: None,
            pressed: true,
            repeat: false,
            modifiers: Default::default(),
        }],
    );
    assert_eq!(app.project["taxRate"], 13.0);
    for (before, after) in original.iter().zip(&app.quote_rows) {
        assert_eq!(before.panel_charge, after.panel_charge);
        assert_eq!(before.cutting_fee, after.cutting_fee);
        assert_eq!(
            after.taxed_panel_charge,
            board_cut_optimizer::pricing::material_after_tax(after.panel_charge, 13.0)
        );
    }
    assert_eq!(settings, app.project["settings"]);
    let restored = quotation::initialize_adjustments(app.plan.as_ref().unwrap(), &app.project);
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(&app.quote_rows).unwrap()
    );
}

#[test]
fn principal_text_pairs_meet_wcag_aa_contrast() {
    fn luminance(c: egui::Color32) -> f64 {
        let rgb = [c.r(), c.g(), c.b()].map(|v| {
            let n = v as f64 / 255.0;
            if n <= 0.04045 {
                n / 12.92
            } else {
                ((n + 0.055) / 1.055).powf(2.4)
            }
        });
        rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    }
    for (fg, bg) in [
        (egui::Color32::WHITE, ui::theme::BLUE),
        (ui::theme::MUTED, egui::Color32::WHITE),
        (ui::theme::INK, ui::theme::CANVAS),
        (ui::theme::BLUE, ui::theme::SELECTED),
        (ui::theme::NAV_TEXT, ui::theme::NAV),
    ] {
        let a = luminance(fg);
        let b = luminance(bg);
        assert!((a.max(b) + 0.05) / (a.min(b) + 0.05) >= 4.5);
    }
}
