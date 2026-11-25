//! Application-level defaults and legacy normalization; store keeps raw JSON.
use crate::{logistics, model::*, pricing, quotation};
use serde_json::{Value, json};
pub fn defaults() -> Value {
    json!({"id":null,"name":"未命名工程","description":"","shippingDestination":"","lossRate":0,"taxRate":0,"panels":[],"parts":[],"settings":{"sawWidth":3,"panelMarginX":10,"panelMarginY":10,"profitRate":100,"cuttingFee":0,"packagingFee":0,"logisticsProvider":"none","allowRotation":true,"optimizationLevel":"full","partEntryKey":"tab","quotationTemplate":quotation::DEFAULT_TEMPLATE},"updatedAt":null})
}
pub fn material_key(value: &Value) -> String {
    string(value).trim().to_lowercase()
}
pub fn thicknesses(panels: &[Value], material: &Value) -> Vec<f64> {
    let key = material_key(material);
    let mut result: Vec<_> = panels
        .iter()
        .filter(|p| material_key(&p["material"]) == key)
        .map(|p| field_number(p, "thickness", 0.0))
        .filter(|v| *v > 0.0)
        .collect();
    result.sort_by(f64::total_cmp);
    result.dedup();
    result
}
pub fn normalize(value: &Value, global: Option<&Value>) -> Value {
    let mut result = defaults();
    if let Some(object) = value.as_object() {
        for (k, v) in object {
            result[k] = v.clone();
        }
    }
    let source = global
        .and_then(|g| g.get("panels"))
        .filter(|v| !v.is_null())
        .unwrap_or(&value["panels"]);
    let panels = source.as_array().cloned().unwrap_or_default();
    let settings_source = global
        .and_then(|g| g.get("settings"))
        .filter(|v| !v.is_null())
        .unwrap_or(&value["settings"]);
    let mut settings = settings_source.as_object().cloned().unwrap_or_default();
    if !settings.contains_key("cuttingFee")
        && let Some(fee) = panels
            .iter()
            .filter_map(|p| p.get("cuttingFee"))
            .map(|v| number(v, f64::NAN))
            .find(|v| v.is_finite() && *v >= 0.0)
    {
        settings.insert("cuttingFee".into(), json!(fee));
    }
    for (key, fallback) in [
        ("cuttingFee", 0.0),
        ("packagingFee", 0.0),
        ("profitRate", 100.0),
    ] {
        let value = settings
            .get(key)
            .map(|v| number(v, f64::NAN))
            .filter(|v| *v >= 0.0 && v.is_finite())
            .unwrap_or(fallback);
        settings.insert(key.into(), json!(value));
    }
    let provider = if settings.get("logisticsProvider") == Some(&json!(logistics::PROVIDER)) {
        logistics::PROVIDER
    } else {
        "none"
    };
    settings.insert("logisticsProvider".into(), json!(provider));
    let key = if settings.get("partEntryKey") == Some(&json!("enter")) {
        "enter"
    } else {
        "tab"
    };
    settings.insert("partEntryKey".into(), json!(key));
    let template =
        quotation::normalize_template(settings.get("quotationTemplate").unwrap_or(&Value::Null));
    settings.insert("quotationTemplate".into(), json!(template));
    for key in [
        "rotationStep",
        "maxShapeVertices",
        "minOffcutLength",
        "minOffcutWidth",
    ] {
        settings.shift_remove(key);
    }
    for (k, v) in settings {
        result["settings"][k] = v;
    }
    result["panels"] = json!(
        panels
            .into_iter()
            .map(|mut p| {
                let cost = number(
                    p.get("cost")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&p["price"]),
                    f64::NAN,
                );
                let weight = field_number(&p, "weight", f64::NAN);
                if let Some(object) = p.as_object_mut() {
                    for key in ["quantity", "cuttingFee", "price"] {
                        object.shift_remove(key);
                    }
                }
                p["cost"] = json!(if cost.is_finite() && cost >= 0.0 {
                    cost
                } else {
                    0.0
                });
                p["weight"] = json!(if weight.is_finite() && weight >= 0.0 {
                    weight
                } else {
                    0.0
                });
                p
            })
            .collect::<Vec<_>>()
    );
    let panels = rows(&result, "panels").to_vec();
    result["parts"] = json!(
        rows(value, "parts")
            .iter()
            .cloned()
            .map(|mut part| {
                let n = field_number(&part, "thickness", f64::NAN);
                part["thickness"] = if n.is_finite() && n > 0.0 {
                    json!(n)
                } else if part.get("thickness").is_none() {
                    thicknesses(&panels, &part["material"])
                        .first()
                        .map_or(json!(""), |v| json!(v))
                } else {
                    json!("")
                };
                part
            })
            .collect::<Vec<_>>()
    );
    result["lossRate"] = json!(field_number(&result, "lossRate", 0.0).clamp(0.0, 100.0));
    result["taxRate"] = json!(pricing::normalize_tax_rate(&result["taxRate"]));
    result["shippingDestination"] = json!(logistics::normalize_destination(&string(
        &result["shippingDestination"]
    )));
    result
}
pub fn global_config(project: &Value) -> Value {
    let normalized = normalize(
        &json!({"panels":project["panels"],"settings":project["settings"],"parts":[]}),
        None,
    );
    json!({"panels":normalized["panels"],"settings":normalized["settings"]})
}
pub fn groups(panels: &[Value]) -> Vec<(String, String)> {
    let mut result: Vec<(String, String)> = Vec::new();
    for p in panels {
        let key = material_key(&p["material"]);
        if !result.iter().any(|(k, _)| k == &key) {
            result.push((key, string(&p["material"]).trim().into()));
        }
    }
    result.sort_by(|a, b| {
        compare_labels(
            if a.1.is_empty() { "默认材质" } else { &a.1 },
            if b.1.is_empty() { "默认材质" } else { &b.1 },
        )
    });
    result
}
fn compare_labels(a: &str, b: &str) -> std::cmp::Ordering {
    #[cfg(windows)]
    unsafe {
        let a: Vec<u16> = a.encode_utf16().collect();
        let b: Vec<u16> = b.encode_utf16().collect();
        let result = windows::Win32::Globalization::CompareStringEx(
            windows::core::w!("zh-CN"),
            windows::Win32::Globalization::COMPARE_STRING_FLAGS(0),
            &a,
            &b,
            None,
            None,
            None,
        );
        if result.0 > 0 {
            return result.0.cmp(&2);
        }
    }
    a.cmp(b)
}
/// Apply the bulk preference once; later per-part edits remain authoritative.
pub fn set_all_parts_rotation(project: &mut Value, allow: bool) {
    project["settings"]["allowRotation"] = json!(allow);
    if let Some(parts) = project["parts"].as_array_mut() {
        for part in parts {
            part["allowRotate"] = json!(allow);
        }
    }
}

