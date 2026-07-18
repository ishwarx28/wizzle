use std::{fs, path::Path};

use serde::Deserialize;

const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const DEFAULT_TIMEOUT_SECONDS: u64 = 45;
const DEFAULT_MAX_DIAGNOSTICS: usize = 50;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CustomCheckConfig {
    #[serde(default)]
    pub args: Vec<String>,
    pub command: String,
    pub cwd: Option<String>,
    #[serde(default)]
    pub extensions: Vec<String>,
    pub id: String,
    pub parser: Option<String>,
}

#[derive(Clone, Debug)]
pub struct VerificationConfig {
    pub builtins: bool,
    pub commands: Vec<CustomCheckConfig>,
    pub enabled: bool,
    pub max_diagnostics: usize,
    pub timeout_seconds: u64,
}

impl Default for VerificationConfig {
    fn default() -> Self {
        Self {
            builtins: true,
            commands: Vec::new(),
            enabled: true,
            max_diagnostics: DEFAULT_MAX_DIAGNOSTICS,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ProjectConfigFile {
    verification: Option<VerificationConfigFile>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct VerificationConfigFile {
    builtins: Option<bool>,
    #[serde(default)]
    commands: Vec<CustomCheckConfig>,
    enabled: Option<bool>,
    max_diagnostics: Option<usize>,
    timeout_seconds: Option<u64>,
}

pub fn load(project_root: &Path) -> Result<VerificationConfig, String> {
    let yaml_path = project_root.join(".wizzle.yaml");
    let yml_path = project_root.join(".wizzle.yml");
    let path = match (yaml_path.exists(), yml_path.exists()) {
        (false, false) => return Ok(VerificationConfig::default()),
        (true, false) => yaml_path,
        (false, true) => yml_path,
        (true, true) => {
            return Err(
                "Keep only one project verification file: .wizzle.yaml or .wizzle.yml.".to_string(),
            )
        }
    };
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(format!(
            "{} is larger than the 64 KB verification-config limit.",
            path.display()
        ));
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let file = serde_yaml::from_str::<ProjectConfigFile>(&text)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))?;
    let Some(verification) = file.verification else {
        return Ok(VerificationConfig::default());
    };

    validate_commands(&verification.commands)?;
    Ok(VerificationConfig {
        builtins: verification.builtins.unwrap_or(true),
        commands: verification.commands,
        enabled: verification.enabled.unwrap_or(true),
        max_diagnostics: verification
            .max_diagnostics
            .unwrap_or(DEFAULT_MAX_DIAGNOSTICS)
            .clamp(1, 100),
        timeout_seconds: verification
            .timeout_seconds
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
            .clamp(1, 120),
    })
}

fn validate_commands(commands: &[CustomCheckConfig]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for command in commands {
        if command.id.trim().is_empty() || command.command.trim().is_empty() {
            return Err(
                "Every verification command requires non-empty id and command fields.".to_string(),
            );
        }
        if !ids.insert(command.id.trim().to_string()) {
            return Err(format!(
                "Verification command id '{}' is duplicated.",
                command.id.trim()
            ));
        }
        if command.extensions.is_empty() {
            return Err(format!(
                "Verification command '{}' requires at least one extension.",
                command.id.trim()
            ));
        }
        if command.parser.as_deref().is_some_and(|parser| {
            !matches!(
                parser.trim(),
                "cargo" | "dart" | "eslint" | "flutter" | "generic" | "pyright" | "ruff"
            )
        }) {
            return Err(format!(
                "Verification command '{}' has an unsupported parser.",
                command.id.trim()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::load;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "wizzle-verification-config-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test project");
        path
    }

    #[test]
    fn loads_bounded_project_overrides() {
        let root = temp_dir("valid");
        fs::write(
            root.join(".wizzle.yaml"),
            r#"verification:
  builtins: false
  timeoutSeconds: 999
  maxDiagnostics: 0
  commands:
    - id: custom
      command: checker
      args: ["--json"]
      extensions: [foo]
      parser: generic
"#,
        )
        .expect("write config");

        let config = load(&root).expect("load config");
        assert!(!config.builtins);
        assert_eq!(config.timeout_seconds, 120);
        assert_eq!(config.max_diagnostics, 1);
        assert_eq!(config.commands.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_duplicate_config_files() {
        let root = temp_dir("duplicate");
        fs::write(root.join(".wizzle.yaml"), "verification: {}\n").expect("write yaml");
        fs::write(root.join(".wizzle.yml"), "verification: {}\n").expect("write yml");
        assert!(load(&root).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
