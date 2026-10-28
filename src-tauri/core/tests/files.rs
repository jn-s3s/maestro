mod support;

use std::{fs, sync::Arc};

use maestro_core::{
    detection::detect_tools,
    files::{FileError, FileStore, Registry, WriteRequest},
    history::HistoryStore,
    watch::SelfWriteRegistry,
};
use support::{Synthetic, custom, test_key};

#[test]
fn reads_missing_files_and_round_trips_new_content() {
    let synthetic = Synthetic::new();
    let file = synthetic.root().join("config.json");
    let store = synthetic.store(&[custom("custom-config", &file)]);

    let missing = store.read_file(&file).unwrap();
    assert!(!missing.exists);
    assert_eq!(missing.revision, None);
    assert_eq!(missing.content, "");
    assert_eq!(store.stat_file(&file).unwrap(), None);

    let written = store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"label\":\"café\"}\n",
                expected_revision: None,
            },
        )
        .unwrap();
    assert!(written.created);
    assert_eq!(written.revision.as_str().len(), 64);
    assert_eq!(written.backup, None);

    let loaded = store.read_file(&file).unwrap();
    assert!(loaded.exists);
    assert_eq!(loaded.content, "{\"label\":\"café\"}\n");
    assert_eq!(loaded.revision.as_ref(), Some(&written.revision));
    assert_eq!(loaded.size, loaded.content.len() as u64);

    let stat = store.stat_file(&file).unwrap().expect("stat");
    assert_eq!(stat.size, loaded.size);
    assert!(stat.mtime_ms > 0);
}

#[test]
fn rejects_stale_and_missing_expected_revisions() {
    let synthetic = Synthetic::new();
    let file = synthetic.write("config.json", "{\"version\":1}");
    let store = synthetic.store(&[custom("custom-config", &file)]);

    for expected in [None, Some("not-a-revision")] {
        let error = store
            .write_file(
                &file,
                WriteRequest {
                    content: "{\"version\":2}",
                    expected_revision: expected,
                },
            )
            .unwrap_err();
        assert!(matches!(error, FileError::Conflict), "{error}");
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "{\"version\":1}");

    let loaded = store.read_file(&file).unwrap();
    let current = loaded.revision.unwrap();
    let result = store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"version\":2}",
                expected_revision: Some(current.as_str()),
            },
        )
        .unwrap();
    assert!(!result.created);
    assert_eq!(fs::read_to_string(&file).unwrap(), "{\"version\":2}");
}

#[test]
fn expected_revision_for_a_deleted_file_is_a_conflict() {
    let synthetic = Synthetic::new();
    let file = synthetic.write("config.json", "{}");
    let store = synthetic.store(&[custom("custom-config", &file)]);
    let revision = store.read_file(&file).unwrap().revision.unwrap();
    fs::remove_file(&file).unwrap();

    let error = store
        .write_file(
            &file,
            WriteRequest {
                content: "{}",
                expected_revision: Some(revision.as_str()),
            },
        )
        .unwrap_err();
    assert!(matches!(error, FileError::Conflict));
    assert!(!file.exists());
}

#[test]
fn replacement_snapshots_the_previous_content_and_deduplicates() {
    let synthetic = Synthetic::new();
    let file = synthetic.write("config.json", "{\"version\":1}");
    let store = synthetic.store(&[custom("custom-config", &file)]);
    let history = synthetic.history();

    let loaded = store.read_file(&file).unwrap();
    let first = store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"version\":2}",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    assert!(!first.created);
    let backup = first.backup.expect("backup path");
    let entries = history.list(&file).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, backup);
    assert_eq!(
        history.read(&file, &entries[0].file).unwrap(),
        "{\"version\":1}"
    );

    let loaded = store.read_file(&file).unwrap();
    let second = store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"version\":2}",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    assert!(
        second.backup.is_some(),
        "the changed content is snapshotted"
    );
    assert_eq!(history.list(&file).unwrap().len(), 2);

    let loaded = store.read_file(&file).unwrap();
    let third = store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"version\":2}",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    assert_eq!(
        third.backup, None,
        "content already matching the newest snapshot is not stored twice"
    );
    assert_eq!(history.list(&file).unwrap().len(), 2);
}

