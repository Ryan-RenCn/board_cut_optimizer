use crate::{logistics, model::*};
use serde_json::{Value, json};

pub fn normalize_tax_rate(value: &Value) -> f64 {
    number(value, 0.0).clamp(0.0, 100.0)
}
pub fn material_after_tax(price: f64, rate: f64) -> f64 {
    let price = if price.is_finite() {
        price.max(0.0)
    } else {
        0.0
    };
    let rate = if rate.is_finite() {
        rate.clamp(0.0, 100.0)
    } else {
        0.0
    };
    let value = price * (1.0 + rate / 100.0);
    // JS Math.round is toward +infinity at half ties; inputs here are non-negative.
    let scaled = (value + f64::EPSILON) * 100.0;
    (scaled.floor()
        + if scaled - scaled.floor() >= 0.5 {
            1.0
        } else {
            0.0
        })
        / 100.0
}

pub fn reprice(plan: &mut Plan, project: &Value) {
    let settings = &project["settings"];
    let loss = field_number(project, "lossRate", 0.0).clamp(0.0, 100.0);
    let profit = field_number(settings, "profitRate", 100.0).max(0.0);
    let cutting = field_number(settings, "cuttingFee", 0.0).max(0.0);
    let packaging = field_number(settings, "packagingFee", 0.0).max(0.0);
    let (mut total_loss, mut total_cost, mut total_charge, mut total_cutting, mut total_weight) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    for layout in &mut plan.layouts {
        let billing_usage = if layout.is_full_sheet {
            1.0
        } else {
            (layout.usage + loss / 100.0).min(1.0)
        };
        let loss_area = layout.width * layout.height * (billing_usage - layout.usage).max(0.0);
        let rate = if billing_usage >= 0.8 - EPSILON {
            1.0
        } else {
            (billing_usage * 10.0 - EPSILON).ceil() / 10.0
        };
        let weight = layout.panel.weight * layout.usage;
        let cost = layout.panel.cost * rate;
        let charge = cost * profit / 100.0;
        let fee = if layout.is_full_sheet {
            0.0
        } else {
            cutting * rate
        };
        layout.pricing=json!({"billingUsage":billing_usage,"lossArea":loss_area,"billingRate":rate,"actualWeight":weight,"panelCost":cost,"panelCharge":charge,"cuttingFee":fee}).as_object().unwrap().clone();
        total_loss += loss_area;
        total_cost += cost;
        total_charge += charge;
        total_cutting += fee;
        total_weight += weight;
    }
    let logistics = logistics::calculate(
        &string(&settings["logisticsProvider"]),
        &string(&project["shippingDestination"]),
        total_weight,
    );
    let used_area = number(&plan.stats["usedPanelArea"], 0.0);
    let parts_area = number(&plan.stats["partsArea"], 0.0);
    let updates = json!({"totalLossArea":total_loss,"totalPanelCost":total_cost,"totalPanelCharge":total_charge,"profitRate":profit,"lossRate":loss,"cuttingFeePerPanel":cutting,"totalCuttingFee":total_cutting,"packagingFee":packaging,"totalWeight":total_weight,"totalLogisticsFee":logistics.fee,"finalQuote":total_charge+total_cutting+packaging+logistics.fee,"averageBillingUsage":if used_area>0.0{(parts_area+total_loss)/used_area}else{0.0},"logistics":logistics});
    for (key, value) in updates.as_object().unwrap() {
        plan.stats[key] = value.clone();
    }
}

/// JS Number.toFixed for non-negative money/usage used by saved quote signatures.
/// Uses the exact f64 mantissa, so ties are rounded up, not Rust's ties-to-even.
pub fn fixed(value: f64, decimals: usize) -> String {
    assert!(decimals <= 6);
    if !value.is_finite() {
        return "0".into();
    }
    if value.abs() >= 1e21 {
        return string(&json!(value));
    }
    let negative = value < 0.0;
    let bits = value.abs().to_bits();
    let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = if raw_exponent == 0 {
        bits & ((1u64 << 52) - 1)
    } else {
        (bits & ((1u64 << 52) - 1)) | (1u64 << 52)
    } as u128;
    let exponent = if raw_exponent == 0 {
        -1074
    } else {
        raw_exponent - 1023 - 52
    };
    let scaled = mantissa * 10u128.pow(decimals as u32);
    let rounded = if exponent >= 0 {
        scaled << exponent
    } else {
        let shift = (-exponent) as u32;
        if shift >= 128 {
            0
        } else {
            let integer = scaled >> shift;
            let remainder = scaled & ((1u128 << shift) - 1);
            integer + u128::from(remainder >= (1u128 << (shift - 1)))
        }
    };
    let mut digits = rounded.to_string();
    if decimals > 0 {
        while digits.len() <= decimals {
            digits.insert(0, '0');
        }
        digits.insert(digits.len() - decimals, '.');
    }
    if negative {
        digits.insert(0, '-');
    }
    digits
}

/// Intl-style decimal formatting: round the shortest decimal representation.
/// `fixed(1.005, 2)` is intentionally different from `format_number(1.005, 2)`.
pub fn format_number(value: f64, decimals: usize, pad: bool, group: bool) -> String {
    let value = if value.is_finite() { value } else { 0.0 };
    let mut digits = value.abs().to_string();
    let decimal = digits.find('.').unwrap_or(digits.len());
    if decimal == digits.len() {
        digits.push('.');
    }
    let mut integer = digits.as_bytes()[..decimal].to_vec();
    let mut fraction = digits.as_bytes()[decimal + 1..].to_vec();
    fraction.resize(fraction.len().max(decimals + 1), b'0');
    let round = fraction[decimals] >= b'5';
    fraction.truncate(decimals);
    if round {
        let mut carry = true;
        for digit in fraction.iter_mut().rev().chain(integer.iter_mut().rev()) {
            if *digit == b'9' {
                *digit = b'0';
            } else {
                *digit += 1;
                carry = false;
                break;
            }
        }
        if carry {
            integer.insert(0, b'1');
        }
    }
    if !pad {
        while fraction.last() == Some(&b'0') {
            fraction.pop();
        }
    }
    let mut integer = String::from_utf8(integer).unwrap();
    if group {
        let mut position = integer.len();
        while position > 3 {
            position -= 3;
            integer.insert(position, ',');
        }
    }
    if !fraction.is_empty() {
        integer.push('.');
        integer.push_str(&String::from_utf8(fraction).unwrap());
    }
    if value.is_sign_negative() {
        integer.insert(0, '-');
    }
    integer
}
pub fn currency(value: f64) -> String {
    let formatted = format_number(value, 2, true, true);
    if let Some(abs) = formatted.strip_prefix('-') {
        format!("-¥{abs}")
    } else {
        format!("¥{formatted}")
    }
}
