//! Detection of AI tool configuration files and folders.
//!
//! Detection reads an injectable [`DetectionEnv`] instead of process globals so
//! every rule can run against a synthetic home directory.

use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::{
    paths::{
        canonical_or_lexical, canonicalize, component_count, is_within, lexical_normalize,
        metadata_is_link, path_key,
    },
    settings::Workspace,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolGroup {
    Workspace,
    Cli,
    Editor,
    Ext,
    Custom,
}

/// Discovery state of a registered file. A path can exist on disk yet still be
/// unusable because it is unreadable, a link, a folder or larger than the
/// editor limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Available,
    Missing,
    Unreadable,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileLang {
    Json,
    Jsonc,
    Yaml,
    Toml,
    Markdown,
    Dotenv,
    Javascript,
    Typescript,
    Python,
    Shell,
    Text,
}

/// Infers the editor language from a file path.
///
/// @param path - The file path to inspect.
/// @returns The inferred language, defaulting to plain text.
pub fn lang_from_path(path: &Path) -> FileLang {
    let base = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if base.starts_with(".env") {
        return FileLang::Dotenv;
    }
    let extension = base
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("");
    match extension {
        "json" => FileLang::Json,
        "jsonc" => FileLang::Jsonc,
        "yml" | "yaml" => FileLang::Yaml,
        "toml" => FileLang::Toml,
        "md" | "markdown" => FileLang::Markdown,
        "js" | "jsx" | "mjs" | "cjs" => FileLang::Javascript,
        "ts" | "tsx" | "mts" | "cts" => FileLang::Typescript,
        "py" => FileLang::Python,
        "sh" | "bash" | "zsh" | "fish" => FileLang::Shell,
        _ => FileLang::Text,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolRoot {
    pub path: PathBuf,
    pub section: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolFile {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub exists: bool,
    pub state: FileState,
    pub lang: FileLang,
    pub secret: bool,
    pub note: Option<String>,
    pub section: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolFolder {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub exists: bool,
    pub section: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub group: ToolGroup,
    pub subtitle: Option<String>,
    pub roots: Vec<ToolRoot>,
    pub files: Vec<ToolFile>,
    pub folders: Vec<ToolFolder>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomEntry {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

/// Filesystem roots used by detection. Tests build this against a temporary
/// tree; the desktop app builds it from the process environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectionEnv {
    pub home: PathBuf,
    pub appdata: PathBuf,
    pub local_appdata: PathBuf,
    pub xdg_data_home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    pub qoder_config_dir: Option<PathBuf>,
    pub cline_data_dir: Option<PathBuf>,
}

impl DetectionEnv {
    /// Builds the detection environment from the current process variables.
    ///
    /// @returns The environment used for real tool detection.
    pub fn from_process() -> Self {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_default();
        Self {
            appdata: env_path("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming")),
            local_appdata: env_path("LOCALAPPDATA")
                .unwrap_or_else(|| home.join("AppData").join("Local")),
            xdg_data_home: env_path("XDG_DATA_HOME"),
            xdg_config_home: env_path("XDG_CONFIG_HOME"),
            codex_home: env_path("CODEX_HOME"),
            qoder_config_dir: env_path("QODER_CONFIG_DIR"),
            cline_data_dir: env_path("CLINE_DATA_DIR"),
            home,
        }
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    let value = std::env::var_os(name)?;
    let text = value.to_string_lossy();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(lexical_normalize(Path::new(trimmed)))
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|candidate| candidate.exists())
        .cloned()
}

fn xdg_data_home(env: &DetectionEnv) -> PathBuf {
    env.xdg_data_home
        .clone()
        .unwrap_or_else(|| env.local_appdata.clone())
}

fn xdg_config_home(env: &DetectionEnv) -> PathBuf {
    env.xdg_config_home
        .clone()
        .unwrap_or_else(|| env.appdata.clone())
}

fn opencode_data_dir(env: &DetectionEnv) -> PathBuf {
    let candidates = [
        xdg_data_home(env).join("opencode"),
        env.home.join(".local").join("share").join("opencode"),
    ];
    first_existing(&candidates).unwrap_or_else(|| candidates[0].clone())
}

fn codex_home(env: &DetectionEnv) -> PathBuf {
    env.codex_home
        .clone()
        .unwrap_or_else(|| env.home.join(".codex"))
}

fn qoder_dir(env: &DetectionEnv) -> PathBuf {
    if let Some(override_dir) = &env.qoder_config_dir {
        return override_dir.clone();
    }
    let candidates = [env.home.join(".qoder"), env.home.join(".qoder-cn")];
    first_existing(&candidates).unwrap_or_else(|| candidates[0].clone())
}

fn cline_root_dir(env: &DetectionEnv) -> PathBuf {
    env.home.join(".cline")
}

fn cline_data_dir(env: &DetectionEnv) -> PathBuf {
    env.cline_data_dir
        .clone()
        .unwrap_or_else(|| cline_root_dir(env).join("data"))
}

fn cline_sessions_dir(env: &DetectionEnv) -> PathBuf {
    cline_data_dir(env).join("sessions")
}

fn make_file(id: &str, label: &str, path: PathBuf, section: &str) -> ToolFile {
    let state = discovery_state(&path);
    ToolFile {
        id: id.to_owned(),
        label: label.to_owned(),
        exists: state != FileState::Missing,
        state,
        lang: lang_from_path(&path),
        path,
        secret: false,
        note: None,
        section: Some(section.to_owned()),
    }
}

/// Classifies a registered file for display and opening decisions.
///
/// @param path - Absolute config file path.
/// @returns The discovery state. Missing paths are distinguished from paths
/// that exist but cannot be read or opened by the editor.
fn discovery_state(path: &Path) -> FileState {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => return state_from_error(&error),
    };
    if metadata_is_link(&metadata) || !metadata.file_type().is_file() {
        return FileState::Unsupported;
    }
    if metadata.len() > crate::MAX_FILE_BYTES {
        return FileState::Unsupported;
    }
    match fs::File::open(path) {
        Ok(_) => FileState::Available,
        Err(error) => state_from_error(&error),
    }
}

fn state_from_error(error: &io::Error) -> FileState {
    if error.kind() == io::ErrorKind::NotFound {
        FileState::Missing
    } else {
        FileState::Unreadable
    }
}

fn make_folder(id: &str, label: &str, path: PathBuf, section: &str) -> ToolFolder {
    ToolFolder {
        id: id.to_owned(),
        label: label.to_owned(),
        exists: path.exists(),
        path,
        section: Some(section.to_owned()),
    }
}

impl ToolFile {
    fn with_note(mut self, note: &str) -> Self {
        self.note = Some(note.to_owned());
        self
    }

    fn with_secret(mut self, note: Option<&str>) -> Self {
        self.secret = true;
        self.note = note.map(str::to_owned);
        self
    }
}

fn slug(value: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if pending && !out.is_empty() {
                out.push('-');
            }
            pending = false;
            out.push(character.to_ascii_lowercase());
        } else {
            pending = true;
        }
    }
    if out.is_empty() {
        "root".to_owned()
    } else {
        out
    }
}

fn join_slash_path(base: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

/// Builds the registry of known AI tool configs and extension folders.
///
/// @param env - Filesystem roots used for detection.
/// @param custom - User-registered custom files and folders.
/// @returns The detected tools in display order, without workspaces.
pub fn detect_tools(env: &DetectionEnv, custom: &[CustomEntry]) -> Vec<Tool> {
    detect_tools_with_workspaces(env, custom, &[])
}

/// Builds the registry of known AI tool configs, custom entries and
/// project-local workspace configs.
///
/// @param env - Filesystem roots used for detection.
/// @param custom - User-registered custom files and folders.
/// @param workspaces - Registered project folders, scanned for local configs.
/// @returns The detected tools in display order.
pub fn detect_tools_with_workspaces(
    env: &DetectionEnv,
    custom: &[CustomEntry],
    workspaces: &[Workspace],
) -> Vec<Tool> {
    let mut tools = Vec::new();
    let home = &env.home;

    let opencode_dir = first_existing(&[
        xdg_config_home(env).join("opencode"),
        home.join(".config").join("opencode"),
    ])
    .unwrap_or_else(|| xdg_config_home(env).join("opencode"));
    let opencode_local = opencode_data_dir(env);
    tools.push(Tool {
        id: "opencode".into(),
        name: "OpenCode".into(),
        group: ToolGroup::Cli,
        subtitle: Some(r"~\.config\opencode".into()),
        roots: vec![
            ToolRoot {
                path: opencode_dir.clone(),
                section: "Config".into(),
                label: None,
            },
            ToolRoot {
                path: opencode_local.clone(),
                section: "Data".into(),
                label: None,
            },
        ],
        files: vec![
            make_file(
                "opencode/opencode.json",
                "opencode.json",
                opencode_dir.join("opencode.json"),
                "Config",
            ),
            make_file(
                "opencode/opencode.jsonc",
                "opencode.jsonc",
                opencode_dir.join("opencode.jsonc"),
                "Config",
            )
            .with_note("OpenCode prefers opencode.jsonc over opencode.json when both exist."),
            make_file(
                "opencode/auth.json",
                "auth.json",
                opencode_local.join("auth.json"),
                "Data",
            )
            .with_secret(Some("OAuth/session tokens.")),
        ],
        folders: vec![
            make_folder(
                "opencode/folder-command",
                "commands",
                opencode_dir.join("command"),
                "Config",
            ),
            make_folder(
                "opencode/folder-agents",
                "agents",
                opencode_dir.join("agents"),
                "Config",
            ),
            make_folder(
                "opencode/folder-plugins",
                "plugins",
                opencode_dir.join("plugins"),
                "Config",
            ),
            make_folder(
                "opencode/folder-storage",
                "storage",
                opencode_local.join("storage"),
                "Data",
            ),
        ],
    });

    tools.push(Tool {
        id: "aider".into(),
        name: "Aider".into(),
        group: ToolGroup::Cli,
        subtitle: Some("~".into()),
        roots: Vec::new(),
        files: vec![
            make_file(
                "aider/.aider.conf.yml",
                ".aider.conf.yml",
                home.join(".aider.conf.yml"),
                "Config",
            ),
            make_file("aider/.env", ".env", home.join(".env"), "Config").with_secret(Some(
                r"Aider reads API keys from %USERPROFILE%\.env (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY).",
            )),
        ],
        folders: Vec::new(),
    });

    let claude_dir = home.join(".claude");
    tools.push(Tool {
        id: "claude-code".into(),
        name: "Claude Code".into(),
        group: ToolGroup::Cli,
        subtitle: Some(r"~\.claude".into()),
        roots: vec![ToolRoot {
            path: claude_dir.clone(),
            section: "Config".into(),
            label: None,
        }],
        files: vec![
            make_file(
                "claude-code/settings.json",
                "settings.json",
                claude_dir.join("settings.json"),
                "Config",
            ),
            make_file(
                "claude-code/.claude.json",
                ".claude.json",
                home.join(".claude.json"),
                "Config",
            )
            .with_secret(Some("Contains account/session state and OAuth tokens.")),
        ],
        folders: vec![
            make_folder(
                "claude-code/folder-commands",
                "commands",
                claude_dir.join("commands"),
                "Config",
            ),
            make_folder(
                "claude-code/folder-agents",
                "agents",
                claude_dir.join("agents"),
                "Config",
            ),
            make_folder(
                "claude-code/folder-skills",
                "skills",
                claude_dir.join("skills"),
                "Config",
            ),
        ],
    });

    let gemini_dir = home.join(".gemini");
    tools.push(Tool {
        id: "gemini-cli".into(),
        name: "Gemini CLI".into(),
        group: ToolGroup::Cli,
        subtitle: Some(r"~\.gemini".into()),
        roots: vec![ToolRoot {
            path: gemini_dir.clone(),
            section: "Config".into(),
            label: None,
        }],
        files: vec![
            make_file(
                "gemini-cli/settings.json",
                "settings.json",
                gemini_dir.join("settings.json"),
                "Config",
            ),
            make_file(
                "gemini-cli/GEMINI.md",
                "GEMINI.md",
                gemini_dir.join("GEMINI.md"),
                "Config",
            ),
            make_file("gemini-cli/.env", ".env", gemini_dir.join(".env"), "Config")
                .with_secret(None),
        ],
        folders: vec![
            make_folder(
                "gemini-cli/folder-commands",
                "commands",
                gemini_dir.join("commands"),
                "Config",
            ),
            make_folder(
                "gemini-cli/folder-extensions",
                "extensions",
                gemini_dir.join("extensions"),
                "Config",
            ),
        ],
    });

    let codex_root = codex_home(env);
    tools.push(Tool {
        id: "codex".into(),
        name: "Codex CLI".into(),
        group: ToolGroup::Cli,
        subtitle: Some(r"~\.codex".into()),
        roots: vec![ToolRoot {
            path: codex_root.clone(),
            section: "Config".into(),
            label: None,
        }],
        files: vec![
            make_file(
                "codex/config.toml",
                "config.toml",
                codex_root.join("config.toml"),
                "Config",
            ),
            make_file(
                "codex/auth.json",
                "auth.json",
                codex_root.join("auth.json"),
                "Config",
            )
            .with_secret(Some("Contains auth tokens.")),
            make_file(
                "codex/.credentials.json",
                ".credentials.json",
                codex_root.join(".credentials.json"),
                "Config",
            )
            .with_secret(None),
        ],
        folders: vec![
            make_folder(
                "codex/folder-prompts",
                "prompts",
                codex_root.join("prompts"),
                "Config",
            ),
            make_folder(
                "codex/folder-skills",
                "skills",
                codex_root.join("skills"),
                "Config",
            ),
        ],
    });

    let qoder_root = qoder_dir(env);
    tools.push(Tool {
        id: "qoder-cli".into(),
        name: "Qoder CLI".into(),
        group: ToolGroup::Cli,
        subtitle: Some(r"~\.qoder".into()),
        roots: vec![ToolRoot {
            path: qoder_root.clone(),
            section: "Config".into(),
            label: None,
        }],
        files: vec![make_file(
            "qoder-cli/settings.json",
            "settings.json",
            qoder_root.join("settings.json"),
            "Config",
        )],
        folders: vec![
            make_folder(
                "qoder-cli/folder-agents",
                "agents",
                qoder_root.join("agents"),
                "Config",
            ),
            make_folder(
                "qoder-cli/folder-skills",
                "skills",
                qoder_root.join("skills"),
                "Config",
            ),
            make_folder(
                "qoder-cli/folder-hooks",
                "hooks",
                qoder_root.join("hooks"),
                "Config",
            ),
        ],
    });

    let cline_root = cline_root_dir(env);
    let cline_data = cline_data_dir(env);
    tools.push(Tool {
        id: "cline-cli".into(),
        name: "Cline CLI".into(),
        group: ToolGroup::Cli,
        subtitle: Some(r"~\.cline".into()),
        roots: vec![
            ToolRoot {
                path: cline_root,
                section: "Config".into(),
                label: None,
            },
            ToolRoot {
                path: cline_data,
                section: "Data".into(),
                label: None,
            },
        ],
        files: Vec::new(),
        folders: vec![make_folder(
            "cline-cli/folder-sessions",
            "sessions",
            cline_sessions_dir(env),
            "Data",
        )],
    });

    tools.push(Tool {
        id: "continue".into(),
        name: "Continue".into(),
        group: ToolGroup::Ext,
        subtitle: Some(r"~\.continue".into()),
        roots: vec![ToolRoot {
            path: home.join(".continue"),
            section: "Config".into(),
            label: None,
        }],
        files: vec![
            make_file(
                "continue/config.yaml",
                "config.yaml",
                home.join(".continue").join("config.yaml"),
                "Config",
            ),
            make_file(
                "continue/config.json",
                "config.json (legacy)",
                home.join(".continue").join("config.json"),
                "Config",
            ),
        ],
        folders: Vec::new(),
    });

    let flavors: Vec<(&str, &str, &str)> = [
        ("code", "VS Code", "Code"),
        ("insiders", "VS Code Insiders", "Code - Insiders"),
        ("vscodium", "VSCodium", "VSCodium"),
    ]
    .into_iter()
    .filter(|(_, _, dir_name)| env.appdata.join(dir_name).join("User").exists())
    .collect();

    for (flavor_id, flavor_name, dir_name) in &flavors {
        let user_dir = env.appdata.join(dir_name).join("User");
        tools.push(Tool {
            id: format!("vscode-{flavor_id}"),
            name: (*flavor_name).into(),
            group: ToolGroup::Editor,
            subtitle: Some(format!(r"%APPDATA%\{dir_name}\User")),
            roots: vec![ToolRoot {
                path: user_dir.clone(),
                section: "Config".into(),
                label: None,
            }],
            files: vec![make_file(
                &format!("vscode-{flavor_id}/settings.json"),
                "settings.json",
                user_dir.join("settings.json"),
                "Config",
            )],
            folders: Vec::new(),
        });
    }

    const RELOAD_NOTE: &str = "Reload the editor window after saving for changes to take effect.";
    const EXTENSIONS: [(&str, &str, &str, &str); 3] = [
        (
            "cline",
            "Cline",
            "saoudrizwan.claude-dev",
            "settings/cline_mcp_settings.json",
        ),
        (
            "roo-code",
            "Roo Code",
            "RooVeterinaryInc.roo-cline",
            "settings/mcp_settings.json",
        ),
        (
            "kilo-code",
            "Kilo Code",
            "kilocode.kilo-code",
            "settings/mcp_settings.json",
        ),
    ];

    for (flavor_id, flavor_name, dir_name) in &flavors {
        let global_storage = env
            .appdata
            .join(dir_name)
            .join("User")
            .join("globalStorage");
        for (extension_id, extension_name, extension_folder, extension_file) in EXTENSIONS {
            let extension_dir = global_storage.join(extension_folder);
            if !extension_dir.exists() {
                continue;
            }
            let file_name = Path::new(extension_file)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            tools.push(Tool {
                id: format!("{extension_id}-{flavor_id}"),
                name: extension_name.into(),
                group: ToolGroup::Ext,
                subtitle: Some(format!("{flavor_name} · {extension_folder}")),
                roots: vec![ToolRoot {
                    path: extension_dir.clone(),
                    section: "Config".into(),
                    label: None,
                }],
                files: vec![
                    make_file(
                        &format!("{extension_id}-{flavor_id}/{file_name}"),
                        &file_name,
                        join_slash_path(&extension_dir, extension_file),
                        "Config",
                    )
                    .with_note(RELOAD_NOTE)
                    .with_secret(Some("May contain MCP server credentials.")),
                ],
                folders: Vec::new(),
            });
        }
    }

    for workspace in workspaces {
        tools.push(workspace_tool(workspace));
    }

    for entry in custom {
        let is_dir = fs::metadata(&entry.path).is_ok_and(|metadata| metadata.is_dir());
        if is_dir {
            tools.push(Tool {
                id: entry.id.clone(),
                name: entry.name.clone(),
                group: ToolGroup::Custom,
                subtitle: Some(entry.path.to_string_lossy().into_owned()),
                roots: Vec::new(),
                files: Vec::new(),
                folders: vec![make_folder(
                    &format!("{}/folder", entry.id),
                    "Files",
                    entry.path.clone(),
                    "Config",
                )],
            });
        } else {
            let label = entry
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| entry.path.to_string_lossy().into_owned());
            tools.push(Tool {
                id: entry.id.clone(),
                name: entry.name.clone(),
                group: ToolGroup::Custom,
                subtitle: Some(entry.path.to_string_lossy().into_owned()),
                roots: Vec::new(),
                files: vec![make_file(
                    &format!("{}/file", entry.id),
                    &label,
                    entry.path.clone(),
                    "Config",
                )],
                folders: Vec::new(),
            });
        }
    }

    for tool in &mut tools {
        if tool.roots.is_empty() {
            continue;
        }
        let roots: Vec<ToolFolder> = tool
            .roots
            .iter()
            .enumerate()
            .map(|(index, root)| {
                make_folder(
                    &format!("{}/folder-root-{}-{index}", tool.id, slug(&root.section)),
                    root.label.as_deref().unwrap_or(&root.section),
                    root.path.clone(),
                    &root.section,
                )
            })
            .collect();
        tool.folders.splice(0..0, roots);
    }

    tools
}

/// Project-local config files detected inside a registered workspace. Only
/// known configuration locations are registered, so a workspace never exposes
/// arbitrary project files to the editor.
const WORKSPACE_RULES: [(&str, &str, &str, &str); 12] = [
    (
        "agents",
        "AGENTS.md",
        "AGENTS.md",
        "Shared agent instructions for this workspace.",
    ),
    (
        "claude-md",
        "CLAUDE.md",
        "CLAUDE.md",
        "Project instructions for Claude Code.",
    ),
    (
        "gemini-md",
        "GEMINI.md",
        "GEMINI.md",
        "Project instructions for Gemini CLI.",
    ),
    (
        "mcp",
        ".mcp.json",
        ".mcp.json",
        "Project-scoped MCP servers shared with compatible tools.",
    ),
    (
        "claude-settings",
        ".claude/settings.json",
        "Claude settings.json",
        "Project settings take precedence over the global Claude Code settings.",
    ),
    (
        "claude-local",
        ".claude/settings.local.json",
        "Claude settings.local.json",
        "Local project overrides, usually kept out of version control.",
    ),
    (
        "opencode-json",
        "opencode.json",
        "opencode.json",
        "Project config takes precedence over the global OpenCode config.",
    ),
    (
        "opencode-jsonc",
        "opencode.jsonc",
        "opencode.jsonc",
        "Project config takes precedence over the global OpenCode config.",
    ),
    (
        "gemini-settings",
        ".gemini/settings.json",
        "Gemini settings.json",
        "Project settings override the global Gemini CLI settings.",
    ),
    (
        "continue-config",
        ".continue/config.yaml",
        "Continue config.yaml",
        "Project config overrides the global Continue config.",
    ),
    (
        "vscode-settings",
        ".vscode/settings.json",
        "VS Code settings.json",
        "Workspace settings override user settings for this folder.",
    ),
    (
        "aider-config",
        ".aider.conf.yml",
        ".aider.conf.yml",
        "Aider reads the nearest project config before the home config.",
    ),
];

/// Builds a workspace tool from the project config files that exist.
///
/// Symbolic links are skipped so workspace detection cannot register a path
/// outside the project folder.
///
/// @param workspace - The registered workspace.
/// @returns The workspace tool, with only existing project config files.
fn workspace_tool(workspace: &Workspace) -> Tool {
    let files = WORKSPACE_RULES
        .iter()
        .filter_map(|(id, relative, label, note)| {
            let path = join_slash_path(&workspace.path, relative);
            let metadata = fs::symlink_metadata(&path).ok()?;
            if metadata_is_link(&metadata) || !metadata.file_type().is_file() {
                return None;
            }
            let workspace_root = canonicalize(&workspace.path).ok()?;
            let canonical_path = canonicalize(&path).ok()?;
            if !is_within(&canonical_path, &workspace_root) {
                return None;
            }
            let mut ancestor = path.parent();
            while let Some(parent) = ancestor {
                if parent == workspace.path {
                    break;
                }
                if fs::symlink_metadata(parent).is_ok_and(|metadata| metadata_is_link(&metadata)) {
                    return None;
                }
                ancestor = parent.parent();
            }
            let file = make_file(
                &format!("{}/{}", workspace.id, id),
                label,
                path,
                "Workspace",
            )
            .with_note(note);
            Some(if *id == "mcp" {
                file.with_secret(Some(note))
            } else {
                file
            })
        })
        .collect();
    Tool {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        group: ToolGroup::Workspace,
        subtitle: Some(workspace.path.to_string_lossy().into_owned()),
        roots: Vec::new(),
        files,
        folders: Vec::new(),
    }
}

fn registry_key(path: &Path) -> String {
    path_key(&canonical_or_lexical(path))
}

/// Collects every registered config file path, normalized for lookups.
///
/// @param tools - The detected tool list.
/// @returns A set of comparison keys.
pub fn registered_paths(tools: &[Tool]) -> HashSet<String> {
    tools
        .iter()
        .flat_map(|tool| tool.files.iter())
        .map(|file| registry_key(&file.path))
        .collect()
}

/// Collects every registered folder root, normalized for lookups.
///
/// @param tools - The detected tool list.
/// @returns A set of comparison keys.
pub fn registered_folder_roots(tools: &[Tool]) -> HashSet<String> {
    tools
        .iter()
        .flat_map(|tool| tool.folders.iter())
        .map(|folder| registry_key(&folder.path))
        .collect()
}

/// Finds the registered tool folder that most deeply contains a path.
///
/// @param tools - The detected tool list.
/// @param path - Absolute path to look up.
/// @returns The containing folder when found.
pub fn find_containing_folder<'a>(tools: &'a [Tool], path: &Path) -> Option<&'a ToolFolder> {
    let target = canonical_or_lexical(path);
    let target_key = path_key(&target);
    let mut best: Option<(&ToolFolder, usize)> = None;
    for folder in tools.iter().flat_map(|tool| tool.folders.iter()) {
        let root = canonical_or_lexical(&folder.path);
        if path_key(&root) == target_key || !is_within(&target, &root) {
            continue;
        }
        let depth = component_count(&root);
        if best.is_none_or(|(_, best_depth)| depth > best_depth) {
            best = Some((folder, depth));
        }
    }
    best.map(|(folder, _)| folder)
}

