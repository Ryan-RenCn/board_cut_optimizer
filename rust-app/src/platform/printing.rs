//! Shared paginated drawing model for native preview and Win32/GDI printing.
use crate::{
    engine,
    model::*,
    pricing,
    quotation::{self, QuoteRow},
};
use std::{mem::size_of, path::Path};
use windows::{
    Win32::{
        Foundation::{COLORREF, GlobalFree, HANDLE, HGLOBAL},
        Graphics::Gdi::*,
        Storage::Xps::*,
        UI::Controls::Dialogs::*,
    },
    core::{PCWSTR, w},
};

#[derive(Clone)]
pub enum Draw {
    Text {
        x: f32,
        y: f32,
        size: f32,
        text: String,
    },
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        fill: [u8; 3],
    },
    Line {
        x: f32,
        y: f32,
        x2: f32,
        y2: f32,
    },
}
#[derive(Clone, Default)]
pub struct PrintPage {
    pub commands: Vec<Draw>,
}
#[derive(Clone)]
pub struct PrintDocument {
    pub title: String,
    pub pages: Vec<PrintPage>,
}
impl PrintPage {
    fn text(&mut self, x: f32, y: f32, size: f32, text: impl Into<String>) {
        self.commands.push(Draw::Text {
            x,
            y,
            size,
            text: text.into(),
        });
    }
}
fn finish(title: String, mut pages: Vec<PrintPage>) -> PrintDocument {
    if pages.is_empty() {
        pages.push(PrintPage::default());
    }
    let count = pages.len();
    for (i, page) in pages.iter_mut().enumerate() {
        page.text(
            40.0,
            1094.0,
            10.0,
            format!("板优排 · 第 {} / {count} 页", i + 1),
        );
    }
    PrintDocument { title, pages }
}
pub fn layout_document(plan: &Plan, project: &serde_json::Value) -> PrintDocument {
    let mut pages = Vec::new();
    for (index, count) in engine::group_identical_layouts(&plan.layouts) {
        let layout = &plan.layouts[index];
        let mut page = PrintPage::default();
        page.text(
            40.0,
            35.0,
            23.0,
            format!("{} · 开料排版", string(&project["name"])),
        );
        page.text(
            40.0,
            76.0,
            13.0,
            format!(
                "{} · {} mm · {} × {} mm · 数量 × {count} 张",
                layout.panel.material, layout.panel.thickness, layout.width, layout.height
            ),
        );
        page.text(
            40.0,
            100.0,
            12.0,
            format!(
                "实际利用率 {}% · 总重量 {} kg{}",
                pricing::format_number(layout.usage * 100.0, 1, false, false),
                pricing::format_number(
                    number(
                        layout
                            .pricing
                            .get("actualWeight")
                            .unwrap_or(&serde_json::Value::Null),
                        0.0
                    ),
                    2,
                    false,
                    false
                ),
                if layout.is_full_sheet {
                    " · 整板件，无切割费"
                } else {
                    ""
                }
            ),
        );
        if !plan.unplaced.is_empty() {
            page.text(
                40.0,
                125.0,
                12.0,
                format!(
                    "注意：尚有 {} 件零件未排入，本页仅为已排入部分。",
                    plan.unplaced.len()
                ),
            );
        }
        let scale = (714.0 / layout.width).min(760.0 / layout.height) as f32;
        let x = 40.0 + (714.0 - layout.width as f32 * scale) / 2.0;
        let y = 165.0;
        page.commands.push(Draw::Rect {
            x,
            y,
            w: layout.width as f32 * scale,
            h: layout.height as f32 * scale,
            fill: [250, 250, 248],
        });
        for rect in &layout.free_rects {
            page.commands.push(Draw::Rect {
                x: x + rect.x as f32 * scale,
                y: y + rect.y as f32 * scale,
                w: rect.w as f32 * scale,
                h: rect.h as f32 * scale,
                fill: [238, 241, 238],
            });
        }
        for p in &layout.placements {
            let px = x + p.x as f32 * scale;
            let py = y + p.y as f32 * scale;
            let width = p.placed_length as f32 * scale;
            let height = p.placed_width as f32 * scale;
            let colors = [
                [214, 231, 194],
                [189, 220, 209],
                [207, 219, 239],
                [232, 220, 198],
                [215, 208, 231],
                [199, 220, 220],
                [237, 211, 215],
                [222, 229, 199],
            ];
            page.commands.push(Draw::Rect {
                x: px,
                y: py,
                w: width,
                h: height,
                fill: colors[p.part.source_index % 8],
            });
            if width > 50.0 && height > 24.0 {
                let code = if layout.is_full_sheet {
                    "整板件".into()
                } else {
                    p.part
                        .extra
                        .get("code")
                        .filter(|v| truthy(v))
                        .map(string)
                        .unwrap_or_else(|| format!("P{}", p.part.source_index + 1))
                };
                page.text(px + 4.0, py + 4.0, 11.0, code);
                page.text(
                    px + 4.0,
                    py + 17.0,
                    9.0,
                    format!(
                        "{} × {}{}",
                        p.part.length,
                        p.part.width,
                        if p.rotated { " · 90°" } else { "" }
                    ),
                );
            }
        }
        page.text(
            40.0,
            970.0,
            11.0,
            format!(
                "锯缝 {} mm · 边距 {} / {} mm · 灰色为余料区域",
                string(&project["settings"]["sawWidth"]),
                string(&project["settings"]["panelMarginX"]),
                string(&project["settings"]["panelMarginY"])
            ),
        );
        pages.push(page);
    }
    if pages.is_empty() {
        let mut page = PrintPage::default();
        page.text(40.0, 40.0, 18.0, "没有生成可打印排版；请检查未排入零件。");
        pages.push(page);
    }
    finish("板优排开料排版".into(), pages)
}
fn wrap(text: &str, columns: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut width = 0;
    for ch in text.chars() {
        let w = if ch.is_ascii() { 1 } else { 2 };
        if width + w > columns && !line.is_empty() {
            lines.push(std::mem::take(&mut line));
            width = 0;
        }
        line.push(ch);
        width += w;
    }
    lines.push(line);
    lines
}
pub fn report_document(
    plan: &Plan,
    project: &serde_json::Value,
    rows: &[QuoteRow],
) -> PrintDocument {
    let totals = quotation::totals(plan, project, rows);
    let mut lines = vec![
        format!(
            "{} · {}",
            string(&project["name"]),
            if plan.is_complete() {
                "最终报价报告"
            } else {
                "已排入部分报价报告"
            }
        ),
        format!("工程说明：{}", string(&project["description"])),
        format!(
            "完成 {} / {} 件 · 使用 {} 张板材 · 总重量 {} kg",
            plan.stats["placedCount"],
            plan.stats["requestedCount"],
            plan.layouts.len(),
            pricing::format_number(number(&plan.stats["totalWeight"], 0.0), 2, false, false)
        ),
    ];
    if !plan.unplaced.is_empty() {
        lines.push(format!(
            "注意：{} 件未排入，以下费用仅覆盖已排入部分，不是完整正式报价。",
            plan.unplaced.len()
        ));
    } else if !plan.is_complete() {
        lines.push("注意：排版零件数量与清单不一致，以下费用不是完整正式报价。".into());
    }
    lines.push(String::new());
    for (index, (layout, row)) in plan.layouts.iter().zip(rows).enumerate() {
        lines.push(format!(
            "#{:02} {} · {} mm · {} × {} mm{}",
            index + 1,
            layout.panel.material,
            layout.panel.thickness,
            layout.width,
            layout.height,
            if layout.is_full_sheet {
                " · 整板件"
            } else {
                ""
            }
        ));
        lines.push(format!(
            "利用率 {}% / 计价 {}% / 计费 {}% · 整张成本 {} · 利润 {}%",
            pricing::format_number(layout.usage * 100.0, 1, false, false),
            pricing::format_number(
                number(&layout.pricing["billingUsage"], 0.0) * 100.0,
                1,
                false,
                false
            ),
            pricing::format_number(
                number(&layout.pricing["billingRate"], 0.0) * 100.0,
                1,
                false,
                false
            ),
            pricing::currency(layout.panel.cost),
            string(&project["settings"]["profitRate"])
        ));
        lines.push(format!(
            "未税板材 {} · 税后材料 {} · 切割费 {} · 税后小计 {}",
            pricing::currency(row.panel_charge),
            pricing::currency(row.taxed_panel_charge),
            pricing::currency(row.cutting_fee),
            pricing::currency(row.taxed_panel_charge + row.cutting_fee)
        ));
        lines.push(String::new());
    }
    lines.push(format!(
        "打包费 {} · 物流费 {} · 目的地 {}",
        pricing::currency(totals.packaging),
        pricing::currency(totals.logistics.fee),
        totals.logistics.destination
    ));
    lines.push(format!(
        "未税合计 {} · 税后合计 {}",
        pricing::currency(totals.final_total),
        pricing::currency(totals.taxed_final_total)
    ));
    lines.push(String::new());
    lines.extend(
        quotation::build_quotation(plan, project, rows)
            .unwrap_or_else(|e| e)
            .lines()
            .map(String::from),
    );
    let mut pages = Vec::new();
    let mut page = PrintPage::default();
    let mut y = 40.0;
    for line in lines {
        for line in wrap(&line, 94) {
            if y > 1060.0 {
                pages.push(page);
                page = PrintPage::default();
                y = 40.0;
            }
            page.text(40.0, y, 12.0, line);
            y += 21.0;
        }
    }
    pages.push(page);
    finish("板优排报价报告".into(), pages)
}