pub fn add_part(project: &mut Value) {
    let panels = rows(project, "panels");
    let material = groups(panels)
        .first()
        .map(|(_, label)| label.clone())
        .unwrap_or_default();
    let available = thicknesses(panels, &json!(material));
    let previous = rows(project, "parts").last();
    let old = previous
        .map(|p| field_number(p, "thickness", f64::NAN))
        .unwrap_or(f64::NAN);
    let thickness = available
        .iter()
        .find(|v| (**v - old).abs() < EPSILON)
        .or(available.first())
        .map_or(json!(""), |v| json!(v));
    let rotate = previous
        .and_then(|p| p["allowRotate"].as_bool())
        .unwrap_or(project["settings"]["allowRotation"] != false);
    project["parts"].as_array_mut().unwrap().push(json!({"id":uuid::Uuid::new_v4().to_string(),"quantity":1,"length":0,"width":0,"material":material,"thickness":thickness,"allowRotate":rotate,"code":"","description":""}));
}
pub fn unsupported(part: &Value) -> bool {
    truthy(&part["shape"]) || part.get("rotationAngles").is_some()
}
pub fn demo() -> Value {
    let mut p = defaults();
    p["name"] = json!("演示工程 · 胡桃木柜体");
    p["description"] = json!("18 mm 柜体板开料示例");
    p["shippingDestination"] = json!("江苏/浙江/上海");
    p["settings"]["cuttingFee"] = json!(60);
    p["settings"]["logisticsProvider"] = json!(logistics::PROVIDER);
    p["panels"] = json!([{"id":"demo-walnut","length":2440,"width":1220,"thickness":18,"cost":328,"weight":39.5,"material":"胡桃木","description":"整板"},{"id":"demo-mdf","length":1800,"width":900,"thickness":18,"cost":168,"weight":21.5,"material":"白色 MDF","description":"备用板材"}]);
    let demo_rows = json!([
        [2, 720, 560, "胡桃木", "SIDE-01", "侧板", true],
        [2, 1160, 540, "胡桃木", "TOP-02", "顶/底板", true],
        [4, 560, 320, "胡桃木", "SHELF-03", "层板", true],
        [2, 1120, 420, "胡桃木", "DOOR-04", "门板（纹理）", false],
        [3, 580, 380, "白色 MDF", "DRAWER-05", "抽屉板", true]
    ]);
    p["parts"]=json!(demo_rows.as_array().unwrap().iter().enumerate().map(|(i,r)|json!({"id":format!("demo-{i}"),"quantity":r[0],"length":r[1],"width":r[2],"thickness":18,"material":r[3],"code":r[4],"description":r[5],"allowRotate":r[6]})).collect::<Vec<_>>());
    p
}
