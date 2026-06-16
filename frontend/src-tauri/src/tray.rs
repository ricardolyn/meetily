use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{
    Emitter,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime,
};

/// Menu-item id prefix used for "Start Recording in <project name>" entries
/// inside the tray submenu. The remainder of the id is the project_id.
const START_PROJECT_PREFIX: &str = "start_project:";

/// Shared flag set by the call-detector module. When true and we're in the
/// `Stopped` state, the tray "Start Recording" entry is prefixed with 📞.
static CALL_DETECTED: AtomicBool = AtomicBool::new(false);

/// Toggle the call-detected flag. Caller should follow up with
/// `update_tray_menu()` to repaint.
pub fn set_call_detected(detected: bool) {
    CALL_DETECTED.store(detected, Ordering::SeqCst);
}

/// Monotonically increasing request id for menu updates. Every menu-update
/// request bumps this and captures the new value; after the async build_menu
/// finishes, the task installs the menu only if its captured value still
/// equals MENU_GEN. This prevents two parallel updates (e.g. user clicks
/// Pause then Stop rapidly) from installing menus out of order — the older
/// task's result is discarded once a newer request has bumped the counter.
static MENU_GEN: AtomicU64 = AtomicU64::new(0);

fn next_menu_gen() -> u64 {
    MENU_GEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
}

fn current_menu_gen() -> u64 {
    MENU_GEN.load(Ordering::SeqCst)
}

#[derive(Debug, Clone)]
pub enum RecordingState {
    Stopped,
    Starting,
    Recording,
    Stopping,
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // Synchronous placeholder menu — build_menu() is async (needs the DB to
    // populate the project submenu) so we install a stub here and let
    // update_tray_menu() replace it once AppState is ready.
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("toggle_recording", "Start Recording").build(app)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItemBuilder::with_id("open_window", "Open Main Window").build(app)?)
        .item(&MenuItemBuilder::with_id("settings", "Settings").build(app)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;

    TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Meetily")
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .build(app)?;

    // Replace placeholder with the real (project-aware) menu once AppState is ready.
    update_tray_menu(app);

    Ok(())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, item_id: &str) {
    match item_id {
        // Plain "Start Recording" (no project chosen) or explicit "No project" entry
        // inside the Start submenu.
        "toggle_recording" | "start_default" => toggle_recording_handler(app, None),
        // "start_project:<project_id>" — start recording with the given project
        s if s.starts_with(START_PROJECT_PREFIX) => {
            let project_id = s[START_PROJECT_PREFIX.len()..].to_string();
            toggle_recording_handler(app, Some(project_id));
        }
        "stop_recording" => stop_recording_handler(app),
        "open_window" => focus_main_window(app),
        "settings" => {
            focus_main_window(app);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.assign('/settings')");
            }
        }
        "check_updates" => check_updates_handler(app),
        "quit" => app.exit(0),
        _ => {}
    }
}
fn toggle_recording_handler<R: Runtime>(app: &AppHandle<R>, project_id: Option<String>) {
    focus_main_window(app);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        if crate::is_recording().await {
            // Immediately show stopping state
            set_tray_state(&app_clone, RecordingState::Stopping);

            log::info!("Tray toggle: Stopping recording...");

            // Generate save path (same as RecordingControls.tsx)
            let data_dir = match app_clone.path().app_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    log::error!("Failed to get app data dir: {}", e);
                    update_tray_menu_async(&app_clone).await;
                    return;
                }
            };

            let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
            let save_path = data_dir.join(format!("recording-{}.wav", timestamp));

            // Call Rust stop_recording command (like pause/resume pattern)
            let stop_result = crate::audio::recording_commands::stop_recording(
                app_clone.clone(),
                crate::audio::recording_commands::RecordingArgs {
                    save_path: save_path.to_string_lossy().to_string(),
                },
            )
            .await;

            // Handle result
            match stop_result {
                Ok(_) => {
                    log::info!("Tray toggle: Recording stopped successfully");

                    // Trigger frontend post-processing via event (works from any page)
                    // (SQLite save, navigation, analytics)
                    if let Err(e) = app_clone.emit("recording-stop-complete", true) {
                        log::error!("Tray toggle: Failed to emit recording-stop-complete event: {}", e);
                    }
                }
                Err(e) => {
                    log::error!("Tray toggle: Failed to stop recording: {}", e);
                    // Revert tray state on error
                    update_tray_menu_async(&app_clone).await;
                }
            }
        } else {
            // Immediately show starting state
            set_tray_state(&app_clone, RecordingState::Starting);

            // If a project was chosen from the submenu, look up its folder so the
            // frontend can pass it straight to Rust without another round-trip.
            let project_folder = if let Some(ref pid) = project_id {
                load_project_folder(&app_clone, pid).await
            } else {
                None
            };

            log::info!(
                "Emitting start recording event from tray (project_id={:?}, folder={:?})",
                project_id,
                project_folder
            );
            if let Some(window) = app_clone.get_webview_window("main") {
                let _ = window.eval("sessionStorage.setItem('autoStartRecording', 'true')");

                // Pass project selection to frontend via sessionStorage. Frontend
                // useRecordingStart reads + clears these on auto-start.
                if let Some(pid) = &project_id {
                    let pid_js = escape_js_string(pid);
                    let _ = window.eval(&format!(
                        "sessionStorage.setItem('autoStartProjectId', '{}')",
                        pid_js
                    ));
                } else {
                    let _ = window.eval("sessionStorage.removeItem('autoStartProjectId')");
                }

                if let Some(folder) = &project_folder {
                    let folder_js = escape_js_string(folder);
                    let _ = window.eval(&format!(
                        "sessionStorage.setItem('autoStartProjectFolder', '{}')",
                        folder_js
                    ));
                } else {
                    let _ = window.eval("sessionStorage.removeItem('autoStartProjectFolder')");
                }

                let _ = window.eval("window.location.assign('/')");
            }
        }
    });
}

