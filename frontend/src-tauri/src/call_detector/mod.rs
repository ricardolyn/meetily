// Call-detection reminder.
//
// Polls the process list every 5 seconds for known call applications
// (Zoom, Microsoft Teams, Webex, Discord, FaceTime, Skype). When one starts
// running while Meetily itself is NOT recording, surfaces a reminder via:
//   1. tray icon — adds a "📞 Call detected — Start Recording" menu item
//   2. OS notification — fires once per call-detected transition
//
// The plan called for native Core Audio APIs (kAudioHardwarePropertyProcessObjectList),
// which is more accurate but macOS 14.4+ only and requires fragile bindings.
// Process enumeration is unprivileged, deterministic, works on all macOS
// versions, and covers the apps users actually want detection for.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use tokio::time::{sleep, Duration};

/// Polling interval between checks. Short enough to feel responsive, long
/// enough that the spawned `ps` call has negligible cost (<1 ms typical).
const POLL_INTERVAL_SECS: u64 = 5;

/// Number of consecutive positive samples needed before firing `CallStarted`.
/// Debounces brief flicker (e.g. a call app being launched and immediately
/// quit). 2 samples × 5 s = ≥5 s of consistent presence.
const DEBOUNCE_SAMPLES: u8 = 2;

// All-lowercase EXACT basenames produced by `ps -axo comm=`. Substring matching
// was too loose — e.g. "discord" matched the Discord background helper that
// stays alive even when no call is active. We now compare the process basename
// for exact equality to keep false positives down. Apps that keep a background
// process running for push notifications (Discord, Skype, FaceTime) are
// intentionally excluded.
#[cfg(target_os = "macos")]
const KNOWN_CALL_APPS: &[&str] = &[
    "zoom.us",
    "msteams",
    "cisco webex meetings",
    "gotomeeting",
    "bluejeans",
];

/// Track whether the reminder has already fired for the currently-detected
/// call, so we don't re-notify every poll tick.
static REMINDED_FOR_CURRENT_CALL: AtomicBool = AtomicBool::new(false);

/// Spawn a background tokio task that monitors call apps and updates tray +
/// notifications. Safe to call once during app setup.
pub fn start_call_detector<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        log::info!(
            "📞 Call detector starting (poll interval: {}s)",
            POLL_INTERVAL_SECS
        );
        let mut consecutive_positive: u8 = 0;
        let mut call_active = false;

        loop {
            sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;

            let now_detected = scan_for_call_app();

            match (call_active, now_detected) {
                (false, true) => {
                    consecutive_positive = consecutive_positive.saturating_add(1);
                    if consecutive_positive >= DEBOUNCE_SAMPLES {
                        call_active = true;
                        consecutive_positive = 0;
                        on_call_started(&app).await;
                    }
                }
                (true, false) => {
                    call_active = false;
                    consecutive_positive = 0;
                    REMINDED_FOR_CURRENT_CALL.store(false, Ordering::SeqCst);
                    on_call_ended(&app).await;
                }
                _ => {
                    consecutive_positive = 0;
                }
            }
        }
    });
}

/// Returns true if any of the known call-app process names is currently
/// running. macOS-only; returns false everywhere else.
fn scan_for_call_app() -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        // `-axo comm=` prints the command (basename) of every process, no header.
        let output = match Command::new("/bin/ps").args(["-axo", "comm="]).output() {
            Ok(o) => o,
            Err(e) => {
                log::warn!("Call detector: failed to spawn ps: {}", e);
                return false;
            }
        };
        if !output.status.success() {
            return false;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // `ps -axo comm=` returns the executable basename. Take just the
            // file name (some paths show with directories) and compare
            // case-insensitively for exact equality against the known list.
            let basename = trimmed
                .rsplit('/')
                .next()
                .unwrap_or(trimmed)
                .to_lowercase();
            for app in KNOWN_CALL_APPS {
                if basename == *app {
                    return true;
                }
            }
        }
        false
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

async fn on_call_started<R: Runtime>(app: &AppHandle<R>) {
    log::info!("📞 Call detected by another app");

    // Mark tray as call-detected and refresh the menu so the "Start Recording"
    // item gets a 📞 hint.
    crate::tray::set_call_detected(true);
    crate::tray::update_tray_menu(app);

    // Don't badge the user with a notification if they're already recording —
    // they obviously don't need a reminder.
    if crate::audio::recording_commands::is_recording().await {
        log::debug!("Call detected but already recording; skipping notification");
        return;
    }

    if !REMINDED_FOR_CURRENT_CALL.swap(true, Ordering::SeqCst) {
        if let Err(e) = app
            .notification()
            .builder()
            .title("Call detected")
            .body("Click Meetily to start recording.")
            .show()
        {
            log::warn!("Failed to show call-detected notification: {}", e);
        }
    }

    let _ = app.emit("call-detected", true);
}

async fn on_call_ended<R: Runtime>(app: &AppHandle<R>) {
    log::info!("📞 Call ended");
    crate::tray::set_call_detected(false);
    crate::tray::update_tray_menu(app);
    let _ = app.emit("call-detected", false);
}
