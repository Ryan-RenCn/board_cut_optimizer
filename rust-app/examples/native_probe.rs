#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::egui;
use std::time::{Duration, Instant};

struct Probe {
    text: String,
    status: String,
    started: Instant,
    smoke: bool,
    requested_screenshot: bool,
}

impl eframe::App for Probe {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("板优排 · Rust 原生技术验证");
            ui.label("独立原生窗口，无 Electron / WebView / JavaScript。");
            ui.label("中文显示：材质、厚度、零件清单、开料排版、税后报价。");
            ui.label("请在此输入中文，检查组词、候选框、回车确认和光标定位：");
            ui.text_edit_singleline(&mut self.text);
            ui.separator();
            #[cfg(windows)]
            if ui.button("打印一页测试（选择打印机）").clicked() {
                self.status = match board_cut_optimizer::platform::printing::print_probe(None) {
                    Ok(()) => "打印命令已完成；请检查实际输出。".into(),
                    Err(error) => format!("打印失败：{error}"),
                };
            }
            ui.label(&self.status);
            ui.collapsing("字体许可证（SIL OFL）", |ui| {
                ui.label(include_str!("../resources/OFL.txt"));
            });
        });
        if self.smoke
            && self.started.elapsed() > Duration::from_millis(800)
            && !self.requested_screenshot
        {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::default()));
            self.requested_screenshot = true;
        }
        let screenshot = ctx.input(|input| {
            input.events.iter().find_map(|event| {
                if let egui::Event::Screenshot { image, .. } = event {
                    Some(image.clone())
                } else {
                    None
                }
            })
        });
        if let Some(image) = screenshot {
            let output = std::env::var("BOARD_CUT_SMOKE_OUTPUT")
                .unwrap_or_else(|_| "../.test-output/rust-probe.png".into());
            if let Some(parent) = std::path::Path::new(&output).parent() {
                std::fs::create_dir_all(parent).expect("create smoke output directory");
            }
            let bytes: Vec<u8> = image
                .pixels
                .iter()
                .flat_map(|pixel| pixel.to_array())
                .collect();
            image::save_buffer(
                &output,
                &bytes,
                image.size[0] as u32,
                image.size[1] as u32,
                image::ColorType::Rgba8,
            )
            .expect("save probe screenshot");
            println!("Native GUI screenshot saved: {output}");
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        if self.smoke {
            ctx.request_repaint_after(Duration::from_millis(50));
            if self.started.elapsed() > Duration::from_secs(15) {
                panic!("native screenshot timed out");
            }
        }
    }
}

fn main() -> eframe::Result {
    #[cfg(windows)]
    if let Some(path) = std::env::args()
        .nth(1)
        .filter(|arg| arg == "--print-probe")
        .and_then(|_| std::env::args().nth(2))
    {
        board_cut_optimizer::platform::printing::print_probe(Some(std::path::Path::new(&path)))
            .expect("print probe PDF");
        return Ok(());
    }
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([900.0, 560.0]),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native(
        "板优排 · Rust 技术验证",
        options,
        Box::new(|cc| {
            let mut fonts = egui::FontDefinitions::default();
            fonts.font_data.insert(
                "chinese".into(),
                egui::FontData::from_static(include_bytes!("../resources/NotoSansSC.ttf")).into(),
            );
            for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
                fonts
                    .families
                    .entry(family)
                    .or_default()
                    .insert(0, "chinese".into());
            }
            cc.egui_ctx.set_fonts(fonts);
            cc.egui_ctx.set_visuals(egui::Visuals::light());
            Ok(Box::new(Probe {
                text: "胡桃木 18 mm".into(),
                status: String::new(),
                started: Instant::now(),
                smoke: std::env::args().any(|arg| arg == "--smoke"),
                requested_screenshot: false,
            }))
        }),
    )
}
