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
        .setup(|app| {
            let db = Db::open().map_err(|e| e.to_string())?;
            app.manage(Orchestrator::new(db, app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_receiver,
            commands::update_receiver,
            commands::remove_receiver,
            commands::list_receivers,
            commands::start_receiver,
            commands::stop_receiver,
            commands::query_transcripts,
            commands::get_settings,
            commands::set_settings,
            commands::list_model_options,
            commands::download_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
