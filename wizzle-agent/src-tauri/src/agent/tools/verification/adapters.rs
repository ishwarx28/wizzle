use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
};

use super::{
    config::VerificationConfig,
    types::{CheckSpec, DiagnosticParser},
};

pub fn discover(
    project_root: &Path,
    changed_files: &[PathBuf],
    config: &VerificationConfig,
) -> Result<Vec<CheckSpec>, String> {
    let mut checks = BTreeMap::new();
    add_custom_checks(&mut checks, project_root, changed_files, config)?;
    if config.builtins {
        for path in changed_files {
            add_builtin_checks(&mut checks, project_root, path, config.timeout_seconds);
        }
    }
    Ok(checks.into_values().collect())
}

fn add_custom_checks(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    changed_files: &[PathBuf],
    config: &VerificationConfig,
) -> Result<(), String> {
    for custom in &config.commands {
        let extensions = custom
            .extensions
            .iter()
            .map(|value| normalize_extension(value))
            .collect::<BTreeSet<_>>();
        if !extensions.contains("*")
            && !changed_files.iter().any(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| extensions.contains(&value.to_ascii_lowercase()))
            })
        {
            continue;
        }
        let cwd = resolve_custom_cwd(project_root, custom.cwd.as_deref())?;
        let parser = parser_from_name(custom.parser.as_deref().unwrap_or("generic"));
        let program = resolve_program(&cwd, &[custom.command.as_str()])
            .unwrap_or_else(|| PathBuf::from(custom.command.trim()));
        let display_command = display_command(&custom.command, &custom.args);
        checks.insert(
            format!("custom:{}:{}", custom.id.trim(), cwd.display()),
            CheckSpec {
                args: custom.args.clone(),
                cwd,
                display_command,
                id: format!("custom:{}", custom.id.trim()),
                parser,
                program,
                source: custom.id.trim().to_string(),
                timeout_seconds: config.timeout_seconds,
            },
        );
    }
    Ok(())
}

fn add_builtin_checks(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    match extension.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            add_javascript_checks(checks, project_root, path, timeout_seconds)
        }
        "py" | "pyi" => add_python_checks(checks, project_root, path, timeout_seconds),
        "dart" => add_dart_checks(checks, project_root, path, timeout_seconds),
        "rs" => add_cargo_check(checks, project_root, path, timeout_seconds),
        "go" => add_go_check(checks, project_root, path, timeout_seconds),
        "kt" | "kts" | "java" | "xml" => {
            add_gradle_check(checks, project_root, path, &extension, timeout_seconds);
            if extension == "java" {
                add_maven_check(checks, project_root, path, timeout_seconds);
            }
        }
        "swift" | "m" | "mm" | "h" | "storyboard" | "xib" | "plist" | "entitlements" => {
            add_apple_check(checks, project_root, path, timeout_seconds)
        }
        "cs" | "fs" | "vb" => add_dotnet_check(checks, project_root, path, timeout_seconds),
        _ => {}
    }

    if matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("Cargo.toml")
    ) {
        add_cargo_check(checks, project_root, path, timeout_seconds);
    }
    if matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("pubspec.yaml")
    ) {
        add_dart_checks(checks, project_root, path, timeout_seconds);
    }
    if is_gradle_file(path) {
        add_gradle_check(checks, project_root, path, &extension, timeout_seconds);
    }
    if path.file_name().and_then(|value| value.to_str()) == Some("pom.xml") {
        add_maven_check(checks, project_root, path, timeout_seconds);
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if file_name == "package.json"
        || file_name == "jsconfig.json"
        || (file_name.starts_with("tsconfig") && file_name.ends_with(".json"))
    {
        add_javascript_checks(checks, project_root, path, timeout_seconds);
    }
    if matches!(
        file_name,
        "pyproject.toml" | "pyrightconfig.json" | "setup.cfg"
    ) {
        add_python_project_check(checks, project_root, path, timeout_seconds);
    }
    if matches!(file_name, "go.mod" | "go.work") {
        add_go_check(checks, project_root, path, timeout_seconds);
    }
    if file_name == "Package.swift" || file_name == "project.pbxproj" {
        add_apple_check(checks, project_root, path, timeout_seconds);
    }
    if matches!(extension.as_str(), "csproj" | "fsproj" | "sln") {
        add_dotnet_check(checks, project_root, path, timeout_seconds);
    }
}

