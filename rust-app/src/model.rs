//! Compatible, permissive reading of historical JS JSON; originals are retained.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const EPSILON: f64 = 0.0001;
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Match finite Number(value), including null/booleans, without accepting NaN.
pub fn number(value: &Value, fallback: f64) -> f64 {
    let result = match value {
        Value::Null => Some(0.0),
        Value::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
        Value::Number(v) => v.as_f64(),
        Value::String(v) => {
            let s = v.trim();
            if s.is_empty() {
                Some(0.0)
            } else if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16).ok().map(|v| v as f64)
            } else if let Some(binary) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
                u64::from_str_radix(binary, 2).ok().map(|v| v as f64)
            } else if let Some(octal) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
                u64::from_str_radix(octal, 8).ok().map(|v| v as f64)
            } else {
                s.parse().ok()
            }
        }
        Value::Array(values) if values.is_empty() => Some(0.0),
        Value::Array(values) if values.len() == 1 => {
            Some(number(&Value::String(string(&values[0])), f64::NAN))
        }
        _ => None,
    };
    result.filter(|v| v.is_finite()).unwrap_or(fallback)
}

pub fn field_number(value: &Value, field: &str, fallback: f64) -> f64 {
    value.get(field).map_or(fallback, |v| number(v, fallback))
}

pub fn string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(v) => v.clone(),
        Value::Number(v) => {
            let n = v.as_f64().unwrap_or(0.0);
            if n == 0.0 {
                "0".into()
            } else if n.abs() >= 1e21 || n.abs() < 1e-6 {
                let result = format!("{n:e}");
                if result.contains("e-") {
                    result
                } else {
                    result.replace('e', "e+")
                }
            } else {
                n.to_string()
            }
        }
        Value::Array(v) => v.iter().map(string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(_) => number(value, 0.0) != 0.0,
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}