pub fn paint_preview(ui: &mut eframe::egui::Ui, page: &PrintPage) {
    use eframe::egui::{self, Color32};
    let width = ui.available_width().min(714.0);
    let scale = width / 794.0;
    let (rect, _) = ui.allocate_exact_size(egui::vec2(width, 1123.0 * scale), egui::Sense::hover());
    let painter = ui.painter().with_clip_rect(rect);
    painter.rect_filled(rect, 0.0, Color32::WHITE);
    for command in &page.commands {
        match command {
            Draw::Text { x, y, size, text } => {
                painter.text(
                    rect.min + egui::vec2(x * scale, y * scale),
                    egui::Align2::LEFT_TOP,
                    text,
                    egui::FontId::proportional(size * scale),
                    Color32::BLACK,
                );
            }
            Draw::Rect { x, y, w, h, fill } => {
                let r = egui::Rect::from_min_size(
                    rect.min + egui::vec2(x * scale, y * scale),
                    egui::vec2(w * scale, h * scale),
                );
                painter.rect_filled(r, 0.0, Color32::from_rgb(fill[0], fill[1], fill[2]));
                painter.rect_stroke(
                    r,
                    0.0,
                    egui::Stroke::new(0.6_f32, Color32::GRAY),
                    egui::StrokeKind::Inside,
                );
            }
            Draw::Line { x, y, x2, y2 } => {
                painter.line_segment(
                    [
                        rect.min + egui::vec2(x * scale, y * scale),
                        rect.min + egui::vec2(x2 * scale, y2 * scale),
                    ],
                    egui::Stroke::new(0.6_f32, Color32::GRAY),
                );
            }
        }
    }
}

