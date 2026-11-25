fn main() {
    println!("cargo:rerun-if-changed=resources/app-icon.ico");
    println!("cargo:rerun-if-changed=Cargo.lock");
    collect_notices();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon("resources/app-icon.ico");
        resource.set("ProductName", "板优排");
        resource.set("FileDescription", "板优排 Rust 原生桌面版");
        resource.compile().expect("compile Windows resources");
    }
}

fn collect_notices() {
    use std::{env, fs, path::PathBuf};
    let lock = fs::read_to_string("Cargo.lock").expect("read locked dependencies");
    let cargo_home = env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("USERPROFILE").expect("user home")).join(".cargo")
        });
    let registries: Vec<_> = fs::read_dir(cargo_home.join("registry/src"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .collect();
    let mut notices = String::from("Third-party software notices (locked Windows build inputs)\n");
    for package in lock.split("[[package]]").skip(1) {
        let field = |key: &str| {
            package.lines().find_map(|line| {
                line.strip_prefix(&format!("{key} = \""))
                    .and_then(|v| v.strip_suffix('"'))
            })
        };
        let Some(name) = field("name") else {
            continue;
        };
        let Some(version) = field("version") else {
            continue;
        };
        if !package.contains("source = \"registry+") {
            continue;
        }
        if let Some(directory) = registries
            .iter()
            .map(|base| base.join(format!("{name}-{version}")))
            .find(|p| p.is_dir())
        {
            for entry in fs::read_dir(&directory)
                .into_iter()
                .flatten()
                .chain(fs::read_dir(directory.join("fonts")).into_iter().flatten())
                .filter_map(Result::ok)
            {
                let filename = entry.file_name().to_string_lossy().to_ascii_uppercase();
                if entry.path().is_file()
                    && (["LICENSE", "LICENCE", "COPYING", "NOTICE", "UNLICENSE"]
                        .iter()
                        .any(|prefix| filename.starts_with(prefix))
                        || ["OFL.TXT", "UFL.TXT"].contains(&filename.as_str())
                        || (entry.path().parent().is_some_and(|p| p.ends_with("fonts"))
                            && filename.ends_with(".TXT")))
                    && let Ok(content) = fs::read_to_string(entry.path())
                {
                    notices.push_str(&format!(
                        "\n===== {name} {version} / {} =====\n{content}\n",
                        entry.file_name().to_string_lossy()
                    ));
                }
            }
        }
    }
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").expect("build output"))
            .join("third-party-notices.txt"),
        notices,
    )
    .expect("write embedded notices");
}
