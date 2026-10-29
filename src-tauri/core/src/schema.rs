//! Bundled key catalogs and deprecation checks for well-known configuration
//! files.
//!
//! The catalogs cover the root keys Maestro can suggest while editing, plus a
//! small set of settings whose replacements are settled. They are intentionally
//! conservative: unknown files get no advice and unknown keys are never
//! flagged.

use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::validation::{strip_json_comments, strip_trailing_commas};

/// One suggested key. `scope` is `root` for top-level properties and `server`
/// for entries inside an `mcpServers` server object.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaKey {
    pub name: &'static str,
    pub detail: &'static str,
    pub scope: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub keys: Vec<SchemaKey>,
}

/// A warning tied to a top-level key, or to the whole file when `key` is
/// `None`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdviceWarning {
    pub key: Option<&'static str>,
    pub message: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Mcp,
    Claude,
    Gemini,
    OpenCode,
    VsCode,
    ContinueLegacy,
}

struct Deprecation {
    key: Option<&'static str>,
    message: &'static str,
}

const MCP_ROOT: &[SchemaKey] = &[SchemaKey {
    name: "mcpServers",
    detail: "Map of named MCP servers available to this tool.",
    scope: "root",
}];

const MCP_SERVER: &[SchemaKey] = &[
    SchemaKey {
        name: "command",
        detail: "Program that starts a stdio server.",
        scope: "server",
    },
    SchemaKey {
        name: "args",
        detail: "Arguments passed to the server command.",
        scope: "server",
    },
    SchemaKey {
        name: "env",
        detail: "Environment variables passed to the server.",
        scope: "server",
    },
    SchemaKey {
        name: "type",
        detail: "Transport type, such as stdio or http.",
        scope: "server",
    },
    SchemaKey {
        name: "url",
        detail: "Endpoint for a remote server.",
        scope: "server",
    },
    SchemaKey {
        name: "headers",
        detail: "HTTP headers sent to a remote server.",
        scope: "server",
    },
    SchemaKey {
        name: "disabled",
        detail: "Skips this server without deleting its settings.",
        scope: "server",
    },
    SchemaKey {
        name: "autoApprove",
        detail: "Tools this server may run without asking.",
        scope: "server",
    },
    SchemaKey {
        name: "timeout",
        detail: "Startup or request timeout in seconds.",
        scope: "server",
    },
];

const CLAUDE: &[SchemaKey] = &[
    SchemaKey {
        name: "permissions",
        detail: "Allow, ask and deny rules for tool calls.",
        scope: "root",
    },
    SchemaKey {
        name: "env",
        detail: "Environment variables applied to every session.",
        scope: "root",
    },
    SchemaKey {
        name: "model",
        detail: "Default model for new sessions.",
        scope: "root",
    },
    SchemaKey {
        name: "hooks",
        detail: "Commands that run around tool events.",
        scope: "root",
    },
    SchemaKey {
        name: "statusLine",
        detail: "Custom status line command and display options.",
        scope: "root",
    },
    SchemaKey {
        name: "enabledPlugins",
        detail: "Plugins enabled for this scope.",
        scope: "root",
    },
    SchemaKey {
        name: "attribution",
        detail: "Commit and pull request attribution settings.",
        scope: "root",
    },
    SchemaKey {
        name: "sandbox",
        detail: "Sandboxed execution settings.",
        scope: "root",
    },
    SchemaKey {
        name: "cleanupPeriodDays",
        detail: "How long session transcripts are kept.",
        scope: "root",
    },
    SchemaKey {
        name: "apiKeyHelper",
        detail: "Script that prints a temporary API key.",
        scope: "root",
    },
    SchemaKey {
        name: "outputStyle",
        detail: "Response style used by the CLI.",
        scope: "root",
    },
    SchemaKey {
        name: "enableAllProjectMcpServers",
        detail: "Accepts every MCP server declared by a project.",
        scope: "root",
    },
];

