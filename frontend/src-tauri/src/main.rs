#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    // Logger is installed by tauri_plugin_log inside app_lib::run() — don't
    // call env_logger::init() here or the Tauri plugin's set_logger call
    // panics with "attempted to set a logger after the logging system was
    // already initialized".
    std::env::set_var("RUST_LOG", "info");
    app_lib::run();
}
