//! Independent rectangular beam-search port, preserving the JS search order.
use crate::{
    engine::{SearchContext, compare_scores},
    model::*,
};
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Clone, Copy)]
pub struct BeamLimits {
    pub width: usize,
    pub candidates: usize,
    pub search_parts: usize,
    pub expanded_states: usize,
}
impl Default for BeamLimits {
    fn default() -> Self {
        Self {
            width: 4,
            candidates: 6,
            search_parts: 60,
            expanded_states: 10000,
        }
    }
}

#[derive(Clone, Default)]
struct State {
    placements: Vec<Placement>,
    used_area: f64,
}

pub struct Fill {
    pub placements: Vec<Placement>,
    pub free_rects: Vec<Rect>,
    pub used_area: f64,
    pub diagnostics: Value,
}

fn state_score(state: &State, bounds: Rect) -> [f64; 5] {
    let mut right = bounds.x;
    let mut bottom = bounds.y;
    for p in &state.placements {
        right = right.max(p.x + p.placed_length);
        bottom = bottom.max(p.y + p.placed_width);
    }
    [
        -state.used_area,
        (right - bounds.x) * (bottom - bounds.y),
        -(state.placements.len() as f64),
        bottom,
        right,
    ]
}

fn state_key(state: &State) -> String {
    let mut parts: Vec<_> = state.placements.iter().collect();
    parts.sort_unstable_by_key(|p| p.part.input_key());
    serde_json::to_string(
        &parts
            .iter()
            .map(|p| (p.part.input_key(), p.x, p.y, p.rotated))
            .collect::<Vec<_>>(),
    )
    .expect("finite state")
}

fn children(
    state: &State,
    parts: &[Part],
    bounds: Rect,
    settings: &Settings,
    candidate_limit: usize,
    consume: &mut dyn FnMut() -> bool,
    context: &SearchContext<'_>,
) -> Result<Vec<State>, String> {
    let occupied: HashSet<_> = state
        .placements
        .iter()
        .map(|p| p.part.input_key())
        .collect();
    let mut specs = HashSet::new();
    let mut result = Vec::new();
    let mut xs = vec![bounds.x];
    let mut ys = vec![bounds.y];
    for p in &state.placements {
        xs.push(p.x + p.placed_length + settings.saw_width);
        ys.push(p.y + p.placed_width + settings.saw_width);
    }
    xs.sort_by(f64::total_cmp);
    xs.dedup();
    ys.sort_by(f64::total_cmp);
    ys.dedup();
    let mut feasible_specs = 0;
    for part in parts {
        context.check()?;
        if occupied.contains(&part.input_key()) {
            continue;
        }
        if !specs.insert((
            part.length.to_bits(),
            part.width.to_bits(),
            part.allow_rotate.unwrap_or(settings.allow_rotation),
        )) {
            continue;
        }
        let mut feasible = false;
        for (w, h, rotated) in part.orientations(settings.allow_rotation) {
            if w > bounds.w + EPSILON || h > bounds.h + EPSILON {
                continue;
            }
            for y in &ys {
                for x in &xs {
                    context.check()?;
                    if !consume() {
                        return Ok(result);
                    }
                    if *x < bounds.x - EPSILON
                        || *y < bounds.y - EPSILON
                        || x + w > bounds.x + bounds.w + EPSILON
                        || y + h > bounds.y + bounds.h + EPSILON
                    {
                        continue;
                    }
                    if !state.placements.iter().all(|p| {
                        x + w + settings.saw_width <= p.x + EPSILON
                            || p.x + p.placed_length + settings.saw_width <= x + EPSILON
                            || y + h + settings.saw_width <= p.y + EPSILON
                            || p.y + p.placed_width + settings.saw_width <= y + EPSILON
                    }) {
                        continue;
                    }
                    feasible = true;
                    let mut next = state.clone();
                    next.used_area += part.length * part.width;
                    next.placements.push(Placement {
                        part: part.clone(),
                        x: *x,
                        y: *y,
                        placed_length: w,
                        placed_width: h,
                        rotated,
                    });
                    result.push(next);
                }
            }
        }
        if feasible {
            feasible_specs += 1;
            if feasible_specs >= candidate_limit {
                break;
            }
        }
    }
    Ok(result)
}

pub fn fill_rectangle_sheet(
    panel: &Panel,
    parts: &[Part],
    settings: &Settings,
    limits: BeamLimits,
    context: &mut SearchContext<'_>,
) -> Result<Fill, String> {
    let width = limits.width.clamp(1, 64);
    let candidates = limits.candidates.clamp(1, 64);
    let bounds = Rect {
        x: settings.margin_x,
        y: settings.margin_y,
        w: panel.length - 2.0 * settings.margin_x,
        h: panel.width - 2.0 * settings.margin_y,
    };
    let valid: Vec<_> = parts
        .iter()
        .filter(|p| p.length > 0.0 && p.width > 0.0)
        .cloned()
        .collect();
    let mut expanded_states = 0;
    let mut limited = valid.len() > limits.search_parts.clamp(1, 500);
    let mut best = State::default();
    let mut beam = vec![best.clone()];
    let mut depth = 0;
    if !limited {
        while depth < valid.len() {
            context.check()?;
            let mut next = Vec::new();
            for state in &beam {
                let mut consume = || {
                    if expanded_states >= limits.expanded_states.clamp(1, 1000000) {
                        limited = true;
                        false
                    } else {
                        expanded_states += 1;
                        true
                    }
                };
                next.extend(children(
                    state,
                    &valid,
                    bounds,
                    settings,
                    candidates,
                    &mut consume,
                    context,
                )?);
                if limited {
                    break;
                }
            }
            if next.is_empty() {
                break;
            }
            next.sort_by(|a, b| compare_scores(&state_score(a, bounds), &state_score(b, bounds)));
            if compare_scores(&state_score(&next[0], bounds), &state_score(&best, bounds)).is_lt() {
                best = next[0].clone();
            }
            let mut seen = HashSet::new();
            beam = next
                .into_iter()
                .filter(|state| seen.insert(state_key(state)))
                .take(width)
                .collect();
            depth += 1;
            if limited {
                break;
            }
        }
    }
    loop {
        context.check()?;
        let mut next = children(&best, &valid, bounds, settings, 1, &mut || true, context)?;
        if next.is_empty() {
            break;
        }
        next.sort_by(|a, b| compare_scores(&state_score(a, bounds), &state_score(b, bounds)));
        best = next.remove(0);
    }
    let mut rects = if bounds.w > 0.0 && bounds.h > 0.0 {
        vec![bounds]
    } else {
        Vec::new()
    };
    for p in &best.placements {
        context.check()?;
        rects = split_rectangles(
            &rects,
            Rect {
                x: p.x,
                y: p.y,
                w: (bounds.x + bounds.w - p.x).min(p.placed_length + settings.saw_width),
                h: (bounds.y + bounds.h - p.y).min(p.placed_width + settings.saw_width),
            },
            true,
        );
    }
    Ok(Fill {
        placements: best.placements,
        free_rects: rects,
        used_area: best.used_area,
        diagnostics: json!({"expandedStates":expanded_states,"beamWidth":width,"depth":depth,"limited":limited}),
    })
}