const GEMINI: &[SchemaKey] = &[
    SchemaKey {
        name: "theme",
        detail: "Terminal colour theme.",
        scope: "root",
    },
    SchemaKey {
        name: "selectedAuthType",
        detail: "Authentication method remembered by the CLI.",
        scope: "root",
    },
    SchemaKey {
        name: "sandbox",
        detail: "Runs tool calls inside the configured sandbox.",
        scope: "root",
    },
    SchemaKey {
        name: "mcpServers",
        detail: "MCP servers offered to Gemini CLI.",
        scope: "root",
    },
    SchemaKey {
        name: "coreTools",
        detail: "Built-in tools that stay enabled.",
        scope: "root",
    },
    SchemaKey {
        name: "excludeTools",
        detail: "Built-in tools removed from the session.",
        scope: "root",
    },
    SchemaKey {
        name: "checkpointing",
        detail: "Checkpoint history for file edits.",
        scope: "root",
    },
    SchemaKey {
        name: "fileFiltering",
        detail: "Which files are offered as context.",
        scope: "root",
    },
    SchemaKey {
        name: "telemetry",
        detail: "Local or remote telemetry settings.",
        scope: "root",
    },
];

const OPENCODE: &[SchemaKey] = &[
    SchemaKey {
        name: "$schema",
        detail: "Editor schema hint for this config file.",
        scope: "root",
    },
    SchemaKey {
        name: "theme",
        detail: "Interface theme.",
        scope: "root",
    },
    SchemaKey {
        name: "model",
        detail: "Default model for new sessions.",
        scope: "root",
    },
    SchemaKey {
        name: "small_model",
        detail: "Model used for lightweight tasks.",
        scope: "root",
    },
    SchemaKey {
        name: "provider",
        detail: "Provider and model configuration.",
        scope: "root",
    },
    SchemaKey {
        name: "agent",
        detail: "Named agent definitions.",
        scope: "root",
    },
    SchemaKey {
        name: "mcp",
        detail: "MCP servers available to OpenCode.",
        scope: "root",
    },
    SchemaKey {
        name: "permission",
        detail: "Tool permission policy.",
        scope: "root",
    },
    SchemaKey {
        name: "instructions",
        detail: "Instruction files added to every session.",
        scope: "root",
    },
    SchemaKey {
        name: "plugin",
        detail: "Plugins loaded at startup.",
        scope: "root",
    },
    SchemaKey {
        name: "formatter",
        detail: "Per-language formatter overrides.",
        scope: "root",
    },
    SchemaKey {
        name: "autoupdate",
        detail: "Whether OpenCode updates itself.",
        scope: "root",
    },
];

const VSCODE: &[SchemaKey] = &[
    SchemaKey {
        name: "editor.fontSize",
        detail: "Font size in pixels.",
        scope: "root",
    },
    SchemaKey {
        name: "editor.tabSize",
        detail: "Spaces inserted per tab stop.",
        scope: "root",
    },
    SchemaKey {
        name: "editor.wordWrap",
        detail: "How long lines wrap in the editor.",
        scope: "root",
    },
    SchemaKey {
        name: "editor.formatOnSave",
        detail: "Runs the default formatter when saving.",
        scope: "root",
    },
    SchemaKey {
        name: "files.associations",
        detail: "Extra file pattern to language mappings.",
        scope: "root",
    },
    SchemaKey {
        name: "files.exclude",
        detail: "Globs hidden from the Explorer.",
        scope: "root",
    },
    SchemaKey {
        name: "terminal.integrated.defaultProfile.windows",
        detail: "Default integrated terminal profile on Windows.",
        scope: "root",
    },
    SchemaKey {
        name: "terminal.integrated.profiles.windows",
        detail: "Integrated terminal profiles on Windows.",
        scope: "root",
    },
];

const CLAUDE_DEPRECATIONS: &[Deprecation] = &[Deprecation {
    key: Some("includeCoAuthoredBy"),
    message: "includeCoAuthoredBy is deprecated. Use the attribution settings instead.",
}];

const VSCODE_DEPRECATIONS: &[Deprecation] = &[
    Deprecation {
        key: Some("terminal.integrated.shell.windows"),
        message: "Deprecated. Use terminal.integrated.defaultProfile.windows instead.",
    },
    Deprecation {
        key: Some("terminal.integrated.shellArgs.windows"),
        message: "Deprecated. Configure terminal.integrated.profiles.windows instead.",
    },
];

const CONTINUE_DEPRECATIONS: &[Deprecation] = &[Deprecation {
    key: None,
    message: "config.json is the legacy Continue format. Migrate to config.yaml.",
}];

