mod support;

use std::{
    sync::mpsc::channel,
    time::{Duration, Instant},
};

use maestro_core::{
    files::WriteRequest,
    watch::{WatchError, WatchEvent, watch_with_debounce},
};
use support::{Synthetic, custom};

type WatchResult = Result<WatchEvent, WatchError>;

#[test]
fn detects_reads_saves_and_watches_a_synthetic_tool_file() {
    let synthetic = Synthetic::new();
    let file = synthetic.write(".claude/settings.json", "{\"version\":1}\n");
    let store = synthetic.store(&[]);

    let loaded = store.read_file(&file).unwrap();
    assert!(loaded.exists);
    assert_eq!(loaded.content, "{\"version\":1}\n");

    let (sender, receiver) = channel::<WatchResult>();
    let _watch = watch_with_debounce(
        &file,
        maestro_core::watch::WatchMode::File,
        store.self_writes().clone(),
        Duration::from_millis(50),
        move |event| {
            let _ = sender.send(event);
        },
    )
    .unwrap();

    store
        .write_file(
            &file,
            WriteRequest {
                content: "{\"version\":2}\n",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    assert!(
        receiver.recv_timeout(Duration::from_millis(400)).is_err(),
        "own save was reported as an external change"
    );

    // The suppression window is one second, so wait it out before the external edit.
    let deadline = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    std::fs::write(&file, "{\"external\":true}\n").unwrap();
    let event = receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("external change event")
        .expect("watch error");
    assert_eq!(event.target, file);

    let history = synthetic.history();
    let entries = history.list(&file).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].file.contains("settings.json"));
    assert_eq!(
        history.read(&file, &entries[0].file).unwrap(),
        "{\"version\":1}\n"
    );

    let reloaded = store.read_file(&file).unwrap();
    let conflict = store.write_file(
        &file,
        WriteRequest {
            content: "{\"version\":3}\n",
            expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
        },
    );
    assert!(matches!(
        conflict,
        Err(maestro_core::files::FileError::Conflict)
    ));
    assert_eq!(reloaded.content, "{\"external\":true}\n");
}

#[test]
fn custom_folder_files_are_readable_and_writable() {
    let synthetic = Synthetic::new();
    let folder = synthetic.root().join("agent-workspace");
    let file = folder.join("prompts.md");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(&file, "# prompt\n").unwrap();
    let store = synthetic.store(&[custom("custom-workspace", &folder)]);

    let loaded = store.read_file(&file).unwrap();
    assert!(loaded.exists);
    store
        .write_file(
            &file,
            WriteRequest {
                content: "# prompt\nupdated\n",
                expected_revision: loaded.revision.as_ref().map(|value| value.as_str()),
            },
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "# prompt\nupdated\n"
    );
    assert_eq!(synthetic.history().list(&file).unwrap().len(), 1);
}
