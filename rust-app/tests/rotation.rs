use board_cut_optimizer::{
    beam_nesting::{BeamLimits, fill_rectangle_sheet},
    engine::{SearchContext, optimize},
    model::{Panel, Part, Settings},
    project,
};
use serde_json::json;

#[test]
fn per_part_rotation_overrides_bulk_default_in_all_search_paths() {
    for quick in [true, false] {
        for include_beam in [false, true] {
            for full_sheet in [false, true] {
                for global in [false, true] {
                    for individual in [None, Some(false), Some(true)] {
                        let mut value = json!({
                            "panels": [{"length": if full_sheet {2440} else {300}, "width": if full_sheet {1220} else {500}, "thickness":18}],
                            "parts": [{"id":"part", "length":if full_sheet {1220} else {450}, "width":if full_sheet {2440} else {250}, "quantity":1, "thickness":18}],
                            "settings":{"allowRotation":global, "sawWidth":0, "panelMarginX":0, "panelMarginY":0, "optimizationLevel":if quick {"quick"} else {"full"}}
                        });
                        if let Some(allow) = individual {
                            value["parts"][0]["allowRotate"] = json!(allow);
                        }
                        let plan = optimize(&value, include_beam).unwrap();
                        let allowed = individual.unwrap_or(global);
                        assert_eq!(
                            plan.stats["placedCount"],
                            json!(if allowed { 1 } else { 0 })
                        );
                        if allowed {
                            assert!(plan.layouts[0].placements[0].rotated);
                        }
                        if !full_sheet {
                            let panel = Panel::from_source(&value["panels"][0], 0);
                            let part = Part::from_source(&value["parts"][0], 0, 0);
                            let fill = fill_rectangle_sheet(
                                &panel,
                                &[part],
                                &Settings::from_project(&value),
                                BeamLimits::default(),
                                &mut SearchContext::new(&|| Ok(()), &mut |_| {}),
                            )
                            .unwrap();
                            assert_eq!(fill.placements.len(), usize::from(allowed));
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn bulk_toggle_applies_once_and_individual_override_survives_reload() {
    let mut value = project::normalize(
        &json!({
            "panels":[{"length":300,"width":500,"thickness":18}],
            "parts":[{"id":"a","length":450,"width":250,"quantity":1,"thickness":18,"allowRotate":true},
                     {"id":"b","length":100,"width":100,"quantity":0,"thickness":18,"allowRotate":false}],
            "settings":{"sawWidth":0,"panelMarginX":0,"panelMarginY":0}
        }),
        None,
    );
    project::set_all_parts_rotation(&mut value, false);
    assert!(
        value["parts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["allowRotate"] == false)
    );
    assert_eq!(optimize(&value, true).unwrap().stats["placedCount"], 0);
    value["parts"][0]["allowRotate"] = json!(true);
    let reloaded = project::normalize(&serde_json::from_str(&value.to_string()).unwrap(), None);
    assert_eq!(reloaded["settings"]["allowRotation"], false);
    assert!(optimize(&reloaded, true).unwrap().layouts[0].placements[0].rotated);
    project::set_all_parts_rotation(&mut value, true);
    assert!(
        value["parts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["allowRotate"] == true)
    );
    project::set_all_parts_rotation(&mut value, false);
    value["parts"] = json!([]);
    project::add_part(&mut value);
    assert_eq!(value["parts"][0]["allowRotate"], false);
}
