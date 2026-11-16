// Rust core (PRD §6). Owns everything that touches disk.
//
// Media dropped on the canvas is copied into a content-addressed asset store
// (`<app data>/assets/<sha256>.<ext>`), so the same file dropped twice is
// stored once and boards reference assets by hash, not by machine-specific
// paths. Phase 1 moves this store inside the `.conceit` project file.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

mod ai;
mod board;

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"];
const VIDEO_EXT: &[&str] = &["mp4", "m4v", "mov", "webm", "ogv"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedMedia {
    /// "image" | "video"
    kind: &'static str,
    /// Asset id: `<sha256>.<ext>`
    asset: String,
    /// Absolute path of the stored asset (for the asset protocol).
    path: String,
    /// Original file name, shown on the card.
    name: String,
    width: Option<usize>,
    height: Option<usize>,
}

fn kind_for(ext: &str) -> Option<&'static str> {
    if IMAGE_EXT.contains(&ext) {
        Some("image")
    } else if VIDEO_EXT.contains(&ext) {
        Some("video")
    } else {
        None
    }
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut reader = BufReader::with_capacity(1 << 20, File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn import_one(src: &Path, assets_dir: &Path) -> Result<ImportedMedia, String> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or("file has no extension")?;
    let kind = kind_for(&ext).ok_or_else(|| format!("unsupported file type: .{ext}"))?;
    if !src.is_file() {
        return Err("not a file".into());
    }

    let hash = sha256_file(src).map_err(|e| format!("could not read file: {e}"))?;
    let asset = format!("{hash}.{ext}");
    let dest = assets_dir.join(&asset);
    if !dest.exists() {
        // Copy to a temp name first so a crash never leaves a half-written asset.
        let tmp = assets_dir.join(format!(".{asset}.partial"));
        fs::copy(src, &tmp).map_err(|e| format!("could not copy file: {e}"))?;
        fs::rename(&tmp, &dest).map_err(|e| format!("could not store file: {e}"))?;
    }

    let (width, height) = if kind == "image" {
        imagesize::size(&dest)
            .map(|s| (Some(s.width), Some(s.height)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    Ok(ImportedMedia {
        kind,
        asset,
        path: dest.to_string_lossy().into_owned(),
        name: src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        width,
        height,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    imported: Vec<ImportedMedia>,
    /// (file name, reason) for each file that was skipped.
    skipped: Vec<(String, String)>,
}

/// Copy dropped files into the asset store. Runs off the main thread, since
/// hashing a large video can take a few seconds.
#[tauri::command]
async fn import_media(app: AppHandle, paths: Vec<PathBuf>) -> Result<ImportResult, String> {
    let assets_dir = assets_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut imported = Vec::new();
        let mut skipped = Vec::new();
        for p in paths {
            match import_one(&p, &assets_dir) {
                Ok(m) => imported.push(m),
                Err(reason) => skipped.push((
                    p.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| p.to_string_lossy().into_owned()),
                    reason,
                )),
            }
        }
        ImportResult { imported, skipped }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Absolute path of the asset store, so the frontend can build asset URLs.
#[tauri::command]
fn assets_path(app: AppHandle) -> Result<String, String> {
    Ok(assets_dir(&app)?.to_string_lossy().into_owned())
}

/// A plain asset store file name: `<64 hex chars>.<ext>`. Rejects anything that
/// could reach outside the store (separators, `..`).
pub(crate) fn is_asset_name(name: &str) -> bool {
    match name.split_once('.') {
        Some((hash, ext)) => {
            hash.len() == 64
                && hash.chars().all(|c| c.is_ascii_hexdigit())
                && !ext.is_empty()
                && ext.len() <= 8
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// File contents for export, as base64 (arrives intact whether Tauri's IPC
/// uses its binary channel or the postMessage fallback used in dev).
#[derive(Serialize)]
struct Blob64 {
    mime: String,
    data: String,
}

fn mime_for(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        _ => "application/octet-stream",
    }
}

/// One stored asset, for export: the webview can't read asset:// URLs itself.
#[tauri::command]
async fn read_asset(app: AppHandle, asset: String, max_bytes: Option<u64>) -> Result<Blob64, String> {
    if !is_asset_name(&asset) {
        return Err(format!("not an asset: {asset}"));
    }
    let path = assets_dir(&app)?.join(&asset);
    let len = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if max_bytes.is_some_and(|m| len > m) {
        return Err(format!("{asset} is too large ({len} bytes)"));
    }
    let ext = asset.rsplit('.').next().unwrap_or_default().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        Ok(Blob64 { mime: mime_for(&ext).into(), data: B64.encode(bytes) })
    })
    .await
    .map_err(|e| e.to_string())?
}

const MAX_WEB_IMAGE: usize = 50 * 1024 * 1024;

/// Download a web image for export when its site doesn't allow the webview to
/// read it (no CORS header, e.g. Pinterest). Images only, http(s) only, ≤ 50 MB.
async fn download_image(url: &str) -> Result<(String, Vec<u8>), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) links can be downloaded".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status()));
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !mime.starts_with("image/") {
        return Err(format!("not an image ({mime})"));
    }
    if res.content_length().is_some_and(|n| n as usize > MAX_WEB_IMAGE) {
        return Err("image is larger than 50 MB".into());
    }
    let mut bytes = Vec::new();
    let mut stream = res.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        if bytes.len() > MAX_WEB_IMAGE {
            return Err("image is larger than 50 MB".into());
        }
    }
    Ok((mime, bytes))
}

#[tauri::command]
async fn fetch_image(url: String) -> Result<Blob64, String> {
    let (mime, bytes) = download_image(&url).await?;
    Ok(Blob64 { mime, data: B64.encode(bytes) })
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        _ => return None,
    })
}

/// Save a copy of a web image into the asset store, so the board keeps it if
/// the link dies (it then also goes into the board file). Returns the asset id.
#[tauri::command]
async fn cache_web_image(app: AppHandle, url: String) -> Result<String, String> {
    let (mime, bytes) = download_image(&url).await?;
    let ext = ext_for_mime(&mime).ok_or_else(|| format!("unsupported image type ({mime})"))?;
    let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let asset = format!("{hash}.{ext}");
    let dir = assets_dir(&app)?;
    let dest = dir.join(&asset);
    if !dest.exists() {
        let tmp = dir.join(format!(".{asset}.partial"));
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    }
    Ok(asset)
}

pub(crate) fn assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("assets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Set once the webview has saved everything and agreed to quit.
#[derive(Default)]
struct Quitting(AtomicBool);

/// The webview finished saving: really quit now.
#[tauri::command]
fn app_quit_now(app: AppHandle) {
    app.state::<Quitting>().0.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Ask the webview to save before quitting, with a fallback if it doesn't answer.
fn request_quit(app: &AppHandle) {
    let _ = app.emit("app-will-quit", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        handle.state::<Quitting>().0.store(true, Ordering::SeqCst);
        handle.exit(0);
    });
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Conceit",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("board:new", "New Board", Some("CmdOrCtrl+N"))?,
            &item("board:open", "Open…", Some("CmdOrCtrl+O"))?,
            &item("board:home", "All Boards", Some("CmdOrCtrl+Shift+H"))?,
            &sep()?,
            &item("board:close", "Close Board", Some("CmdOrCtrl+W"))?,
            &item("board:rename", "Rename…", None)?,
            &item("board:copy", "Save a Copy…", Some("CmdOrCtrl+Shift+S"))?,
            &item("board:reveal", "Show in Finder", None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Export and board files: native open/save dialogs.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ai::AiState::default())
        .manage(board::BoardState::default())
        .manage(board::PendingOpen::default())
        .manage(Quitting::default())
        .setup(|app| {
            let handle = app.handle();
            app.set_menu(build_menu(handle)?)?;
            app.on_menu_event(|app, e| {
                let _ = app.emit("menu", e.id().as_ref());
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window quits: let the webview save first.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !app.state::<Quitting>().0.load(Ordering::SeqCst) {
                    api.prevent_close();
                    request_quit(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            import_media,
            assets_path,
            read_asset,
            fetch_image,
            cache_web_image,
            app_quit_now,
            board::board_create,
            board::board_open,
            board::board_close,
            board::board_append,
            board::board_compact,
            board::board_store_assets,
            board::board_set_preview,
            board::board_rename,
            board::board_save_copy,
            board::board_peek,
            board::board_default_dir,
            board::board_import_legacy,
            board::board_take_pending,
            board::chat_list,
            board::chat_load,
            board::chat_save,
            board::chat_delete,
            ai::ai_status,
            ai::ai_set_api_key,
            ai::ai_chat,
            ai::ai_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // ⌘Q: save first (app.exit from app_quit_now passes a code and goes through).
            tauri::RunEvent::ExitRequested { api, code: None, .. } => {
                if !app.state::<Quitting>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_quit(app);
                }
            }
            // Double-click in Finder / drop on the Dock icon.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter(|p| p.extension().is_some_and(|e| e == board::EXT))
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if let Some(last) = paths.last() {
                    if let Ok(mut v) = app.state::<board::PendingOpen>().0.lock() {
                        v.push(last.clone());
                    }
                    let _ = app.emit("board-open-request", last.clone());
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_cannot_escape_the_store() {
        let ok = format!("{}.png", "a".repeat(64));
        assert!(is_asset_name(&ok));
        assert!(!is_asset_name("../secret.png"));
        assert!(!is_asset_name(&format!("{}.png/../x", "a".repeat(64))));
        assert!(!is_asset_name(&format!("{}.", "a".repeat(64))));
        assert!(!is_asset_name("abc.png"));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("conceit-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn imports_image_by_content_hash_and_dedupes() {
        let dir = temp_dir("dedupe");
        let assets = dir.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let icon = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png");
        let a = dir.join("first.PNG");
        let b = dir.join("copy.png");
        fs::copy(&icon, &a).unwrap();
        fs::copy(&icon, &b).unwrap();

        let m1 = import_one(&a, &assets).unwrap();
        let m2 = import_one(&b, &assets).unwrap();
        assert_eq!(m1.kind, "image");
        assert_eq!(m1.asset, m2.asset, "same bytes → same asset id");
        assert!(m1.asset.ends_with(".png") && m1.asset.len() == 64 + 4);
        assert_eq!((m1.width, m1.height), (Some(32), Some(32)));
        assert_eq!(m1.name, "first.PNG");
        assert_eq!(fs::read_dir(&assets).unwrap().count(), 1, "stored once, no temp files left");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unsupported_files() {
        let dir = temp_dir("reject");
        let pdf = dir.join("notes.pdf");
        fs::write(&pdf, b"%PDF").unwrap();
        let err = import_one(&pdf, &dir).err().unwrap();
        assert!(err.contains("unsupported"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_is_classified_without_dimensions() {
        let dir = temp_dir("video");
        let mov = dir.join("clip.mov");
        fs::write(&mov, b"not really a movie").unwrap();
        let m = import_one(&mov, &dir).unwrap();
        assert_eq!(m.kind, "video");
        assert_eq!(m.width, None);
        let _ = fs::remove_dir_all(&dir);
    }
}
