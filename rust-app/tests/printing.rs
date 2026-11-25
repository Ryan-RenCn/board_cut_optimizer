use board_cut_optimizer::{
    engine,
    platform::printing::{self, Draw},
    project, quotation,
};
use serde_json::json;
#[test]
fn paginated_report_handles_long_descriptions_and_stays_on_page() {
    let mut project = project::demo();
    project["parts"][0]["description"] = json!("长备注与中文测试".repeat(1200));
    let plan = engine::optimize(&project, true).unwrap();
    let rows = quotation::initialize_adjustments(&plan, &project);
    let document = printing::report_document(&plan, &project, &rows);
    assert!(document.pages.len() > 3);
    for page in &document.pages {
        for command in &page.commands {
            if let Draw::Text { x, y, size, .. } = command {
                assert!(*x >= 0.0 && *x < 794.0);
                assert!(*y >= 0.0 && y + size <= 1123.0);
            }
        }
    }
}
#[test]
fn repeated_layouts_are_printed_with_quantity_not_silently_omitted() {
    let project = json!({"name":"整板重复","panels":[{"length":2440,"width":1220,"thickness":18}],"parts":[{"id":"full","length":2440,"width":1220,"thickness":18,"quantity":3}]});
    let plan = engine::optimize(&project, true).unwrap();
    let document = printing::layout_document(&plan, &project);
    assert_eq!(document.pages.len(), 1);
    assert!(
        document.pages[0]
            .commands
            .iter()
            .any(|command| matches!(command,Draw::Text{text,..} if text.contains("数量 × 3 张")))
    );
}
