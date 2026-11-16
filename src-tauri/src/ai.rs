// AI gateway (PRD §5.2, §6). The webview never talks to a model provider:
// it sends the board context here, and this module forwards it to whichever
// access the user brought:
//
// - `claude-cli`  the user's installed, logged-in Claude Code (headless `-p`)
// - `codex-cli`   the user's installed, logged-in Codex CLI (`codex exec`)
// - `anthropic-api` an Anthropic API key (BYOK), kept in the OS keychain and
//                 never handed back to the webview
//
// Replies stream back over a Tauri channel as small events. CLIs are started
// with fixed argument lists (never through a shell), in an empty scratch
// folder, with their tools turned off where the CLI allows it.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

const KEYCHAIN_SERVICE: &str = "dev.conceit.app";
const KEYCHAIN_ACCOUNT: &str = "anthropic-api-key";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
const DEFAULT_API_MODEL: &str = "claude-opus-5-5";

// ---------------------------------------------------------------------------
// Types shared with the webview
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
pub enum Provider {
    #[serde(rename = "claude-cli")]
    ClaudeCli,
    #[serde(rename = "codex-cli")]
    CodexCli,
    #[serde(rename = "anthropic-api")]
    AnthropicApi,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Turn {
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ImageIn {
    /// Shown to the model right before the picture, e.g. "Image 2 (card #5)".
    pub label: String,
    pub mime: String,
    /// Base64, no `data:` prefix.
    pub data: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// Chosen by the webview; used to cancel.
    pub id: String,
    pub provider: Provider,
    /// Empty = the provider's default.
    #[serde(default)]
    pub model: String,
    pub system: String,
    /// Earlier turns, oldest first, then the new user turn last.
    pub turns: Vec<Turn>,
    /// Pictures from the board, attached to the last user turn.
    #[serde(default)]
    pub images: Vec<ImageIn>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    /// Reasoning summary text, when the provider shares it.
    Thinking { text: String },
    /// Answer text, appended as it arrives.
    Text { text: String },
    /// Which model actually answered (the CLIs pick their own default).
    Model { name: String },
    Done,
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    claude_cli: Option<String>,
    codex_cli: Option<String>,
    has_api_key: bool,
}

/// Running requests, so the webview can stop one.
#[derive(Default)]
pub struct AiState {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

// ---------------------------------------------------------------------------
// Finding the CLIs. Apps started from Finder get a minimal PATH, so also look
// where installers usually put them.
// ---------------------------------------------------------------------------

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", ".cargo/bin"] {
            dirs.push(home.join(d));
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

fn find_cli(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_string()]
    };
    search_dirs()
        .into_iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

/// PATH for the child: the search dirs, so a CLI that is a Node script still
/// finds `node`.
fn child_path() -> std::ffi::OsString {
    std::env::join_paths(search_dirs()).unwrap_or_default()
}

/// An empty folder to run CLIs in, so they don't pick up a project's files or
/// instructions from wherever the app was launched.
fn scratch_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("ai-scratch");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Keychain (BYOK)
// ---------------------------------------------------------------------------

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn read_api_key() -> Option<String> {
    key_entry().ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

#[tauri::command]
pub fn ai_status() -> AiStatus {
    AiStatus {
        claude_cli: find_cli("claude").map(|p| p.to_string_lossy().into_owned()),
        codex_cli: find_cli("codex").map(|p| p.to_string_lossy().into_owned()),
        has_api_key: read_api_key().is_some(),
    }
}

/// Save the API key in the OS keychain, or remove it when `key` is empty.
#[tauri::command]
pub fn ai_set_api_key(key: String) -> Result<(), String> {
    let entry = key_entry()?;
    let key = key.trim();
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(key).map_err(|e| format!("Could not save to the keychain: {e}"))
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AiState>,
    request: ChatRequest,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    if request.turns.last().map(|t| t.role.as_str()) != Some("user") {
        return Err("the last turn must be the user's".into());
    }
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    state.running.lock().unwrap().insert(request.id.clone(), stop_tx);

    let emit = |ev: AiEvent| {
        let _ = on_event.send(ev);
    };
    let work = async {
        match request.provider {
            Provider::ClaudeCli => run_claude_cli(&app, &request, &emit).await,
            Provider::CodexCli => run_codex_cli(&app, &request, &emit).await,
            Provider::AnthropicApi => run_api(&request, &emit).await,
        }
    };
    // Dropping `work` on stop kills the CLI child (kill_on_drop) or closes
    // the HTTP stream.
    let result = tokio::select! {
        r = work => r,
        _ = stop_rx => Ok(()),
    };
    state.running.lock().unwrap().remove(&request.id);
    match result {
        Ok(()) => emit(AiEvent::Done),
        Err(message) => emit(AiEvent::Error { message }),
    }
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, id: String) {
    if let Some(tx) = state.running.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

/// CLIs get one prompt, so earlier turns are folded into it as a transcript.
fn transcript_prompt(turns: &[Turn]) -> String {
    let (last, earlier) = turns.split_last().expect("checked non-empty");
    if earlier.is_empty() {
        return last.text.clone();
    }
    let mut s = String::from("<conversation_so_far>\n");
    for t in earlier {
        let who = if t.role == "assistant" { "Assistant" } else { "User" };
        s.push_str(&format!("{who}: {}\n\n", t.text.trim()));
    }
    s.push_str("</conversation_so_far>\n\n");
    s.push_str(&last.text);
    s
}

/// The last user turn as API content blocks: each picture after its label,
/// then the text.
fn user_content(images: &[ImageIn], text: &str) -> Vec<Value> {
    let mut content = Vec::new();
    for img in images {
        content.push(json!({ "type": "text", "text": img.label }));
        content.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": img.mime, "data": img.data },
        }));
    }
    content.push(json!({ "type": "text", "text": text }));
    content
}

async fn spawn_lines(
    mut cmd: Command,
    stdin_data: Vec<u8>,
    mut on_line: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("PATH", child_path());
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the CLI: {e}"))?;

    let mut stdin = child.stdin.take().unwrap();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&stdin_data).await;
        let _ = stdin.shutdown().await; // EOF: the CLI starts working
    });
    let mut stderr = child.stderr.take().unwrap();
    let err_reader = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut buf).await;
        buf
    });

    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if !line.trim().is_empty() {
            on_line(&line)?;
        }
    }
    let _ = writer.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_reader.await.unwrap_or_default();
    if !status.success() {
        let tail: String = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(if tail.trim().is_empty() {
            format!("The CLI stopped with {status}")
        } else {
            tail
        });
    }
    Ok(())
}

