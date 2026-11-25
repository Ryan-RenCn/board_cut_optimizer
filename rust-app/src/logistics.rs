use serde::{Deserialize, Serialize};

pub const PROVIDER: &str = "shanghai-kuta";
pub const PROVIDER_LABEL: &str = "上海库沓物流（上海始发）";
pub struct Route {
    pub destinations: &'static [&'static str],
    pub days: u32,
    pub first: f64,
    pub rates: [f64; 6],
}
pub const ROUTES: &[Route] = &[
    Route {
        destinations: &["江苏", "浙江", "上海"],
        days: 1,
        first: 15.0,
        rates: [0.8, 0.7, 0.6, 0.55, 0.5, 0.4],
    },
    Route {
        destinations: &["崇明岛", "象山", "舟山"],
        days: 1,
        first: 45.0,
        rates: [1.0, 0.9, 0.9, 0.9, 0.8, 0.6],
    },
    Route {
        destinations: &["安徽"],
        days: 1,
        first: 20.0,
        rates: [1.0, 0.8, 0.7, 0.65, 0.6, 0.4],
    },
    Route {
        destinations: &["山东", "福建", "江西", "广东", "湖南", "湖北", "河南"],
        days: 1,
        first: 20.0,
        rates: [1.3, 1.0, 0.9, 0.85, 0.8, 0.6],
    },
    Route {
        destinations: &["北京", "河北", "天津"],
        days: 2,
        first: 25.0,
        rates: [1.4, 1.2, 1.1, 1.0, 1.0, 0.8],
    },
    Route {
        destinations: &["四川", "重庆"],
        days: 3,
        first: 25.0,
        rates: [1.8, 1.7, 1.6, 1.5, 1.4, 1.2],
    },
    Route {
        destinations: &["山西", "陕西", "广西"],
        days: 3,
        first: 25.0,
        rates: [2.0, 1.8, 1.6, 1.5, 1.3, 1.1],
    },
    Route {
        destinations: &["贵州", "云南", "辽宁", "吉林", "黑龙江"],
        days: 3,
        first: 25.0,
        rates: [2.4, 1.7, 1.6, 1.4, 1.4, 1.3],
    },
    Route {
        destinations: &["海南", "甘肃", "内蒙古", "宁夏", "青海"],
        days: 3,
        first: 50.0,
        rates: [3.0, 2.7, 2.6, 2.5, 2.3, 2.1],
    },
    Route {
        destinations: &["香港", "新疆", "西藏", "澳门"],
        days: 5,
        first: 100.0,
        rates: [5.5, 5.3, 5.0, 4.8, 4.6, 4.3],
    },
];
pub fn destinations() -> Vec<String> {
    ROUTES.iter().map(|r| r.destinations.join("/")).collect()
}
pub fn normalize_destination(value: &str) -> String {
    ROUTES
        .iter()
        .find(|r| {
            r.destinations.join("/") == value.trim() || r.destinations.contains(&value.trim())
        })
        .map(|r| r.destinations.join("/"))
        .unwrap_or_default()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Logistics {
    pub enabled: bool,
    pub available: bool,
    pub provider_label: String,
    pub origin: String,
    pub destination: String,
    pub transit_days: Option<u32>,
    pub weight: f64,
    pub fee: f64,
}

pub fn calculate(provider: &str, destination: &str, weight: f64) -> Logistics {
    let weight = if weight.is_finite() {
        weight.max(0.0)
    } else {
        0.0
    };
    let destination = normalize_destination(destination);
    let route = ROUTES
        .iter()
        .find(|r| r.destinations.join("/") == destination);
    let enabled = provider == PROVIDER;
    let mut result = Logistics {
        enabled,
        available: enabled && route.is_some(),
        provider_label: if enabled {
            PROVIDER_LABEL
        } else {
            "不计算物流"
        }
        .into(),
        origin: "上海".into(),
        destination,
        transit_days: route.map(|r| r.days),
        weight,
        fee: 0.0,
    };
    if let Some(route) = route.filter(|_| enabled && weight > 0.0) {
        let index = [70.0, 100.0, 200.0, 300.0, 500.0]
            .iter()
            .position(|threshold| weight <= *threshold)
            .unwrap_or(5);
        let base = if weight <= 10.0 {
            route.first
        } else {
            route.first + (weight - 10.0) * route.rates[index]
        };
        result.fee = (base * 1.2 / 10.0).ceil() * 10.0;
    }
    result
}
