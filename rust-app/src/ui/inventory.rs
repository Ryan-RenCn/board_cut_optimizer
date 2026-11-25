use super::theme::*;
use crate::{app::App, model::*, project};
use eframe::egui::{self, RichText};
use serde_json::json;
pub fn render(app: &mut App, ui: &mut egui::Ui) {
    page_heading(
        ui,
        "PANEL INVENTORY",
        "板材库存",
        "按材质维护全局板材规格、成本与重量。每种规格视为无限库存。",
        260.0,
        |ui| {
            if ui.button("＋ 添加材质").clicked() {
                let groups = project::groups(rows(&app.project, "panels"));
                let mut suffix = 1;
                while groups.iter().any(|(_, m)| m == &format!("新材质 {suffix}")) {
                    suffix += 1;
                }
                let material = format!("新材质 {suffix}");
                app.project["panels"].as_array_mut().unwrap().push(json!({"id":uuid::Uuid::new_v4().to_string(),"length":2440,"width":1220,"thickness":18,"cost":0,"weight":0,"material":material,"description":""}));
                app.active_material = project::material_key(&json!(material));
                app.commit(true);
            }
            if dark(ui, "保存板材库存").clicked() {
                app.save_global();
            }
        },
    );
    ui.add_space(20.0);
    let groups = project::groups(rows(&app.project, "panels"));
    if groups.is_empty() {
        card().show(ui, |ui| {
            empty_state(
                ui,
                "从第一种板材开始",
                "点击「添加材质」创建第一个材质分组，再维护厚度、成本与重量。",
            );
        });
        return;
    }
    if !groups.iter().any(|(key, _)| *key == app.active_material) {
        app.active_material = groups[0].0.clone();
    }
    let count = if ui.available_width() < 900.0 { 2 } else { 4 };
    let stats = [
        (
            "材质分组",
            format!("{} 种", groups.len()),
            "全局资源，统一维护",
        ),
        (
            "厚度规格",
            format!("{} 种", rows(&app.project, "panels").len()),
            "所有工程共用",
        ),
        (
            "当前材质",
            groups
                .iter()
                .find(|(key, _)| *key == app.active_material)
                .map(|(_, m)| m.clone())
                .unwrap_or_default(),
            "按材质分组维护",
        ),
        ("库存方式", "无限库存".into(), "按规格提供原始板材"),
    ];
    for (group, chunk) in stats.chunks(count).enumerate() {
        ui.columns(chunk.len(), |cols| {
            for (i, (label, value, note)) in chunk.iter().enumerate() {
                metric(&mut cols[i], label, value, note, group == 0 && i == 0);
            }
        });
        ui.add_space(16.0);
    }
    card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.horizontal_wrapped(|ui| {for (key,material) in &groups {ui.selectable_value(&mut app.active_material,key.clone(),if material.is_empty() {"默认材质"} else {material});}});
        ui.separator();
        let current=groups.iter().find(|(key,_)|*key==app.active_material).unwrap().clone();
        let mut data=rows(&app.project,"panels").to_vec();
        let mut changed=false;
        let mut remove=None;
        ui.horizontal_wrapped(|ui| {
            ui.label("材质名称");
            let key=format!("material-name-{}",current.0);
            let mut name=app.editing.get(&key).cloned().unwrap_or_else(||current.1.clone());
            let response=ui.add(singleline(&mut name).desired_width(220.0));
            if response.lost_focus() && name.trim()!=current.1 {
                let next=name.trim().to_string(); let next_key=project::material_key(&json!(next));
                if groups.iter().any(|(key,_)|*key!=current.0 && *key==next_key) {app.notify("该材质名称已经存在，请使用其他名称"); name=current.1.clone();}
                else {
                    for panel in &mut data {if project::material_key(&panel["material"])==current.0 {panel["material"]=json!(next);}}
                    for part in app.project["parts"].as_array_mut().unwrap() {if project::material_key(&part["material"])==current.0 {part["material"]=json!(next);}}
                    app.active_material=next_key; changed=true;
                }
            }
            app.editing.insert(key,name);
            if ui.button("＋ 添加厚度规格").clicked() {
                let base=data.iter().rev().find(|p|project::material_key(&p["material"])==app.active_material).cloned().unwrap_or_default();
                let material=base.get("material").cloned().unwrap_or_else(||json!(current.1));
                data.push(json!({"id":uuid::Uuid::new_v4().to_string(),"length":base["length"],"width":base["width"],"thickness":"","cost":base["cost"],"weight":base["weight"],"material":material,"description":""})); changed=true;
            }
            badge(ui,"每种规格无限库存");
        });
        ui.add_space(12.0);
        egui::ScrollArea::horizontal().id_salt("inventory-horizontal").show(ui, |ui| {
            egui::Grid::new("inventory-grid").striped(true).spacing([12.0,14.0]).show(ui, |ui| {
                for title in ["","长度 mm","宽度 mm","材质","厚度 mm","成本 元/张","重量 kg/张","备注",""] {header(ui,title);} ui.end_row();
                let active=app.active_material.clone();
                for (index,panel) in data.iter_mut().enumerate().filter(|(_,p)|project::material_key(&p["material"])==active) {
                    ui.label(format!("{:02}",index+1));
                    for field in ["length","width"] {let (_,c)=numeric(app,ui,&mut panel[field],format!("panel-{index}-{field}"),false,false); changed|=c;}
                    ui.add_sized([100.0,INPUT_HEIGHT],egui::Label::new(if string(&panel["material"]).is_empty() {"默认材质".into()} else {string(&panel["material"])}).truncate());
                    for field in ["thickness","cost","weight"] {let (_,c)=numeric(app,ui,&mut panel[field],format!("panel-{index}-{field}"),false,false); changed|=c;}
                    changed|=text(ui,&mut panel["description"],140.0).changed();
                    if ui.button(RichText::new("删除").color(DANGER)).clicked() {remove=Some(index);} ui.end_row();
                }
            });
        });
        if let Some(index)=remove {data.remove(index); changed=true; app.editing.clear();}
        if changed {app.project["panels"]=json!(data); app.commit(true);}
        ui.add_space(12.0);
        ui.label(RichText::new("修改规格后，当前工程需要重新优化。成本为元/张，重量为 kg/张。").small().color(MUTED));
    });
    ui.add_space(20.0);
    egui::Frame::new()
        .fill(SELECTED)
        .corner_radius(8)
        .inner_margin(18)
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new("全局资源，统一维护").color(BLUE).strong());
            ui.label(
                RichText::new(
                    "工程共用同一份板材库存。修改材质名称时会同步关联零件；请核对后保存。",
                )
                .color(MUTED),
            );
        });
}
