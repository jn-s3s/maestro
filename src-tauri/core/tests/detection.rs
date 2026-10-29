mod support;

use std::fs;

use maestro_core::detection::{
    FileLang, ToolGroup, detect_tools, detect_tools_with_workspaces, find_containing_folder,
    is_secret_path, is_within_registered, registered_paths,
};
use maestro_core::settings::Workspace;
use support::{Synthetic, custom};

#[test]
fn detects_tools_from_a_synthetic_home() {
    let synthetic = Synthetic::new();
    synthetic.write(".claude/settings.json", "{}");
    synthetic.write(".claude.json", "{}");
    synthetic.write(".codex/config.toml", "");
    synthetic.write(".codex/auth.json", "{}");
    synthetic.write(".gemini/settings.json", "{}");
    synthetic.write(".aider.conf.yml", "");
    synthetic.write(".env", "OPENAI_API_KEY=synthetic");
    synthetic.write(".continue/config.yaml", "");
    synthetic.write(".cline/data/sessions/session.json", "{}");
    synthetic.write_at(&synthetic.appdata().join("Code/User/settings.json"), "{}");
    synthetic.write_at(
        &synthetic.appdata().join(
            "Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
        ),
        "{}",
    );
    synthetic.write_at(
        &synthetic
            .appdata()
            .join("Code - Insiders/User/settings.json"),
        "{}",
    );

    let tools = detect_tools(&synthetic.env(), &[]);
    let ids: Vec<&str> = tools.iter().map(|tool| tool.id.as_str()).collect();
    for expected in [
        "opencode",
        "aider",
        "claude-code",
        "gemini-cli",
        "codex",
        "qoder-cli",
        "cline-cli",
        "continue",
        "vscode-code",
        "vscode-insiders",
        "cline-code",
    ] {
        assert!(ids.contains(&expected), "missing tool {expected}");
    }
    for unexpected in ["vscode-vscodium", "cline-insiders", "roo-code-code"] {
        assert!(!ids.contains(&unexpected), "unexpected tool {unexpected}");
    }

    let claude = tools
        .iter()
        .find(|tool| tool.id == "claude-code")
        .expect("claude tool");
    assert_eq!(claude.group, ToolGroup::Cli);
    let settings = claude
        .files
        .iter()
        .find(|file| file.id == "claude-code/settings.json")
        .expect("claude settings");
    assert!(settings.exists);
    assert_eq!(settings.lang, FileLang::Json);
    let account = claude
        .files
        .iter()
        .find(|file| file.id == "claude-code/.claude.json")
        .expect("claude account state");
    assert!(account.secret);
    assert!(account.exists);

    assert_eq!(claude.folders[0].id, "claude-code/folder-root-config-0");
    assert_eq!(claude.folders[0].label, "Config");
    assert_eq!(
        claude.roots[0].path,
        synthetic.home().join(".claude"),
        "root path"
    );

    let extension = tools
        .iter()
        .find(|tool| tool.id == "cline-code")
        .expect("cline extension for VS Code");
    assert_eq!(extension.group, ToolGroup::Ext);
    assert!(
        extension.files[0]
            .path
            .ends_with("globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json")
    );

    let vscode = tools
        .iter()
        .find(|tool| tool.id == "vscode-code")
        .expect("VS Code");
    assert_eq!(
        vscode.files[0].path,
        synthetic.appdata().join("Code/User/settings.json")
    );
    assert!(vscode.files[0].exists);
}

