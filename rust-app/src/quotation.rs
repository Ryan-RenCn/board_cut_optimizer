use crate::{
    logistics::{self, Logistics},
    model::*,
    parts_csv,
    pricing::{self, currency, format_number},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const DEFAULT_TEMPLATE: &str = "明细\n{{分隔线}}\n{{零件明细}}\n{{分隔线}}\n板材报价：{{板材报价}}\n材料税率：{{材料税率}}\n材料税后价：{{材料税后价格}}\n油漆费用：{{油漆费用}}\n切割费用：{{切割费用}}\n打包费用：{{打包费用}}\n  总重量：{{总重量}}\n物流费用：{{物流费用}}\n{{分隔线}}\n未税合计：{{未税合计}}\n税后合计：{{税后合计}}";
pub const LEGACY_TEMPLATE: &str = "明细\n{{分隔线}}\n{{零件明细}}\n{{分隔线}}\n板材报价：{{板材报价}}\n油漆费用：{{油漆费用}}\n切割费用：{{切割费用}}\n打包费用：{{打包费用}}\n  总重量：{{总重量}}\n物流费用：{{物流费用}}\n{{分隔线}}\n最终合计：{{最终合计}}";
pub const PREVIOUS_TEMPLATE: &str = "明细\n{{分隔线}}\n{{零件明细}}\n{{分隔线}}\n板材报价：{{板材报价}}\n材料税率：{{材料税率}}\n材料税后价：{{材料税后价格}}\n油漆费用：{{油漆费用}}\n切割费用：{{切割费用}}\n打包费用：{{打包费用}}\n  总重量：{{总重量}}\n物流费用：{{物流费用}}\n{{分隔线}}\n未税合计：{{最终合计}}\n税后合计：{{税后合计}}";

pub fn normalize_template(value: &Value) -> String {
    match value.as_str() {
        Some(LEGACY_TEMPLATE | PREVIOUS_TEMPLATE) | None => DEFAULT_TEMPLATE.into(),
        Some(v) => v.into(),
    }
}

pub fn format_quotation(input: &Value) -> Result<String, String> {
    let source = input
        .get("template")
        .filter(|v| !v.is_null())
        .map(string)
        .unwrap_or_else(|| DEFAULT_TEMPLATE.into());
    let mut details = Vec::new();
    for part in rows(input, "parts") {
        if truthy(&part["shape"]) || part.get("rotationAngles").is_some() {
            return Err("仅支持矩形零件报价，请删除旧版轮廓或指定角度零件后重试".into());
        }
        let description = string(&part["description"])
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let dimensions = ["length", "width", "thickness"]
            .map(|key| format_number(number(&part[key], 0.0), 1, false, false))
            .join("*");
        details.push(format!(
            "{dimensions}mm {}张{}",
            format_number(number(&part["quantity"], 0.0), 0, false, false),
            if description.is_empty() {
                String::new()
            } else {
                format!(" [{description}]")
            }
        ));
    }
    let panel = field_number(input, "panelTotal", 0.0);
    let final_total = field_number(input, "finalTotal", 0.0);
    let tax = field_number(input, "taxRate", 0.0);
    let taxed_panel = field_number(input, "taxedPanelTotal", panel);
    let taxed_final = field_number(input, "taxedFinalTotal", final_total);
    let fields = [
        ("工程名称", string(&input["projectName"])),
        ("工程说明", string(&input["projectDescription"])),
        ("发货目的地", string(&input["shippingDestination"])),
        ("分隔线", "-".repeat(50)),
        ("零件明细", details.join("\n")),
        ("板材报价", currency(panel)),
        (
            "材料税率",
            format!("{}%", format_number(tax, 2, false, false)),
        ),
        ("材料税后价格", currency(taxed_panel)),
        ("油漆费用", currency(field_number(input, "paintTotal", 0.0))),
        (
            "切割费用",
            currency(field_number(input, "cuttingTotal", 0.0)),
        ),
        (
            "打包费用",
            currency(field_number(input, "packagingTotal", 0.0)),
        ),
        (
            "总重量",
            format!(
                "{} kg",
                format_number(field_number(input, "totalWeight", 0.0), 2, false, false)
            ),
        ),
        (
            "物流费用",
            currency(field_number(input, "logisticsTotal", 0.0)),
        ),
        ("未税合计", currency(final_total)),
        ("最终合计", currency(final_total)),
        ("税后合计", currency(taxed_final)),
    ];
    let mut result = source.clone();
    for (field, value) in &fields {
        result = result.replace(&format!("{{{{{field}}}}}"), value);
    }
    let has_tax = ["材料税率", "材料税后价格", "税后合计"]
        .iter()
        .any(|key| source.contains(&format!("{{{{{key}}}}}")));
    if !has_tax
        && (tax > 0.0
            || (taxed_panel - panel).abs() >= 0.005
            || (taxed_final - final_total).abs() >= 0.005)
    {
        result.push_str(&format!(
            "\n材料税率：{}%\n材料税后价：{}\n税后合计：{}",
            format_number(tax, 2, false, false),
            currency(taxed_panel),
            currency(taxed_final)
        ));
    }
    Ok(result)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRow {
    pub panel_charge: f64,
    pub taxed_panel_charge: f64,
    pub cutting_fee: f64,
}

pub fn signature(plan: &Plan) -> String {
    plan.layouts
        .iter()
        .map(|layout| {
            let mut ids: Vec<_> = layout
                .placements
                .iter()
                .map(|p| p.part.instance_id.clone())
                .collect();
            ids.sort_by_cached_key(|id| id.encode_utf16().collect::<Vec<_>>());
            format!(
                "{}:{}:{}:{}:{}:{}",
                layout.panel.source_index,
                if layout.is_full_sheet {
                    "full-sheet"
                } else {
                    "cut-layout"
                },
                pricing::fixed(layout.usage, 6),
                pricing::fixed(
                    number(
                        layout.pricing.get("panelCharge").unwrap_or(&Value::Null),
                        0.0
                    ),
                    6
                ),
                pricing::fixed(
                    number(
                        layout.pricing.get("cuttingFee").unwrap_or(&Value::Null),
                        0.0
                    ),
                    6
                ),
                ids.join(",")
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

pub fn initialize_adjustments(plan: &Plan, project: &Value) -> Vec<QuoteRow> {
    let saved = &project["quotationAdjustment"];
    let matched = saved["signature"] == signature(plan);
    let rate = pricing::normalize_tax_rate(&project["taxRate"]);
    plan.layouts
        .iter()
        .enumerate()
        .map(|(index, layout)| {
            let row = if matched {
                &saved["rows"][index]
            } else {
                &Value::Null
            };
            // JS Number(undefined) is NaN, whereas Number(null) is zero.
            let valid = |key: &str| {
                row.get(key)
                    .map(|v| number(v, f64::NAN))
                    .filter(|v| v.is_finite() && *v >= 0.0)
            };
            let charge = valid("panelCharge").unwrap_or_else(|| {
                number(
                    layout.pricing.get("panelCharge").unwrap_or(&Value::Null),
                    0.0,
                )
            });
            QuoteRow {
                panel_charge: charge,
                taxed_panel_charge: valid("taxedPanelCharge")
                    .unwrap_or_else(|| pricing::material_after_tax(charge, rate)),
                cutting_fee: if layout.is_full_sheet {
                    0.0
                } else {
                    valid("cuttingFee").unwrap_or_else(|| {
                        number(
                            layout.pricing.get("cuttingFee").unwrap_or(&Value::Null),
                            0.0,
                        )
                    })
                },
            }
        })
        .collect()
}

pub struct Totals {
    pub panel: f64,
    pub taxed_panel: f64,
    pub cutting: f64,
    pub packaging: f64,
    pub logistics: Logistics,
    pub final_total: f64,
    pub taxed_final_total: f64,
}
pub fn totals(plan: &Plan, project: &Value, adjustments: &[QuoteRow]) -> Totals {
    let panel = adjustments.iter().map(|r| r.panel_charge).sum::<f64>();
    let taxed_panel = adjustments
        .iter()
        .map(|r| r.taxed_panel_charge)
        .sum::<f64>();
    let cutting = adjustments.iter().map(|r| r.cutting_fee).sum::<f64>();
    let packaging = field_number(&project["settings"], "packagingFee", 0.0).max(0.0);
    let logistics = logistics::calculate(
        &string(&project["settings"]["logisticsProvider"]),
        &string(&project["shippingDestination"]),
        number(&plan.stats["totalWeight"], 0.0),
    );
    Totals {
        panel,
        taxed_panel,
        cutting,
        packaging,
        final_total: panel + cutting + packaging + logistics.fee,
        taxed_final_total: taxed_panel + cutting + packaging + logistics.fee,
        logistics,
    }
}

pub fn build_quotation(
    plan: &Plan,
    project: &Value,
    adjustments: &[QuoteRow],
) -> Result<String, String> {
    if !plan.unplaced.is_empty() {
        return Ok(format!(
            "尚有 {} 件零件未排入，暂不能生成正式报价。请调整零件或板材并重新优化；当前费用仅覆盖已排入部分。",
            plan.unplaced.len()
        ));
    }
    if !plan.is_complete() {
        return Err("排版零件数量与清单不一致，暂不能生成正式报价".into());
    }
    let totals = totals(plan, project, adjustments);
    let mut input = json!({"projectName":project["name"],"projectDescription":project["description"],"shippingDestination":project["shippingDestination"],"parts":project["parts"],"panelTotal":totals.panel,"taxRate":project["taxRate"],"taxedPanelTotal":totals.taxed_panel,"cuttingTotal":totals.cutting,"packagingTotal":totals.packaging,"totalWeight":plan.stats["totalWeight"],"logisticsTotal":totals.logistics.fee,"finalTotal":totals.final_total,"taxedFinalTotal":totals.taxed_final_total});
    if let Some(template) = project["settings"].get("quotationTemplate") {
        input["template"] = template.clone();
    }
    format_quotation(&input)
}

pub fn export_report(
    plan: &Plan,
    project: &Value,
    adjustments: &[QuoteRow],
) -> Result<String, String> {
    if !plan.unplaced.is_empty() {
        return Err("存在未排入的零件，请完成排版后再导出报告".into());
    }
    if !plan.is_complete() {
        return Err("排版零件数量与清单不一致，请重新优化后再导出报告".into());
    }
    if adjustments.len() != plan.layouts.len() {
        return Err("报价明细与排版不一致，请重新生成报价".into());
    }
    let totals = totals(plan, project, adjustments);
    let mut rows = vec![
        vec![
            "排版号",
            "板材材质",
            "板材厚度(mm)",
            "板材长度(mm)",
            "板材宽度(mm)",
            "实际用量重量(kg)",
            "整板件",
            "实际利用率",
            "本单损耗率(%)",
            "计价利用率",
            "计费比例",
            "整张成本价(元)",
            "利润比例(%)",
            "板材报价未税(元)",
            "材料税率(%)",
            "材料税后价格(元)",
            "调整后切割费(元)",
            "未税单张报价(元)",
            "税后单张报价(元)",
            "打包费合计(元)",
            "物流公司",
            "发货目的地",
            "物流时效(天)",
            "物流费合计(元)",
            "未税最终报价(元)",
            "税后最终报价(元)",
            "零件编号",
            "零件说明",
            "零件材质",
            "零件厚度(mm)",
            "零件长度(mm)",
            "零件宽度(mm)",
            "X(mm)",
            "Y(mm)",
            "旋转角度(°)",
            "计量面积(mm²)",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
    ];
    for (index, layout) in plan.layouts.iter().enumerate() {
        let row = &adjustments[index];
        for p in &layout.placements {
            let fallback = |v: &str| {
                if v.is_empty() {
                    "默认材质".into()
                } else {
                    v.to_owned()
                }
            };
            let code = p
                .part
                .extra
                .get("code")
                .filter(|v| truthy(v))
                .map(string)
                .unwrap_or_else(|| format!("P{}", p.part.source_index + 1));
            let values = vec![
                json!(index + 1),
                json!(fallback(&layout.panel.material)),
                json!(layout.panel.thickness),
                json!(layout.width),
                json!(layout.height),
                layout.pricing["actualWeight"].clone(),
                json!(if layout.is_full_sheet { "是" } else { "否" }),
                json!(layout.usage),
                project["lossRate"].clone(),
                layout.pricing["billingUsage"].clone(),
                layout.pricing["billingRate"].clone(),
                json!(layout.panel.cost),
                project["settings"]["profitRate"].clone(),
                json!(row.panel_charge),
                project["taxRate"].clone(),
                json!(row.taxed_panel_charge),
                json!(row.cutting_fee),
                json!(row.panel_charge + row.cutting_fee),
                json!(row.taxed_panel_charge + row.cutting_fee),
                json!(totals.packaging),
                json!(totals.logistics.provider_label),
                json!(totals.logistics.destination),
                totals
                    .logistics
                    .transit_days
                    .map_or(json!(""), |v| json!(v)),
                json!(totals.logistics.fee),
                json!(totals.final_total),
                json!(totals.taxed_final_total),
                json!(code),
                p.part
                    .extra
                    .get("description")
                    .cloned()
                    .unwrap_or(json!("")),
                json!(fallback(&p.part.material)),
                json!(p.part.thickness),
                json!(p.part.length),
                json!(p.part.width),
                json!(p.x),
                json!(p.y),
                json!(if p.rotated { 90 } else { 0 }),
                json!(p.part.length * p.part.width),
            ];
            rows.push(values.iter().map(string).collect());
        }
    }
    Ok(parts_csv::serialize_rows(&rows))
}