#[test]
fn blocks_writes_when_the_backup_cannot_be_created() {
    let synthetic = Synthetic::new();
    let file = synthetic.write("config.json", "{\"version\":1}");
    let blocked_root = synthetic.root().join("blocked-history");
    fs::write(&blocked_root, "not a directory").unwrap();
    let tools = detect_tools(&synthetic.env(), &[custom("custom-config", &file)]);
    let store = FileStore::new(
        Registry::new(tools),
        HistoryStore::new(blocked_root, test_key()),
        Arc::new(SelfWriteRegistry::new()),
    );

    let loaded = store.read_file(&file).unwrap();
    let error = store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"version\":2}",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap_err();
    assert!(matches!(error, FileError::Backup(_)), "{error}");
    assert_eq!(fs::read_to_string(&file).unwrap(), "{\"version\":1}");
}

#[test]
fn rejects_paths_outside_registered_regions() {
    let synthetic = Synthetic::new();
    let folder = synthetic.root().join("registered-folder");
    fs::create_dir_all(&folder).unwrap();
    let store = synthetic.store(&[custom("custom-folder", &folder)]);

    let outside = synthetic.root().join("outside.json");
    assert!(matches!(
        store.write_file(
            &outside,
            WriteRequest {
                content: "{}",
                expected_revision: None
            }
        ),
        Err(FileError::NotRegistered)
    ));

    let escape = folder.join("..").join("escape.json");
    assert!(matches!(
        store.write_file(
            &escape,
            WriteRequest {
                content: "{}",
                expected_revision: None
            }
        ),
        Err(FileError::NotRegistered)
    ));

    assert!(matches!(
        store.read_file(&folder),
        Err(FileError::NotRegistered)
    ));

    let inside = store
        .write_file(
            &folder.join("inside.json"),
            WriteRequest {
                content: "{}",
                expected_revision: None,
            },
        )
        .unwrap();
    assert!(inside.created);
    assert!(folder.join("inside.json").exists());
}

#[test]
fn rejects_oversized_and_non_utf8_files() {
    let synthetic = Synthetic::new();
    let large = synthetic.root().join("large.json");
    fs::write(&large, " ".repeat(5 * 1024 * 1024 + 1)).unwrap();
    let binary = synthetic.root().join("binary.json");
    fs::write(&binary, [0x7f, 0xff, 0xfe]).unwrap();
    let store = synthetic.store(&[
        custom("custom-large", &large),
        custom("custom-binary", &binary),
    ]);

    assert!(matches!(store.read_file(&large), Err(FileError::TooLarge)));
    assert!(matches!(store.read_file(&binary), Err(FileError::NotUtf8)));
    assert!(matches!(
        store.write_file(
            &large,
            WriteRequest {
                content: "{}",
                expected_revision: None,
            }
        ),
        Err(FileError::TooLarge)
    ));
}

#[test]
fn replaces_without_leaving_temporary_files() {
    let synthetic = Synthetic::new();
    let file = synthetic.write("settings.json", "{\"version\":1}");
    let store = synthetic.store(&[custom("custom-config", &file)]);
    let loaded = store.read_file(&file).unwrap();
    store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"version\":2}",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();

    let leftovers: Vec<String> = fs::read_dir(synthetic.root())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".tmp-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "temporary files left behind: {leftovers:?}"
    );
}

#[test]
fn folder_reveal_and_secret_validation_follow_registered_regions() {
    let synthetic = Synthetic::new();
    let folder = synthetic.root().join("registered-folder");
    let file = synthetic.write_at(&folder.join("child.json"), "{}");
    let secret = synthetic.write(".claude.json", "{}");
    let store = synthetic.store(&[custom("custom-folder", &folder)]);
    let registry = store.registry();

    assert!(registry.resolve_folder(&folder).is_ok());
    assert!(
        registry
            .resolve_folder(&folder.join("missing-subfolder"))
            .is_ok()
    );
    assert!(matches!(
        registry.resolve_folder(&file),
        Err(FileError::NotAFolder)
    ));
    assert!(matches!(
        registry.resolve_folder(synthetic.root()),
        Err(FileError::NotRegisteredFolder)
    ));

    assert!(registry.resolve_reveal(&file).is_ok());
    assert!(registry.resolve_reveal(&folder).is_ok());
    assert!(matches!(
        registry.resolve_reveal(&synthetic.root().join("outside.json")),
        Err(FileError::NotRegistered)
    ));

    let home_store = synthetic.store(&[]);
    assert!(home_store.registry().is_secret_file(&secret));
    assert!(
        !home_store
            .registry()
            .is_secret_file(&synthetic.home().join(".claude/settings.json"))
    );
}

