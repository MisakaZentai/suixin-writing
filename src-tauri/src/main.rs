#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;

use keyring::Entry;
use std::sync::Arc;

/// API Key 等机密信息的系统级安全存储（spec §7：Key 不落工程文件，存系统安全区）。
/// service 名固定为 "ai-writer"（沿用旧名，改名会让已保存的 Key 失联），
/// name 由前端传入（如 "apiKey:deepseek"）。
const KEYRING_SERVICE: &str = "ai-writer";

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, name).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_secret(name: String) -> Result<Option<String>, String> {
    let entry = entry(&name)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_secret(name: String, value: String) -> Result<(), String> {
    entry(&name)?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_secret(name: String) -> Result<(), String> {
    let entry = entry(&name)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // AI 请求由 Rust 侧发出：不受 WebView 跨域限制，服务端报错也能读到
        .plugin(tauri_plugin_http::init())
        .manage(Arc::new(bridge::Bridge::new()))
        .setup(|app| {
            // 实时桥开不起来不影响写作：agent 退回直接读写文件
            if let Err(e) = bridge::start(app.handle()) {
                eprintln!("实时桥未启动：{e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_secret,
            write_secret,
            delete_secret,
            bridge::bridge_ready,
            bridge::bridge_respond,
            bridge::bridge_publish
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                bridge::cleanup(app);
            }
        });
}
