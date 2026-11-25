//! Deterministic MaxRects + multi-strategy rectangular beam optimization.
use crate::{
    beam_nesting::{BeamLimits, fill_rectangle_sheet},
    model::*,
};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::HashSet,
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub struct Progress {
    pub layouts: Vec<Layout>,
    pub total_count: usize,
    pub sort_key: String,
    pub strategy: String,
}

pub struct SearchContext<'a> {
    pub checkpoint: &'a dyn Fn() -> Result<(), String>,
    pub on_progress: &'a mut dyn FnMut(Progress),
    pub progress_interval: Duration,
    last_progress: Option<Instant>,
}
impl<'a> SearchContext<'a> {
    pub fn new(
        checkpoint: &'a dyn Fn() -> Result<(), String>,
        on_progress: &'a mut dyn FnMut(Progress),
    ) -> Self {
        Self {
            checkpoint,
            on_progress,
            progress_interval: Duration::ZERO,
            last_progress: None,
        }
    }
    pub fn check(&self) -> Result<(), String> {
        (self.checkpoint)()
    }
    fn progress_due(&mut self) -> bool {
        if self
            .last_progress
            .is_some_and(|last| last.elapsed() < self.progress_interval)
        {
            return false;
        }
        self.last_progress = Some(Instant::now());
        true
    }
}

pub fn compare_scores(a: &[f64], b: &[f64]) -> Ordering {
    for (a, b) in a.iter().zip(b) {
        if (a - b).abs() > EPSILON {
            return a.total_cmp(b);
        }
    }
    Ordering::Equal
}
fn candidate_better(a: &[f64], b: &[f64]) -> bool {
    (0..a.len()).any(|i| a[i] < b[i] - EPSILON && (0..i).all(|j| (a[j] - b[j]).abs() < EPSILON))
}

fn build_layout(panel: &Panel, index: usize, settings: &Settings) -> Layout {
    let usable_width = (panel.length - 2.0 * settings.margin_x).max(0.0);
    let usable_height = (panel.width - 2.0 * settings.margin_y).max(0.0);
    Layout {
        id: format!("layout-{}", index + 1),
        panel: panel.clone(),
        width: panel.length,
        height: panel.width,
        usable_width,
        usable_height,
        placements: Vec::new(),
        free_rects: if usable_width > 0.0 && usable_height > 0.0 {
            vec![Rect {
                x: settings.margin_x,
                y: settings.margin_y,
                w: usable_width,
                h: usable_height,
            }]
        } else {
            Vec::new()
        },
        used_area: 0.0,
        packing_area: 0.0,
        measurement_area: 0.0,
        usage: 0.0,
        is_full_sheet: false,
        diagnostics: None,
        pricing: Default::default(),
    }
}

fn full_layout(panel: &Panel, part: Part, index: usize, settings: &Settings) -> Layout {
    let mut result = build_layout(panel, index, settings);
    let rotated = (part.length - panel.length).abs() >= EPSILON
        || (part.width - panel.width).abs() >= EPSILON;
    result.usable_width = panel.length;
    result.usable_height = panel.width;
    result.free_rects.clear();
    result.used_area = panel.length * panel.width;
    result.is_full_sheet = true;
    result.placements.push(Placement {
        part,
        x: 0.0,
        y: 0.0,
        placed_length: panel.length,
        placed_width: panel.width,
        rotated,
    });
    result
}