pub fn rows<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn extras(value: &Value, fields: &[&str]) -> Map<String, Value> {
    let mut result = value.as_object().cloned().unwrap_or_default();
    for field in fields {
        result.shift_remove(*field);
    }
    result
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
    pub source_index: usize,
    pub instance_index: usize,
    pub instance_id: String,
    pub length: f64,
    pub width: f64,
    pub area: f64,
    pub thickness: f64,
    pub material: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_rotate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Part {
    pub fn from_source(value: &Value, source_index: usize, instance_index: usize) -> Self {
        let length = field_number(value, "length", 0.0).max(0.0);
        let width = field_number(value, "width", 0.0).max(0.0);
        let id = value
            .get("id")
            .filter(|v| !v.is_null())
            .map(string)
            .unwrap_or_else(|| source_index.to_string());
        Self {
            extra: extras(
                value,
                &[
                    "sourceIndex",
                    "instanceIndex",
                    "instanceId",
                    "length",
                    "width",
                    "area",
                    "thickness",
                    "material",
                    "allowRotate",
                    "reason",
                ],
            ),
            source_index,
            instance_index,
            instance_id: format!("{id}-{}", instance_index + 1),
            length,
            width,
            area: length * width,
            thickness: field_number(value, "thickness", 0.0).max(0.0),
            material: string(&value["material"]).trim().into(),
            allow_rotate: value["allowRotate"].as_bool(),
            reason: None,
        }
    }
    /// Stored IDs are retained for historical quote signatures, but can collide.
    pub(crate) fn input_key(&self) -> (usize, usize) {
        (self.source_index, self.instance_index)
    }
    pub fn full_sheet(&self) -> bool {
        ((self.length - 2440.0).abs() < EPSILON && (self.width - 1220.0).abs() < EPSILON)
            || ((self.length - 1220.0).abs() < EPSILON && (self.width - 2440.0).abs() < EPSILON)
    }
    pub fn orientations(&self, allow_rotation: bool) -> Vec<(f64, f64, bool)> {
        let mut result = vec![(self.length, self.width, false)];
        if self.allow_rotate.unwrap_or(allow_rotation) && (self.length - self.width).abs() > EPSILON
        {
            result.push((self.width, self.length, true));
        }
        result
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
    pub source_index: usize,
    pub instance_id: String,
    pub length: f64,
    pub width: f64,
    pub thickness: f64,
    pub material: String,
    pub cost: f64,
    pub weight: f64,
}

impl Panel {
    pub fn from_source(value: &Value, source_index: usize) -> Self {
        let id = value
            .get("id")
            .filter(|v| !v.is_null())
            .map(string)
            .unwrap_or_else(|| source_index.to_string());
        Self {
            extra: extras(
                value,
                &[
                    "sourceIndex",
                    "instanceId",
                    "length",
                    "width",
                    "thickness",
                    "material",
                    "cost",
                    "weight",
                    "cuttingFee",
                    "price",
                ],
            ),
            source_index,
            instance_id: format!("{id}-template"),
            length: field_number(value, "length", 0.0).max(0.0),
            width: field_number(value, "width", 0.0).max(0.0),
            thickness: field_number(value, "thickness", 0.0).max(0.0),
            material: string(&value["material"]).trim().into(),
            cost: number(
                value
                    .get("cost")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&value["price"]),
                0.0,
            )
            .max(0.0),
            weight: field_number(value, "weight", 0.0).max(0.0),
        }
    }
    pub fn matches(&self, part: &Part) -> bool {
        self.material.trim().to_lowercase() == part.material.trim().to_lowercase()
            && (self.thickness - part.thickness).abs() < EPSILON
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    #[serde(flatten)]
    pub part: Part,
    pub x: f64,
    pub y: f64,
    pub placed_length: f64,
    pub placed_width: f64,
    pub rotated: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
impl Rect {
    pub fn contains(self, other: Self) -> bool {
        other.x >= self.x - EPSILON
            && other.y >= self.y - EPSILON
            && other.x + other.w <= self.x + self.w + EPSILON
            && other.y + other.h <= self.y + self.h + EPSILON
    }
    pub fn intersects(self, other: Self) -> bool {
        self.x < other.x + other.w - EPSILON
            && self.x + self.w > other.x + EPSILON
            && self.y < other.y + other.h - EPSILON
            && self.y + self.h > other.y + EPSILON
    }
}

pub fn prune_rectangles(rects: Vec<Rect>) -> Vec<Rect> {
    let valid: Vec<_> = rects
        .into_iter()
        .filter(|r| r.w > EPSILON && r.h > EPSILON)
        .collect();
    valid
        .iter()
        .enumerate()
        .filter(|(i, r)| {
            !valid
                .iter()
                .enumerate()
                .any(|(j, other)| j != *i && other.contains(**r) && (!r.contains(*other) || j < *i))
        })
        .map(|(_, r)| *r)
        .collect()
}

pub fn split_rectangles(rects: &[Rect], used: Rect, beam_order: bool) -> Vec<Rect> {
    let mut result = Vec::new();
    for free in rects {
        if !free.intersects(used) {
            result.push(*free);
            continue;
        }
        let left = (used.x > free.x + EPSILON).then_some(Rect {
            w: used.x - free.x,
            ..*free
        });
        let right = (used.x + used.w < free.x + free.w - EPSILON).then_some(Rect {
            x: used.x + used.w,
            w: free.x + free.w - used.x - used.w,
            ..*free
        });
        let top = (used.y > free.y + EPSILON).then_some(Rect {
            h: used.y - free.y,
            ..*free
        });
        let bottom = (used.y + used.h < free.y + free.h - EPSILON).then_some(Rect {
            y: used.y + used.h,
            h: free.y + free.h - used.y - used.h,
            ..*free
        });
        result.extend(
            if beam_order {
                [left, top, right, bottom]
            } else {
                [left, right, top, bottom]
            }
            .into_iter()
            .flatten(),
        );
    }
    prune_rectangles(result)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub id: String,
    pub panel: Panel,
    pub width: f64,
    pub height: f64,
    pub usable_width: f64,
    pub usable_height: f64,
    pub placements: Vec<Placement>,
    pub free_rects: Vec<Rect>,
    pub used_area: f64,
    pub packing_area: f64,
    pub measurement_area: f64,
    pub usage: f64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_full_sheet: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Value>,
    #[serde(flatten)]
    pub pricing: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub layouts: Vec<Layout>,
    pub unplaced: Vec<Part>,
    pub strategy: String,
    pub sort_key: String,
    pub orientation_strategy: String,
    pub score: [f64; 3],
    pub stats: Value,
    pub algorithm: Value,
    pub attempts_summary: Vec<Value>,
    pub trace: Vec<Value>,
}
impl Plan {
    pub fn is_complete(&self) -> bool {
        if !self.unplaced.is_empty() {
            return false;
        }
        let placed = self
            .layouts
            .iter()
            .map(|l| l.placements.len())
            .sum::<usize>() as u64;
        placed > 0
            && self.stats["placedCount"].as_u64() == Some(placed)
            && self.stats["requestedCount"].as_u64() == Some(placed)
    }
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub saw_width: f64,
    pub margin_x: f64,
    pub margin_y: f64,
    pub allow_rotation: bool,
    pub orientation: String,
    pub beam: bool,
    pub quick: bool,
}
impl Settings {
    pub fn from_project(project: &Value) -> Self {
        let value = &project["settings"];
        Self {
            saw_width: field_number(value, "sawWidth", 3.0).max(0.0),
            margin_x: field_number(value, "panelMarginX", 10.0).max(0.0),
            margin_y: field_number(value, "panelMarginY", 10.0).max(0.0),
            allow_rotation: value["allowRotation"] != false,
            orientation: "bestFit".into(),
            beam: false,
            quick: value["optimizationLevel"] == "quick",
        }
    }
}

pub fn valid_quantity(value: &Value) -> bool {
    if !value.is_number() && !value.is_string() {
        return false;
    }
    if string(value).trim().is_empty() {
        return false;
    }
    let n = number(value, f64::NAN);
    n.is_finite() && (0.0..=MAX_SAFE_INTEGER).contains(&n) && n.fract() == 0.0
}

pub fn validate_project(project: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    for (i, panel) in rows(project, "panels").iter().enumerate() {
        if field_number(panel, "length", 0.0) <= 0.0 || field_number(panel, "width", 0.0) <= 0.0 {
            errors.push(format!("第 {} 种板材缺少有效尺寸", i + 1));
        }
        if field_number(panel, "thickness", 0.0) <= 0.0 {
            errors.push(format!("第 {} 种板材缺少有效厚度", i + 1));
        }
        if number(
            panel
                .get("cost")
                .filter(|v| !v.is_null())
                .unwrap_or(&panel["price"]),
            0.0,
        ) < 0.0
        {
            errors.push(format!("第 {} 种板材的成本价不能为负数", i + 1));
        }
        if field_number(panel, "weight", 0.0) < 0.0 {
            errors.push(format!("第 {} 种板材的重量不能为负数", i + 1));
        }
    }
    let settings = &project["settings"];
    for (key, message) in [
        ("cuttingFee", "全局切割费不能为负数"),
        ("packagingFee", "全局打包费不能为负数"),
        ("profitRate", "全局利润比例不能为负数"),
    ] {
        if field_number(settings, key, 0.0) < 0.0 {
            errors.push(message.into());
        }
    }
    if !(0.0..=100.0).contains(&field_number(project, "lossRate", 0.0)) {
        errors.push("本单损耗率必须在 0% 到 100% 之间".into());
    }
    for (i, part) in rows(project, "parts").iter().enumerate() {
        if !valid_quantity(&part["quantity"]) {
            errors.push(format!("第 {} 种零件的数量必须为有效的非负整数", i + 1));
        }
        if truthy(&part["shape"]) || part.get("rotationAngles").is_some() {
            errors.push(format!(
                "第 {} 种零件含不再支持的轮廓或指定角度，请删除后重新录入矩形零件",
                i + 1
            ));
        }
        if field_number(part, "length", 0.0) <= 0.0 || field_number(part, "width", 0.0) <= 0.0 {
            errors.push(format!("第 {} 种零件缺少有效尺寸", i + 1));
        }
        if field_number(part, "thickness", 0.0) <= 0.0 {
            errors.push(format!("第 {} 种零件缺少有效厚度", i + 1));
        }
    }
    errors
}