/// Reports whether a canonical path is registered as a secret-bearing file.
///
/// @param tools - The detected tool list.
/// @param path - Absolute path to look up.
/// @returns True when the exact file is flagged secret.
pub fn is_secret_path(tools: &[Tool], path: &Path) -> bool {
    let key = registry_key(path);
    tools
        .iter()
        .flat_map(|tool| tool.files.iter())
        .any(|file| file.secret && registry_key(&file.path) == key)
}

/// Reports whether a path is a registered file, a registered folder root, or
/// sits inside a registered folder.
///
/// @param tools - The detected tool list.
/// @param path - Absolute path to look up.
/// @returns True when the path is covered by a registered region.
pub fn is_within_registered(tools: &[Tool], path: &Path) -> bool {
    let key = registry_key(path);
    registered_paths(tools).contains(&key)
        || registered_folder_roots(tools).contains(&key)
        || find_containing_folder(tools, path).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_languages_from_paths() {
        let cases = [
            ("settings.json", FileLang::Json),
            ("settings.jsonc", FileLang::Jsonc),
            ("config.yaml", FileLang::Yaml),
            ("config.yml", FileLang::Yaml),
            ("config.toml", FileLang::Toml),
            ("README.md", FileLang::Markdown),
            ("GEMINI.md", FileLang::Markdown),
            (".env", FileLang::Dotenv),
            (".env.local", FileLang::Dotenv),
            ("index.mjs", FileLang::Javascript),
            ("app.tsx", FileLang::Typescript),
            ("script.fish", FileLang::Shell),
            ("notes.txt", FileLang::Text),
            ("Makefile", FileLang::Text),
        ];
        for (name, expected) in cases {
            assert_eq!(lang_from_path(Path::new(name)), expected, "{name}");
        }
    }

    #[test]
    fn slug_matches_legacy_shape() {
        assert_eq!(slug("Config"), "config");
        assert_eq!(slug("Data Files"), "data-files");
        assert_eq!(slug("!!!"), "root");
    }

    #[test]
    fn classifies_discovery_states() {
        let temp = tempfile::tempdir().unwrap();
        let available = temp.path().join("settings.json");
        fs::write(&available, "{}").unwrap();
        let folder = temp.path().join("folder.json");
        fs::create_dir(&folder).unwrap();
        let oversized = temp.path().join("large.json");
        fs::write(&oversized, vec![b'x'; crate::MAX_FILE_BYTES as usize + 1]).unwrap();

        assert_eq!(discovery_state(&available), FileState::Available);
        assert_eq!(
            discovery_state(&temp.path().join("missing.json")),
            FileState::Missing
        );
        assert_eq!(discovery_state(&folder), FileState::Unsupported);
        assert_eq!(discovery_state(&oversized), FileState::Unsupported);
        assert_eq!(
            state_from_error(&io::Error::from(io::ErrorKind::PermissionDenied)),
            FileState::Unreadable
        );
        assert_eq!(
            state_from_error(&io::Error::from(io::ErrorKind::NotFound)),
            FileState::Missing
        );

        let tool = Tool {
            id: "synthetic".into(),
            name: "Synthetic".into(),
            group: ToolGroup::Custom,
            subtitle: None,
            roots: Vec::new(),
            files: vec![make_file(
                "synthetic/file",
                "settings.json",
                available.clone(),
                "Config",
            )],
            folders: Vec::new(),
        };
        assert_eq!(tool.files[0].state, FileState::Available);
        assert!(tool.files[0].exists);
        let missing = make_file(
            "synthetic/missing",
            "missing.json",
            temp.path().join("missing.json"),
            "Config",
        );
        assert_eq!(missing.state, FileState::Missing);
        assert!(!missing.exists);
    }
}
