use crate::{
    jobs::{JobError, OptimizationJob},
    model::*,
    pricing, project,
    quotation::{self, QuoteRow},
    storage::{self, Store},
    ui,
};
use eframe::egui::{self, Id};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum View {
    Parts,
    Layouts,
    Report,
    Inventory,
    Settings,
}
impl View {
    pub const ALL: [Self; 5] = [
        Self::Parts,
        Self::Layouts,
        Self::Report,
        Self::Inventory,
        Self::Settings,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Self::Parts => "零件清单",
            Self::Layouts => "开料排版",
            Self::Report => "统计报告",
            Self::Inventory => "板材库存",
            Self::Settings => "全局设置",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Parts => "input",
            Self::Layouts => "layout",
            Self::Report => "report",
            Self::Inventory => "inventory",
            Self::Settings => "settings",
        }
    }
}
pub enum Confirm {
    NewProject,
    ClearParts,
    ReplaceParts(Vec<Value>),
    DeleteProject(String),
}
pub struct App {
    pub project: Value,
    pub store: Option<Store>,
    pub fatal: Option<String>,
    pub view: View,
    pub plan: Option<Plan>,
    pub quote_rows: Vec<QuoteRow>,
    pub job: Option<OptimizationJob>,
    pub generation: u64,
    pub preview: Vec<Layout>,
    pub job_started: Option<Instant>,
    pub active_material: String,
    pub editing: HashMap<String, String>,
    pub cell_ids: Vec<(Id, usize, usize)>,
    pub focus_request: Option<(usize, usize)>,
    pub parts_scroll_to_bottom: bool,
    pub ime_active: bool,
    pub library_open: bool,
    pub library: Vec<Value>,
    pub confirmation: Option<Confirm>,
    pub notice: String,
    pub notification: Option<(String, Instant)>,
    pub show_license: bool,
    pub print_document: Option<crate::platform::printing::PrintDocument>,
    // Presentation-only state. Never serialized into a project or global config.
    pub settings_template: bool,
    pub selected_layout: usize,
    pub selected_quote: usize,
    pub preview_page: usize,
    dirty: Option<Instant>,
    save_error_shown: bool,
    zoom: f32,
    pub smoke: bool,
    smoke_index: usize,
    smoke_requested: bool,
    smoke_phase_started: Instant,
    started: Instant,
}
impl App {
    pub fn new(smoke: bool, demo: bool) -> Self {
        let mut app = Self {
            project: project::defaults(),
            store: None,
            fatal: None,
            view: View::Parts,
            plan: None,
            quote_rows: Vec::new(),
            job: None,
            generation: 0,
            preview: Vec::new(),
            job_started: None,
            active_material: String::new(),
            editing: HashMap::new(),
            cell_ids: Vec::new(),
            focus_request: None,
            parts_scroll_to_bottom: false,
            ime_active: false,
            library_open: false,
            library: Vec::new(),
            confirmation: None,
            notice: "先录入板材和零件，然后开始优化。".into(),
            notification: None,
            show_license: false,
            print_document: None,
            settings_template: false,
            selected_layout: 0,
            selected_quote: 0,
            preview_page: 0,
            dirty: None,
            save_error_shown: false,
            zoom: 1.0,
            smoke,
            smoke_index: 0,
            smoke_requested: false,
            smoke_phase_started: Instant::now(),
            started: Instant::now(),
        };
        let load = (|| -> Result<(), String> {
            let path = if smoke || demo {
                PathBuf::from(":memory:")
            } else {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                storage::resolve_database_path(
                    exe.parent().ok_or("无法定位程序目录")?,
                    &std::env::vars().collect(),
                )
            };
            let store = Store::open(path)?;
            let draft = store.draft()?;
            let seed = if smoke || demo {
                project::demo()
            } else {
                draft.clone().unwrap_or_else(project::defaults)
            };
            let global = store
                .global_settings()?
                .unwrap_or_else(|| project::global_config(&seed));
            if store.global_settings()?.is_none() {
                store.save_global_settings(&global)?;
            }
            app.project = project::normalize(&seed, Some(&global));
            app.store = Some(store);
            Ok(())
        })();
        if let Err(error) = load {
            app.fatal = Some(format!(
                "数据库加载失败：{error}\n为防止覆盖旧数据，已禁用保存。"
            ));
        }
        if (smoke || demo) && app.fatal.is_none() {
            app.start_optimization();
        }
        app
    }
    pub fn save_status(&self) -> &'static str {
        if self.fatal.is_some() || self.save_error_shown {
            "保存失败 · 请检查数据库"
        } else if self.dirty.is_some() {
            "正在保存…"
        } else {
            "已保存 · 本机 SQLite"
        }
    }
    pub fn notify(&mut self, message: impl Into<String>) {
        self.notification = Some((message.into(), Instant::now()));
    }
    pub fn commit(&mut self, invalidate: bool) {
        if invalidate {
            self.invalidate(true);
        }
        self.dirty = Some(Instant::now());
    }
    pub fn invalidate(&mut self, clear_adjustments: bool) {
        self.generation = self.generation.wrapping_add(1);
        self.job.take();
        self.preview.clear();
        self.selected_layout = 0;
        self.selected_quote = 0;
        self.plan = None;
        self.quote_rows.clear();
        if clear_adjustments {
            self.project
                .as_object_mut()
                .unwrap()
                .shift_remove("quotationAdjustment");
        }
        self.notice = "数据已修改，请重新执行优化。".into();
    }
    pub fn flush(&mut self) -> bool {
        if self.dirty.is_none() {
            return true;
        }
        let outcome = self
            .store
            .as_ref()
            .ok_or_else(|| "数据库不可用".to_string())
            .and_then(|s| s.save_draft(&self.project));
        match outcome {
            Ok(_) => {
                self.dirty = None;
                self.save_error_shown = false;
                true
            }
            Err(error) => {
                if !self.save_error_shown {
                    self.notify(format!("自动保存失败：{error}"));
                }
                self.save_error_shown = true;
                false
            }
        }
    }
    pub fn save_project(&mut self) {
        if self.project["id"].is_null() {
            self.project["id"] = json!(uuid::Uuid::new_v4().to_string());
        }
        let name = string(&self.project["name"]).trim().to_string();
        self.project["name"] = json!(if name.is_empty() {
            "未命名工程"
        } else {
            &name
        });
        self.project["updatedAt"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let outcome = self
            .store
            .as_ref()
            .ok_or("数据库不可用".to_string())
            .and_then(|s| {
                s.save_project(&self.project)?;
                s.save_draft(&self.project)
            });
        match outcome {
            Ok(_) => {
                self.dirty = None;
                self.notify("工程已保存到 SQLite 数据库");
            }
            Err(error) => self.notify(format!("保存失败：{error}")),
        }
    }
    pub fn save_global(&mut self) {
        let outcome = self
            .store
            .as_ref()
            .ok_or("数据库不可用".to_string())
            .and_then(|s| {
                s.save_global_settings(&project::global_config(&self.project))?;
                s.save_draft(&self.project)
            });
        match outcome {
            Ok(_) => {
                self.dirty = None;
                self.notify("板材库存与全局设置已保存到 SQLite 数据库");
            }
            Err(error) => self.notify(format!("设置保存失败：{error}")),
        }
    }
    pub fn set_project(&mut self, next: &Value) {
        let global = project::global_config(&self.project);
        self.invalidate(false);
        self.project = project::normalize(next, Some(&global));
        self.editing.clear();
        self.active_material.clear();
        self.commit(false);
    }
    pub fn open_library(&mut self) {
        match self
            .store
            .as_ref()
            .ok_or("数据库不可用".to_string())
            .and_then(Store::list_projects)
        {
            Ok(rows) => {
                self.library = rows;
                self.library_open = true;
            }
            Err(error) => self.notify(format!("工程库加载失败：{error}")),
        }
    }
    pub fn add_part(&mut self, focus: bool) {
        project::add_part(&mut self.project);
        self.parts_scroll_to_bottom = true;
        if focus {
            self.focus_request = Some((rows(&self.project, "parts").len() - 1, 0));
        }
        self.commit(true);
    }
    pub fn start_optimization(&mut self) {
        if self.job.is_some() {
            return;
        }
        self.generation = self.generation.wrapping_add(1);
        self.plan = None;
        self.quote_rows.clear();
        self.preview.clear();
        self.view = View::Layouts;
        self.notice = "正在准备板材和零件，预览将随计算更新…".into();
        match OptimizationJob::start(
            self.generation,
            self.project.clone(),
            Duration::from_secs(60),
        ) {
            Ok(job) => {
                self.job = Some(job);
                self.job_started = Some(Instant::now());
            }
            Err(error) => self.notify(error),
        }
    }
    pub fn stop_optimization(&mut self) {
        if let Some(job) = &self.job {
            job.cancel();
            self.preview.clear();
            self.notice = "正在停止优化…".into();
        }
    }
    pub fn poll_job(&mut self) {
        let Some(job) = self.job.as_mut() else {
            return;
        };
        if let Some(progress) = job.progress(self.generation) {
            self.preview = progress.layouts;
            let count: usize = self.preview.iter().map(|l| l.placements.len()).sum();
            self.notice = format!(
                "正在试排：本轮已放入 {count} / {} 件；预览尚非最终方案",
                progress.total_count
            );
        }
        if let Some(result) = job.poll(self.generation) {
            self.job.take();
            self.preview.clear();
            self.job_started = None;
            match result {
                Ok(mut plan) => {
                    pricing::reprice(&mut plan, &self.project);
                    self.quote_rows = quotation::initialize_adjustments(&plan, &self.project);
                    self.notice = format!(
                        "{} · 使用 {} 张板材",
                        string(&self.project["name"]),
                        plan.layouts.len()
                    );
                    let message = if plan.unplaced.is_empty() {
                        format!(
                            "优化完成：{} 件零件，使用 {} 张板材",
                            plan.stats["placedCount"],
                            plan.layouts.len()
                        )
                    } else {
                        format!("排版完成，有 {} 件零件未排入", plan.unplaced.len())
                    };
                    self.plan = Some(plan);
                    self.notify(message);
                }
                Err(error) => {
                    self.notice = if error == JobError::Cancelled {
                        "优化已停止，未生成最终方案。".into()
                    } else {
                        "优化未完成，未生成最终方案。".into()
                    };
                    self.notify(error.to_string());
                }
            }
        }
    }
    pub fn save_quote_adjustments(&mut self) {
        if let Some(plan) = &self.plan {
            self.project["quotationAdjustment"] =
                json!({"signature":quotation::signature(plan),"rows":self.quote_rows});
            self.commit(false);
        }
    }
    pub fn reprice_loss(&mut self) {
        self.project
            .as_object_mut()
            .unwrap()
            .shift_remove("quotationAdjustment");
        if let Some(plan) = self.plan.as_mut() {
            pricing::reprice(plan, &self.project);
            self.quote_rows = quotation::initialize_adjustments(plan, &self.project);
        }
        self.commit(false);
    }
    pub fn register_cell(&mut self, response: &egui::Response, row: usize, column: usize) {
        self.cell_ids.push((response.id, row, column));
        if self.focus_request == Some((row, column)) {
            response.request_focus();
            self.focus_request = None;
        }
    }
    pub fn keyboard(&mut self, ctx: &egui::Context) {
        let composing = self.ime_active
            || ctx.input(|i| i.events.iter().any(|e| matches!(e, egui::Event::Ime(_))));
        ctx.input(|i| {
            for event in &i.events {
                if let egui::Event::Ime(event) = event {
                    match event {
                        egui::ImeEvent::Enabled | egui::ImeEvent::Preedit(_) => {
                            self.ime_active = true
                        }
                        _ => self.ime_active = false,
                    }
                }
            }
        });
        if ctx.input_mut(|i| i.consume_key(egui::Modifiers::CTRL, egui::Key::Num0)) {
            self.zoom = 1.0;
            ctx.set_zoom_factor(self.zoom);
        }
        if ctx.input_mut(|i| {
            i.consume_key(egui::Modifiers::CTRL, egui::Key::Plus)
                || i.consume_key(egui::Modifiers::CTRL, egui::Key::Equals)
                || i.consume_key(
                    egui::Modifiers::CTRL | egui::Modifiers::SHIFT,
                    egui::Key::Plus,
                )
        }) {
            self.zoom = ((self.zoom + 0.1) * 10.0).round().clamp(5.0, 20.0) / 10.0;
            ctx.set_zoom_factor(self.zoom);
        }
        if ctx.input_mut(|i| i.consume_key(egui::Modifiers::CTRL, egui::Key::Minus)) {
            self.zoom = ((self.zoom - 0.1) * 10.0).round().clamp(5.0, 20.0) / 10.0;
            ctx.set_zoom_factor(self.zoom);
        }
        if composing || self.view != View::Parts || self.confirmation.is_some() {
            return;
        }
        let focused = ctx.memory(|m| m.focused());
        let Some(position) = self
            .cell_ids
            .iter()
            .position(|(id, _, _)| Some(*id) == focused)
        else {
            return;
        };
        let (_, row, col) = self.cell_ids[position];
        let key = if self.project["settings"]["partEntryKey"] == "enter" {
            egui::Key::Enter
        } else {
            egui::Key::Tab
        };
        let consume = |key, modifiers| {
            ctx.input_mut(|input| {
            let mut found=false;
            input.events.retain(|event| {
                let matches=matches!(event,egui::Event::Key {key:k,pressed:true,modifiers:m,..} if *k==key && *m==modifiers);
                found|=matches;!matches
            });found
        })
        };
        let reverse = consume(key, egui::Modifiers::SHIFT);
        let forward = consume(key, egui::Modifiers::NONE);
        if forward || reverse {
            ctx.memory_mut(|m| m.move_focus(egui::FocusDirection::None));
            if forward && position + 1 == self.cell_ids.len() {
                self.add_part(true);
            } else {
                let next = if reverse {
                    (position + self.cell_ids.len() - 1) % self.cell_ids.len()
                } else {
                    position + 1
                };
                let (id, r, c) = self.cell_ids[next];
                ctx.memory_mut(|m| m.request_focus(id));
                self.focus_request = Some((r, c));
            }
            return;
        }
        for (key, dr, dc) in [
            (egui::Key::ArrowLeft, 0, -1),
            (egui::Key::ArrowRight, 0, 1),
            (egui::Key::ArrowUp, -1, 0),
            (egui::Key::ArrowDown, 1, 0),
        ] {
            if consume(key, egui::Modifiers::NONE) {
                ctx.memory_mut(|m| m.move_focus(egui::FocusDirection::None));
                let target = (row as isize + dr, col as isize + dc);
                if let Some((id, r, c)) = self
                    .cell_ids
                    .iter()
                    .find(|(_, r, c)| (*r as isize, *c as isize) == target)
                {
                    ctx.memory_mut(|m| m.request_focus(*id));
                    self.focus_request = Some((*r, *c));
                }
                return;
            }
        }
    }
    pub fn export_parts(&mut self) {
        if rows(&self.project, "parts").is_empty() {
            self.notify("请先添加零件再导出 CSV");
            return;
        }
        if rows(&self.project, "parts")
            .iter()
            .any(project::unsupported)
        {
            self.notify("清单含不支持的旧版轮廓或指定角度，请删除后再导出矩形 CSV");
            return;
        }
        self.save_csv(
            "零件清单",
            &crate::parts_csv::serialize_parts(rows(&self.project, "parts")),
        );
    }
    pub fn export_report(&mut self) {
        let Some(plan) = &self.plan else {
            self.notify("请先生成排版");
            return;
        };
        match quotation::export_report(plan, &self.project, &self.quote_rows) {
            Ok(csv) => self.save_csv("开料报告", &csv),
            Err(error) => self.notify(error),
        }
    }
    fn save_csv(&mut self, suffix: &str, csv: &str) {
        let name = string(&self.project["name"])
            .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-");
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("CSV", &["csv"])
            .set_file_name(format!("{name}-{suffix}.csv"))
            .save_file()
        {
            match std::fs::write(path, csv) {
                Ok(()) => self.notify("CSV 已导出"),
                Err(error) => self.notify(format!("导出失败：{error}")),
            }
        }
    }
    pub fn import_parts(&mut self) {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("CSV", &["csv"])
            .pick_file()
        else {
            return;
        };
        if let Err(error) = std::fs::read_to_string(path)
            .map_err(|e| e.to_string())
            .and_then(|text| self.prepare_parts_import(&text))
        {
            self.notify(format!("导入失败：{error}"));
        }
    }
    pub fn prepare_parts_import(&mut self, text: &str) -> Result<(), String> {
        let panels = rows(&self.project, "panels");
        let groups = project::groups(panels);
        let material = groups.first().map(|(_, m)| m.as_str()).unwrap_or_default();
        let parts = crate::parts_csv::parts_from_csv(
            text,
            material,
            &project::thicknesses(panels, &json!(material)),
            &mut || uuid::Uuid::new_v4().to_string(),
        )?;
        if rows(&self.project, "parts").is_empty() {
            self.apply_parts_import(parts);
        } else {
            self.confirmation = Some(Confirm::ReplaceParts(parts));
        }
        Ok(())
    }
    pub(crate) fn apply_parts_import(&mut self, parts: Vec<Value>) {
        let n = parts.len();
        self.project["parts"] = Value::Array(parts);
        self.editing.clear();
        self.focus_request = None;
        self.commit(true);
        self.notify(format!("已导入 {n} 种零件"));
    }
    fn smoke_capture(&mut self, ctx: &egui::Context) {
        if !self.smoke {
            return;
        }
        if self.smoke_index >= View::ALL.len() + 2 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            return;
        }
        if self.smoke_index == 0 && self.view != View::Parts {
            self.view = View::Parts;
            ctx.request_repaint();
            return;
        }
        if self.started.elapsed() > Duration::from_secs(30) {
            panic!("native UI smoke timed out: {}", self.notice);
        }
        if self.job.is_some()
            || self.plan.is_none()
            || self.started.elapsed() < Duration::from_millis(800)
        {
            return;
        }
        if !self.smoke_requested && self.smoke_phase_started.elapsed() < Duration::from_millis(250)
        {
            ctx.request_repaint_after(Duration::from_millis(50));
            return;
        }
        let image = ctx.input(|i| {
            i.events.iter().find_map(|e| {
                if let egui::Event::Screenshot { image, .. } = e {
                    Some(image.clone())
                } else {
                    None
                }
            })
        });
        if let Some(image) = image {
            let output = PathBuf::from(
                std::env::var("BOARD_CUT_SMOKE_DIRECTORY")
                    .unwrap_or_else(|_| "../.test-output".into()),
            )
            .join(format!(
                "rust-ui-{}.png",
                match self.smoke_index {
                    5 => "library",
                    6 => "print-preview",
                    _ => self.view.name(),
                }
            ));
            std::fs::create_dir_all(output.parent().unwrap()).unwrap();
            let bytes: Vec<_> = image.pixels.iter().flat_map(|p| p.to_array()).collect();
            image::save_buffer(
                &output,
                &bytes,
                image.size[0] as u32,
                image.size[1] as u32,
                image::ColorType::Rgba8,
            )
            .unwrap();
            println!("Screenshot: {}", output.display());
            self.smoke_index += 1;
            self.smoke_requested = false;
            self.smoke_phase_started = Instant::now();
            match self.smoke_index {
                0..=4 => self.view = View::ALL[self.smoke_index],
                5 => {
                    self.view = View::Parts;
                    self.save_project();
                    self.open_library();
                }
                6 => {
                    self.library_open = false;
                    self.view = View::Layouts;
                    self.print_document = self.plan.as_ref().map(|plan| {
                        crate::platform::printing::layout_document(plan, &self.project)
                    });
                }
                _ => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
            }
        } else if !self.smoke_requested {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::default()));
            self.smoke_requested = true;
        }
        ctx.request_repaint_after(Duration::from_millis(100));
    }
}
impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.keyboard(ctx);
        self.poll_job();
        if self
            .dirty
            .is_some_and(|last| last.elapsed() >= Duration::from_millis(180))
        {
            self.flush();
        }
        if ctx.input(|i| i.viewport().close_requested()) && !self.flush() {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        }
        ui::render(self, ctx);
        self.smoke_capture(ctx);
        if self.job.is_some() || self.dirty.is_some() || self.notification.is_some() {
            ctx.request_repaint_after(Duration::from_millis(30));
        }
    }
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.job.take();
        self.flush();
    }
}