fn place_part(
    layout: &mut Layout,
    part: &Part,
    settings: &Settings,
    context: &SearchContext<'_>,
) -> Result<bool, String> {
    let mut best: Option<(Placement, Rect, [f64; 6])> = None;
    for free in &layout.free_rects {
        context.check()?;
        for (w, h, rotated) in part.orientations(settings.allow_rotation) {
            if w > free.w + EPSILON || h > free.h + EPSILON {
                continue;
            }
            let kerf = settings.saw_width;
            if !layout.placements.iter().all(|p| {
                free.x + w + kerf <= p.x + EPSILON
                    || p.x + p.placed_length + kerf <= free.x + EPSILON
                    || free.y + h + kerf <= p.y + EPSILON
                    || p.y + p.placed_width + kerf <= free.y + EPSILON
            }) {
                continue;
            }
            let bias = match settings.orientation.as_str() {
                "preserve" => {
                    if rotated {
                        1.0
                    } else {
                        0.0
                    }
                }
                "rotate" => {
                    if rotated {
                        0.0
                    } else {
                        1.0
                    }
                }
                _ => 0.0,
            };
            let score = [
                bias,
                (free.w - w).min(free.h - h),
                (free.w - w).max(free.h - h),
                free.w * free.h - w * h,
                free.y,
                free.x,
            ];
            if best
                .as_ref()
                .is_none_or(|(_, _, current)| candidate_better(&score, current))
            {
                best = Some((
                    Placement {
                        part: part.clone(),
                        x: free.x,
                        y: free.y,
                        placed_length: w,
                        placed_width: h,
                        rotated,
                    },
                    Rect {
                        x: free.x,
                        y: free.y,
                        w: free.w.min(w + kerf),
                        h: free.h.min(h + kerf),
                    },
                    score,
                ));
            }
        }
    }
    if let Some((placement, reservation, _)) = best {
        layout.placements.push(placement);
        layout.used_area += part.length * part.width;
        layout.free_rects = split_rectangles(&layout.free_rects, reservation, false);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn raw_compare(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}
fn sort_parts(parts: &mut [Part], key: &str) {
    parts.sort_by(|a, b| {
        b.full_sheet().cmp(&a.full_sheet()).then_with(|| {
            let area = || raw_compare(b.length * b.width, a.length * a.width);
            let long = || raw_compare(b.length.max(b.width), a.length.max(a.width));
            match key {
                "longSide" => long().then_with(area),
                "perimeter" => raw_compare(b.length + b.width, a.length + a.width).then_with(area),
                "width" => {
                    raw_compare(b.width, a.width).then_with(|| raw_compare(b.length, a.length))
                }
                _ => area().then_with(long),
            }
        })
    });
}

fn report(
    context: &mut SearchContext<'_>,
    layouts: &[Layout],
    current: Option<&Layout>,
    count: usize,
    sort_key: &str,
    strategy: &str,
) {
    if !context.progress_due() {
        return;
    }
    let mut preview = layouts.to_vec();
    if let Some(current) = current {
        preview.push(current.clone());
    }
    for layout in &mut preview {
        layout.free_rects.clear();
    }
    (context.on_progress)(Progress {
        layouts: preview,
        total_count: count,
        sort_key: sort_key.into(),
        strategy: strategy.into(),
    });
}

fn run_attempt(
    panels: &[Panel],
    parts: &[Part],
    settings: &Settings,
    sort_key: &str,
    context: &mut SearchContext<'_>,
) -> Result<Plan, String> {
    context.check()?;
    let mut pending = parts.to_vec();
    sort_parts(&mut pending, sort_key);
    context.check()?;
    let mut available = panels.to_vec();
    available.sort_by(|a, b| raw_compare(a.length * a.width, b.length * b.width));
    let mut layouts = Vec::new();
    let mut unplaced = Vec::new();
    let strategy = if settings.beam {
        "rectangle-beam"
    } else {
        "maxrects"
    };
    while !pending.is_empty() {
        context.check()?;
        let first = &pending[0];
        let inventory: Vec<_> = available.iter().filter(|p| p.matches(first)).collect();
        let full = if first.full_sheet() {
            inventory
                .iter()
                .find(|p| {
                    first
                        .orientations(settings.allow_rotation)
                        .iter()
                        .any(|(w, h, _)| {
                            (w - p.length).abs() < EPSILON && (h - p.width).abs() < EPSILON
                        })
                })
                .copied()
        } else {
            None
        };
        if let Some(panel) = full {
            layouts.push(full_layout(
                panel,
                pending.remove(0),
                layouts.len(),
                settings,
            ));
            report(context, &layouts, None, parts.len(), sort_key, strategy);
            continue;
        }
        let matching: Vec<_> = inventory
            .iter()
            .copied()
            .filter(|p| {
                first
                    .orientations(settings.allow_rotation)
                    .iter()
                    .any(|(w, h, _)| {
                        *w <= p.length - settings.margin_x * 2.0 + EPSILON
                            && *h <= p.width - settings.margin_y * 2.0 + EPSILON
                    })
            })
            .collect();
        if matching.is_empty() {
            let reason = if inventory.is_empty() {
                "没有匹配材质或厚度的板材"
            } else {
                "零件尺寸超出板材尺寸"
            };
            let mut part = pending.remove(0);
            part.reason = Some(reason.into());
            unplaced.push(part);
            continue;
        }
        let mut best: Option<(Layout, [f64; 3])> = None;
        for panel in matching {
            context.check()?;
            let mut trial = build_layout(panel, layouts.len(), settings);
            if settings.beam {
                let limits = if settings.quick {
                    BeamLimits {
                        width: 2,
                        candidates: 4,
                        search_parts: 24,
                        expanded_states: 1200,
                    }
                } else {
                    BeamLimits {
                        width: 4,
                        candidates: 6,
                        search_parts: 40,
                        expanded_states: 5000,
                    }
                };
                let compatible: Vec<_> = pending
                    .iter()
                    .filter(|p| panel.matches(p))
                    .cloned()
                    .collect();
                let filled = fill_rectangle_sheet(panel, &compatible, settings, limits, context)?;
                trial.placements = filled.placements;
                trial.free_rects = filled.free_rects;
                trial.used_area = filled.used_area;
                trial.diagnostics = Some(filled.diagnostics);
                report(
                    context,
                    &layouts,
                    Some(&trial),
                    parts.len(),
                    sort_key,
                    strategy,
                );
            } else {
                for part in &pending {
                    context.check()?;
                    if panel.matches(part) && place_part(&mut trial, part, settings, context)? {
                        report(
                            context,
                            &layouts,
                            Some(&trial),
                            parts.len(),
                            sort_key,
                            strategy,
                        );
                    }
                }
            }
            let area = panel.length * panel.width;
            let score = [
                if trial.placements.is_empty() {
                    1.0
                } else {
                    0.0
                },
                -trial.used_area / area,
                area,
            ];
            if best
                .as_ref()
                .is_none_or(|(_, current)| candidate_better(&score, current))
            {
                best = Some((trial, score));
            }
        }
        if let Some((trial, _)) = best.filter(|(trial, _)| !trial.placements.is_empty()) {
            let placed_keys: HashSet<_> = trial
                .placements
                .iter()
                .map(|p| p.part.input_key())
                .collect();
            pending.retain(|p| !placed_keys.contains(&p.input_key()));
            layouts.push(trial);
            report(context, &layouts, None, parts.len(), sort_key, strategy);
        } else {
            let mut part = pending.remove(0);
            part.reason = Some("排版空间不足".into());
            unplaced.push(part);
        }
    }
    for layout in &mut layouts {
        layout.packing_area = layout.used_area;
        layout.measurement_area = layout
            .placements
            .iter()
            .map(|p| p.part.length * p.part.width)
            .sum();
        layout.used_area = (layout.width * layout.height).min(layout.measurement_area);
        layout.usage = if layout.width * layout.height > 0.0 {
            layout.used_area / (layout.width * layout.height)
        } else {
            0.0
        };
    }
    let placed: usize = layouts.iter().map(|l| l.placements.len()).sum();
    if placed + unplaced.len() != parts.len() {
        return Err("排版零件数量与清单不一致，未生成有效方案".into());
    }
    let used_panel_area: f64 = layouts.iter().map(|l| l.width * l.height).sum();
    let parts_area: f64 = layouts.iter().map(|l| l.used_area).sum();
    let packing_area: f64 = layouts.iter().map(|l| l.packing_area).sum();
    Ok(Plan {
        score: [
            unplaced.len() as f64,
            used_panel_area - packing_area,
            layouts.len() as f64,
        ],
        stats: json!({"placedCount":placed,"requestedCount":parts.len(),"usedPanels":layouts.len(),"partsArea":parts_area,"usedPanelArea":used_panel_area,"averageUsage":if used_panel_area>0.0{parts_area/used_panel_area}else{0.0}}),
        layouts,
        unplaced,
        strategy: strategy.into(),
        sort_key: sort_key.into(),
        orientation_strategy: settings.orientation.clone(),
        algorithm: Value::Null,
        attempts_summary: Vec::new(),
        trace: Vec::new(),
    })
}

pub fn optimize(project: &Value, include_beam: bool) -> Result<Plan, String> {
    let started = Instant::now();
    let checkpoint = || {
        if started.elapsed() > Duration::from_secs(60) {
            Err("优化超过60秒，已停止。请尝试快速模式或减少零件数量后重试".into())
        } else {
            Ok(())
        }
    };
    optimize_with_context(
        project,
        include_beam,
        &mut SearchContext::new(&checkpoint, &mut |_| {}),
    )
}

pub fn optimize_with_context(
    project: &Value,
    include_beam: bool,
    context: &mut SearchContext<'_>,
) -> Result<Plan, String> {
    context.check()?;
    if let Some(error) = validate_project(project).first() {
        return Err(error.clone());
    }
    let base = Settings::from_project(project);
    let mut parts = Vec::new();
    for (source_index, part) in rows(project, "parts").iter().enumerate() {
        context.check()?;
        let quantity = field_number(part, "quantity", 0.0) as usize;
        for instance_index in 0..quantity {
            context.check()?;
            parts
                .try_reserve(1)
                .map_err(|_| "零件数量过大，内存不足".to_string())?;
            let mut instance = Part::from_source(part, source_index, instance_index);
            instance.allow_rotate = Some(instance.allow_rotate.unwrap_or(base.allow_rotation));
            parts.push(instance);
        }
    }
    let panels: Vec<_> = rows(project, "panels")
        .iter()
        .enumerate()
        .map(|(i, p)| Panel::from_source(p, i))
        .collect();
    if parts.is_empty() {
        return Err("请至少录入一个尺寸完整的零件。".into());
    }
    if panels.is_empty() {
        return Err("请至少录入一张尺寸完整的板材。".into());
    }
    let sort_keys: &[&str] = if base.quick {
        &["area"]
    } else {
        &["area", "longSide", "perimeter", "width"]
    };
    let orientations: &[&str] =
        if base.allow_rotation || parts.iter().any(|part| part.allow_rotate == Some(true)) {
            &["bestFit", "preserve", "rotate"]
        } else {
            &["bestFit"]
        };
    let mut attempts = Vec::new();
    for sort in sort_keys {
        for orientation in orientations {
            let mut settings = base.clone();
            settings.orientation = (*orientation).into();
            attempts.push(run_attempt(&panels, &parts, &settings, sort, context)?);
        }
    }
    if include_beam {
        for sort in if base.quick {
            &["area"][..]
        } else {
            &["area", "longSide"][..]
        } {
            let mut settings = base.clone();
            settings.beam = true;
            attempts.push(run_attempt(&panels, &parts, &settings, sort, context)?);
        }
    }
    let mut winner = 0;
    for i in 1..attempts.len() {
        if compare_scores(&attempts[i].score, &attempts[winner].score).is_lt() {
            winner = i;
        }
    }
    let summary=attempts.iter().enumerate().map(|(i,p)|json!({"strategy":p.strategy,"sortKey":p.sort_key,"orientationStrategy":p.orientation_strategy,"score":p.score,"usedPanels":p.layouts.len(),"placedCount":p.stats["placedCount"],"selected":i==winner})).collect();
    let count = attempts.len();
    let mut best = attempts.remove(winner);
    best.algorithm = json!({"label":if include_beam{"组合优化：矩形束搜索 + 多策略贴合"}else{"多策略贴合"},"provenance":"independent-rectangle-adaptation","attempts":count,"selectedStrategy":best.strategy,"selectedSort":best.sort_key,"selectedOrientation":best.orientation_strategy});
    best.attempts_summary = summary;
    best.trace=best.layouts.iter().enumerate().flat_map(|(li,l)|l.placements.iter().enumerate().map(move |(pi,p)|(li,l,pi,p))).map(|(li,l,pi,p)|json!({"layoutIndex":li,"placementIndex":pi,"partId":p.part.instance_id,"x":p.x,"y":p.y,"width":p.placed_length,"height":p.placed_width,"rotated":p.rotated,"angle":if p.rotated{90}else{0},"strategy":if l.is_full_sheet{"full-sheet"}else{&best.strategy}})).collect();
    crate::pricing::reprice(&mut best, project);
    Ok(best)
}

pub fn group_identical_layouts(layouts: &[Layout]) -> Vec<(usize, usize)> {
    let mut keys = Vec::new();
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for (index, layout) in layouts.iter().enumerate() {
        let mut placements = if layout.is_full_sheet {
            Vec::new()
        } else {
            layout.placements.iter().collect::<Vec<_>>()
        };
        placements.sort_by(|a, b| {
            raw_compare(a.y, b.y)
                .then_with(|| raw_compare(a.x, b.x))
                .then_with(|| {
                    string(&a.part.extra.get("code").cloned().unwrap_or(Value::Null)).cmp(&string(
                        &b.part.extra.get("code").cloned().unwrap_or(Value::Null),
                    ))
                })
        });
        let rows:Vec<_>=placements.iter().map(|p| {
            let code=p.part.extra.get("code").filter(|v|truthy(v)).map(string).unwrap_or_else(||format!("P{}",p.part.source_index+1));
            json!({"code":code,"description":p.part.extra.get("description").filter(|v|truthy(v)).map(string).unwrap_or_default(),"material":p.part.material,"thickness":p.part.thickness,"length":p.part.length,"width":p.part.width,"x":p.x,"y":p.y,"placedLength":p.placed_length,"placedWidth":p.placed_width,"rotated":p.rotated,"angle":p.part.extra.get("angle").filter(|v|!v.is_null()).cloned().unwrap_or(json!(if p.rotated{90}else{0}))})
        }).collect();
        let key=json!({"panel":{"material":layout.panel.material,"description":layout.panel.extra.get("description").filter(|v|truthy(v)).map(string).unwrap_or_default(),"thickness":layout.panel.thickness,"length":layout.width,"width":layout.height,"cost":layout.panel.cost,"weight":layout.panel.weight},"isFullSheet":layout.is_full_sheet,"usableWidth":layout.usable_width,"usableHeight":layout.usable_height,"placements":rows}).to_string();
        if let Some(i) = keys.iter().position(|k| k == &key) {
            groups[i].1 += 1;
        } else {
            keys.push(key);
            groups.push((index, 1));
        }
    }
    groups
}
