use board_cut_optimizer::{
    beam_nesting::{self, BeamLimits},
    engine::{self, SearchContext},
    model::*,
};
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
            assert_eq!(a.len(), b.len(), "{path}: length");
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
fn validation_and_geometry_match_41_js_cases() {
    for case in fixtures()["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let errors = validate_project(&case["project"]);
        equal(&json!(errors), &case["errors"], name);
        if !errors.is_empty() {
            continue;
        }
        let plan = engine::optimize(&case["project"], case["options"]["includeBeam"] != false)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let actual = serde_json::to_value(&plan).unwrap();
        let expected = &case["expected"];
        for key in [
            "strategy",
            "sortKey",
            "orientationStrategy",
            "score",
            "algorithm",
            "attemptsSummary",
            "trace",
        ] {
            equal(&actual[key], &expected[key], &format!("{name}.{key}"));
        }
        for key in [
            "placedCount",
            "requestedCount",
            "usedPanels",
            "partsArea",
            "usedPanelArea",
            "averageUsage",
        ] {
            equal(
                &actual["stats"][key],
                &expected["stats"][key],
                &format!("{name}.stats.{key}"),
            );
        }
        equal(
            &actual["unplaced"],
            &expected["unplaced"],
            &format!("{name}.unplaced"),
        );
        assert_eq!(
            plan.layouts.len(),
            expected["layouts"].as_array().unwrap().len(),
            "{name}"
        );
        for (index, layout) in actual["layouts"].as_array().unwrap().iter().enumerate() {
            for key in [
                "panel",
                "width",
                "height",
                "usableWidth",
                "usableHeight",
                "placements",
                "freeRects",
                "packingArea",
                "measurementArea",
                "usedArea",
                "usage",
                "diagnostics",
            ] {
                equal(
                    &layout[key],
                    &expected["layouts"][index][key],
                    &format!("{name}.layouts[{index}].{key}"),
                );
            }
        }
        for layout in &plan.layouts {
            for p in &layout.placements {
                assert!(
                    p.x >= -EPSILON
                        && p.y >= -EPSILON
                        && p.x + p.placed_length <= layout.width + EPSILON
                        && p.y + p.placed_width <= layout.height + EPSILON,
                    "{name}: bounds"
                );
                assert!(
                    !p.rotated
                        || p.part
                            .allow_rotate
                            .unwrap_or(case["project"]["settings"]["allowRotation"] != false),
                    "{name}: rotation"
                );
            }
            let kerf = field_number(&case["project"]["settings"], "sawWidth", 3.0);
            for (i, a) in layout.placements.iter().enumerate() {
                for b in layout.placements.iter().skip(i + 1) {
                    assert!(
                        a.x + a.placed_length + kerf <= b.x + EPSILON
                            || b.x + b.placed_length + kerf <= a.x + EPSILON
                            || a.y + a.placed_width + kerf <= b.y + EPSILON
                            || b.y + b.placed_width + kerf <= a.y + EPSILON,
                        "{name}: kerf"
                    );
                }
            }
        }
    }
}

#[test]
fn duplicate_legacy_ids_do_not_hide_unplaced_pieces() {
    let mut project = json!({
        "panels":[{"length":1000,"width":1000,"thickness":18,"material":"A"}],
        "parts":[
            {"id":"duplicate","length":800,"width":800,"thickness":18,"quantity":2,"material":"A"},
            {"id":"duplicate","length":800,"width":800,"thickness":18,"quantity":2,"material":"B"}
        ],
        "settings":{"optimizationLevel":"quick"}
    });
    for include_beam in [false, true] {
        let plan = engine::optimize(&project, include_beam).unwrap();
        assert_eq!(plan.stats["requestedCount"], 4);
        assert_eq!(plan.stats["placedCount"], 2);
        assert_eq!(plan.unplaced.len(), 2);
        assert!(plan.unplaced.iter().all(|p| p.source_index == 1));
        assert!(!plan.is_complete());
    }
    project["parts"][1]["material"] = json!("A");
    let plan = engine::optimize(&project, true).unwrap();
    assert_eq!(plan.layouts.len(), 4);
    assert!(plan.is_complete());
}

