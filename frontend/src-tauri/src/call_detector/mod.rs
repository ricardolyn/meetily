// Call-detection reminder.
//
// Polls Core Audio every few seconds to check whether ANY input device
// (built-in mic, AirPods, USB headset, virtual loopback, …) is running
// for any process other than ourselves. When one is, surfaces a reminder
// via:
//   1. tray icon — adds a "📞 Call detected — Start Recording" menu item
//   2. OS notification — re-surfaces periodically until you start recording or
//      the call ends, since the notification plugin can't pin a banner open
//
// We previously matched on hard-coded process names (zoom.us, msteams, …)
// which missed browser-based meetings (Google Meet, Teams web, etc.) and
// gave no signal for Slack huddles, Discord calls, FaceTime audio, etc.
// `kAudioDevicePropertyDeviceIsRunningSomewhere` returns true the moment
// any process opens an input device for IO. We scan every input device
// (not just the system default) so a call that grabs headphones / AirPods
// while the default mic sits idle still triggers the reminder.

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_notification::NotificationExt;
use tokio::time::{sleep, Duration};

/// Polling interval between checks. The Core Audio call is essentially
/// free (a single property read), so we can poll fast enough that the
/// reminder feels responsive.
const POLL_INTERVAL_SECS: u64 = 3;

/// Number of consecutive positive samples needed before firing.
/// Debounces brief flicker (apps that briefly open the device during
/// device-change probing). 2 × 3 s = ≥3 s of consistent presence.
const DEBOUNCE_SAMPLES: u8 = 2;

/// While a call stays detected and we're not yet recording, re-surface the
/// notification on this cadence so it keeps nagging instead of vanishing after
/// the first banner.
const RENOTIFY_INTERVAL_SECS: u64 = 30;

pub fn start_call_detector<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        log::info!(
            "📞 Call detector starting (poll interval: {}s)",
            POLL_INTERVAL_SECS
        );
        let mut consecutive_positive: u8 = 0;
        let mut call_active = false;
        let mut cycles_since_notify: u32 = 0;
        let renotify_cycles = (RENOTIFY_INTERVAL_SECS / POLL_INTERVAL_SECS).max(1) as u32;

        loop {
            sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;

            // "Someone else is using the mic" = device is running AND that
            // someone isn't us. When we're recording, the device naturally
            // shows as running, so suppress entirely in that case.
            let we_are_recording = crate::audio::recording_commands::is_recording().await;
            let device_busy = scan_any_input_busy();
            let now_detected = device_busy && !we_are_recording;

            match (call_active, now_detected) {
                (false, true) => {
                    consecutive_positive = consecutive_positive.saturating_add(1);
                    if consecutive_positive >= DEBOUNCE_SAMPLES {
                        call_active = true;
                        consecutive_positive = 0;
                        cycles_since_notify = 0;
                        on_call_started(&app).await;
                    }
                }
                (true, true) => {
                    // Still on the call and not recording — keep nagging.
                    cycles_since_notify += 1;
                    if cycles_since_notify >= renotify_cycles {
                        cycles_since_notify = 0;
                        show_call_notification(&app);
                    }
                }
                (true, false) => {
                    call_active = false;
                    consecutive_positive = 0;
                    cycles_since_notify = 0;
                    on_call_ended(&app).await;
                }
                (false, false) => {
                    consecutive_positive = 0;
                }
            }
        }
    });
}

