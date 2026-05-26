// Periodic cleanup of large per-meeting artifacts.
//
// Each meeting folder accumulates:
//   audio.mp4 / *.wav        — large (megabytes per minute)
//   .checkpoints/             — incremental save snapshots, also large
//   transcripts.json          — small text
//   summary.json / summary.md — small text
//   metadata.json             — small text
//
// Once the user has a transcript + summary, the audio mostly serves
// re-transcription. Storing it forever is wasteful. We delete audio +
// .checkpoints/ once they pass `RETENTION_DAYS`, but keep transcripts,
// summaries, and metadata indefinitely so the meeting is still browsable.
//
// Runs once at app startup, in a tokio task so it doesn't block the UI.

use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager, Runtime};

/// How many days an audio/checkpoint file may live before cleanup deletes it.
const RETENTION_DAYS: u64 = 30;

/// File extensions considered audio. Compared case-insensitively.
const AUDIO_EXTENSIONS: &[&str] = &["mp4", "m4a", "wav", "aac", "mp3", "ogg", "flac"];

/// Files that must always be kept regardless of age.
const KEEP_FILENAMES: &[&str] = &[
    "transcripts.json",
    "summary.json",
    "summary.md",
    "metadata.json",
];

/// Spawn a tokio task that scans all known meeting folders once and removes
/// audio + .checkpoints/ older than RETENTION_DAYS. Safe to call once during
/// app setup; logs warnings on individual file failures.
pub fn run_startup_cleanup<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        log::info!(
            "🧹 Starting old-audio cleanup (retention: {} days)",
            RETENTION_DAYS
        );
        let Some(state) = app.try_state::<crate::state::AppState>() else {
            log::warn!("Cleanup: AppState not available, skipping");
            return;
        };
        let pool = state.db_manager.pool();

        let folders: Vec<String> = match sqlx::query_as::<_, (Option<String>,)>(
            "SELECT folder_path FROM meetings WHERE folder_path IS NOT NULL",
        )
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows.into_iter().filter_map(|(p,)| p).collect(),
            Err(e) => {
                log::error!("Cleanup: failed to read meeting folders: {}", e);
                return;
            }
        };

        let cutoff = SystemTime::now() - Duration::from_secs(RETENTION_DAYS * 24 * 60 * 60);
        let mut deleted_files: u64 = 0;
        let mut deleted_bytes: u64 = 0;

        for folder in folders {
            match cleanup_folder(std::path::Path::new(&folder), cutoff) {
                Ok((n, bytes)) => {
                    deleted_files += n;
                    deleted_bytes += bytes;
                }
                Err(e) => log::warn!("Cleanup: error in {}: {}", folder, e),
            }
        }

        log::info!(
            "🧹 Cleanup done: removed {} files ({:.1} MB)",
            deleted_files,
            deleted_bytes as f64 / (1024.0 * 1024.0)
        );
    });
}

/// Walk a single meeting folder, deleting audio files and the .checkpoints
/// subdirectory if they're older than `cutoff`. Returns (files_deleted, bytes_freed).
fn cleanup_folder(
    folder: &std::path::Path,
    cutoff: SystemTime,
) -> std::io::Result<(u64, u64)> {
    if !folder.exists() {
        return Ok((0, 0));
    }
    let mut files = 0u64;
    let mut bytes = 0u64;

    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;

        if metadata.is_dir() {
            // Delete .checkpoints/ as a unit if any file in it predates the cutoff
            if path.file_name().and_then(|n| n.to_str()) == Some(".checkpoints") {
                if directory_is_old(&path, cutoff)? {
                    let size = directory_size(&path).unwrap_or(0);
                    if let Err(e) = std::fs::remove_dir_all(&path) {
                        log::warn!("Cleanup: failed to remove {}: {}", path.display(), e);
                    } else {
                        log::info!("Cleanup: removed {}", path.display());
                        files += 1;
                        bytes += size;
                    }
                }
            }
            continue;
        }

        if !metadata.is_file() {
            continue;
        }

        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if KEEP_FILENAMES.iter().any(|k| file_name == *k) {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase());
        let is_audio = extension
            .as_deref()
            .map(|e| AUDIO_EXTENSIONS.contains(&e))
            .unwrap_or(false);
        if !is_audio {
            continue;
        }

        let modified = metadata.modified().unwrap_or(SystemTime::now());
        if modified >= cutoff {
            continue;
        }

        let size = metadata.len();
        match std::fs::remove_file(&path) {
            Ok(_) => {
                log::info!(
                    "Cleanup: removed {} ({} bytes, modified {:?} ago)",
                    path.display(),
                    size,
                    SystemTime::now().duration_since(modified).ok()
                );
                files += 1;
                bytes += size;
            }
            Err(e) => log::warn!("Cleanup: failed to remove {}: {}", path.display(), e),
        }
    }

    Ok((files, bytes))
}

/// Recursive size of a directory in bytes. Best-effort; errors return 0.
fn directory_size(path: &std::path::Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            total += directory_size(&entry.path()).unwrap_or(0);
        } else {
            total += metadata.len();
        }
    }
    Ok(total)
}

/// Returns true if every regular file in the tree has mtime older than cutoff.
/// Used to decide whether the whole .checkpoints/ directory is safely stale.
fn directory_is_old(path: &std::path::Path, cutoff: SystemTime) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            if !directory_is_old(&entry.path(), cutoff)? {
                return Ok(false);
            }
        } else {
            let modified = metadata.modified().unwrap_or(SystemTime::now());
            if modified >= cutoff {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