#[test]
fn beam_fills_with_distinct_rows_that_share_an_id() {
    let panel = Panel::from_source(&json!({"length":1000,"width":1000,"thickness":18}), 0);
    let source = json!({"id":"duplicate","length":400,"width":400,"thickness":18});
    let parts = [
        Part::from_source(&source, 0, 0),
        Part::from_source(&source, 1, 0),
    ];
    let mut noop = |_| {};
    let mut context = SearchContext::new(&|| Ok(()), &mut noop);
    let fill = beam_nesting::fill_rectangle_sheet(
        &panel,
        &parts,
        &Settings::from_project(&json!({})),
        BeamLimits::default(),
        &mut context,
    )
    .unwrap();
    let mut placed: Vec<_> = fill
        .placements
        .iter()
        .map(|p| p.part.source_index)
        .collect();
    placed.sort_unstable();
    assert_eq!(placed, [0, 1]);
}

#[test]
fn identical_layout_groups_match_js() {
    let fixtures = fixtures();
    for case in fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| !c["expected"].is_null())
    {
        let plan =
            engine::optimize(&case["project"], case["options"]["includeBeam"] != false).unwrap();
        let counts: Vec<_> = engine::group_identical_layouts(&plan.layouts)
            .into_iter()
            .map(|(_, count)| count)
            .collect();
        let expected = fixtures["geometry"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["name"] == case["name"])
            .unwrap();
        equal(
            &json!(counts),
            &expected["groups"],
            case["name"].as_str().unwrap(),
        );
    }
}

#[test]
fn standalone_beam_search_matches_js() {
    for case in fixtures()["beamCases"].as_array().unwrap() {
        let panel = Panel::from_source(&case["panel"], 0);
        let parts: Vec<_> = case["parts"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let mut part = Part::from_source(p, i, 0);
                part.instance_id = string(&p["instanceId"]);
                part
            })
            .collect();
        let input = &case["settings"];
        let mut settings = Settings::from_project(&json!({"settings":input}));
        settings.saw_width = field_number(input, "sawWidth", 0.0).max(0.0);
        settings.margin_x = field_number(input, "panelMarginX", 0.0).max(0.0);
        settings.margin_y = field_number(input, "panelMarginY", 0.0).max(0.0);
        let mut noop = |_| {};
        let mut context = SearchContext::new(&|| Ok(()), &mut noop);
        let fill = beam_nesting::fill_rectangle_sheet(
            &panel,
            &parts,
            &settings,
            BeamLimits {
                width: field_number(input, "beamWidth", 4.0) as usize,
                candidates: field_number(input, "candidateLimit", 6.0) as usize,
                search_parts: field_number(input, "maxSearchParts", 60.0) as usize,
                expanded_states: field_number(input, "maxExpandedStates", 10000.0) as usize,
            },
            &mut context,
        )
        .unwrap();
        equal(
            &json!(fill.used_area),
            &case["expected"]["usedArea"],
            "beam area",
        );
        equal(
            &json!(fill.free_rects),
            &case["expected"]["freeRects"],
            "beam freeRects",
        );
        equal(
            &fill.diagnostics,
            &case["expected"]["diagnostics"],
            "beam diagnostics",
        );
        assert_eq!(
            fill.placements.len(),
            case["expected"]["placements"].as_array().unwrap().len()
        );
        for (a, b) in fill
            .placements
            .iter()
            .zip(case["expected"]["placements"].as_array().unwrap())
        {
            let a = serde_json::to_value(a).unwrap();
            for key in [
                "instanceId",
                "x",
                "y",
                "placedLength",
                "placedWidth",
                "rotated",
            ] {
                equal(&a[key], &b[key], key);
            }
        }
    }
}
