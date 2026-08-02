mod commands;
mod watcher;

use std::sync::Mutex;

use commands::{AppState, WatcherState};
use tauri_specta::{collect_commands, Builder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::core_version,
        commands::set_vault,
        commands::detect_storage_dirs,
        commands::get_vault_path,
        commands::get_schemas,
        commands::list_notes,
        commands::read_note,
        commands::save_note,
        commands::create_note,
        commands::delete_note,
        commands::open_today_daily,
        commands::open_daily,
        commands::write_export,
        commands::reading_for_book,
        commands::append_reading_entry,
        commands::append_daily_entry,
        commands::note_blocks,
        commands::change_kind,
        commands::append_callout,
        commands::list_callouts,
        commands::add_callout,
        commands::remove_callout,
        commands::note_todos,
        commands::toggle_todo,
        commands::update_todo,
        commands::delete_todo,
        commands::update_entry,
        commands::delete_entry,
        commands::search,
        commands::get_backlinks,
        commands::get_backlinks_detailed,
        commands::get_tags,
        commands::rename_tag,
        commands::preview_template,
        commands::notes_by_tag,
        commands::suggest_tags_for_text,
        commands::suggest_tags_batch,
        commands::untagged_notes,
        commands::reindex,
        commands::quick_capture,
        commands::fetch_page_title,
        commands::scrape_article,
        commands::save_scrap,
        commands::file_index_status,
        commands::build_file_index,
        commands::drop_file_index,
        commands::reset_file_index,
        commands::list_entries,
        commands::daily_digest,
        commands::list_open_todos,
        commands::get_title_template,
        commands::set_title_template,
        commands::auto_title_note,
        commands::audit_vault,
        commands::fix_issue,
        commands::read_raw,
        commands::write_raw,
        commands::list_history,
        commands::read_history,
        commands::restore_history,
        commands::purge_history,
        commands::set_history_policy,
        commands::list_trash,
        commands::restore_trash,
        commands::purge_trash,
        commands::add_custom_type,
        commands::update_custom_type_template,
        commands::remove_custom_type,
        commands::rename_note,
        commands::update_frontmatter,
        commands::attach_cover,
        commands::attach_cover_pasted,
        commands::import_attachment,
        commands::save_pasted_image,
        commands::search_books,
        commands::attach_cover_from_url,
        commands::enrich_books,
        commands::fetch_kyobo_meta,
        commands::autofill_book,
        commands::enrich_preview,
        commands::enrich_apply_one,
        commands::cancel_enrich,
        commands::get_note_template,
        commands::set_note_template,
        commands::mirror_sync,
        commands::mirror_resolve,
        commands::flush_index_files,
    ]);

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default()
                .header("// @ts-nocheck\n/* eslint-disable */"),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState(Mutex::new(None)))
        .manage(WatcherState(Mutex::new(None)))
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