struct PrinterDc(HDC);
impl Drop for PrinterDc {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}
struct DialogMemory(HGLOBAL);
impl Drop for DialogMemory {
    fn drop(&mut self) {
        if !self.0.0.is_null() {
            unsafe {
                let _ = GlobalFree(Some(self.0));
            }
        }
    }
}
struct Document {
    dc: HDC,
    finished: bool,
}
impl Drop for Document {
    fn drop(&mut self) {
        if !self.finished {
            unsafe {
                AbortDoc(self.dc);
            }
        }
    }
}
struct Font(HFONT);
impl Drop for Font {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}
struct EmbeddedFont(HANDLE);
impl Drop for EmbeddedFont {
    fn drop(&mut self) {
        unsafe {
            let _ = RemoveFontMemResourceEx(self.0);
        }
    }
}
fn check(result: i32, action: &str) -> Result<(), String> {
    if result > 0 {
        Ok(())
    } else {
        Err(format!("{action}: {}", windows::core::Error::from_thread()))
    }
}
fn color(rgb: [u8; 3]) -> COLORREF {
    COLORREF(rgb[0] as u32 | ((rgb[1] as u32) << 8) | ((rgb[2] as u32) << 16))
}
pub fn print_document(document: &PrintDocument, pdf_path: Option<&Path>) -> Result<(), String> {
    unsafe {
        let output: Vec<u16> = pdf_path
            .map(|path| {
                path.as_os_str()
                    .to_string_lossy()
                    .encode_utf16()
                    .chain(Some(0))
                    .collect()
            })
            .unwrap_or_default();
        let dc = if pdf_path.is_some() {
            PrinterDc(CreateDCW(
                w!("WINSPOOL"),
                w!("Microsoft Print to PDF"),
                PCWSTR::null(),
                None,
            ))
        } else {
            let mut dialog = PRINTDLGW {
                lStructSize: size_of::<PRINTDLGW>() as u32,
                Flags: PD_RETURNDC | PD_NOSELECTION | PD_NOPAGENUMS,
                ..Default::default()
            };
            let accepted = PrintDlgW(&mut dialog).as_bool();
            let _dev_mode = DialogMemory(dialog.hDevMode);
            let _dev_names = DialogMemory(dialog.hDevNames);
            if !accepted {
                let error = CommDlgExtendedError();
                if error.0 == 0 {
                    return Ok(());
                }
                return Err(format!("打印对话框错误：{}", error.0));
            }
            PrinterDc(dialog.hDC)
        };
        if dc.0.is_invalid() {
            return Err("无法创建打印机设备上下文".into());
        }
        let title: Vec<u16> = document.title.encode_utf16().chain(Some(0)).collect();
        let info = DOCINFOW {
            cbSize: size_of::<DOCINFOW>() as i32,
            lpszDocName: PCWSTR(title.as_ptr()),
            lpszOutput: if output.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(output.as_ptr())
            },
            ..Default::default()
        };
        check(StartDocW(dc.0, &info), "StartDocW")?;
        let mut job = Document {
            dc: dc.0,
            finished: false,
        };
        let bytes = crate::resources::CHINESE_FONT;
        let mut count = 0;
        let handle = AddFontMemResourceEx(
            bytes.as_ptr().cast(),
            bytes.len() as u32,
            None,
            &raw mut count,
        );
        if handle.is_invalid() {
            return Err("无法注册嵌入的中文打印字体".into());
        }
        let _embedded = EmbeddedFont(handle);
        let width = GetDeviceCaps(Some(dc.0), HORZRES) as f32;
        let height = GetDeviceCaps(Some(dc.0), VERTRES) as f32;
        let scale = (width / 794.0).min(height / 1123.0);
        if scale <= 0.0 {
            return Err("打印机页面尺寸无效".into());
        }
        for page in &document.pages {
            check(StartPage(dc.0), "StartPage")?;
            SetBkMode(dc.0, TRANSPARENT);
            for command in &page.commands {
                match command {
                    Draw::Text { x, y, size, text } => {
                        let font = Font(CreateFontW(
                            -(size * scale).round() as i32,
                            0,
                            0,
                            0,
                            FW_NORMAL.0 as i32,
                            0,
                            0,
                            0,
                            DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS,
                            DEFAULT_QUALITY,
                            DEFAULT_PITCH.0 as u32,
                            w!("Noto Sans SC"),
                        ));
                        if font.0.is_invalid() {
                            return Err("无法创建中文打印字体".into());
                        }
                        let previous = SelectObject(dc.0, font.0.into());
                        SetTextColor(dc.0, color([32, 35, 39]));
                        let chars: Vec<u16> = text.encode_utf16().collect();
                        let ok = TextOutW(
                            dc.0,
                            (x * scale).round() as i32,
                            (y * scale).round() as i32,
                            &chars,
                        )
                        .as_bool();
                        SelectObject(dc.0, previous);
                        if !ok {
                            return Err("TextOutW 输出失败".into());
                        }
                    }
                    Draw::Rect { x, y, w, h, fill } => {
                        let brush = CreateSolidBrush(color(*fill));
                        let previous = SelectObject(dc.0, brush.into());
                        let ok = Rectangle(
                            dc.0,
                            (x * scale).round() as i32,
                            (y * scale).round() as i32,
                            ((x + w) * scale).round() as i32,
                            ((y + h) * scale).round() as i32,
                        )
                        .as_bool();
                        SelectObject(dc.0, previous);
                        let _ = DeleteObject(brush.into());
                        if !ok {
                            return Err("Rectangle 输出失败".into());
                        }
                    }
                    Draw::Line { x, y, x2, y2 } => {
                        if !MoveToEx(
                            dc.0,
                            (x * scale).round() as i32,
                            (y * scale).round() as i32,
                            None,
                        )
                        .as_bool()
                            || !LineTo(
                                dc.0,
                                (x2 * scale).round() as i32,
                                (y2 * scale).round() as i32,
                            )
                            .as_bool()
                        {
                            return Err("LineTo 输出失败".into());
                        }
                    }
                }
            }
            check(EndPage(dc.0), "EndPage")?;
        }
        check(EndDoc(dc.0), "EndDoc")?;
        job.finished = true;
        Ok(())
    }
}
pub fn print_probe(path: Option<&Path>) -> Result<(), String> {
    let mut page = PrintPage::default();
    page.text(40.0, 40.0, 18.0, "板优排 · Rust 原生打印验证");
    page.text(40.0, 90.0, 14.0, "材质：胡桃木　厚度：18 mm　数量：2");
    page.text(40.0, 125.0, 14.0, "尺寸：600 × 400 mm　税后报价：￥128.50");
    page.text(
        40.0,
        160.0,
        14.0,
        "本页由 Rust / Win32 GDI 直接输出，无浏览器依赖。",
    );
    print_document(&finish("板优排打印验证".into(), vec![page]), path)
}