#[cfg(windows)]
#[test]
fn refuses_junction_targets_and_escapes_through_junctions() {
    use std::process::Command;

    let synthetic = Synthetic::new();
    let registry_folder = synthetic.root().join("registered-folder");
    let outside_folder = synthetic.root().join("outside-folder");
    fs::create_dir_all(&registry_folder).unwrap();
    fs::create_dir_all(&outside_folder).unwrap();
    let store = synthetic.store(&[custom("custom-folder", &registry_folder)]);

    let escape = registry_folder.join("escape");
    let status = Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(&escape)
        .arg(&outside_folder)
        .status()
        .expect("run mklink");
    if !status.success() {
        eprintln!("skipping junction checks: mklink /J unavailable");
        return;
    }

    assert!(matches!(
        store.write_file(
            &escape.join("escaped.json"),
            WriteRequest {
                content: "{}",
                expected_revision: None
            }
        ),
        Err(FileError::NotRegistered)
    ));

    let linked_file = synthetic.root().join("linked-config.json");
    let target_folder = synthetic.root().join("target-folder");
    fs::create_dir_all(&target_folder).unwrap();
    let file_store = synthetic.store(&[custom("custom-linked", &linked_file)]);
    let status = Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(&linked_file)
        .arg(&target_folder)
        .status()
        .expect("run mklink");
    assert!(status.success());
    assert!(matches!(
        file_store.write_file(
            &linked_file,
            WriteRequest {
                content: "{}",
                expected_revision: None
            }
        ),
        Err(FileError::SymlinkTarget)
    ));
}