/// Escape a string for safe inclusion in a JS single-quoted literal.
fn escape_js_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

/// Load all projects from the local sqlite DB. Returns an empty vec if the
/// AppState is not yet initialised (during early startup).
async fn load_projects<R: Runtime>(
    app: &AppHandle<R>,
) -> Vec<crate::database::models::ProjectModel> {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return Vec::new();
    };
    let pool = state.db_manager.pool();
    crate::database::repositories::projects::ProjectsRepository::list_projects(pool)
        .await
        .unwrap_or_default()
}

/// Look up a single project's folder_path by id.
async fn load_project_folder<R: Runtime>(app: &AppHandle<R>, project_id: &str) -> Option<String> {
    let state = app.try_state::<crate::state::AppState>()?;
    let pool = state.db_manager.pool();
    match crate::database::repositories::projects::ProjectsRepository::get_project(pool, project_id)
        .await
    {
        Ok(Some(project)) => Some(project.folder_path),
        _ => None,
    }
}

fn stop_recording_handler<R: Runtime>(app: &AppHandle<R>) {
    // Immediately show stopping state
    set_tray_state(app, RecordingState::Stopping);

    focus_main_window(app);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        log::info!("Tray: Stopping recording...");

        // Generate save path (same as RecordingControls.tsx)
        let data_dir = match app_clone.path().app_data_dir() {
            Ok(dir) => dir,
            Err(e) => {
                log::error!("Failed to get app data dir: {}", e);
                update_tray_menu_async(&app_clone).await;
                return;
            }
        };

        let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
        let save_path = data_dir.join(format!("recording-{}.wav", timestamp));

        // Call Rust stop_recording command (like pause/resume pattern)
        let stop_result = crate::audio::recording_commands::stop_recording(
            app_clone.clone(),
            crate::audio::recording_commands::RecordingArgs {
                save_path: save_path.to_string_lossy().to_string(),
            },
        )
        .await;

        // Handle result
        match stop_result {
            Ok(_) => {
                log::info!("Tray: Recording stopped successfully");

                // Trigger frontend post-processing via event (works from any page)
                // (SQLite save, navigation, analytics)
                if let Err(e) = app_clone.emit("recording-stop-complete", true) {
                    log::error!("Tray: Failed to emit recording-stop-complete event: {}", e);
                }
            }
            Err(e) => {
                log::error!("Tray: Failed to stop recording: {}", e);
                // Revert tray state on error
                update_tray_menu_async(&app_clone).await;
            }
        }
    });
}