/// Returns the suggestion catalog for a path, when a bundled schema covers it.
///
/// @param path - Absolute configuration file path.
/// @returns The catalog, or `None` for unrecognised files.
pub fn schema_for(path: &Path) -> Option<SchemaInfo> {
    let kind = schema_kind(path)?;
    let (id, label, keys) = match kind {
        Kind::Mcp => (
            "mcp",
            "MCP server configuration",
            [MCP_ROOT, MCP_SERVER].concat(),
        ),
        Kind::Claude => ("claude", "Claude Code settings", CLAUDE.to_vec()),
        Kind::Gemini => ("gemini", "Gemini CLI settings", GEMINI.to_vec()),
        Kind::OpenCode => ("opencode", "OpenCode configuration", OPENCODE.to_vec()),
        Kind::VsCode => ("vscode", "VS Code settings", VSCODE.to_vec()),
        Kind::ContinueLegacy => return None,
    };
    Some(SchemaInfo { id, label, keys })
}

/// Returns deprecation warnings for a configuration document. Invalid JSON,
/// unknown paths and unreadably large content produce no warnings; syntax
/// errors are reported by the editor instead.
///
/// @param path - Absolute configuration file path.
/// @param content - Current editor content.
/// @returns Warnings for deprecated keys or formats present in the document.
pub fn warnings(path: &Path, content: &str) -> Vec<AdviceWarning> {
    let Some(kind) = schema_kind(path) else {
        return Vec::new();
    };
    if content.len() as u64 > crate::MAX_FILE_BYTES {
        return Vec::new();
    }
    let Some(object) = parsed_object(content) else {
        return Vec::new();
    };
    let deprecations = match kind {
        Kind::Claude => CLAUDE_DEPRECATIONS,
        Kind::VsCode => VSCODE_DEPRECATIONS,
        Kind::ContinueLegacy => CONTINUE_DEPRECATIONS,
        Kind::Mcp | Kind::Gemini | Kind::OpenCode => return Vec::new(),
    };
    deprecations
        .iter()
        .filter(|deprecation| match deprecation.key {
            Some(key) => object.contains_key(key),
            None => true,
        })
        .map(|deprecation| AdviceWarning {
            key: deprecation.key,
            message: deprecation.message,
        })
        .collect()
}

fn schema_kind(path: &Path) -> Option<Kind> {
    let parts = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let name = parts.last()?.as_str();
    let parent = parts
        .len()
        .checked_sub(2)
        .and_then(|index| parts.get(index))
        .map(String::as_str);
    match name {
        ".mcp.json" | "mcp.json" | "mcp_settings.json" | "cline_mcp_settings.json" => {
            Some(Kind::Mcp)
        }
        "opencode.json" | "opencode.jsonc" => Some(Kind::OpenCode),
        "settings.json" | "settings.local.json" if parent == Some(".claude") => Some(Kind::Claude),
        "settings.json" if parent == Some(".gemini") => Some(Kind::Gemini),
        "settings.json" if parent == Some(".vscode") => Some(Kind::VsCode),
        "settings.json" if parent == Some("user") => parts
            .len()
            .checked_sub(3)
            .and_then(|index| parts.get(index))
            .filter(|flavor| {
                matches!(
                    flavor.as_str(),
                    "code" | "code - insiders" | "vscode" | "vscodium"
                )
            })
            .map(|_| Kind::VsCode),
        "config.json" if parent == Some(".continue") => Some(Kind::ContinueLegacy),
        _ => None,
    }
}