/// Returns true if ANY input-capable audio device currently has IO running
/// for at least one process on the system. macOS-only; no-ops elsewhere.
fn scan_any_input_busy() -> bool {
    #[cfg(target_os = "macos")]
    {
        match macos::any_input_is_running_somewhere() {
            Ok(v) => v,
            Err(status) => {
                log::warn!("Call detector: Core Audio query failed (OSStatus {})", status);
                false
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::mem::size_of;

    // FourCC helper — Core Audio property selectors are packed ASCII.
    const fn fcc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
    }

    // AudioObject IDs and property selectors (from CoreAudio/AudioHardware.h).
    const K_AUDIO_OBJECT_SYSTEM_OBJECT: u32 = 1;
    const SELECTOR_DEVICES: u32 = fcc(b"dev#");
    // kAudioDevicePropertyDeviceIsRunningSomewhere — true when ANY process has
    // the device running. Note: 'goin' is kAudioDevicePropertyDeviceIsRunning,
    // which only reflects OUR process's IOProc and stays 0 for calls in other
    // apps; 'gone' is the cross-process variant we actually need.
    const SELECTOR_IS_RUNNING_SOMEWHERE: u32 = fcc(b"gone");
    const SELECTOR_STREAMS: u32 = fcc(b"stm#");
    const SCOPE_GLOBAL: u32 = fcc(b"glob");
    const SCOPE_INPUT: u32 = fcc(b"inpt");
    const ELEMENT_MAIN: u32 = 0;

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            in_object_id: u32,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            io_data_size: *mut u32,
            out_data: *mut c_void,
        ) -> i32;

        fn AudioObjectGetPropertyDataSize(
            in_object_id: u32,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            out_data_size: *mut u32,
        ) -> i32;
    }

    /// True if any device that currently exposes an input stream has IO
    /// running. `kAudioDevicePropertyDeviceIsRunningSomewhere` is device-level,
    /// NOT scope-aware — it reads 1 whenever the device is doing IO in any
    /// direction, so an output-only device reports "running" during plain
    /// playback (music, video) even when queried on the input scope. Gating on
    /// input-stream presence is therefore required: speakers and displays
    /// expose 0 input streams, and Bluetooth headsets expose 0 input streams
    /// in music (A2DP) mode, so neither trips the reminder. A device only
    /// counts here once something opens it for input IO.
    pub fn any_input_is_running_somewhere() -> Result<bool, i32> {
        let devices = enumerate_devices()?;
        for device_id in devices {
            if device_input_stream_count(device_id) == 0 {
                continue;
            }
            match device_is_running(device_id) {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(status) => {
                    log::debug!(
                        "Call detector: is-running query failed for device {} (OSStatus {})",
                        device_id,
                        status
                    );
                }
            }
        }
        Ok(false)
    }

    fn enumerate_devices() -> Result<Vec<u32>, i32> {
        let addr = AudioObjectPropertyAddress {
            selector: SELECTOR_DEVICES,
            scope: SCOPE_GLOBAL,
            element: ELEMENT_MAIN,
        };
        let mut size: u32 = 0;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                K_AUDIO_OBJECT_SYSTEM_OBJECT,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
            )
        };
        if status != 0 {
            return Err(status);
        }
        let count = (size as usize) / size_of::<u32>();
        if count == 0 {
            return Ok(Vec::new());
        }
        let mut devices: Vec<u32> = vec![0; count];
        let status = unsafe {
            AudioObjectGetPropertyData(
                K_AUDIO_OBJECT_SYSTEM_OBJECT,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                devices.as_mut_ptr() as *mut c_void,
            )
        };
        if status != 0 {
            return Err(status);
        }
        Ok(devices)
    }

    /// Number of input streams the device currently exposes. Output-only
    /// devices report 0; Bluetooth headsets report 0 until a call switches
    /// them from A2DP to headset (HFP) mode. Returns 0 on query failure so a
    /// device we can't inspect is never treated as an active mic.
    fn device_input_stream_count(device_id: u32) -> u32 {
        let addr = AudioObjectPropertyAddress {
            selector: SELECTOR_STREAMS,
            scope: SCOPE_INPUT,
            element: ELEMENT_MAIN,
        };
        let mut size: u32 = 0;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(device_id, &addr, 0, std::ptr::null(), &mut size)
        };
        if status != 0 {
            return 0;
        }
        size / size_of::<u32>() as u32
    }

    fn device_is_running(device_id: u32) -> Result<bool, i32> {
        let addr = AudioObjectPropertyAddress {
            selector: SELECTOR_IS_RUNNING_SOMEWHERE,
            scope: SCOPE_GLOBAL,
            element: ELEMENT_MAIN,
        };
        let mut running: u32 = 0;
        let mut size: u32 = size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                device_id,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut running as *mut u32 as *mut c_void,
            )
        };
        if status != 0 {
            return Err(status);
        }
        Ok(running != 0)
    }
}

async fn on_call_started<R: Runtime>(app: &AppHandle<R>) {
    log::info!("📞 Microphone in use by another app");

    crate::tray::set_call_detected(true);
    crate::tray::update_tray_menu(app);
    show_call_notification(app);

    let _ = app.emit("call-detected", true);
}

/// Show the "Call detected" banner. Fired on detection and re-fired on the
/// re-notify cadence while the call stays active and we're not recording.
fn show_call_notification<R: Runtime>(app: &AppHandle<R>) {
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

async fn on_call_ended<R: Runtime>(app: &AppHandle<R>) {
    log::info!("📞 Microphone released");
    crate::tray::set_call_detected(false);
    crate::tray::update_tray_menu(app);
    let _ = app.emit("call-detected", false);
}