fn check_updates_handler<R: Runtime>(app: &AppHandle<R>) {
    focus_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(
            "window.dispatchEvent(new CustomEvent('check-updates-from-tray'))"
        );
    }
}

pub fn update_tray_menu<R: Runtime>(app: &AppHandle<R>) {
    // For sync update, spawn async task to get current state
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        // Small delay to ensure recording state has been updated
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        update_tray_menu_async(&app_clone).await;
    });
}

pub fn set_tray_state<R: Runtime>(app: &AppHandle<R>, state: RecordingState) {
    log::info!("Tray: Setting intermediate state: {:?}", state);
    // build_menu is async because it queries the DB for the project list when
    // showing the "Start Recording" submenu. Spawn a task to do it, then
    // check the generation counter before actually installing the menu so a
    // slow build can't overwrite a newer update.
    let app_clone = app.clone();
    let gen = next_menu_gen();
    tauri::async_runtime::spawn(async move {
        match build_menu(&app_clone, state, true).await {
            Ok(menu) => {
                if current_menu_gen() != gen {
                    log::debug!(
                        "Tray: discarding stale intermediate-state menu (gen {} != {})",
                        gen,
                        current_menu_gen()
                    );
                    return;
                }
                if let Some(tray) = app_clone.tray_by_id("main-tray") {
                    let _ = tray.set_menu(Some(menu));
                } else {
                    log::warn!("Tray: Could not find tray with id 'main-tray'");
                }
            }
            Err(e) => log::error!("Tray: Failed to build menu for intermediate state: {}", e),
        }
    });
}

async fn get_current_recording_state() -> RecordingState {
    // Check if currently recording
    let is_recording = crate::audio::recording_commands::is_recording().await;
    log::info!(
        "Tray: get_current_recording_state - is_recording: {}",
        is_recording
    );

    if !is_recording {
        log::info!("Tray: Recording state is Stopped");
        return RecordingState::Stopped;
    }

    log::info!("Tray: Recording state is Recording");
    RecordingState::Recording
}

/// Check if recording is allowed based on onboarding status and transcription model availability
/// Returns true if:
/// - Onboarding is complete (user may prefer Whisper later), OR
/// - Parakeet transcription model is ready (downloaded)
async fn check_can_record<R: Runtime>(app: &AppHandle<R>) -> bool {
    // First check if onboarding is complete
    let onboarding_complete = match crate::onboarding::load_onboarding_status(app).await {
        Ok(status) => status.completed,
        Err(e) => {
            log::warn!("Tray: Failed to load onboarding status: {}, assuming complete", e);
            true // Assume complete if we can't check (safe default)
        }
    };

    // If onboarding is complete, always allow recording
    // (user may prefer Whisper or have their own transcription setup)
    if onboarding_complete {
        return true;
    }

    // During onboarding, check if Parakeet transcription model is ready
    match crate::parakeet_engine::commands::parakeet_has_available_models().await {
        Ok(has_models) => has_models,
        Err(e) => {
            log::warn!("Tray: Failed to check Parakeet models: {}, assuming not ready", e);
            false
        }
    }
}