fn add_javascript_checks(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let workspace = nearest_ancestor_with(path, project_root, &["package.json"])
        .unwrap_or_else(|| project_root.to_path_buf());
    if nearest_ancestor_with(path, project_root, &["tsconfig.json", "jsconfig.json"]).is_some() {
        let program = resolve_node_bin(&workspace, "tsc").unwrap_or_else(|| "tsc".into());
        insert_check(
            checks,
            "typescript",
            &workspace,
            program,
            vec!["--noEmit".into(), "--pretty".into(), "false".into()],
            DiagnosticParser::Flutter,
            "typescript",
            timeout_seconds,
        );
    }
    if matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
    ) {
        let Some(program) = resolve_node_bin(&workspace, "eslint") else {
            return;
        };
        let relative = relative_argument(&workspace, path);
        insert_or_extend_files(
            checks,
            "eslint",
            &workspace,
            program,
            vec!["--format".into(), "json".into()],
            relative,
            DiagnosticParser::Eslint,
            "eslint",
            timeout_seconds,
        );
    }
}

fn add_python_project_check(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let workspace = nearest_ancestor_with(
        path,
        project_root,
        &["pyproject.toml", "pyrightconfig.json", "setup.cfg"],
    )
    .unwrap_or_else(|| project_root.to_path_buf());
    let program = resolve_python_tool(&workspace, "pyright").unwrap_or_else(|| "pyright".into());
    insert_check(
        checks,
        "pyright",
        &workspace,
        program,
        vec!["--outputjson".into()],
        DiagnosticParser::Pyright,
        "pyright",
        timeout_seconds,
    );
}

fn add_python_checks(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let workspace = nearest_ancestor_with(
        path,
        project_root,
        &["pyproject.toml", "pyrightconfig.json", "setup.cfg"],
    )
    .unwrap_or_else(|| project_root.to_path_buf());
    let relative = relative_argument(&workspace, path);
    if let Some(program) = resolve_python_tool(&workspace, "pyright") {
        insert_or_extend_files(
            checks,
            "pyright",
            &workspace,
            program,
            vec!["--outputjson".into()],
            relative.clone(),
            DiagnosticParser::Pyright,
            "pyright",
            timeout_seconds,
        );
    } else if let Some(program) = resolve_program(&workspace, &["python3", "python"]) {
        insert_or_extend_files(
            checks,
            "python-syntax",
            &workspace,
            program,
            vec![
                "-c".into(),
                "import ast,sys,pathlib; [(ast.parse(pathlib.Path(p).read_text(encoding='utf-8'), filename=p)) for p in sys.argv[1:]]".into(),
            ],
            relative.clone(),
            DiagnosticParser::Generic,
            "python",
            timeout_seconds,
        );
    } else {
        insert_or_extend_files(
            checks,
            "pyright",
            &workspace,
            PathBuf::from("pyright"),
            vec!["--outputjson".into()],
            relative.clone(),
            DiagnosticParser::Pyright,
            "pyright",
            timeout_seconds,
        );
    }
    if let Some(program) = resolve_python_tool(&workspace, "ruff") {
        insert_or_extend_files(
            checks,
            "ruff",
            &workspace,
            program,
            vec!["check".into(), "--output-format".into(), "json".into()],
            relative,
            DiagnosticParser::Ruff,
            "ruff",
            timeout_seconds,
        );
    }
}

fn add_dart_checks(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let workspace = nearest_ancestor_with(path, project_root, &["pubspec.yaml"])
        .unwrap_or_else(|| project_root.to_path_buf());
    let flutter_project = fs::read_to_string(workspace.join("pubspec.yaml"))
        .map(|text| text.contains("sdk: flutter"))
        .unwrap_or(false);
    if flutter_project {
        let program = resolve_program(&workspace, &["flutter"])
            .and_then(|flutter| {
                let dart_name = if cfg!(target_os = "windows") {
                    "dart.exe"
                } else {
                    "dart"
                };
                let dart = flutter.parent()?.join(dart_name);
                dart.is_file().then_some(dart)
            })
            .or_else(|| resolve_program(&workspace, &["dart"]))
            .unwrap_or_else(|| "dart".into());
        insert_check(
            checks,
            "flutter-analyze",
            &workspace,
            program,
            vec!["analyze".into(), "--format".into(), "machine".into()],
            DiagnosticParser::Dart,
            "flutter-analyze",
            timeout_seconds,
        );
    } else {
        let program = resolve_program(&workspace, &["dart"]).unwrap_or_else(|| "dart".into());
        insert_check(
            checks,
            "dart-analyze",
            &workspace,
            program,
            vec!["analyze".into(), "--format".into(), "machine".into()],
            DiagnosticParser::Dart,
            "dart-analyze",
            timeout_seconds,
        );
    }
}

