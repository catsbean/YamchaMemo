mod commands;
mod watcher;

use std::sync::Mutex;

use commands::{AppState, WatcherState};
use tauri::Manager as _;
use tauri_specta::{collect_commands, Builder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::core_version,
        commands::set_vault,
        commands::detect_storage_dirs,
        commands::get_vault_path,
        commands::get_schemas,
        commands::notes::list_notes,
        commands::notes::note_summary,
        commands::notes::read_note,
        commands::notes::save_note,
        commands::notes::create_note,
        commands::notes::delete_note,
        commands::notes::open_today_daily,
        commands::notes::open_daily,
        commands::write_export,
        commands::notes::reading_for_book,
        commands::notes::append_reading_entry,
        commands::notes::append_daily_entry,
        commands::notes::note_blocks,
        commands::notes::change_kind,
        commands::notes::append_callout,
        commands::notes::list_callouts,
        commands::notes::add_callout,
        commands::notes::remove_callout,
        commands::notes::note_todos,
        commands::notes::toggle_todo,
        commands::notes::update_todo,
        commands::notes::delete_todo,
        commands::notes::update_entry,
        commands::notes::delete_entry,
        commands::find::search,
        commands::find::get_backlinks,
        commands::find::get_backlinks_detailed,
        commands::find::get_tags,
        commands::find::rename_tag,
        commands::preview_template,
        commands::find::notes_by_tag,
        commands::find::suggest_tags_for_text,
        commands::find::suggest_tags_batch,
        commands::find::untagged_notes,
        commands::reindex,
        commands::notes::quick_capture,
        commands::scrap::fetch_page_title,
        commands::scrap::scrape_article,
        commands::scrap::save_scrap,
        commands::files::file_index_status,
        commands::files::build_file_index,
        commands::files::drop_file_index,
        commands::files::reset_file_index,
        commands::dashboard::list_entries,
        commands::dashboard::daily_digest,
        commands::dashboard::list_open_todos,
        commands::dashboard::review_range,
        commands::notes::get_title_template,
        commands::notes::set_title_template,
        commands::notes::auto_title_note,
        commands::update::check_latest_release,
        commands::maintenance::audit_vault,
        commands::maintenance::fix_issue,
        commands::maintenance::read_raw,
        commands::maintenance::write_raw,
        commands::maintenance::list_history,
        commands::maintenance::read_history,
        commands::maintenance::restore_history,
        commands::maintenance::purge_history,
        commands::maintenance::set_history_policy,
        commands::maintenance::list_trash,
        commands::maintenance::restore_trash,
        commands::maintenance::purge_trash,
        commands::add_custom_type,
        commands::update_custom_type_template,
        commands::update_custom_type_list_fields,
        commands::remove_custom_type,
        commands::notes::rename_note,
        commands::notes::move_note,
        commands::notes::update_frontmatter,
        commands::notes::attach_cover,
        commands::notes::attach_cover_pasted,
        commands::notes::import_attachment,
        commands::notes::save_pasted_image,
        commands::books::search_books,
        commands::books::attach_cover_from_url,
        commands::books::enrich_books,
        commands::books::fetch_kyobo_meta,
        commands::books::autofill_book,
        commands::books::enrich_preview,
        commands::books::enrich_apply_one,
        commands::books::cancel_enrich,
        commands::notes::get_note_template,
        commands::notes::set_note_template,
        commands::maintenance::mirror_sync,
        commands::maintenance::mirror_resolve,
        commands::maintenance::flush_index_files,
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
        // **제일 먼저 붙인다** (플러그인 문서의 요구). 두 번째 실행은 여기서 끝나고,
        // 이미 떠 있던 창이 앞으로 나온다. 두 벌이 뜨면 뒤에 뜬 쪽이 앞선 쪽의 검색
        // 색인을 지우려 들기 때문에(tantivy 쓰기 잠금은 프로세스 하나만 쥔다), 막는 편이
        // 사용자에게도 자연스럽다 — 아이콘을 두 번 눌렀을 때 기대하는 동작이 그거다.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
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
