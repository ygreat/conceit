// Board files (PRD §4.1, §6). One board = one `.conceit` file the user owns.
//
// The file is a SQLite database ("SQLite as an application file format"):
// every autosave writes only what changed, it survives a crash mid-save, and
// it is still a single file to copy, mail or sync. It holds:
//
// - `updates`: the board as a log of Yjs updates (append-only between
//   compactions). This is the same unit a sync server exchanges, so making a
//   board collaborative later means connecting this log to a server rather than
//   changing the format.
// - `assets` / `asset_chunks`: every local picture and video the board uses,
//   content-addressed (`<sha256>.<ext>`, same ids as the app's asset store) and
//   stored in 8 MB chunks. Collaborators can later fetch them by hash.
// - `chats`: AI conversations about this board, kept outside the Yjs document
//   (they are personal, not shared board content) and tagged with an author.
// - `meta`: a permanent board id (separate from the file name), title, preview.
//
// While a board is open, its assets are also unpacked into the app's asset
// store (a cache), so the webview keeps loading media through asset:// URLs.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// `PRAGMA application_id`: "Cnct". Lets us tell our files from other SQLite files.
const APP_ID: i32 = 0x436E_6374;
/// File format version (`PRAGMA user_version`).
const FORMAT: i32 = 1;
const CHUNK: usize = 8 * 1024 * 1024;
pub const EXT: &str = "conceit";

pub struct OpenBoard {
    pub path: PathBuf,
    conn: Connection,
    id: String,
}

#[derive(Default, Clone)]
pub struct BoardState(Arc<Mutex<Option<OpenBoard>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoardInfo {
    pub path: String,
    pub id: String,
    pub title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    info: BoardInfo,
    /// Yjs updates, base64, in order.
    updates: Vec<String>,
    /// Highest update sequence number (for compaction).
    last_seq: i64,
    /// Asset ids stored in the file.
    assets: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peek {
    path: String,
    id: String,
    title: String,
    /// Milliseconds since the epoch.
    updated: i64,
    /// JSON written by the app: card rectangles and colors for a thumbnail.
    preview: Option<String>,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    id: String,
    title: String,
    author: String,
    created: i64,
    updated: i64,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- File format

fn init_schema(conn: &Connection, title: &str) -> rusqlite::Result<String> {
    // auto_vacuum must be set before the first table exists: lets the file
    // shrink after big videos are removed.
    conn.execute_batch(
        "PRAGMA auto_vacuum = INCREMENTAL;
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL, at INTEGER NOT NULL);
         CREATE TABLE assets (id TEXT PRIMARY KEY, size INTEGER NOT NULL, chunks INTEGER NOT NULL, added INTEGER NOT NULL);
         CREATE TABLE asset_chunks (id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, idx));
         CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
                             created INTEGER NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);",
    )?;
    conn.pragma_update(None, "application_id", APP_ID)?;
    conn.pragma_update(None, "user_version", FORMAT)?;
    let id = uuid::Uuid::new_v4().to_string();
    let t = now().to_string();
    for (k, v) in [("id", id.as_str()), ("title", title), ("created", &t), ("updated", &t), ("app", env!("CARGO_PKG_VERSION"))] {
        conn.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", params![k, v])?;
    }
    Ok(id)
}

fn check_format(conn: &Connection) -> Result<(), String> {
    let app: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0)).map_err(|_| "Not a Conceit board.")?;
    if app != APP_ID {
        return Err("Not a Conceit board.".into());
    }
    let v: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(err)?;
    if v > FORMAT {
        return Err("This board was made by a newer version of Conceit. Update the app to open it.".into());
    }
    Ok(())
}

fn meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn touch(conn: &Connection) -> rusqlite::Result<()> {
    set_meta(conn, "updated", &now().to_string())
}

fn open_conn(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err("The file isn't there any more.".into());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("Couldn't open the board: {e}"))?;
    check_format(&conn)?;
    // Rollback journal (not WAL): no side files next to the board between saves,
    // so it stays one file even while open (important for Dropbox/iCloud).
    conn.pragma_update(None, "journal_mode", "DELETE").map_err(err)?;
    conn.busy_timeout(std::time::Duration::from_secs(3)).map_err(err)?;
    Ok(conn)
}

fn title_from_path(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into())
}

fn info(b: &OpenBoard) -> BoardInfo {
    BoardInfo { path: b.path.to_string_lossy().into_owned(), id: b.id.clone(), title: title_from_path(&b.path) }
}

