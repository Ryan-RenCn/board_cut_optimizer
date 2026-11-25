use crate::model::*;
use serde_json::{Value, json};
pub const HEADERS: [&str; 4] = ["数量", "长度", "宽度", "厚度"];

pub fn escape(value: &str) -> String {
    if value.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.into()
    }
}
pub fn serialize_rows(rows: &[Vec<String>]) -> String {
    format!(
        "\u{feff}{}",
        rows.iter()
            .map(|r| r.iter().map(|v| escape(v)).collect::<Vec<_>>().join(","))
            .collect::<Vec<_>>()
            .join("\r\n")
    )
}

fn parse_rows(text: &str) -> Result<Vec<(usize, Vec<String>)>, String> {
    #[derive(PartialEq, Eq)]
    enum Field {
        Start,
        Unquoted,
        Quoted,
        Closed,
    }
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut value = String::new();
    let mut field = Field::Start;
    let (mut line, mut row_line) = (1, 1);
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(mut ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            ch = '\n';
        }
        if field == Field::Quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    value.push('"');
                } else {
                    field = Field::Closed;
                }
            } else {
                value.push(ch);
                if ch == '\n' {
                    line += 1;
                }
            }
            continue;
        }
        match ch {
            ',' => {
                row.push(value.trim().to_string());
                value.clear();
                field = Field::Start;
            }
            '\n' => {
                if !row.is_empty() || field != Field::Start {
                    row.push(value.trim().to_string());
                    rows.push((row_line, std::mem::take(&mut row)));
                    value.clear();
                }
                field = Field::Start;
                line += 1;
                row_line = line;
            }
            '"' if field == Field::Start => field = Field::Quoted,
            c if c.is_whitespace() && matches!(field, Field::Start | Field::Closed) => {}
            '"' => return Err(format!("CSV 第 {line} 行：双引号必须包住整个字段")),
            _ if field == Field::Closed => {
                return Err(format!("CSV 第 {line} 行：结束引号后必须是分隔符"));
            }
            _ => {
                field = Field::Unquoted;
                value.push(ch);
            }
        }
    }
    if field == Field::Quoted {
        return Err(format!("CSV 第 {row_line} 行存在未闭合的双引号"));
    }
    if !row.is_empty() || field != Field::Start {
        row.push(value.trim().to_string());
        rows.push((row_line, row));
    }
    Ok(rows)
}

pub fn parts_from_csv(
    text: &str,
    material: &str,
    thicknesses: &[f64],
    make_id: &mut dyn FnMut() -> String,
) -> Result<Vec<Value>, String> {
    let mut rows = parse_rows(text)?.into_iter();
    let Some((_, header)) = rows.next() else {
        return Err("CSV 中没有可导入的零件数据".into());
    };
    if header != HEADERS {
        return Err(format!("CSV 表头必须为：{}", HEADERS.join("、")));
    }
    let mut result = Vec::new();
    for (line, row) in rows {
        let invalid = |message: &str| format!("CSV 第 {line} 行：{message}");
        let [quantity, length, width, thickness] = row.as_slice() else {
            return Err(invalid("每行必须有 4 列（数量、长度、宽度、厚度）"));
        };
        let quantity = json!(quantity);
        if !valid_quantity(&quantity) {
            return Err(invalid("数量必须为有效的非负整数"));
        }
        let quantity = number(&quantity, 0.0);
        let positive = |text: &str, label: &str| {
            let n = number(&json!(text), f64::NAN);
            if n.is_finite() && n > 0.0 {
                Ok(n)
            } else {
                Err(invalid(&format!("{label}必须为有限正数")))
            }
        };
        let length = positive(length, "长度")?;
        let width = positive(width, "宽度")?;
        // Preserve historical CSV rows with zero quantity and an empty/unmatched thickness.
        let thickness = if quantity == 0.0 && thickness.is_empty() {
            None
        } else {
            let n = positive(thickness, "厚度")?;
            thicknesses
                .iter()
                .any(|t| (t - n).abs() < EPSILON)
                .then_some(n)
        };
        if quantity > 0.0 && thickness.is_none() {
            return Err(invalid("厚度未匹配首个材质的库存规格，请先核对板材库存"));
        }
        result.push(json!({"id":make_id(),"quantity":quantity,"length":length,"width":width,"thickness":thickness.map_or(json!(""), |n| json!(n)),"material":if thickness.is_some(){material}else{""},"allowRotate":true,"code":"","description":""}));
    }
    if result.is_empty() {
        return Err("CSV 中没有可导入的零件数据".into());
    }
    Ok(result)
}
pub fn serialize_parts(parts: &[Value]) -> String {
    let mut rows = vec![HEADERS.iter().map(|v| v.to_string()).collect()];
    for part in parts {
        rows.push(
            ["quantity", "length", "width", "thickness"]
                .iter()
                .map(|key| string(&part[key]))
                .collect(),
        );
    }
    serialize_rows(&rows)
}
