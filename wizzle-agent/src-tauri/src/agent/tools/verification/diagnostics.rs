use std::path::Path;

use regex::Regex;
use serde_json::Value;

use super::types::{DiagnosticParser, VerificationDiagnostic};

pub fn parse(
    parser: DiagnosticParser,
    output: &str,
    check_id: &str,
    source: &str,
    cwd: &Path,
) -> Vec<VerificationDiagnostic> {
    let diagnostics = match parser {
        DiagnosticParser::Cargo => parse_cargo(output, check_id, source, cwd),
        DiagnosticParser::Dart => parse_dart(output, check_id, source, cwd),
        DiagnosticParser::Eslint => parse_eslint(output, check_id, source, cwd),
        DiagnosticParser::Flutter => parse_flutter(output, check_id, source, cwd),
        DiagnosticParser::Pyright => parse_pyright(output, check_id, source, cwd),
        DiagnosticParser::Ruff => parse_ruff(output, check_id, source, cwd),
        DiagnosticParser::Generic => Vec::new(),
    };
    if diagnostics.is_empty() {
        parse_generic(output, check_id, source, cwd)
    } else {
        diagnostics
    }
}

fn parse_pyright(
    output: &str,
    check_id: &str,
    source: &str,
    cwd: &Path,
) -> Vec<VerificationDiagnostic> {
    let Ok(root) = serde_json::from_str::<Value>(output) else {
        return Vec::new();
    };
    root.get("generalDiagnostics")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let start = item.get("range")?.get("start")?;
            Some(diagnostic(
                check_id,
                item.get("rule").and_then(Value::as_str).map(str::to_string),
                start
                    .get("character")
                    .and_then(Value::as_u64)
                    .map(|value| value + 1),
                normalize_file(item.get("file").and_then(Value::as_str), cwd),
                start
                    .get("line")
                    .and_then(Value::as_u64)
                    .map(|value| value + 1),
                item.get("message")?.as_str()?.to_string(),
                normalize_severity(item.get("severity").and_then(Value::as_str)),
                source,
            ))
        })
        .collect()
}

fn parse_ruff(
    output: &str,
    check_id: &str,
    source: &str,
    cwd: &Path,
) -> Vec<VerificationDiagnostic> {
    let Ok(items) = serde_json::from_str::<Vec<Value>>(output) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| {
            let location = item.get("location")?;
            Some(diagnostic(
                check_id,
                item.get("code").and_then(Value::as_str).map(str::to_string),
                location.get("column").and_then(Value::as_u64),
                normalize_file(item.get("filename").and_then(Value::as_str), cwd),
                location.get("row").and_then(Value::as_u64),
                item.get("message")?.as_str()?.to_string(),
                "error".to_string(),
                source,
            ))
        })
        .collect()
}