/// `Name.conceit`, `Name 2.conceit`, … the first that doesn't exist in `dir`.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let clean: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '-' } else { c })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .chars()
        .take(120)
        .collect();
    let base = if clean.is_empty() { "Untitled".to_string() } else { clean };
    let mut p = dir.join(format!("{base}.{EXT}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{base} {n}.{EXT}"));
        n += 1;
    }
    p
}

pub fn create_at(path: &Path, title: &str) -> Result<OpenBoard, String> {
    if path.exists() {
        return Err("A file with that name already exists.".into());
    }
    // Build it under a temporary name, then move it into place: a crash never
    // leaves a half-made board behind.
    let tmp = path.with_extension(format!("{EXT}.partial"));
    let _ = fs::remove_file(&tmp);
    {
        let conn = Connection::open(&tmp).map_err(err)?;
        init_schema(&conn, title).map_err(err)?;
    }
    fs::rename(&tmp, path).map_err(err)?;
    open_at(path)
}

pub fn open_at(path: &Path) -> Result<OpenBoard, String> {
    let conn = open_conn(path)?;
    let id = meta(&conn, "id").map_err(err)?.ok_or("The board has no id.")?;
    Ok(OpenBoard { path: path.to_path_buf(), conn, id })
}

impl OpenBoard {
    pub fn load(&self) -> Result<(Vec<Vec<u8>>, i64), String> {
        let mut st = self.conn.prepare("SELECT seq, data FROM updates ORDER BY seq").map_err(err)?;
        let mut last = 0;
        let mut out = Vec::new();
        let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).map_err(err)?;
        for row in rows {
            let (seq, data) = row.map_err(err)?;
            last = seq;
            out.push(data);
        }
        Ok((out, last))
    }

    pub fn append(&self, update: &[u8]) -> Result<i64, String> {
        self.conn.execute("INSERT INTO updates (data, at) VALUES (?1, ?2)", params![update, now()]).map_err(err)?;
        let seq = self.conn.last_insert_rowid();
        touch(&self.conn).map_err(err)?;
        Ok(seq)
    }

    /// Replace updates up to `upto` with one snapshot (same seq, so later
    /// updates still apply after it), and drop assets nothing uses any more.
    pub fn compact(&mut self, snapshot: &[u8], upto: i64, keep_assets: Option<&[String]>) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(err)?;
        tx.execute("DELETE FROM updates WHERE seq <= ?1", [upto]).map_err(err)?;
        tx.execute("INSERT INTO updates (seq, data, at) VALUES (?1, ?2, ?3)", params![upto.max(1), snapshot, now()]).map_err(err)?;
        if let Some(keep) = keep_assets {
            let stored: Vec<String> = {
                let mut st = tx.prepare("SELECT id FROM assets").map_err(err)?;
                st.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?
            };
            for id in stored.iter().filter(|id| !keep.contains(id)) {
                tx.execute("DELETE FROM asset_chunks WHERE id = ?1", [id]).map_err(err)?;
                tx.execute("DELETE FROM assets WHERE id = ?1", [id]).map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
        // Each step frees one page: run it to the end so the file shrinks.
        let mut st = self.conn.prepare("PRAGMA incremental_vacuum").map_err(err)?;
        let mut rows = st.query([]).map_err(err)?;
        while rows.next().map_err(err)?.is_some() {}
        Ok(())
    }

    pub fn asset_ids(&self) -> Result<Vec<String>, String> {
        let mut st = self.conn.prepare("SELECT id FROM assets").map_err(err)?;
        let ids = st.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
        Ok(ids)
    }

    fn has_asset(&self, id: &str) -> Result<bool, String> {
        Ok(self.conn.query_row("SELECT 1 FROM assets WHERE id = ?1", [id], |_| Ok(())).optional().map_err(err)?.is_some())
    }

    /// Copy assets from the app's store into the file. Returns the ids found in
    /// neither place (missing media).
    pub fn store_assets(&mut self, ids: &[String], cache: &Path) -> Result<Vec<String>, String> {
        let mut missing = Vec::new();
        for id in ids {
            if !crate::is_asset_name(id) || self.has_asset(id)? {
                continue;
            }
            let src = cache.join(id);
            let Ok(mut f) = File::open(&src) else {
                missing.push(id.clone());
                continue;
            };
            let tx = self.conn.transaction().map_err(err)?;
            let mut buf = vec![0u8; CHUNK];
            let (mut idx, mut size) = (0i64, 0i64);
            loop {
                let n = read_full(&mut f, &mut buf).map_err(err)?;
                if n == 0 {
                    break;
                }
                tx.execute("INSERT INTO asset_chunks (id, idx, data) VALUES (?1, ?2, ?3)", params![id, idx, &buf[..n]]).map_err(err)?;
                idx += 1;
                size += n as i64;
            }
            tx.execute("INSERT INTO assets (id, size, chunks, added) VALUES (?1, ?2, ?3, ?4)", params![id, size, idx, now()]).map_err(err)?;
            tx.commit().map_err(err)?;
        }
        Ok(missing)
    }

    /// Unpack the file's assets into the app's store (skipping ones already there).
    pub fn extract_assets(&self, cache: &Path) -> Result<(), String> {
        for id in self.asset_ids()? {
            if !crate::is_asset_name(&id) {
                continue;
            }
            let dest = cache.join(&id);
            if dest.exists() {
                continue;
            }
            let tmp = cache.join(format!(".{id}.partial"));
            {
                let mut out = File::create(&tmp).map_err(err)?;
                let mut st = self.conn.prepare("SELECT data FROM asset_chunks WHERE id = ?1 ORDER BY idx").map_err(err)?;
                let rows = st.query_map([&id], |r| r.get::<_, Vec<u8>>(0)).map_err(err)?;
                for chunk in rows {
                    out.write_all(&chunk.map_err(err)?).map_err(err)?;
                }
                out.sync_all().map_err(err)?;
            }
            fs::rename(&tmp, &dest).map_err(err)?;
        }
        Ok(())
    }

    // --- chats

    pub fn chat_list(&self) -> Result<Vec<ChatMeta>, String> {
        let mut st = self.conn.prepare("SELECT id, title, author, created, updated FROM chats ORDER BY updated DESC").map_err(err)?;
        let rows = st
            .query_map([], |r| Ok(ChatMeta { id: r.get(0)?, title: r.get(1)?, author: r.get(2)?, created: r.get(3)?, updated: r.get(4)? }))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        Ok(rows)
    }

    pub fn chat_load(&self, id: &str) -> Result<Option<String>, String> {
        self.conn.query_row("SELECT data FROM chats WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(err)
    }

    pub fn chat_save(&self, id: &str, title: &str, author: &str, data: &str) -> Result<(), String> {
        let t = now();
        self.conn
            .execute(
                "INSERT INTO chats (id, title, author, created, updated, data) VALUES (?1, ?2, ?3, ?4, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated = excluded.updated, data = excluded.data",
                params![id, title, author, t, data],
            )
            .map_err(err)?;
        Ok(())
    }

    pub fn chat_delete(&self, id: Option<&str>) -> Result<(), String> {
        match id {
            Some(id) => self.conn.execute("DELETE FROM chats WHERE id = ?1", [id]),
            None => self.conn.execute("DELETE FROM chats", []),
        }
        .map_err(err)?;
        Ok(())
    }

    /// A standalone copy at `dest` with a new board id (it is a new board from
    /// now on), optionally without the AI chats.
    pub fn save_copy(&self, dest: &Path, include_chats: bool) -> Result<(), String> {
        if dest.exists() {
            fs::remove_file(dest).map_err(err)?; // the save dialog already asked to replace it
        }
        self.conn.execute("VACUUM INTO ?1", [dest.to_string_lossy()]).map_err(err)?;
        let copy = Connection::open(dest).map_err(err)?;
        set_meta(&copy, "copy_of", &self.id).map_err(err)?;
        set_meta(&copy, "id", &uuid::Uuid::new_v4().to_string()).map_err(err)?;
        set_meta(&copy, "title", &title_from_path(dest)).map_err(err)?;
        if !include_chats {
            copy.execute("DELETE FROM chats", []).map_err(err)?;
            copy.execute_batch("VACUUM;").map_err(err)?;
        }
        Ok(())
    }
}

fn read_full(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        let r = f.read(&mut buf[n..])?;
        if r == 0 {
            break;
        }
        n += r;
    }
    Ok(n)
}