// --- Claude Code ------------------------------------------------------------

/// One line of `claude -p --output-format stream-json` → events. Returns an
/// error for a failed result.
fn claude_line(line: &str, emit: &impl Fn(AiEvent)) -> Result<(), String> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Ok(()); // not JSON (e.g. a warning): ignore
    };
    match v["type"].as_str() {
        Some("stream_event") => {
            let ev = &v["event"];
            match ev["type"].as_str() {
                Some("content_block_delta") => {
                    let d = &ev["delta"];
                    match d["type"].as_str() {
                        Some("text_delta") => emit(AiEvent::Text { text: d["text"].as_str().unwrap_or("").into() }),
                        Some("thinking_delta") => emit(AiEvent::Thinking { text: d["thinking"].as_str().unwrap_or("").into() }),
                        _ => {}
                    }
                }
                Some("message_start") => {
                    if let Some(m) = ev["message"]["model"].as_str() {
                        emit(AiEvent::Model { name: m.into() });
                    }
                }
                _ => {}
            }
        }
        Some("result") => {
            if v["is_error"].as_bool() == Some(true) || v["subtype"].as_str().is_some_and(|s| s != "success") {
                let msg = v["result"].as_str().filter(|s| !s.is_empty()).unwrap_or("Claude Code reported an error");
                return Err(msg.to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

async fn run_claude_cli(app: &AppHandle, req: &ChatRequest, emit: &impl Fn(AiEvent)) -> Result<(), String> {
    claude_cli_in(&scratch_dir(app)?, req, emit).await
}

async fn claude_cli_in(scratch: &std::path::Path, req: &ChatRequest, emit: &impl Fn(AiEvent)) -> Result<(), String> {
    let bin = find_cli("claude").ok_or("Claude Code isn't installed (no `claude` command found).")?;
    let mut cmd = Command::new(bin);
    cmd.current_dir(scratch).args([
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools", "", // no file, shell or web tools: it only reads what we send
        "--strict-mcp-config",
        "--setting-sources", "",
        "--no-session-persistence",
        "--system-prompt", &req.system,
    ]);
    if !req.model.trim().is_empty() {
        cmd.args(["--model", req.model.trim()]);
    }
    let msg = json!({
        "type": "user",
        "message": { "role": "user", "content": user_content(&req.images, &transcript_prompt(&req.turns)) },
    });
    let mut input = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    input.push(b'\n');
    spawn_lines(cmd, input, |line| claude_line(line, emit)).await
}

// --- Codex --------------------------------------------------------------------

fn codex_line(line: &str, emit: &impl Fn(AiEvent)) -> Result<(), String> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Ok(());
    };
    match v["type"].as_str() {
        Some("item.completed") => {
            let item = &v["item"];
            let text = item["text"].as_str().unwrap_or("").to_string();
            match item["type"].as_str() {
                Some("agent_message") => emit(AiEvent::Text { text }),
                Some("reasoning") => emit(AiEvent::Thinking { text: format!("{text}\n\n") }),
                _ => {}
            }
        }
        Some("turn.failed") => {
            let m = v["error"]["message"].as_str().unwrap_or("Codex couldn't finish the reply");
            return Err(m.to_string());
        }
        Some("error") => {
            let m = v["message"].as_str().unwrap_or("Codex reported an error");
            return Err(m.to_string());
        }
        _ => {}
    }
    Ok(())
}

fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    }
}