fn parse_eslint(
    output: &str,
    check_id: &str,
    source: &str,
    cwd: &Path,
) -> Vec<VerificationDiagnostic> {
    let Ok(files) = serde_json::from_str::<Vec<Value>>(output) else {
        return Vec::new();
    };
    files
        .into_iter()
        .flat_map(|file| {
            let path = normalize_file(file.get("filePath").and_then(Value::as_str), cwd);
            file.get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(move |message| {
                    Some(diagnostic(
                        check_id,
                        message
                            .get("ruleId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        message.get("column").and_then(Value::as_u64),
                        path.clone(),
                        message.get("line").and_then(Value::as_u64),
                        message.get("message")?.as_str()?.to_string(),
                        match message.get("severity").and_then(Value::as_u64) {
                            Some(2) => "error".to_string(),
                            _ => "warning".to_string(),
                        },
                        source,
                    ))
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn parse_cargo(
    output: &str,
    check_id: &str,
    source: &str,
    cwd: &Path,
) -> Vec<VerificationDiagnostic> {
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|item| item.get("reason").and_then(Value::as_str) == Some("compiler-message"))
        .filter_map(|item| {
            let message = item.get("message")?;
            let span = message
                .get("spans")
                .and_then(Value::as_array)
                .and_then(|spans| {
                    spans
                        .iter()
                        .find(|span| span.get("is_primary").and_then(Value::as_bool) == Some(true))
                        .or_else(|| spans.first())
                });
            Some(diagnostic(
                check_id,
                message
                    .get("code")
                    .and_then(|value| value.get("code"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                span.and_then(|value| value.get("column_start"))
                    .and_then(Value::as_u64),
                normalize_file(
                    span.and_then(|value| value.get("file_name"))
                        .and_then(Value::as_str),
                    cwd,
                ),
                span.and_then(|value| value.get("line_start"))
                    .and_then(Value::as_u64),
                message.get("message")?.as_str()?.to_string(),
                normalize_severity(message.get("level").and_then(Value::as_str)),
                source,
            ))
        })
        .collect()
}

fn parse_dart(
    output: &str,
    check_id: &str,
    source: &str,
    cwd: &Path,
) -> Vec<VerificationDiagnostic> {
    output
        .lines()
        .filter_map(|line| {
            let parts = line.splitn(8, '|').collect::<Vec<_>>();
            if parts.len() != 8 || !matches!(parts[0], "ERROR" | "WARNING" | "INFO") {
                return None;
            }
            Some(diagnostic(
                check_id,
                (!parts[2].is_empty()).then(|| parts[2].to_string()),
                parts[5].parse().ok(),
                normalize_file(Some(parts[3]), cwd),
                parts[4].parse().ok(),
                parts[7].to_string(),
                normalize_severity(Some(parts[0])),
                source,
            ))
        })
        .collect()
}

fn parse_flutter(
    output: &str,
    check_id: &str,
    source: &str,
    cwd: &Path,
) -> Vec<VerificationDiagnostic> {
    let location = Regex::new(r"^(.+?):(\d+):(\d+)$").expect("valid Flutter location regex");
    output
        .lines()
        .filter_map(|line| {
            let parts = line.split('•').map(str::trim).collect::<Vec<_>>();
            if parts.len() < 3 {
                return None;
            }
            let severity = normalize_severity(Some(parts[0]));
            if severity == "info" && !parts[0].eq_ignore_ascii_case("info") {
                return None;
            }
            let captures = location.captures(parts[2])?;
            Some(diagnostic(
                check_id,
                parts.get(3).map(|value| value.to_string()),
                capture(&captures, 3).and_then(|value| value.parse().ok()),
                normalize_file(captures.get(1).map(|value| value.as_str()), cwd),
                capture(&captures, 2).and_then(|value| value.parse().ok()),
                parts[1].to_string(),
                severity,
                source,
            ))
        })
        .collect()
}

fn parse_generic(
    output: &str,
    check_id: &str,
    source: &str,
    cwd: &Path,
) -> Vec<VerificationDiagnostic> {
    let unix = Regex::new(
        r"^(?:[ew]:\s+)?(?:file://)?(.+?):(\d+)(?::(\d+))?:\s*(error|warning|info)(?:\s+\[?([A-Za-z0-9_.-]+)\]?)?:?\s*(.+)$",
    )
    .expect("valid diagnostic regex");
    let windows =
        Regex::new(r"^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s*([A-Za-z0-9_.-]+)?:?\s*(.+)$")
            .expect("valid diagnostic regex");
    let kotlin = Regex::new(r"^(e|w):\s+(?:file://)?(.+?):(\d+):(\d+)\s+(.+)$")
        .expect("valid Kotlin diagnostic regex");
    let aapt = Regex::new(
        r"^(?:ERROR:\s+)?(.+?):(\d+)(?::(\d+))?:\s+(?:AAPT:\s+)?(error|warning):\s*(.+)$",
    )
    .expect("valid Android resource diagnostic regex");
    let mut diagnostics = output
        .lines()
        .filter_map(|line| {
            if let Some(captures) = kotlin.captures(line.trim()) {
                return Some(diagnostic(
                    check_id,
                    None,
                    capture(&captures, 4).and_then(|value| value.parse().ok()),
                    normalize_file(captures.get(2).map(|value| value.as_str()), cwd),
                    capture(&captures, 3).and_then(|value| value.parse().ok()),
                    capture(&captures, 5)?,
                    if captures.get(1).map(|value| value.as_str()) == Some("e") {
                        "error".to_string()
                    } else {
                        "warning".to_string()
                    },
                    source,
                ));
            }
            if let Some(captures) = aapt.captures(line.trim()) {
                return Some(diagnostic(
                    check_id,
                    None,
                    capture(&captures, 3).and_then(|value| value.parse().ok()),
                    normalize_file(captures.get(1).map(|value| value.as_str()), cwd),
                    capture(&captures, 2).and_then(|value| value.parse().ok()),
                    capture(&captures, 5)?,
                    normalize_severity(captures.get(4).map(|value| value.as_str())),
                    source,
                ));
            }
            if let Some(captures) = windows.captures(line.trim()) {
                return Some(diagnostic(
                    check_id,
                    capture(&captures, 5),
                    capture(&captures, 3).and_then(|value| value.parse().ok()),
                    normalize_file(captures.get(1).map(|value| value.as_str()), cwd),
                    capture(&captures, 2).and_then(|value| value.parse().ok()),
                    capture(&captures, 6)?,
                    normalize_severity(captures.get(4).map(|value| value.as_str())),
                    source,
                ));
            }
            let captures = unix.captures(line.trim())?;
            Some(diagnostic(
                check_id,
                capture(&captures, 5),
                capture(&captures, 3).and_then(|value| value.parse().ok()),
                normalize_file(captures.get(1).map(|value| value.as_str()), cwd),
                capture(&captures, 2).and_then(|value| value.parse().ok()),
                capture(&captures, 6)?,
                normalize_severity(captures.get(4).map(|value| value.as_str())),
                source,
            ))
        })
        .collect::<Vec<_>>();
    if diagnostics.is_empty() {
        let python =
            Regex::new(r#"^\s*File "(.+?)", line (\d+)"#).expect("valid Python diagnostic regex");
        let lines = output.lines().collect::<Vec<_>>();
        for (index, line) in lines.iter().enumerate() {
            let Some(captures) = python.captures(line) else {
                continue;
            };
            let error = lines
                .iter()
                .skip(index + 1)
                .take(4)
                .find(|candidate| candidate.contains("Error:"));
            diagnostics.push(diagnostic(
                check_id,
                None,
                None,
                normalize_file(captures.get(1).map(|value| value.as_str()), cwd),
                capture(&captures, 2).and_then(|value| value.parse().ok()),
                error.copied().unwrap_or("Python syntax error").to_string(),
                "error".to_string(),
                source,
            ));
        }
    }
    diagnostics
}

#[allow(clippy::too_many_arguments)]
fn diagnostic(
    check_id: &str,
    code: Option<String>,
    column: Option<u64>,
    file: Option<String>,
    line: Option<u64>,
    message: String,
    severity: String,
    source: &str,
) -> VerificationDiagnostic {
    VerificationDiagnostic {
        check_id: check_id.to_string(),
        code,
        column,
        file,
        is_new: false,
        line,
        message: message.trim().chars().take(1_000).collect(),
        severity,
        source: source.to_string(),
    }
}

fn capture(captures: &regex::Captures<'_>, index: usize) -> Option<String> {
    captures
        .get(index)
        .map(|value| value.as_str().trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_file(value: Option<&str>, cwd: &Path) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let path = Path::new(value);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    Some(resolved.to_string_lossy().replace('\\', "/"))
}

fn normalize_severity(value: Option<&str>) -> String {
    match value.unwrap_or_default().to_ascii_lowercase().as_str() {
        "error" | "fatal" => "error".to_string(),
        "warning" | "warn" => "warning".to_string(),
        _ => "info".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::parse;
    use crate::agent::tools::verification::types::DiagnosticParser;

    #[test]
    fn parses_pyright_json() {
        let output = r#"{"generalDiagnostics":[{"file":"main.py","severity":"error","message":"Unknown name","rule":"reportUndefinedVariable","range":{"start":{"line":2,"character":4},"end":{"line":2,"character":5}}}]}"#;
        let diagnostics = parse(
            DiagnosticParser::Pyright,
            output,
            "pyright",
            "pyright",
            Path::new("/project"),
        );
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].line, Some(3));
        assert_eq!(diagnostics[0].column, Some(5));
        assert_eq!(
            diagnostics[0].code.as_deref(),
            Some("reportUndefinedVariable")
        );
    }

    #[test]
    fn parses_generic_unix_and_windows_diagnostics() {
        let output = "src/main.ts:4:8: error TS2322: Wrong type\nC:\\app\\Main.cs(7,3): warning CS0168: Unused\n";
        let diagnostics = parse(
            DiagnosticParser::Generic,
            output,
            "compiler",
            "compiler",
            Path::new("/project"),
        );
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].line, Some(4));
        assert_eq!(diagnostics[1].code.as_deref(), Some("CS0168"));
    }

    #[test]
    fn parses_dart_machine_output() {
        let output =
            "ERROR|COMPILE_TIME_ERROR|UNDEFINED_METHOD|lib/main.dart|8|12|4|Undefined method";
        let diagnostics = parse(
            DiagnosticParser::Dart,
            output,
            "dart",
            "dart",
            Path::new("/project"),
        );
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code.as_deref(), Some("UNDEFINED_METHOD"));
    }

    #[test]
    fn parses_flutter_and_android_diagnostics() {
        let flutter = parse(
            DiagnosticParser::Flutter,
            "error • Undefined method • lib/main.dart:8:12 • undefined_method",
            "flutter",
            "flutter",
            Path::new("/project"),
        );
        assert_eq!(flutter.len(), 1);
        assert_eq!(flutter[0].line, Some(8));
        assert_eq!(flutter[0].code.as_deref(), Some("undefined_method"));

        let android = parse(
            DiagnosticParser::Generic,
            "e: file:///project/app/src/Main.kt:9:4 Unresolved reference",
            "android",
            "android-gradle",
            Path::new("/project"),
        );
        assert_eq!(android.len(), 1);
        assert_eq!(android[0].severity, "error");
        assert_eq!(android[0].line, Some(9));
    }

    #[test]
    fn parses_python_syntax_traceback() {
        let output = "Traceback (most recent call last):\n  File \"main.py\", line 3\n    value =\n           ^\nSyntaxError: invalid syntax\n";
        let diagnostics = parse(
            DiagnosticParser::Generic,
            output,
            "python",
            "python",
            Path::new("/project"),
        );
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].line, Some(3));
        assert!(diagnostics[0].message.contains("SyntaxError"));
    }
}