pub fn peek(path: &Path) -> Result<Peek, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| "The file isn't there any more.")?;
    check_format(&conn)?;
    Ok(Peek {
        path: path.to_string_lossy().into_owned(),
        id: meta(&conn, "id").map_err(err)?.unwrap_or_default(),
        title: title_from_path(path),
        updated: meta(&conn, "updated").map_err(err)?.and_then(|s| s.parse().ok()).unwrap_or(0),
        preview: meta(&conn, "preview").map_err(err)?,
        bytes: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    })
}

// ---------------------------------------------------------------- Commands

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::assets_dir(app)
}

/// `~/Documents/Conceit`: where new boards go.
fn boards_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().document_dir().map_err(err)?.join("Conceit");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Run `f` on the open board off the main thread.
async fn with_board<T: Send + 'static>(
    state: &BoardState,
    f: impl FnOnce(&mut OpenBoard) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let s = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = s.0.lock().map_err(err)?;
        let b = guard.as_mut().ok_or("No board is open.")?;
        f(b)
    })
    .await
    .map_err(err)?
}

fn finish_open(app: &AppHandle, state: &BoardState, b: OpenBoard) -> Result<Loaded, String> {
    b.extract_assets(&cache_dir(app)?)?;
    let (updates, last_seq) = b.load()?;
    let loaded = Loaded {
        info: info(&b),
        updates: updates.iter().map(|u| B64.encode(u)).collect(),
        last_seq,
        assets: b.asset_ids()?,
    };
    *state.0.lock().map_err(err)? = Some(b);
    Ok(loaded)
}

