use maestro_core::migration::{LegacyProfileKey, decode_snapshot};
use serde::Deserialize;
use std::{fs, process::ExitCode};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixtures {
    electron_version: String,
    encrypted_key: String,
    samples: Vec<Sample>,
}

#[derive(Deserialize)]
struct Sample {
    label: String,
    stored: String,
    expected: Option<String>,
}

fn verify() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("Pass the synthetic fixture JSON path")?;
    let fixtures: Fixtures = serde_json::from_slice(&fs::read(path)?)?;
    if fixtures.samples.is_empty() {
        return Err("No compatibility samples supplied".into());
    }
    let key = LegacyProfileKey::from_encoded(&fixtures.encrypted_key)?;
    for sample in &fixtures.samples {
        let result = decode_snapshot(&sample.stored, Some(&key));
        let passed = match (&sample.expected, result) {
            (Some(expected), Ok(actual)) => *expected == actual,
            (None, Err(_)) => true,
            _ => false,
        };
        if !passed {
            return Err(format!("Compatibility check failed for sample {}", sample.label).into());
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "success": true,
            "electronVersion": fixtures.electron_version,
            "samples": fixtures.samples.len(),
            "format": "maestro-enc:v1 / v10 / AES-256-GCM / DPAPI profile key"
        })
    );
    Ok(())
}

fn main() -> ExitCode {
    match verify() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Legacy compatibility probe: {error}");
            ExitCode::FAILURE
        }
    }
}