fn add_cargo_check(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let Some(workspace) = nearest_ancestor_with(path, project_root, &["Cargo.toml"]) else {
        return;
    };
    let program = resolve_program(&workspace, &["cargo"]).unwrap_or_else(|| "cargo".into());
    insert_check(
        checks,
        "cargo-check",
        &workspace,
        program,
        vec![
            "check".into(),
            "--offline".into(),
            "--message-format=json".into(),
        ],
        DiagnosticParser::Cargo,
        "cargo",
        timeout_seconds,
    );
}

fn add_go_check(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let Some(workspace) = nearest_ancestor_with(path, project_root, &["go.mod", "go.work"]) else {
        return;
    };
    let package_dir = path.parent().unwrap_or(&workspace);
    let package = if package_dir == workspace {
        ".".to_string()
    } else {
        format!("./{}", relative_argument(&workspace, package_dir))
    };
    let program = resolve_program(&workspace, &["go"]).unwrap_or_else(|| "go".into());
    insert_check(
        checks,
        &format!("go-check:{package}"),
        &workspace,
        program,
        vec!["test".into(), "-run=^$".into(), package],
        DiagnosticParser::Generic,
        "go",
        timeout_seconds,
    );
}

fn add_gradle_check(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    extension: &str,
    timeout_seconds: u64,
) {
    let Some(workspace) = nearest_ancestor_with(
        path,
        project_root,
        &["settings.gradle", "settings.gradle.kts"],
    ) else {
        return;
    };
    let program = resolve_program(&workspace, &["gradle"])
        .or_else(|| cached_gradle_wrapper(&workspace))
        .unwrap_or_else(|| "gradle".into());
    let android = contains_android_project_marker(&workspace, path);
    let task = if android {
        let module = nearest_gradle_module(&workspace, path);
        let prefix = module
            .filter(|value| !value.is_empty())
            .map(|value| format!(":{}:", value.replace('/', ":")))
            .unwrap_or_else(|| ":".to_string());
        match extension {
            "kt" | "kts" => format!("{prefix}compileDebugKotlin"),
            "java" => format!("{prefix}compileDebugJavaWithJavac"),
            "xml" => format!("{prefix}processDebugResources"),
            _ => format!("{prefix}lintDebug"),
        }
    } else {
        "classes".to_string()
    };
    insert_check(
        checks,
        &format!("gradle:{task}"),
        &workspace,
        program,
        vec![task, "--console=plain".into(), "--offline".into()],
        DiagnosticParser::Generic,
        if android { "android-gradle" } else { "gradle" },
        timeout_seconds,
    );
}

fn add_apple_check(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    if let Some(workspace) = nearest_ancestor_with(path, project_root, &["Package.swift"]) {
        let program = resolve_program(&workspace, &["swift"]).unwrap_or_else(|| "swift".into());
        insert_check(
            checks,
            "swift-build",
            &workspace,
            program,
            vec![
                "build".into(),
                "--disable-automatic-resolution".into(),
                "--skip-update".into(),
            ],
            DiagnosticParser::Generic,
            "swift",
            timeout_seconds,
        );
        return;
    }

    let Some((workspace, project)) = nearest_xcode_project(path, project_root) else {
        return;
    };
    let program =
        resolve_program(&workspace, &["xcodebuild"]).unwrap_or_else(|| "xcodebuild".into());
    insert_check(
        checks,
        "xcode-build",
        &workspace,
        program,
        vec![
            "-project".into(),
            project.to_string_lossy().to_string(),
            "-alltargets".into(),
            "-configuration".into(),
            "Debug".into(),
            "-sdk".into(),
            "iphonesimulator".into(),
            "CODE_SIGNING_ALLOWED=NO".into(),
            "-disableAutomaticPackageResolution".into(),
            "build".into(),
        ],
        DiagnosticParser::Generic,
        "xcodebuild",
        timeout_seconds,
    );
}

