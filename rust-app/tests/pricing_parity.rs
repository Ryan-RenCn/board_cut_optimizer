use board_cut_optimizer::{engine, logistics, parts_csv, pricing, quotation};
use serde_json::{Value, json};
fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/js-baseline.json")).unwrap()
}
fn equal(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert!(
            (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() < 1e-7,
            "{path}: {a} != {b}"
        ),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                equal(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (k, b) in b {
                equal(a.get(k).unwrap_or(&Value::Null), b, &format!("{path}.{k}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}
#[test]
fn all_plan_financials_match_js() {
    for case in fixtures()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| !c["expected"].is_null())
    {
        let plan =
            engine::optimize(&case["project"], case["options"]["includeBeam"] != false).unwrap();
        let actual = serde_json::to_value(plan).unwrap();
        equal(
            &actual["stats"],
            &case["expected"]["stats"],
            case["name"].as_str().unwrap(),
        );
        equal(
            &actual["layouts"],
            &case["expected"]["layouts"],
            case["name"].as_str().unwrap(),
        );
    }
}
#[test]
fn logistics_and_tax_match_js() {
    let fixtures = fixtures();
    for case in fixtures["logistics"].as_array().unwrap() {
        equal(
            &json!(logistics::calculate(
                logistics::PROVIDER,
                case["destination"].as_str().unwrap(),
                case["weight"].as_f64().unwrap()
            )),
            &case["expected"],
            "logistics",
        );
    }
    for case in fixtures["tax"].as_array().unwrap() {
        equal(
            &json!(pricing::material_after_tax(
                case["amount"].as_f64().unwrap(),
                case["rate"].as_f64().unwrap()
            )),
            &case["expected"],
            "tax",
        );
    }
    assert_eq!(logistics::calculate("none", "浙江", 10.0).fee, 0.0);
    assert!(!logistics::calculate(logistics::PROVIDER, "不支持的目的地", 10.0).available);
}
#[test]
fn quotation_and_csv_text_match_js_exactly() {
    let fixtures = fixtures();
    assert_eq!(
        quotation::format_quotation(&fixtures["quotation"]["input"]).unwrap(),
        fixtures["quotation"]["expected"].as_str().unwrap()
    );
    let parts = parts_csv::parts_from_csv(
        fixtures["csv"]["text"].as_str().unwrap(),
        "MDF",
        &[18.0],
        &mut || "csv-part".into(),
    )
    .unwrap();
    equal(&json!(parts), &fixtures["csv"]["parts"], "CSV parts");
    assert_eq!(
        parts_csv::serialize_parts(&parts),
        fixtures["csv"]["serialized"].as_str().unwrap()
    );
    for case in fixtures["workflows"].as_array().unwrap() {
        let plan = engine::optimize(&case["project"], true).unwrap();
        assert_eq!(
            quotation::signature(&plan),
            case["signature"].as_str().unwrap()
        );
        let adjusted = quotation::initialize_adjustments(&plan, &case["project"]);
        equal(
            &json!(adjusted),
            &case["adjustments"],
            "restored quote adjustment",
        );
        assert_eq!(
            quotation::build_quotation(&plan, &case["project"], &adjusted).unwrap(),
            case["text"].as_str().unwrap()
        );
        assert_eq!(
            quotation::export_report(&plan, &case["project"], &adjusted).unwrap(),
            case["csv"].as_str().unwrap()
        );
    }
}
#[test]
fn fixed_signatures_have_js_half_tie_behavior() {
    assert_eq!(pricing::fixed(0.0078125, 6), "0.007813");
    assert_eq!(pricing::fixed(1.005, 2), "1.00");
    assert_eq!(pricing::format_number(1.005, 2, true, false), "1.01");
    assert_eq!(pricing::currency(1234567.5), "¥1,234,567.50");
    assert_eq!(pricing::fixed(-0.0, 6), "0.000000");
}
#[test]
fn incomplete_reports_and_invalid_csv_are_rejected() {
    let fixtures = fixtures();
    for name in ["oversize", "material-mismatch", "thickness-mismatch"] {
        let project = &fixtures["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap()["project"];
        let plan = engine::optimize(project, true).unwrap();
        let rows = quotation::initialize_adjustments(&plan, project);
        assert!(
            quotation::export_report(&plan, project, &rows)
                .unwrap_err()
                .contains("未排入")
        );
        assert!(
            quotation::build_quotation(&plan, project, &rows)
                .unwrap()
                .contains("暂不能生成正式报价")
        );
    }
    for quantity in ["1.5", "-1", "", "invalid"] {
        assert!(
            parts_csv::parts_from_csv(
                &format!("数量,长度,宽度,厚度\n{quantity},100,200,18"),
                "MDF",
                &[18.0],
                &mut || "id".into()
            )
            .unwrap_err()
            .contains("数量")
        );
    }
    assert!(
        parts_csv::parts_from_csv(
            "数量,长度,宽度,厚度\n1,\"100,200,18",
            "MDF",
            &[18.0],
            &mut || "id".into()
        )
        .unwrap_err()
        .contains("未闭合")
    );
}
#[test]
fn piece_count_mismatch_blocks_formal_output_even_without_unplaced_records() {
    let project = board_cut_optimizer::project::demo();
    let mut plan = engine::optimize(&project, false).unwrap();
    plan.layouts[0].placements.pop().unwrap();
    assert!(plan.unplaced.is_empty());
    assert!(!plan.is_complete());
    let rows = quotation::initialize_adjustments(&plan, &project);
    assert!(
        quotation::build_quotation(&plan, &project, &rows)
            .unwrap_err()
            .contains("数量")
    );
    assert!(
        quotation::export_report(&plan, &project, &rows)
            .unwrap_err()
            .contains("数量")
    );
}

#[test]
fn csv_validates_each_data_row() {
    for (row, reason) in [
        ("1,100,200", "4 列"),
        ("1,100,200,18,extra", "4 列"),
        ("1,oops,200,18", "长度"),
        ("1,100,0,18", "宽度"),
        ("1,100,200,NaN", "厚度"),
        ("1,100,200,9", "库存"),
        ("1,1\"00\",200,18", "双引号"),
        ("1,\"100\"a,200,18", "结束引号"),
        (",,,", "数量"),
    ] {
        let error = parts_csv::parts_from_csv(
            &format!("数量,长度,宽度,厚度\r\n1,100,200,18\r\n\r\n{row}"),
            "MDF",
            &[18.0],
            &mut || "id".into(),
        )
        .unwrap_err();
        assert!(
            error.contains("第 4 行") && error.contains(reason),
            "{error}"
        );
    }
    let rows = parts_csv::parts_from_csv(
        "\u{feff}\"数量\",长度,宽度,厚度\r1, \"100.5\" ,200,18\r0,100,200,",
        "MDF",
        &[18.0],
        &mut || "id".into(),
    )
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["length"], 100.5);
    assert_eq!(rows[0]["material"], "MDF");
    assert_eq!(rows[1]["thickness"], "");
}

#[test]
fn legacy_templates_receive_a_tax_summary() {
    let input = json!({"template":"最终合计：{{最终合计}}","panelTotal":100,"taxRate":13,"taxedPanelTotal":113,"finalTotal":150,"taxedFinalTotal":163});
    let text = quotation::format_quotation(&input).unwrap();
    assert_eq!(
        text,
        "最终合计：¥150.00\n材料税率：13%\n材料税后价：¥113.00\n税后合计：¥163.00"
    );
    assert_eq!(
        quotation::normalize_template(&json!(quotation::LEGACY_TEMPLATE)),
        quotation::DEFAULT_TEMPLATE
    );
}
