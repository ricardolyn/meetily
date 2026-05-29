// Call-detection reminder.
//
// Polls Core Audio every few seconds to check whether ANY input device
// (built-in mic, AirPods, USB headset, virtual loopback, …) is running
// for any process other than ourselves. When one is, surfaces a reminder
// via:
//   1. tray icon — adds a "📞 Call detected — Start Recording" menu item
//   2. OS notification — fires once per call-detected transition
//
// We previously matched on hard-coded process names (zoom.us, msteams, …)
// which missed browser-based meetings (Google Meet, Teams web, etc.) and
// gave no signal for Slack huddles, Discord calls, FaceTime audio, etc.
// `kAudioDevicePropertyDeviceIsRunningSomewhere` returns true the moment
// any process opens an input device for IO. We scan every input device
// (not just the system default) so a call that grabs headphones / AirPods
// while the default mic sits idle still triggers the reminder.

use std::sync::atomic::{AtomicBool, Ordering};
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

static REMINDED_FOR_CURRENT_CALL: AtomicBool = AtomicBool::new(false);

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
    const SELECTOR_IS_RUNNING_SOMEWHERE: u32 = fcc(b"goin");
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

    /// True if any input-capable audio device on the system currently has
    /// IO running. Iterates every audio device known to Core Audio and
    /// queries `kAudioDevicePropertyDeviceIsRunningSomewhere` against the
    /// INPUT scope. For an output-only device, that scoped query returns
    /// 0 or errors — both treated as "not running" here, so we don't need
    /// a separate input-stream-count probe.
    pub fn any_input_is_running_somewhere() -> Result<bool, i32> {
        let devices = enumerate_devices()?;
        for device_id in devices {
            match device_input_is_running(device_id) {
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

    fn device_input_is_running(device_id: u32) -> Result<bool, i32> {
        let addr = AudioObjectPropertyAddress {
            selector: SELECTOR_IS_RUNNING_SOMEWHERE,
            scope: SCOPE_INPUT,
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
    log::info!("📞 Microphone released");
    crate::tray::set_call_detected(false);
    crate::tray::update_tray_menu(app);
    let _ = app.emit("call-detected", false);
}