pub async fn update_tray_menu_async<R: Runtime>(app: &AppHandle<R>) {
    log::info!("Tray: update_tray_menu_async called");
    let recording_state = get_current_recording_state().await;
    let can_record = check_can_record(app).await;
    log::info!(
        "Tray: state={:?} can_record={} — building menu",
        recording_state, can_record
    );

    // Reserve a generation slot so a later set_tray_state can pre-empt this.
    let gen = next_menu_gen();
    match build_menu(app, recording_state, can_record).await {
        Ok(menu) => {
            if current_menu_gen() != gen {
                log::debug!(
                    "Tray: discarding stale full menu update (gen {} != {})",
                    gen,
                    current_menu_gen()
                );
                return;
            }
            if let Some(tray) = app.tray_by_id("main-tray") {
                let result = tray.set_menu(Some(menu));
                log::info!("Tray: Menu update result: {:?}", result);
            } else {
                log::warn!("Tray: Could not find tray with id 'main-tray'");
            }
        }
        Err(e) => log::error!("Tray: Failed to build menu: {}", e),
    }
}

async fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: RecordingState,
    can_record: bool, // True if recording is allowed (onboarding complete OR transcription model ready)
) -> tauri::Result<tauri::menu::Menu<R>> {
    let mut builder = MenuBuilder::new(app);

    // If recording is not allowed (during onboarding, no transcription model), show disabled message
    if !can_record {
        builder = builder.item(
            &MenuItemBuilder::new("⏳ Downloading transcription model...")
                .enabled(false)
                .build(app)?,
        );
    } else {
        match state {
            RecordingState::Stopped => {
                let call_detected = CALL_DETECTED.load(Ordering::SeqCst);
                let label = if call_detected {
                    "📞 Call detected — Start Recording"
                } else {
                    "Start Recording"
                };

                // If projects exist, show a submenu letting the user pick which
                // one the recording belongs to. Otherwise a plain item.
                let projects = load_projects(app).await;
                if projects.is_empty() {
                    builder = builder.item(
                        &MenuItemBuilder::with_id("toggle_recording", label).build(app)?,
                    );
                } else {
                    let mut sub = SubmenuBuilder::with_id(app, "start_submenu", label);
                    sub = sub.item(
                        &MenuItemBuilder::with_id("start_default", "No project (default folder)")
                            .build(app)?,
                    );
                    sub = sub.separator();
                    for p in &projects {
                        let id = format!("{}{}", START_PROJECT_PREFIX, p.id);
                        sub = sub.item(&MenuItemBuilder::with_id(&id, &p.name).build(app)?);
                    }
                    builder = builder.item(&sub.build()?);
                }
            }
            RecordingState::Starting => {
                builder = builder.item(
                    &MenuItemBuilder::new("🔄 Starting Recording...")
                        .enabled(false)
                        .build(app)?,
                );
            }
            RecordingState::Recording => {
                builder = builder
                    .item(&MenuItemBuilder::with_id("stop_recording", "⏹ Stop Recording").build(app)?);
            }
            RecordingState::Stopping => {
                builder = builder.item(
                    &MenuItemBuilder::new("⏹ Stopping...")
                        .enabled(false)
                        .build(app)?,
                );
            }
        }
    }

    builder
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItemBuilder::with_id("open_window", "Open Main Window").build(app)?)
        .item(&MenuItemBuilder::with_id("settings", "Settings").build(app)?)
        .item(&MenuItemBuilder::with_id("check_updates", "Check for Updates").build(app)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()
}

/// Tauri command exposed to the frontend so that after project CRUD the tray
/// "Start Recording" submenu picks up the change immediately.
#[tauri::command]
pub async fn refresh_tray_menu<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    update_tray_menu_async(&app).await;
    Ok(())
}

fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    // Restore the Dock icon before bringing the window back — symmetric to
    // the Accessory policy set in lib.rs when the window is closed.
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            log::error!("Failed to set activation policy to Regular: {}", e);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval("window.focus()");
    } else {
        log::warn!("Could not find main window");
    }
}
