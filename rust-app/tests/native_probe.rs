use eframe::egui::{self, Event, ImeEvent};

#[test]
fn chinese_ime_preedit_and_commit_are_supported_by_native_text_edit() {
    let ctx = egui::Context::default();
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "chinese".into(),
        egui::FontData::from_static(include_bytes!("../resources/NotoSansSC.ttf")).into(),
    );
    fonts
        .families
        .entry(egui::FontFamily::Proportional)
        .or_default()
        .insert(0, "chinese".into());
    ctx.set_fonts(fonts);
    let mut text = String::new();
    let mut frame = |events| {
        let _ = ctx.run(
            egui::RawInput {
                events,
                ..Default::default()
            },
            |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    ui.add(egui::TextEdit::singleline(&mut text).id(egui::Id::new("probe-input")))
                        .request_focus();
                });
            },
        );
    };
    frame(vec![]);
    frame(vec![Event::Ime(ImeEvent::Enabled)]);
    frame(vec![Event::Ime(ImeEvent::Preedit("hutao".into()))]);
    frame(vec![Event::Ime(ImeEvent::Commit("胡桃木".into()))]);
    assert_eq!(text, "胡桃木");
}