/// A new board. Without a path it goes to ~/Documents/Conceit as "Untitled".
#[tauri::command]
pub async fn board_create(app: AppHandle, state: State<'_, BoardState>, title: Option<String>, path: Option<PathBuf>) -> Result<Loaded, String> {
    let dir = boards_dir(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = match path {
            Some(p) => p,
            None => unique_path(&dir, title.as_deref().unwrap_or("Untitled")),
        };
        let b = create_at(&path, &title_from_path(&path))?;
        finish_open(&app, &state, b)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn board_open(app: AppHandle, state: State<'_, BoardState>, path: PathBuf) -> Result<Loaded, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        *state.0.lock().map_err(err)? = None; // close the previous one first
        let b = open_at(&path)?;
        finish_open(&app, &state, b)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn board_close(state: State<'_, BoardState>) -> Result<(), String> {
    *state.0.lock().map_err(err)? = None;
    Ok(())
}

#[tauri::command]
pub async fn board_append(state: State<'_, BoardState>, update: String) -> Result<i64, String> {
    let bytes = B64.decode(update).map_err(err)?;
    with_board(state.inner(), move |b| b.append(&bytes)).await
}

#[tauri::command]
pub async fn board_compact(state: State<'_, BoardState>, snapshot: String, upto: i64, keep_assets: Option<Vec<String>>) -> Result<(), String> {
    let bytes = B64.decode(snapshot).map_err(err)?;
    with_board(state.inner(), move |b| b.compact(&bytes, upto, keep_assets.as_deref())).await
}

/// Make sure the file holds these assets. Returns the ones that can't be found.
#[tauri::command]
pub async fn board_store_assets(app: AppHandle, state: State<'_, BoardState>, ids: Vec<String>) -> Result<Vec<String>, String> {
    let cache = cache_dir(&app)?;
    with_board(state.inner(), move |b| b.store_assets(&ids, &cache)).await
}

#[tauri::command]
pub async fn board_set_preview(state: State<'_, BoardState>, preview: String) -> Result<(), String> {
    with_board(state.inner(), move |b| set_meta(&b.conn, "preview", &preview).map_err(err)).await
}

/// Rename the file (the title is the file name). Returns the new info.
#[tauri::command]
pub async fn board_rename(state: State<'_, BoardState>, title: String) -> Result<BoardInfo, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.0.lock().map_err(err)?;
        let b = guard.take().ok_or("No board is open.")?;
        let old = b.path.clone();
        let dir = old.parent().ok_or("No folder")?.to_path_buf();
        let target = unique_path(&dir, &title);
        // Close before moving: SQLite names its journal after the path it opened.
        drop(b);
        let result = fs::rename(&old, &target);
        let reopened = open_at(if result.is_ok() { &target } else { &old })?;
        let _ = set_meta(&reopened.conn, "title", &title_from_path(&reopened.path));
        let i = info(&reopened);
        *guard = Some(reopened);
        result.map_err(|e| format!("Couldn't rename: {e}"))?;
        Ok(i)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn board_save_copy(state: State<'_, BoardState>, dest: PathBuf, include_chats: bool) -> Result<(), String> {
    with_board(state.inner(), move |b| b.save_copy(&dest, include_chats)).await
}

#[tauri::command]
pub async fn board_peek(paths: Vec<PathBuf>) -> Result<Vec<Result<Peek, String>>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| peek(p)).collect()).await.map_err(err)
}

#[tauri::command]
pub fn board_default_dir(app: AppHandle) -> Result<String, String> {
    Ok(boards_dir(&app)?.to_string_lossy().into_owned())
}

/// Bring the board kept in the webview's localStorage (before board files
/// existed) into a file. `update` is the whole Yjs state. Safe to call more
/// than once (e.g. the page reloads mid-way): the file remembers a hash of
/// what it was made from, and a second call opens that file instead.
#[tauri::command]
pub async fn board_import_legacy(app: AppHandle, state: State<'_, BoardState>, update: String) -> Result<Loaded, String> {
    let bytes = B64.decode(update).map_err(err)?;
    let dir = boards_dir(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let b = import_legacy(&dir, &bytes)?;
        finish_open(&app, &state, b)
    })
    .await
    .map_err(err)?
}