fn add_dotnet_check(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let Some(workspace) = nearest_ancestor_matching(path, project_root, |entry| {
        matches!(
            entry.extension().and_then(|value| value.to_str()),
            Some("sln" | "csproj" | "fsproj")
        )
    }) else {
        return;
    };
    let program = resolve_program(&workspace, &["dotnet"]).unwrap_or_else(|| "dotnet".into());
    insert_check(
        checks,
        "dotnet-build",
        &workspace,
        program,
        vec!["build".into(), "--nologo".into(), "--no-restore".into()],
        DiagnosticParser::Generic,
        "dotnet",
        timeout_seconds,
    );
}

fn add_maven_check(
    checks: &mut BTreeMap<String, CheckSpec>,
    project_root: &Path,
    path: &Path,
    timeout_seconds: u64,
) {
    let Some(workspace) = nearest_ancestor_with(path, project_root, &["pom.xml"]) else {
        return;
    };
    let program = resolve_program(&workspace, &["mvn"]).unwrap_or_else(|| "mvn".into());
    insert_check(
        checks,
        "maven-compile",
        &workspace,
        program,
        vec![
            "-q".into(),
            "--offline".into(),
            "-DskipTests".into(),
            "compile".into(),
        ],
        DiagnosticParser::Generic,
        "maven",
        timeout_seconds,
    );
}

#[allow(clippy::too_many_arguments)]
fn insert_check(
    checks: &mut BTreeMap<String, CheckSpec>,
    id: &str,
    cwd: &Path,
    program: PathBuf,
    args: Vec<String>,
    parser: DiagnosticParser,
    source: &str,
    timeout_seconds: u64,
) {
    let key = format!("{id}:{}", cwd.display());
    checks.entry(key).or_insert_with(|| CheckSpec {
        display_command: display_command(&program.to_string_lossy(), &args),
        args,
        cwd: cwd.to_path_buf(),
        id: id.to_string(),
        parser,
        program,
        source: source.to_string(),
        timeout_seconds,
    });
}

#[allow(clippy::too_many_arguments)]
fn insert_or_extend_files(
    checks: &mut BTreeMap<String, CheckSpec>,
    id: &str,
    cwd: &Path,
    program: PathBuf,
    base_args: Vec<String>,
    file: String,
    parser: DiagnosticParser,
    source: &str,
    timeout_seconds: u64,
) {
    let key = format!("{id}:{}", cwd.display());
    if let Some(check) = checks.get_mut(&key) {
        if !check.args.contains(&file) {
            check.args.push(file);
            check.display_command = display_command(&check.program.to_string_lossy(), &check.args);
        }
        return;
    }
    let mut args = base_args;
    args.push(file);
    insert_check(
        checks,
        id,
        cwd,
        program,
        args,
        parser,
        source,
        timeout_seconds,
    );
}

fn parser_from_name(value: &str) -> DiagnosticParser {
    match value.trim() {
        "cargo" => DiagnosticParser::Cargo,
        "dart" => DiagnosticParser::Dart,
        "eslint" => DiagnosticParser::Eslint,
        "flutter" => DiagnosticParser::Flutter,
        "pyright" => DiagnosticParser::Pyright,
        "ruff" => DiagnosticParser::Ruff,
        _ => DiagnosticParser::Generic,
    }
}

fn resolve_custom_cwd(project_root: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(project_root.to_path_buf());
    };
    let candidate = project_root.join(cwd);
    let canonical = candidate.canonicalize().map_err(|error| {
        format!(
            "Could not resolve verification cwd {}: {error}",
            candidate.display()
        )
    })?;
    if !canonical.starts_with(project_root) || !canonical.is_dir() {
        return Err(
            "Verification command cwd must be a directory inside the selected project.".to_string(),
        );
    }
    Ok(canonical)
}