fn parsed_object(content: &str) -> Option<Map<String, Value>> {
    let parse = |text: &str| {
        serde_json::from_str::<Value>(text)
            .ok()?
            .as_object()
            .cloned()
    };
    if let Some(object) = parse(content) {
        return Some(object);
    }
    parse(&strip_trailing_commas(&strip_json_comments(content)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn warnings_for(name: &str, content: &str) -> Vec<AdviceWarning> {
        warnings(&PathBuf::from(name), content)
    }

    #[test]
    fn classifies_known_schemas() {
        let cases = [
            (r"C:\Users\me\.mcp.json", "mcp"),
            (
                r"C:\Users\me\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json",
                "mcp",
            ),
            (r"C:\Users\me\.claude\settings.json", "claude"),
            (r"C:\Users\me\.claude\settings.local.json", "claude"),
            (r"C:\Users\me\.gemini\settings.json", "gemini"),
            (r"C:\Users\me\.config\opencode\opencode.jsonc", "opencode"),
            (
                r"C:\Users\me\AppData\Roaming\Code\User\settings.json",
                "vscode",
            ),
            (
                r"C:\Users\me\AppData\Roaming\Code - Insiders\User\settings.json",
                "vscode",
            ),
            (
                r"C:\Users\me\AppData\Roaming\VSCodium\User\settings.json",
                "vscode",
            ),
            (r"C:\project\.vscode\settings.json", "vscode"),
        ];
        for (path, expected) in cases {
            let schema = schema_for(&PathBuf::from(path)).unwrap_or_else(|| panic!("{path}"));
            assert_eq!(schema.id, expected, "{path}");
        }
        assert!(schema_for(Path::new(r"C:\Users\me\.continue\config.json")).is_none());
        assert!(schema_for(Path::new(r"C:\Users\me\custom.json")).is_none());
        assert!(
            schema_for(Path::new(
                r"C:\Users\me\AppData\Roaming\Other\User\settings.json"
            ))
            .is_none()
        );
    }

    #[test]
    fn suggestions_are_unique_per_scope() {
        for path in [
            r"C:\Users\me\.mcp.json",
            r"C:\Users\me\.claude\settings.json",
            r"C:\Users\me\.gemini\settings.json",
            r"C:\Users\me\.config\opencode\opencode.json",
            r"C:\Users\me\AppData\Roaming\Code\User\settings.json",
        ] {
            let schema = schema_for(&PathBuf::from(path)).unwrap();
            let mut seen = std::collections::HashSet::new();
            for key in &schema.keys {
                assert!(matches!(key.scope, "root" | "server"));
                assert!(seen.insert((key.name, key.scope)), "{}", key.name);
                assert!(!key.detail.is_empty());
            }
        }
        let mcp = schema_for(Path::new(r"C:\Users\me\.mcp.json")).unwrap();
        assert!(
            mcp.keys
                .iter()
                .any(|key| key.scope == "server" && key.name == "command")
        );
        assert!(
            mcp.keys
                .iter()
                .any(|key| key.scope == "root" && key.name == "mcpServers")
        );
    }

    #[test]
    fn warns_on_deprecated_claude_setting() {
        let warnings = warnings_for(
            r"C:\Users\me\.claude\settings.json",
            r#"{"includeCoAuthoredBy": false, "model": "opus"}"#,
        );
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].key, Some("includeCoAuthoredBy"));
        assert!(
            warnings_for(r"C:\Users\me\.claude\settings.json", r#"{"model": "opus"}"#).is_empty()
        );
        assert!(
            warnings_for(
                r"C:\Users\me\.claude\settings.json",
                r#"{"includeCoAuthoredBy": }"#
            )
            .is_empty()
        );
    }

    #[test]
    fn warns_on_deprecated_vscode_terminal_settings() {
        let warnings = warnings_for(
            r"C:\Users\me\AppData\Roaming\Code\User\settings.json",
            "{\n  // old terminal setup\n  \"terminal.integrated.shell.windows\": \"cmd.exe\",\n  \"terminal.integrated.shellArgs.windows\": [],\n}\n",
        );
        assert_eq!(warnings.len(), 2);
        assert_eq!(
            warnings
                .iter()
                .map(|warning| warning.key.unwrap())
                .collect::<Vec<_>>(),
            [
                "terminal.integrated.shell.windows",
                "terminal.integrated.shellArgs.windows"
            ]
        );
    }

    #[test]
    fn warns_on_legacy_continue_config() {
        let name = r"C:\Users\me\.continue\config.json";
        let warnings = warnings_for(name, "{\"models\": []}");
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].key, None);
        assert!(warnings_for(name, "{").is_empty());
    }

    #[test]
    fn leaves_other_json_files_alone() {
        assert!(
            warnings_for(
                r"C:\Users\me\package.json",
                r#"{"includeCoAuthoredBy": false}"#
            )
            .is_empty()
        );
        assert!(
            warnings_for(
                r"C:\Users\me\.gemini\settings.json",
                r#"{"includeCoAuthoredBy": false}"#
            )
            .is_empty()
        );
    }
}
