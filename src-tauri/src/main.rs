#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asr;
mod audio;
mod commands;
mod digital;
mod events;
mod model;
mod orchestrator;
mod source;
mod store;

use orchestrator::Orchestrator;
use store::db::Db;
use tauri::Manager;

fn main() {
    let _ = env_logger::try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db = Db::open().map_err(|e| e.to_string())?;
            app.manage(Orchestrator::new(db, app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_receiver,
            commands::update_receiver,
            commands::remove_receiver,
            commands::set_favorite,
            commands::list_receivers,
            commands::start_receiver,
            commands::stop_receiver,
            commands::tune,
            commands::set_radio_ctl,
            commands::export_log,
            commands::query_transcripts,
            commands::get_settings,
            commands::set_settings,
            commands::list_model_options,
            commands::download_model,
            commands::model_status,
            commands::partial_recordings,
            commands::set_monitor,
            commands::set_monitor_sub,
            commands::set_watched,
            commands::start_recording,
            commands::stop_recording,
            commands::recording_ids,
            commands::recordings_dir,
            commands::running_ids,
            commands::add_bookmark,
            commands::list_bookmarks,
            commands::remove_bookmark,
            commands::add_alert_rule,
            commands::list_alert_rules,
            commands::remove_alert_rule,
            commands::list_alert_hits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