fn resolve_node_bin(workspace: &Path, name: &str) -> Option<PathBuf> {
    let windows_name = format!("{name}.cmd");
    let local_names = if cfg!(target_os = "windows") {
        vec![windows_name.as_str(), name]
    } else {
        vec![name]
    };
    for ancestor in workspace.ancestors() {
        for local_name in &local_names {
            let candidate = ancestor.join("node_modules").join(".bin").join(local_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    resolve_program(workspace, &[name])
}

fn resolve_python_tool(workspace: &Path, name: &str) -> Option<PathBuf> {
    let candidates = if cfg!(target_os = "windows") {
        vec![
            workspace
                .join(".venv")
                .join("Scripts")
                .join(format!("{name}.exe")),
            workspace
                .join("venv")
                .join("Scripts")
                .join(format!("{name}.exe")),
        ]
    } else {
        vec![
            workspace.join(".venv").join("bin").join(name),
            workspace.join("venv").join("bin").join(name),
        ]
    };
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .or_else(|| resolve_node_bin(workspace, name))
        .or_else(|| resolve_program(workspace, &[name]))
}

fn resolve_program(cwd: &Path, names: &[&str]) -> Option<PathBuf> {
    for name in names {
        let direct = PathBuf::from(name);
        if direct.components().count() > 1 {
            let candidate = if direct.is_absolute() {
                direct
            } else {
                cwd.join(direct)
            };
            if candidate.is_file() {
                return Some(candidate);
            }
            continue;
        }
        let Some(path_value) = env::var_os("PATH") else {
            continue;
        };
        for directory in env::split_paths(&path_value) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
            if cfg!(target_os = "windows") {
                for suffix in ["exe", "cmd", "bat"] {
                    let candidate = directory.join(format!("{name}.{suffix}"));
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}

fn cached_gradle_wrapper(workspace: &Path) -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "gradlew.bat"
    } else {
        "gradlew"
    };
    let wrapper = workspace.join(name);
    if !wrapper.is_file() {
        return None;
    }
    let properties =
        fs::read_to_string(workspace.join("gradle/wrapper/gradle-wrapper.properties")).ok()?;
    let distribution = properties
        .lines()
        .find_map(|line| line.trim().strip_prefix("distributionUrl="))?
        .rsplit('/')
        .next()?
        .trim_end_matches(".zip");
    let gradle_home = env::var_os("GRADLE_USER_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .or_else(|| env::var_os("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".gradle"))
        })?;
    let cached = gradle_home.join("wrapper/dists").join(distribution);
    let executable_name = if cfg!(target_os = "windows") {
        "gradle.bat"
    } else {
        "gradle"
    };
    let available = fs::read_dir(cached)
        .ok()?
        .filter_map(Result::ok)
        .any(|hash| {
            fs::read_dir(hash.path())
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .any(|entry| entry.path().join("bin").join(executable_name).is_file())
        });
    available.then_some(wrapper)
}

fn nearest_ancestor_with(path: &Path, project_root: &Path, names: &[&str]) -> Option<PathBuf> {
    let start = if path.is_dir() { path } else { path.parent()? };
    for ancestor in start.ancestors() {
        if !ancestor.starts_with(project_root) {
            break;
        }
        if names.iter().any(|name| ancestor.join(name).is_file()) {
            return Some(ancestor.to_path_buf());
        }
        if ancestor == project_root {
            break;
        }
    }
    None
}

fn nearest_ancestor_matching(
    path: &Path,
    project_root: &Path,
    predicate: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let start = if path.is_dir() { path } else { path.parent()? };
    for ancestor in start.ancestors() {
        if !ancestor.starts_with(project_root) {
            break;
        }
        if fs::read_dir(ancestor)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .any(|entry| predicate(&entry.path()))
        {
            return Some(ancestor.to_path_buf());
        }
        if ancestor == project_root {
            break;
        }
    }
    None
}

fn nearest_xcode_project(path: &Path, project_root: &Path) -> Option<(PathBuf, PathBuf)> {
    let workspace = nearest_ancestor_matching(path, project_root, |entry| {
        entry.extension().and_then(|value| value.to_str()) == Some("xcodeproj")
    })?;
    let project = fs::read_dir(&workspace)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|entry| entry.extension().and_then(|value| value.to_str()) == Some("xcodeproj"))?;
    Some((workspace, project))
}

fn nearest_gradle_module(workspace: &Path, path: &Path) -> Option<String> {
    let start = if path.is_dir() { path } else { path.parent()? };
    for ancestor in start.ancestors() {
        if !ancestor.starts_with(workspace) {
            break;
        }
        if ancestor.join("build.gradle").is_file() || ancestor.join("build.gradle.kts").is_file() {
            return ancestor
                .strip_prefix(workspace)
                .ok()
                .map(|relative| relative.to_string_lossy().replace('\\', "/"));
        }
        if ancestor == workspace {
            break;
        }
    }
    None
}

fn contains_android_project_marker(workspace: &Path, path: &Path) -> bool {
    if path
        .ancestors()
        .take_while(|ancestor| ancestor.starts_with(workspace))
        .any(|ancestor| ancestor.join("src/main/AndroidManifest.xml").is_file())
    {
        return true;
    }
    ["build.gradle", "build.gradle.kts"]
        .iter()
        .filter_map(|name| fs::read_to_string(workspace.join(name)).ok())
        .any(|text| {
            text.contains("com.android.application") || text.contains("com.android.library")
        })
}