static LEGACY: Mutex<()> = Mutex::new(());

pub fn import_legacy(dir: &Path, bytes: &[u8]) -> Result<OpenBoard, String> {
    use sha2::{Digest, Sha256};
    let _one_at_a_time = LEGACY.lock().map_err(err)?;
    let hash: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_none_or(|x| x != EXT) {
                continue;
            }
            let Ok(conn) = Connection::open_with_flags(&p, OpenFlags::SQLITE_OPEN_READ_ONLY) else { continue };
            if meta(&conn, "legacy_hash").ok().flatten().as_deref() == Some(hash.as_str()) {
                drop(conn);
                return open_at(&p);
            }
        }
    }
    let path = unique_path(dir, "My first board");
    let b = create_at(&path, "My first board")?;
    b.append(bytes)?;
    set_meta(&b.conn, "legacy_hash", &hash).map_err(err)?;
    Ok(b)
}

#[tauri::command]
pub async fn chat_list(state: State<'_, BoardState>) -> Result<Vec<ChatMeta>, String> {
    with_board(state.inner(), |b| b.chat_list()).await
}

#[tauri::command]
pub async fn chat_load(state: State<'_, BoardState>, id: String) -> Result<Option<String>, String> {
    with_board(state.inner(), move |b| b.chat_load(&id)).await
}

#[tauri::command]
pub async fn chat_save(state: State<'_, BoardState>, id: String, title: String, author: String, data: String) -> Result<(), String> {
    with_board(state.inner(), move |b| b.chat_save(&id, &title, &author, &data)).await
}

#[tauri::command]
pub async fn chat_delete(state: State<'_, BoardState>, id: Option<String>) -> Result<(), String> {
    with_board(state.inner(), move |b| b.chat_delete(id.as_deref())).await
}

// ---------------------------------------------------------------- Opening from Finder

/// Board files the OS asked us to open (double-click, drag onto the Dock icon)
/// before the webview was ready to take them.
#[derive(Default)]
pub struct PendingOpen(pub Mutex<Vec<String>>);

