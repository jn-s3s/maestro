mod support;

use std::sync::Arc;

use maestro_core::{
    detection::{detect_tools, detect_tools_with_workspaces},
    files::{FileStore, Registry},
    search::{MAX_HITS_PER_FILE, search_files, search_files_excluding},
    settings::Workspace,
    watch::SelfWriteRegistry,
};
use support::{Synthetic, custom};

#[test]
fn finds_lines_in_registered_files_with_line_numbers() {
    let synthetic = Synthetic::new();
    synthetic.write(".claude/settings.json", "{\n  \"model\": \"Sonnet\"\n}\n");
    let store = synthetic.store(&[]);

    let hits = search_files(&store, "sonnet", 10);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].label, "settings.json");
    assert_eq!(hits[0].line, 2);
    assert_eq!(hits[0].preview, "\"model\": \"Sonnet\"");
}

#[test]
fn excludes_secret_and_dotenv_files() {
    let synthetic = Synthetic::new();
    synthetic.write(".claude/settings.json", "needle in settings");
    synthetic.write(".claude.json", "needle in session tokens");
    synthetic.write(".env", "needle in env");
    let store = synthetic.store(&[]);

    let hits = search_files(&store, "needle", 20);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].label, "settings.json");
}

#[test]
fn excludes_mcp_credentials_from_custom_file_search() {
    let synthetic = Synthetic::new();
    let config = synthetic.write_at(
        &synthetic.root().join("project/.mcp.json"),
        "{\"token\":\"needle-secret\"}",
    );
    let store = synthetic.store(&[custom("custom-mcp", &config)]);

    assert!(search_files(&store, "needle", 10).is_empty());
}

#[test]
fn excludes_extension_mcp_credentials_from_search() {
    let synthetic = Synthetic::new();
    let config = synthetic
        .appdata()
        .join("Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
    synthetic.write_at(&config, "{\"token\":\"needle-secret\"}");
    let store = FileStore::new(
        Registry::new(detect_tools(&synthetic.env(), &[])),
        synthetic.history(),
        Arc::new(SelfWriteRegistry::new()),
    );

    assert!(search_files(&store, "needle", 10).is_empty());
}

#[test]
fn excludes_secret_file_when_another_registration_is_not_flagged() {
    let synthetic = Synthetic::new();
    let project = synthetic.root().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let secret = project.join(".mcp.json");
    std::fs::write(&secret, "needle in an api token").unwrap();
    let custom_tools = detect_tools(&synthetic.env(), &[custom("custom-mcp", &secret)]);
    let workspace = Workspace {
        id: "workspace-mcp".into(),
        name: "Project".into(),
        path: project,
    };
    let workspace_tool = detect_tools_with_workspaces(&synthetic.env(), &[], &[workspace])
        .into_iter()
        .find(|tool| tool.id == "workspace-mcp")
        .unwrap();
    let custom_file = custom_tools
        .iter()
        .flat_map(|tool| &tool.files)
        .find(|file| file.path == secret)
        .unwrap();
    assert!(!custom_file.secret);
    let mut tools = custom_tools;
    tools.push(workspace_tool);
    let store = FileStore::new(
        Registry::new(tools),
        synthetic.history(),
        Arc::new(SelfWriteRegistry::new()),
    );

    assert!(search_files(&store, "needle", 10).is_empty());
}

#[test]
fn skips_missing_files_and_short_queries() {
    let synthetic = Synthetic::new();
    synthetic.write(".gemini/settings.json", "present");
    // Claude Code settings.json is registered but not created.
    let store = synthetic.store(&[]);

    assert!(search_files(&store, "p", 20).is_empty());
    let hits = search_files(&store, "  p  ", 20);
    assert!(hits.is_empty(), "a single letter is not searched");
    assert_eq!(search_files(&store, "present", 20).len(), 1);
}

#[test]
fn caps_hits_per_file_and_in_total() {
    let synthetic = Synthetic::new();
    let content = (0..20)
        .map(|index| format!("match line {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    synthetic.write(".claude/settings.json", &content);
    synthetic.write(".gemini/settings.json", &content);
    let store = synthetic.store(&[]);

    let hits = search_files(&store, "match", 100);
    assert_eq!(hits.len(), MAX_HITS_PER_FILE * 2);
    assert_eq!(hits[0].line, 1);
    assert_eq!(hits[MAX_HITS_PER_FILE - 1].line, MAX_HITS_PER_FILE as u32);

    let limited = search_files(&store, "match", 3);
    assert_eq!(limited.len(), 3);
}

#[test]
fn excludes_paths_before_applying_result_limit() {
    let synthetic = Synthetic::new();
    synthetic.write(".claude/settings.json", "needle hidden");
    synthetic.write(".gemini/settings.json", "needle visible");
    let store = synthetic.store(&[]);
    let hidden = store
        .registry()
        .tools()
        .iter()
        .find(|tool| tool.id == "claude-code")
        .unwrap()
        .files[0]
        .path
        .clone();
    let excluded = std::collections::HashSet::from([maestro_core::paths::path_key(
        &maestro_core::paths::canonical_or_lexical(&hidden),
    )]);

    let hits = search_files_excluding(&store, "needle", 1, &excluded);
    assert_eq!(hits.len(), 1);
    assert!(hits[0].preview.contains("visible"));
}

#[test]
fn truncates_long_previews_and_control_characters() {
    let synthetic = Synthetic::new();
    let long_line = format!("needle{}", "x".repeat(400));
    synthetic.write(".claude/settings.json", &long_line);
    let store = synthetic.store(&[]);

    let hits = search_files(&store, "needle", 5);
    assert_eq!(hits.len(), 1);
    assert!(hits[0].preview.ends_with("..."));
    assert!(hits[0].preview.chars().count() <= 203);
}