#[test]
fn environment_overrides_replace_default_locations() {
    let synthetic = Synthetic::new();
    let mut env = synthetic.env();
    env.codex_home = Some(synthetic.root().join("codex-home"));
    env.qoder_config_dir = Some(synthetic.root().join("qoder-home"));
    env.cline_data_dir = Some(synthetic.root().join("cline-data"));
    env.xdg_config_home = Some(synthetic.root().join("xdg-config"));
    env.xdg_data_home = Some(synthetic.root().join("xdg-data"));
    fs::create_dir_all(env.codex_home.as_ref().unwrap()).unwrap();
    fs::create_dir_all(env.qoder_config_dir.as_ref().unwrap()).unwrap();
    fs::create_dir_all(env.cline_data_dir.as_ref().unwrap()).unwrap();
    fs::create_dir_all(env.xdg_config_home.as_ref().unwrap().join("opencode")).unwrap();
    fs::create_dir_all(env.xdg_data_home.as_ref().unwrap().join("opencode")).unwrap();

    let tools = detect_tools(&env, &[]);
    let codex = tools.iter().find(|tool| tool.id == "codex").unwrap();
    assert_eq!(codex.roots[0].path, synthetic.root().join("codex-home"));

    let qoder = tools.iter().find(|tool| tool.id == "qoder-cli").unwrap();
    assert_eq!(qoder.roots[0].path, synthetic.root().join("qoder-home"));

    let cline = tools.iter().find(|tool| tool.id == "cline-cli").unwrap();
    let sessions = cline
        .folders
        .iter()
        .find(|folder| folder.id == "cline-cli/folder-sessions")
        .expect("cline sessions folder");
    assert_eq!(
        sessions.path,
        synthetic.root().join("cline-data").join("sessions")
    );

    let opencode = tools.iter().find(|tool| tool.id == "opencode").unwrap();
    assert_eq!(
        opencode.roots[0].path,
        synthetic.root().join("xdg-config").join("opencode")
    );
    assert_eq!(
        opencode.roots[1].path,
        synthetic.root().join("xdg-data").join("opencode")
    );
}

#[test]
fn falls_back_to_china_qoder_and_user_local_opencode() {
    let synthetic = Synthetic::new();
    let china = synthetic.home().join(".qoder-cn");
    fs::create_dir_all(&china).unwrap();
    let local_data = synthetic.home().join(".local/share/opencode");
    fs::create_dir_all(&local_data).unwrap();

    let tools = detect_tools(&synthetic.env(), &[]);
    let qoder = tools.iter().find(|tool| tool.id == "qoder-cli").unwrap();
    assert_eq!(qoder.roots[0].path, china);
    let opencode = tools.iter().find(|tool| tool.id == "opencode").unwrap();
    assert_eq!(opencode.roots[1].path, local_data);
}

#[test]
fn custom_entries_register_files_and_folders() {
    let synthetic = Synthetic::new();
    let folder = synthetic.root().join("workspace-configs");
    fs::create_dir_all(&folder).unwrap();
    let file = synthetic.write_at(&synthetic.root().join("extra.jsonc"), "{}");
    let missing = synthetic.root().join("not-created-yet.json");

    let tools = detect_tools(
        &synthetic.env(),
        &[
            custom("custom-folder", &folder),
            custom("custom-file", &file),
            custom("custom-missing", &missing),
        ],
    );

    let folder_tool = tools
        .iter()
        .find(|tool| tool.id == "custom-folder")
        .expect("custom folder tool");
    assert_eq!(folder_tool.group, ToolGroup::Custom);
    assert_eq!(folder_tool.folders.len(), 1);
    assert_eq!(folder_tool.folders[0].label, "Files");

    let file_tool = tools.iter().find(|tool| tool.id == "custom-file").unwrap();
    assert_eq!(file_tool.files[0].lang, FileLang::Jsonc);
    assert!(file_tool.files[0].exists);

    let missing_tool = tools
        .iter()
        .find(|tool| tool.id == "custom-missing")
        .expect("custom missing tool");
    assert!(!missing_tool.files[0].exists);

    let registered = registered_paths(&tools);
    assert!(registered.contains(&maestro_core::paths::path_key(
        &maestro_core::paths::canonical_or_lexical(&file)
    )));
}

#[test]
fn lookups_are_case_insensitive_on_windows() {
    let synthetic = Synthetic::new();
    let settings = synthetic.write(".claude/settings.json", "{}");
    let secrets = synthetic.write(".claude.json", "{}");
    let tools = detect_tools(&synthetic.env(), &[]);

    #[cfg(windows)]
    {
        let upper = std::path::PathBuf::from(settings.to_string_lossy().to_uppercase());
        assert!(is_within_registered(&tools, &upper));
        let upper_secret = std::path::PathBuf::from(secrets.to_string_lossy().to_uppercase());
        assert!(is_secret_path(&tools, &upper_secret));
    }
    #[cfg(not(windows))]
    {
        assert!(is_within_registered(&tools, &settings));
        assert!(is_secret_path(&tools, &secrets));
    }
}

#[test]
fn finds_the_deepest_registered_folder() {
    let synthetic = Synthetic::new();
    let nested = synthetic.write(".claude/skills/example/SKILL.md", "# skill");
    let outside = synthetic.root().join("unregistered.txt");
    let tools = detect_tools(&synthetic.env(), &[]);

    let folder = find_containing_folder(&tools, &nested).expect("containing folder");
    assert_eq!(folder.id, "claude-code/folder-skills");
    assert!(find_containing_folder(&tools, &outside).is_none());
}