#[tauri::command]
pub fn board_take_pending(pending: State<'_, PendingOpen>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut v| v.pop())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("conceit-board-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn create_append_reopen_and_compact() {
        let dir = temp_dir("roundtrip");
        let path = unique_path(&dir, "Moodboard");
        assert_eq!(path.file_name().unwrap(), "Moodboard.conceit");
        let b = create_at(&path, "Moodboard").unwrap();
        let id = b.id.clone();
        b.append(b"one").unwrap();
        let s2 = b.append(b"two").unwrap();
        b.append(b"three").unwrap();
        drop(b);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "one file, no journal or temp file left");
        assert_eq!(unique_path(&dir, "Moodboard").file_name().unwrap(), "Moodboard 2.conceit");

        let mut b = open_at(&path).unwrap();
        assert_eq!(b.id, id, "id survives reopening");
        let (u, last) = b.load().unwrap();
        assert_eq!(u, vec![b"one".to_vec(), b"two".to_vec(), b"three".to_vec()]);
        b.compact(b"snap12", s2, None).unwrap();
        let (u, last2) = b.load().unwrap();
        assert_eq!(u, vec![b"snap12".to_vec(), b"three".to_vec()], "snapshot keeps its place before later updates");
        assert_eq!(last, last2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_other_files_and_names_are_safe() {
        let dir = temp_dir("reject");
        let other = dir.join("x.conceit");
        Connection::open(&other).unwrap().execute_batch("CREATE TABLE t (a);").unwrap();
        assert!(open_at(&other).err().unwrap().contains("Not a Conceit board"));
        let txt = dir.join("y.conceit");
        fs::write(&txt, "hello").unwrap();
        assert!(open_at(&txt).is_err());
        assert_eq!(unique_path(&dir, "../../etc/passwd").parent().unwrap(), dir);
        assert_eq!(unique_path(&dir, "  ").file_name().unwrap(), "Untitled.conceit");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn assets_go_into_the_file_and_come_back_out() {
        let dir = temp_dir("assets");
        let cache = dir.join("cache");
        fs::create_dir_all(&cache).unwrap();
        // ~20 MB so it spans three chunks.
        let bytes: Vec<u8> = (0..20_000_000u32).map(|i| (i % 251) as u8).collect();
        let id = format!("{}.mp4", "a".repeat(64));
        fs::write(cache.join(&id), &bytes).unwrap();
        let gone = format!("{}.png", "b".repeat(64));

        let path = dir.join("b.conceit");
        let mut b = create_at(&path, "b").unwrap();
        let missing = b.store_assets(&[id.clone(), gone.clone(), "../evil".into()], &cache).unwrap();
        assert_eq!(missing, vec![gone.clone()]);
        assert!(b.store_assets(&[id.clone()], &cache).unwrap().is_empty(), "storing twice is a no-op");
        let chunks: i64 = b.conn.query_row("SELECT chunks FROM assets", [], |r| r.get(0)).unwrap();
        assert_eq!(chunks, 3);

        // Another machine: empty cache.
        let cache2 = dir.join("cache2");
        fs::create_dir_all(&cache2).unwrap();
        b.extract_assets(&cache2).unwrap();
        assert_eq!(fs::read(cache2.join(&id)).unwrap(), bytes);

        // Compaction drops assets nothing uses, and the file shrinks.
        let before = fs::metadata(&path).unwrap().len();
        b.compact(b"s", 1, Some(&[])).unwrap();
        assert!(b.asset_ids().unwrap().is_empty());
        assert!(fs::metadata(&path).unwrap().len() < before / 4, "file shrank after removing the video");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn moving_the_old_board_in_happens_once() {
        let dir = temp_dir("legacy");
        let a = import_legacy(&dir, b"old board").unwrap();
        let b = import_legacy(&dir, b"old board").unwrap();
        assert_eq!(a.path, b.path, "a second attempt reopens the same file");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        // Concurrent attempts (several page loads at once) also make one file.
        drop((a, b));
        let d2 = dir.join("concurrent");
        fs::create_dir_all(&d2).unwrap();
        let handles: Vec<_> = (0..4).map(|_| { let d = d2.clone(); std::thread::spawn(move || import_legacy(&d, b"x").map(|b| b.path)) }).collect();
        let paths: Vec<_> = handles.into_iter().map(|h| h.join().unwrap().unwrap()).collect();
        assert!(paths.windows(2).all(|w| w[0] == w[1]));
        assert_eq!(fs::read_dir(&d2).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn chats_and_copies() {
        let dir = temp_dir("chats");
        let path = dir.join("c.conceit");
        let b = create_at(&path, "c").unwrap();
        b.append(b"state").unwrap();
        b.chat_save("c1", "First", "me", "[1]").unwrap();
        b.chat_save("c1", "First!", "me", "[1,2]").unwrap();
        b.chat_save("c2", "Second", "me", "[]").unwrap();
        assert_eq!(b.chat_list().unwrap().len(), 2);
        assert_eq!(b.chat_load("c1").unwrap().as_deref(), Some("[1,2]"));

        let shared = dir.join("For client.conceit");
        b.save_copy(&shared, false).unwrap();
        let c = open_at(&shared).unwrap();
        assert_ne!(c.id, b.id, "a copy is a new board");
        assert!(c.chat_list().unwrap().is_empty(), "chats left out");
        assert_eq!(c.load().unwrap().0, vec![b"state".to_vec()]);
        assert_eq!(peek(&shared).unwrap().title, "For client");

        let mine = dir.join("Backup.conceit");
        b.save_copy(&mine, true).unwrap();
        assert_eq!(open_at(&mine).unwrap().chat_list().unwrap().len(), 2);
        b.chat_delete(None).unwrap();
        assert!(b.chat_list().unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
