#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use board_cut_optimizer::{
    app::App,
    engine,
    platform::{printing, single_instance::SingleInstance},
    project, quotation, ui,
};
use eframe::egui;
use std::path::Path;
fn main() -> eframe::Result {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "--print-probe") {
        let path = args
            .get(2)
            .expect("--print-probe requires an output PDF path");
        printing::print_probe(Some(Path::new(path))).expect("print probe PDF");
        return Ok(());
    }
    if args.get(1).is_some_and(|a| a == "--print-demo") {
        let directory = Path::new(
            args.get(2)
                .expect("--print-demo requires an output directory"),
        );
        std::fs::create_dir_all(directory).expect("create output directory");
        let project = project::normalize(&project::demo(), None);
        let plan = engine::optimize(&project, true).expect("demo optimization");
        let rows = quotation::initialize_adjustments(&plan, &project);
        printing::print_document(
            &printing::layout_document(&plan, &project),
            Some(&directory.join("rust-layout.pdf")),
        )
        .expect("print layout PDF");
        printing::print_document(
            &printing::report_document(&plan, &project, &rows),
            Some(&directory.join("rust-report.pdf")),
        )
        .expect("print report PDF");
        std::fs::write(
            directory.join("rust-report.csv"),
            quotation::export_report(&plan, &project, &rows).expect("report CSV"),
        )
        .expect("write report CSV");
        return Ok(());
    }
    let smoke = args.iter().any(|a| a == "--smoke");
    let _instance = if smoke {
        None
    } else {
        match SingleInstance::acquire() {
            Ok(Some(instance)) => Some(instance),
            Ok(None) => return Ok(()),
            Err(error) => {
                rfd::MessageDialog::new()
                    .set_title("板优排启动失败")
                    .set_description(error)
                    .set_level(rfd::MessageLevel::Error)
                    .show();
                return Ok(());
            }
        }
    };
    let icon = eframe::icon_data::from_png_bytes(include_bytes!("../resources/app-icon.png"))
        .expect("embedded app icon");
    let window_size = if smoke {
        std::env::var("BOARD_CUT_SMOKE_SIZE")
            .ok()
            .and_then(|s| {
                s.split_once('x')
                    .map(|(w, h)| (w.parse::<f32>().ok(), h.parse::<f32>().ok()))
            })
            .and_then(|(w, h)| Some([w?, h?]))
            .unwrap_or([1440.0, 920.0])
    } else {
        [1440.0, 920.0]
    };
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size(window_size)
            .with_min_inner_size([1000.0, 700.0])
            .with_icon(icon),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native(
        "板优排 · Rust 原生版",
        options,
        Box::new(move |cc| {
            ui::theme::configure(&cc.egui_ctx);
            Ok(Box::new(App::new(
                smoke,
                args.iter().any(|a| a == "--demo"),
            )))
        }),
    )
}