#[test]
fn detects_project_configs_inside_a_workspace() {
    let synthetic = Synthetic::new();
    let project = synthetic.root().join("project");
    fs::create_dir_all(project.join(".claude")).unwrap();
    fs::create_dir_all(project.join(".vscode")).unwrap();
    fs::write(project.join(".claude/settings.json"), "{}").unwrap();
    fs::write(project.join(".vscode/settings.json"), "{}").unwrap();
    fs::write(project.join(".mcp.json"), "{}").unwrap();
    fs::write(project.join("AGENTS.md"), "# Agents").unwrap();
    fs::write(project.join("notes.txt"), "not registered").unwrap();
    let workspace = Workspace {
        id: "workspace-1".into(),
        name: "Example project".into(),
        path: project.clone(),
    };

    let tools = detect_tools_with_workspaces(&synthetic.env(), &[], &[workspace]);
    let tool = tools
        .iter()
        .find(|tool| tool.id == "workspace-1")
        .expect("workspace tool");
    assert_eq!(tool.group, ToolGroup::Workspace);
    assert_eq!(tool.name, "Example project");
    let labels: Vec<&str> = tool.files.iter().map(|file| file.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "AGENTS.md",
            ".mcp.json",
            "Claude settings.json",
            "VS Code settings.json"
        ]
    );
    assert!(tool.files.iter().all(|file| file.exists));
    assert_eq!(
        tool.files.iter().filter(|file| file.secret).count(),
        1,
        "project MCP servers can carry credentials"
    );
    assert!(
        tool.files
            .iter()
            .any(|file| file.label == ".mcp.json" && file.secret)
    );
    assert!(
        tool.files
            .iter()
            .all(|file| file.section.as_deref() == Some("Workspace"))
    );
    assert!(
        tool.files
            .iter()
            .find(|file| file.label == "Claude settings.json")
            .and_then(|file| file.note.as_deref())
            .unwrap_or_default()
            .contains("precedence")
    );
    assert!(registered_paths(&tools).contains(&maestro_core::paths::path_key(
        &maestro_core::paths::canonical_or_lexical(&project.join(".claude/settings.json"))
    )));
}

#[test]
fn workspace_without_project_configs_stays_visible() {
    let synthetic = Synthetic::new();
    let project = synthetic.root().join("empty-project");
    fs::create_dir_all(&project).unwrap();
    let workspace = Workspace {
        id: "workspace-empty".into(),
        name: "Empty".into(),
        path: project,
    };
    let tools = detect_tools_with_workspaces(&synthetic.env(), &[], &[workspace]);
    let tool = tools
        .iter()
        .find(|tool| tool.id == "workspace-empty")
        .expect("workspace tool");
    assert!(tool.files.is_empty());
}

#[cfg(unix)]
#[test]
fn workspace_detection_skips_symlinked_configs() {
    use std::os::unix::fs::symlink;

    let synthetic = Synthetic::new();
    let project = synthetic.root().join("project");
    fs::create_dir_all(&project).unwrap();
    let outside = synthetic.write("outside.md", "# outside");
    symlink(&outside, project.join("AGENTS.md")).unwrap();
    let workspace = Workspace {
        id: "workspace-link".into(),
        name: "Linked".into(),
        path: project,
    };
    let tools = detect_tools_with_workspaces(&synthetic.env(), &[], &[workspace]);
    let tool = tools.iter().find(|tool| tool.id == "workspace-link").unwrap();
    assert!(tool.files.is_empty());
}

#[cfg(unix)]
#[test]
fn workspace_detection_skips_configs_through_symlinked_parent_directories() {
    use std::os::unix::fs::symlink;

    let synthetic = Synthetic::new();
    let project = synthetic.root().join("project");
    let outside = synthetic.root().join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("settings.json"), "{}").unwrap();
    symlink(&outside, project.join(".claude")).unwrap();
    let workspace = Workspace {
        id: "workspace-parent-link".into(),
        name: "Linked parent".into(),
        path: project,
    };

    let tools = detect_tools_with_workspaces(&synthetic.env(), &[], &[workspace]);
    let tool = tools
        .iter()
        .find(|tool| tool.id == "workspace-parent-link")
        .unwrap();
    assert!(tool.files.is_empty());
}