async fn run_codex_cli(app: &AppHandle, req: &ChatRequest, emit: &impl Fn(AiEvent)) -> Result<(), String> {
    codex_cli_in(&scratch_dir(app)?, req, emit).await
}

async fn codex_cli_in(scratch: &std::path::Path, req: &ChatRequest, emit: &impl Fn(AiEvent)) -> Result<(), String> {
    let bin = find_cli("codex").ok_or("Codex CLI isn't installed (no `codex` command found).")?;
    // Codex takes pictures as files: write them to a folder for this request.
    let dir = scratch.join(format!("req-{}", sanitize(&req.id)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _cleanup = RemoveOnDrop(dir.clone());
    let mut files = Vec::new();
    let mut legend = String::new();
    for (i, img) in req.images.iter().enumerate() {
        let path = dir.join(format!("image-{:02}.{}", i + 1, ext_for(&img.mime)));
        let bytes = B64.decode(&img.data).map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        legend.push_str(&format!("- Attached picture {}: {}\n", i + 1, img.label));
        files.push(path);
    }

    // Codex has no system prompt flag: the instructions lead the prompt.
    let mut prompt = format!("<instructions>\n{}\n</instructions>\n\n", req.system);
    if !legend.is_empty() {
        prompt.push_str(&format!("The attached pictures, in order:\n{legend}\n"));
    }
    prompt.push_str("Answer from the board content in this message only. Do not run commands or open files.\n\n");
    prompt.push_str(&transcript_prompt(&req.turns));

    let mut cmd = Command::new(bin);
    cmd.current_dir(&dir).args(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"]);
    if !req.model.trim().is_empty() {
        cmd.args(["--model", req.model.trim()]);
    }
    for f in &files {
        cmd.arg("--image").arg(f);
    }
    cmd.arg("-"); // prompt on stdin
    spawn_lines(cmd, prompt.into_bytes(), |line| codex_line(line, emit)).await
}

fn sanitize(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect()
}

struct RemoveOnDrop(PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// --- Anthropic API (BYOK) --------------------------------------------------------

fn api_body(req: &ChatRequest) -> Value {
    let (last, earlier) = req.turns.split_last().expect("checked non-empty");
    let mut messages: Vec<Value> = earlier
        .iter()
        .filter(|t| !t.text.trim().is_empty())
        .map(|t| json!({ "role": if t.role == "assistant" { "assistant" } else { "user" }, "content": t.text }))
        .collect();
    messages.push(json!({ "role": "user", "content": user_content(&req.images, &last.text) }));
    let model = if req.model.trim().is_empty() { DEFAULT_API_MODEL } else { req.model.trim() };
    json!({
        "model": model,
        "max_tokens": 32000,
        "stream": true,
        "system": req.system,
        "thinking": { "type": "adaptive", "display": "summarized" },
        "output_config": { "effort": "medium" },
        // If a safety classifier declines, the API retries on a fallback
        // model inside the same call instead of failing the reply.
        "fallbacks": "default",
        "messages": messages,
    })
}

/// One SSE `data:` payload → events. `Err` for an error event or a refusal.
fn api_event(data: &str, emit: &impl Fn(AiEvent)) -> Result<(), String> {
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return Ok(());
    };
    match v["type"].as_str() {
        Some("message_start") => {
            if let Some(m) = v["message"]["model"].as_str() {
                emit(AiEvent::Model { name: m.into() });
            }
        }
        Some("content_block_delta") => {
            let d = &v["delta"];
            match d["type"].as_str() {
                Some("text_delta") => emit(AiEvent::Text { text: d["text"].as_str().unwrap_or("").into() }),
                Some("thinking_delta") => emit(AiEvent::Thinking { text: d["thinking"].as_str().unwrap_or("").into() }),
                _ => {}
            }
        }
        Some("message_delta") => match v["delta"]["stop_reason"].as_str() {
            Some("refusal") => {
                let why = v["delta"]["stop_details"]["explanation"].as_str().unwrap_or("");
                return Err(format!("The model declined to answer. {why}").trim().to_string());
            }
            Some("max_tokens") => emit(AiEvent::Text { text: "\n\n_(Reply cut off at the length limit.)_".into() }),
            _ => {}
        },
        Some("error") => {
            return Err(v["error"]["message"].as_str().unwrap_or("The API reported an error").to_string());
        }
        _ => {}
    }
    Ok(())
}

async fn run_api(req: &ChatRequest, emit: &impl Fn(AiEvent)) -> Result<(), String> {
    let key = read_api_key().ok_or("No API key saved. Add one in the AI panel's settings.")?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(API_URL)
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .header("content-type", "application/json")
        .body(api_body(req).to_string())
        .send()
        .await
        .map_err(|e| format!("Could not reach the API: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(body);
        return Err(match status.as_u16() {
            401 => "The API key was rejected. Check it in the AI panel's settings.".into(),
            429 => format!("Rate limited by the API. Try again in a moment. ({msg})"),
            _ => format!("API error {status}: {msg}"),
        });
    }

    use futures_util::StreamExt;
    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        // SSE events end with a blank line.
        while let Some(end) = find_event_end(&buf) {
            let event: Vec<u8> = buf.drain(..end.1).collect();
            let text = String::from_utf8_lossy(&event[..end.0]);
            for line in text.lines() {
                if let Some(data) = line.strip_prefix("data:") {
                    api_event(data.trim_start(), emit)?;
                }
            }
        }
    }
    Ok(())
}

/// (end of event, end including the separator) for the first complete event.
fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
    let a = buf.windows(2).position(|w| w == b"\n\n").map(|i| (i, i + 2));
    let b = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, i + 4));
    match (a, b) {
        (Some(x), Some(y)) => Some(if x.0 < y.0 { x } else { y }),
        (x, y) => x.or(y),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::Path;

    fn collect(f: impl Fn(&dyn Fn(AiEvent)) -> Result<(), String>) -> (Vec<AiEvent>, Result<(), String>) {
        let out = RefCell::new(Vec::new());
        let r = f(&|e| out.borrow_mut().push(e));
        (out.into_inner(), r)
    }

    #[test]
    fn parses_claude_stream_json() {
        let (evs, r) = collect(|emit| {
            claude_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Warm"}}}"#, &emit)?;
            claude_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}"#, &emit)?;
            claude_line("not json", &emit)?;
            claude_line(r#"{"type":"result","subtype":"success","is_error":false}"#, &emit)
        });
        assert!(r.is_ok());
        assert_eq!(evs, vec![AiEvent::Text { text: "Warm".into() }, AiEvent::Thinking { text: "hmm".into() }]);
        let (_, r) = collect(|emit| claude_line(r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}"#, &emit));
        assert_eq!(r.unwrap_err(), "Not logged in");
    }

    #[test]
    fn parses_codex_json() {
        let (evs, r) = collect(|emit| {
            codex_line(r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Muted palette."}}"#, &emit)
        });
        assert!(r.is_ok());
        assert_eq!(evs, vec![AiEvent::Text { text: "Muted palette.".into() }]);
        let (_, r) = collect(|emit| codex_line(r#"{"type":"turn.failed","error":{"message":"auth"}}"#, &emit));
        assert_eq!(r.unwrap_err(), "auth");
    }

    #[test]
    fn parses_api_sse_and_refusal() {
        let (evs, r) = collect(|emit| {
            api_event(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#, &emit)
        });
        assert!(r.is_ok());
        assert_eq!(evs, vec![AiEvent::Text { text: "Hi".into() }]);
        let (_, r) = collect(|emit| api_event(r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#, &emit));
        assert!(r.unwrap_err().starts_with("The model declined"));
        assert_eq!(find_event_end(b"data: x\n\ndata: y"), Some((7, 9)));
        assert_eq!(find_event_end(b"data: x"), None);
    }

    fn req(turns: &[(&str, &str)]) -> ChatRequest {
        ChatRequest {
            id: "1".into(),
            provider: Provider::AnthropicApi,
            model: String::new(),
            system: "sys".into(),
            turns: turns.iter().map(|(r, t)| Turn { role: r.to_string(), text: t.to_string() }).collect(),
            images: vec![ImageIn { label: "Image 1 (card #2)".into(), mime: "image/jpeg".into(), data: "AAAA".into() }],
        }
    }

    #[test]
    fn api_body_puts_images_on_last_turn() {
        let b = api_body(&req(&[("user", "a"), ("assistant", "b"), ("user", "c")]));
        assert_eq!(b["model"], DEFAULT_API_MODEL);
        let msgs = b["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["role"], "assistant");
        let last = msgs[2]["content"].as_array().unwrap();
        assert_eq!(last[0]["text"], "Image 1 (card #2)");
        assert_eq!(last[1]["type"], "image");
        assert_eq!(last[2]["text"], "c");
    }

    /// Real CLI round trips, with a picture and the real instructions.
    /// Opt-in (uses your CLI login and a little quota):
    /// `cargo test live_ -- --ignored --nocapture`
    fn live_request(provider: Provider) -> ChatRequest {
        let png = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/128x128.png")).unwrap();
        let system = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ai/prompts.ts")).unwrap();
        ChatRequest {
            id: format!("live-{provider:?}"),
            provider,
            model: String::new(),
            system,
            turns: vec![Turn {
                role: "user".into(),
                text: "<board>\nScope: the whole board, 2 cards.\n#1 image \"App icon\" at (0, 0), 128×128 — local file \"icon.png\" [picture attached as Image 1]\n#2 color swatch at (160, 0), 120×120 — #C4673F\n</board>\n\nIn one short sentence: what colors does Image 1 use?".into(),
            }],
            images: vec![ImageIn { label: "Image 1 (card #1)".into(), mime: "image/png".into(), data: B64.encode(png) }],
        }
    }

    async fn live(provider: Provider) {
        let dir = std::env::temp_dir().join(format!("conceit-ai-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let events = std::sync::Mutex::new(Vec::new());
        let req = live_request(provider);
        let emit = |e: AiEvent| events.lock().unwrap().push(e);
        let r = match provider {
            Provider::ClaudeCli => claude_cli_in(&dir, &req, &emit).await,
            Provider::CodexCli => codex_cli_in(&dir, &req, &emit).await,
            Provider::AnthropicApi => run_api(&req, &emit).await,
        };
        let events = events.into_inner().unwrap();
        let text: String = events.iter().filter_map(|e| if let AiEvent::Text { text } = e { Some(text.as_str()) } else { None }).collect();
        println!("{provider:?}: {r:?}\n  answer: {text}\n  events: {}", events.len());
        assert!(r.is_ok(), "{r:?}");
        assert!(!text.trim().is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn live_claude_cli() {
        live(Provider::ClaudeCli).await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_codex_cli() {
        live(Provider::CodexCli).await;
    }

    #[test]
    fn transcript_folds_earlier_turns() {
        let r = req(&[("user", "a"), ("assistant", "b"), ("user", "c")]);
        let p = transcript_prompt(&r.turns);
        assert!(p.starts_with("<conversation_so_far>\nUser: a\n\nAssistant: b"));
        assert!(p.ends_with("</conversation_so_far>\n\nc"));
        assert_eq!(transcript_prompt(&r.turns[..1]), "a");
    }
}