#[cfg(unix)]
#[test]
fn preserves_unix_permissions_on_replacement() {
    use std::os::unix::fs::PermissionsExt;

    let synthetic = Synthetic::new();
    let file = synthetic.write("settings.json", "{}");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let store = synthetic.store(&[custom("custom-config", &file)]);
    let loaded = store.read_file(&file).unwrap();
    store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"changed\":true}",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[cfg(windows)]
#[test]
fn rejects_writes_through_a_file_symlink_when_available() {
    let synthetic = Synthetic::new();
    let missing = synthetic.root().join("settings.json");
    let store = synthetic.store(&[custom("custom-config", &missing)]);

    let target = synthetic.root().join("elsewhere.json");
    fs::write(&target, "{}").unwrap();
    if std::os::windows::fs::symlink_file(&target, &missing).is_err() {
        eprintln!("skipping symlink check: this account cannot create file symlinks");
        return;
    }
    assert!(matches!(
        store.write_file(
            &missing,
            WriteRequest {
                content: "{}",
                expected_revision: None
            }
        ),
        Err(FileError::SymlinkTarget)
    ));
}

#[test]
fn validates_json_and_jsonc_before_snapshotting_or_writing() {
    let synthetic = Synthetic::new();
    let json = synthetic.write("settings.json", "{\"version\":1}\n");
    let jsonc = synthetic.write("config.jsonc", "{\n  // note\n  \"a\": 1,\n}\n");
    let dotenv = synthetic.write(".env", "KEY=value\n");
    let store = synthetic.store(&[
        custom("custom-json", &json),
        custom("custom-jsonc", &jsonc),
        custom("custom-dotenv", &dotenv),
    ]);
    let loaded = store.read_file(&json).unwrap();

    let error = store
        .write_file(
            &json,
            WriteRequest {
                content: "{\"broken\":",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap_err();
    assert!(matches!(error, FileError::Content(_)), "{error}");
    assert_eq!(fs::read_to_string(&json).unwrap(), "{\"version\":1}\n");
    assert!(
        synthetic.history().list(&json).unwrap().is_empty(),
        "a rejected save must not create a snapshot"
    );

    store
        .write_file(
            &json,
            WriteRequest {
                content: "{\"version\":2}\n",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    let loaded = store.read_file(&jsonc).unwrap();
    store
        .write_file(
            &jsonc,
            WriteRequest {
                content: "{\n  // updated\n  \"a\": 2,\n}\n",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    let dotenv_loaded = store.read_file(&dotenv).unwrap();
    store
        .write_file(
            &dotenv,
            WriteRequest {
                content: "KEY=another\nNOT JSON AT ALL\n",
                expected_revision: dotenv_loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(&dotenv).unwrap(),
        "KEY=another\nNOT JSON AT ALL\n"
    );
}

#[test]
fn creates_lists_and_renames_entries_in_a_registered_folder() {
    let synthetic = Synthetic::new();
    let folder = synthetic.root().join("registered-folder");
    fs::create_dir_all(&folder).unwrap();
    let store = synthetic.store(&[custom("custom-folder", &folder)]);

    let file = store.create_file_in(&folder, "notes.md").unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "");
    assert!(matches!(
        store.create_file_in(&folder, "notes.md"),
        Err(FileError::FileExists)
    ));
    assert!(matches!(
        store.create_file_in(&folder, "a/b.txt"),
        Err(FileError::InvalidName(_))
    ));
    assert!(matches!(
        store.create_file_in(&folder, ".hidden"),
        Err(FileError::InvalidName(_))
    ));

    let sub = store
        .create_folder_in(&folder.join("missing-child"), "sub")
        .unwrap();
    assert!(sub.is_dir());
    assert!(folder.join("missing-child").is_dir());
    assert!(matches!(
        store.create_folder_in(&folder, "notes.md"),
        Err(FileError::FolderExists)
    ));

    fs::write(folder.join("b.txt"), "b").unwrap();
    fs::write(folder.join("A.txt"), "a").unwrap();
    fs::write(folder.join(".hidden"), "hidden").unwrap();
    let listing = store.list_folder(&folder).unwrap();
    assert!(listing.exists);
    let names: Vec<&str> = listing
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(
        names,
        ["missing-child", "A.txt", "b.txt", "notes.md"],
        "folders sort before files and dotfiles stay hidden"
    );
    assert!(listing.entries[0].is_dir);
    assert!(!store.list_folder(&folder.join("absent")).unwrap().exists);

    let renamed = store.rename_file(&file, "renamed.md").unwrap();
    assert!(renamed.ends_with("renamed.md"));
    assert!(!file.exists());
    assert!(matches!(
        store.rename_file(&renamed, "A.txt"),
        Err(FileError::FileExists)
    ));
    assert!(matches!(
        store.rename_file(&renamed, "bad|name"),
        Err(FileError::InvalidName(_))
    ));

    let renamed_folder = store.rename_folder(&sub, "renamed-sub").unwrap();
    assert!(renamed_folder.is_dir());
    assert!(!sub.exists());
    #[cfg(windows)]
    assert_eq!(
        store.rename_file(&renamed, "RENAMED.MD").unwrap(),
        renamed,
        "case-only renames are no-ops"
    );
}

#[test]
fn protects_registered_roots_and_tracked_files_from_rename_and_delete() {
    let synthetic = Synthetic::new();
    let settings = synthetic.write(".claude/settings.json", "{}");
    let root_store = synthetic.store(&[]);
    let loaded = root_store.read_file(&settings).unwrap();
    assert!(matches!(
        root_store.rename_file(&settings, "other.json"),
        Err(FileError::RootFile)
    ));
    assert!(matches!(
        root_store.delete_file_target(&settings),
        Err(FileError::RootFile)
    ));
    assert!(matches!(
        root_store.rename_folder(&synthetic.home().join(".claude"), "other"),
        Err(FileError::RootFolder)
    ));
    assert!(matches!(
        root_store.delete_folder_target(&synthetic.home().join(".claude")),
        Err(FileError::RootFolder)
    ));
    assert!(loaded.exists);

    let folder = synthetic.root().join("registered-folder");
    let child = synthetic.write_at(&folder.join("child.json"), "{}");
    let folder_store = synthetic.store(&[custom("custom-folder", &folder)]);
    assert_eq!(folder_store.delete_file_target(&child).unwrap(), child);
    assert!(matches!(
        folder_store.delete_folder_target(&folder),
        Err(FileError::RootFolder)
    ));
    let sub = folder_store.create_folder_in(&folder, "sub").unwrap();
    assert_eq!(folder_store.delete_folder_target(&sub).unwrap(), sub);
    assert!(matches!(
        folder_store.delete_file_target(&folder.join("missing.json")),
        Err(FileError::Missing)
    ));
    assert!(matches!(
        folder_store.delete_folder_target(&folder.join("missing")),
        Err(FileError::MissingFolder)
    ));

    let tracked_dir = folder_store.create_folder_in(&folder, "tracked").unwrap();
    let tracked_file = tracked_dir.join("tracked.json");
    fs::write(&tracked_file, "{}").unwrap();
    let tracked_store = synthetic.store(&[
        custom("custom-folder", &folder),
        custom("custom-tracked", &tracked_file),
    ]);
    assert!(matches!(
        tracked_store.delete_folder_target(&tracked_dir),
        Err(FileError::ContainsTrackedFiles)
    ));
    assert!(matches!(
        tracked_store.delete_file_target(&tracked_file),
        Err(FileError::RootFile)
    ));
}