fn is_gradle_file(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("build.gradle" | "build.gradle.kts" | "settings.gradle" | "settings.gradle.kts")
    )
}

fn normalize_extension(value: &str) -> String {
    value.trim().trim_start_matches('.').to_ascii_lowercase()
}

fn relative_argument(cwd: &Path, path: &Path) -> String {
    path.strip_prefix(cwd)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn display_command(program: &str, args: &[String]) -> String {
    std::iter::once(program.to_string())
        .chain(args.iter().map(|argument| {
            if argument.contains(char::is_whitespace) {
                format!("\"{}\"", argument.replace('"', "\\\""))
            } else {
                argument.clone()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::discover;
    use crate::agent::tools::verification::config::VerificationConfig;

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("wizzle-adapter-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test project");
        path
    }

    #[test]
    fn discovers_custom_checks_by_extension() {
        let root = temp_dir("custom");
        let source = root.join("main.foo");
        fs::write(&source, "value\n").expect("write source");
        fs::write(
            root.join(".wizzle.yaml"),
            r#"verification:
  builtins: false
  commands:
    - id: foo-check
      command: checker
      args: []
      extensions: [.foo]
"#,
        )
        .expect("write config");
        let config = crate::agent::tools::verification::config::load(&root).expect("load config");
        let checks = discover(&root, &[source], &config).expect("discover checks");
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].id, "custom:foo-check");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn disabled_builtins_return_no_checks() {
        let root = temp_dir("disabled");
        let source = root.join("main.rs");
        fs::write(&source, "fn main() {}\n").expect("write source");
        let config = VerificationConfig {
            builtins: false,
            ..VerificationConfig::default()
        };
        assert!(discover(&root, &[source], &config)
            .expect("discover checks")
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_flutter_android_ios_and_pyright_adapters() {
        let root = temp_dir("mobile-python");

        let flutter = root.join("flutter-app");
        fs::create_dir_all(flutter.join("lib")).expect("create Flutter source");
        fs::write(
            flutter.join("pubspec.yaml"),
            "dependencies:\n  flutter:\n    sdk: flutter\n",
        )
        .expect("write pubspec");
        let dart = flutter.join("lib/main.dart");
        fs::write(&dart, "void main() {}\n").expect("write Dart source");

        let android = root.join("android-app");
        fs::create_dir_all(android.join("app/src/main/java")).expect("create Android source");
        fs::write(android.join("settings.gradle"), "include ':app'\n")
            .expect("write Gradle settings");
        fs::write(
            android.join("app/build.gradle"),
            "plugins { id 'com.android.application' }\n",
        )
        .expect("write Gradle module");
        fs::create_dir_all(android.join("app/src/main")).expect("create Android main");
        fs::write(
            android.join("app/src/main/AndroidManifest.xml"),
            "<manifest />\n",
        )
        .expect("write Android manifest");
        let kotlin = android.join("app/src/main/java/Main.kt");
        fs::write(&kotlin, "class Main\n").expect("write Kotlin source");

        let ios = root.join("ios-app");
        fs::create_dir_all(ios.join("Demo.xcodeproj")).expect("create Xcode project");
        let swift = ios.join("Main.swift");
        fs::write(&swift, "struct Main {}\n").expect("write Swift source");

        let python = root.join("python-app");
        fs::create_dir_all(python.join("node_modules/.bin")).expect("create Python tool bin");
        fs::write(python.join("pyproject.toml"), "[project]\nname = 'demo'\n")
            .expect("write Python manifest");
        let pyright_name = if cfg!(target_os = "windows") {
            "pyright.cmd"
        } else {
            "pyright"
        };
        fs::write(python.join("node_modules/.bin").join(pyright_name), "")
            .expect("write Pyright tool");
        let python_source = python.join("main.py");
        fs::write(&python_source, "value = 1\n").expect("write Python source");

        let checks = discover(
            &root,
            &[dart, kotlin, swift, python_source],
            &VerificationConfig::default(),
        )
        .expect("discover checks");
        assert!(checks.iter().any(|check| check.id == "flutter-analyze"));
        assert!(checks.iter().any(
            |check| check.source == "android-gradle" && check.id.contains("compileDebugKotlin")
        ));
        assert!(checks.iter().any(|check| check.id == "xcode-build"));
        assert!(checks.iter().any(|check| check.id == "pyright"));
        let _ = fs::remove_dir_all(root);
    }
}
