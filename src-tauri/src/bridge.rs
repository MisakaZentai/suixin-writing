//! 实时桥：让命令行 / MCP 里的 agent 把操作交给正在运行的 App。
//!
//! - 只监听 127.0.0.1 的随机端口；端口与随机令牌写在应用数据目录的 bridge.json，
//!   每个请求都要带令牌（`Authorization: Bearer …`），并校验 Host 防 DNS 重绑定；
//! - Rust 只做转发：请求以事件交给前端执行，前端执行完调用 `bridge_respond` 回复；
//! - 事件（作者接受 / 放弃建议、选区变化、交办任务……）由前端 `bridge_publish` 发来，
//!   agent 用 `events.wait` 长轮询取走；在线状态（哪些 agent 连着）也在这里维护。

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const PROTOCOL_VERSION: u32 = 1;
const MAX_BODY: usize = 8 * 1024 * 1024;
const EVENT_CAP: usize = 500;
const MAX_AGENT_NAME: usize = 64;
/// 多久没有动静就不再算"在线"
const PRESENCE_TTL: Duration = Duration::from_secs(45);
/// 长轮询最长等待
const MAX_WAIT_MS: u64 = 30_000;
/// 普通请求等前端回复的时间；授权请求要等作者点按钮，放宽到 3 分钟
/// （须短于 Node fetch 默认 300 秒的响应头超时）
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);
const ACCESS_TIMEOUT: Duration = Duration::from_secs(180);

struct EventLog {
    next_seq: u64,
    items: VecDeque<Value>,
}

struct AgentSeen {
    last: Instant,
    last_ms: u64,
    waiting: u32,
}

pub struct Bridge {
    token: String,
    ready: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    events: Mutex<EventLog>,
    events_cv: Condvar,
    agents: Mutex<HashMap<String, AgentSeen>>,
    info: Mutex<Option<(u16, PathBuf)>>,
}

impl Bridge {
    pub fn new() -> Self {
        Bridge {
            token: random_token(),
            ready: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            events: Mutex::new(EventLog { next_seq: 1, items: VecDeque::new() }),
            events_cv: Condvar::new(),
            agents: Mutex::new(HashMap::new()),
            info: Mutex::new(None),
        }
    }
}

fn random_token() -> String {
    let mut buf = [0u8; 24];
    // 取不到系统随机数时宁可不开桥，也不要用可猜的令牌
    getrandom::fill(&mut buf).expect("系统随机数不可用");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn error(code: &str, message: &str, hint: Option<&str>) -> Value {
    let mut e = json!({ "code": code, "message": message });
    if let Some(h) = hint {
        e["hint"] = json!(h);
    }
    json!({ "ok": false, "error": e })
}

/* ── 启动与退出 ─────────────────────────────────────── */

pub fn start(app: &AppHandle) -> Result<(), String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("拿不到监听端口")?;
    let bridge: State<Arc<Bridge>> = app.state();
    let bridge = bridge.inner().clone();

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("bridge.json");
    let discovery = json!({
        "port": port,
        "token": bridge.token,
        "pid": std::process::id(),
        "version": PROTOCOL_VERSION,
    });
    std::fs::write(&file, serde_json::to_string_pretty(&discovery).unwrap()).map_err(|e| e.to_string())?;
    *bridge.info.lock().unwrap() = Some((port, file));

    let server = Arc::new(server);
    {
        let app = app.clone();
        let bridge = bridge.clone();
        thread::spawn(move || {
            for request in server.incoming_requests() {
                let app = app.clone();
                let bridge = bridge.clone();
                // 每个请求一个线程：长轮询不会挡住别的请求
                thread::spawn(move || handle(&app, &bridge, port, request));
            }
        });
    }
    {
        // 定期清理掉线的 agent
        let app = app.clone();
        let bridge = bridge.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(5));
            let changed = {
                let mut agents = bridge.agents.lock().unwrap();
                let before = agents.len();
                agents.retain(|_, a| a.waiting > 0 || a.last.elapsed() < PRESENCE_TTL);
                agents.len() != before
            };
            if changed {
                emit_presence(&app, &bridge);
            }
        });
    }
    Ok(())
}

/// 退出时删掉 bridge.json（只删自己写的那份，另一个实例写的留着）
pub fn cleanup(app: &AppHandle) {
    let bridge: State<Arc<Bridge>> = app.state();
    let info = bridge.info.lock().unwrap().clone();
    if let Some((_, file)) = info {
        let mine = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .map(|v| v["pid"] == json!(std::process::id()))
            .unwrap_or(false);
        if mine {
            let _ = std::fs::remove_file(file);
        }
    }
}

/* ── 请求处理 ───────────────────────────────────────── */

fn respond(request: tiny_http::Request, status: u16, body: &Value) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap();
    let response = tiny_http::Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header);
    let _ = request.respond(response);
}

fn header<'a>(request: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

/// 逐字节比较，耗时与内容无关
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(app: &AppHandle, bridge: &Arc<Bridge>, port: u16, mut request: tiny_http::Request) {
    // 浏览器里的网页借 DNS 重绑定也访问不到：Host 必须是本机地址
    let host_ok = matches!(header(&request, "Host"), Some(h) if h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    if !host_ok {
        return respond(request, 403, &error("FORBIDDEN", "只接受本机请求", None));
    }
    let authorized = header(&request, "Authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| same(t, &bridge.token))
        .unwrap_or(false);
    if !authorized {
        return respond(request, 401, &error("UNAUTHORIZED", "令牌不对", Some("重新读取 bridge.json")));
    }
    if request.method() != &tiny_http::Method::Post || request.url() != "/rpc" {
        return respond(request, 404, &error("NOT_FOUND", "只有 POST /rpc", None));
    }
    let mut body = String::new();
    if request.as_reader().take(MAX_BODY as u64 + 1).read_to_string(&mut body).is_err() || body.len() > MAX_BODY {
        return respond(request, 400, &error("INVALID_PARAMS", "请求体无效或过大", None));
    }
    let msg: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return respond(request, 400, &error("INVALID_PARAMS", "请求体不是 JSON", None)),
    };
    let method = msg["method"].as_str().unwrap_or("").to_string();
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let agent: String = msg["agent"]
        .as_str()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Agent")
        .chars()
        .take(MAX_AGENT_NAME)
        .collect();

    let result = match method.as_str() {
        "hello" => {
            touch(app, bridge, &agent, 0);
            json!({ "ok": true, "result": {
                "app": "随心写作",
                "version": env!("CARGO_PKG_VERSION"),
                "protocol": PROTOCOL_VERSION,
                "ready": bridge.ready.load(Ordering::SeqCst),
            }})
        }
        "events.wait" => {
            touch(app, bridge, &agent, 1);
            let out = wait_events(bridge, &params);
            touch(app, bridge, &agent, -1);
            out
        }
        _ => {
            touch(app, bridge, &agent, 0);
            forward(app, bridge, &method, params, &agent)
        }
    };
    respond(request, 200, &result);
}

/// 交给前端执行，等它回复
fn forward(app: &AppHandle, bridge: &Arc<Bridge>, method: &str, params: Value, agent: &str) -> Value {
    if !bridge.ready.load(Ordering::SeqCst) {
        return error("UNAVAILABLE", "App 还在启动", Some("稍后重试"));
    }
    let id = bridge.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    bridge.pending.lock().unwrap().insert(id, tx);
    if app
        .emit("bridge://request", json!({ "id": id, "method": method, "params": params, "agent": agent }))
        .is_err()
    {
        bridge.pending.lock().unwrap().remove(&id);
        return error("UNAVAILABLE", "App 窗口没有响应", Some("稍后重试"));
    }
    let timeout = if method == "access.request" { ACCESS_TIMEOUT } else { REPLY_TIMEOUT };
    match rx.recv_timeout(timeout) {
        Ok(v) => v,
        Err(_) => {
            bridge.pending.lock().unwrap().remove(&id);
            if method == "access.request" {
                error("TIMEOUT", "作者没有回应授权请求", Some("稍后再请求，或先用提建议的方式修改"))
            } else {
                error("TIMEOUT", "App 没有及时回复", Some("稍后重试"))
            }
        }
    }
}

/// 长轮询：返回 seq > since 的事件；没有就等，最长 timeout 毫秒
fn wait_events(bridge: &Arc<Bridge>, params: &Value) -> Value {
    let timeout = params["timeout"].as_u64().unwrap_or(25_000).min(MAX_WAIT_MS);
    let types: Option<Vec<String>> = params["types"]
        .as_array()
        .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect());
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let mut log = bridge.events.lock().unwrap();
    // 不给 since：从现在开始等新事件
    let since = params["since"].as_u64().unwrap_or(log.next_seq - 1);
    loop {
        let latest = log.next_seq - 1;
        let oldest = log.items.front().and_then(|e| e["seq"].as_u64()).unwrap_or(log.next_seq);
        let events: Vec<Value> = log
            .items
            .iter()
            .filter(|e| e["seq"].as_u64().unwrap_or(0) > since)
            .filter(|e| match &types {
                Some(t) => e["type"].as_str().map(|x| t.iter().any(|y| y == x)).unwrap_or(false),
                None => true,
            })
            .cloned()
            .collect();
        let now = Instant::now();
        if !events.is_empty() || now >= deadline {
            let mut result = json!({ "cursor": latest, "events": events });
            if since + 1 < oldest && params["since"].is_u64() {
                // 太久没来取，早先的事件已经丢弃
                result["missed"] = json!(true);
            }
            return json!({ "ok": true, "result": result });
        }
        log = bridge.events_cv.wait_timeout(log, deadline - now).unwrap().0;
    }
}

/// 记一次 agent 活动；waiting 为 +1 / -1 表示开始 / 结束长轮询
fn touch(app: &AppHandle, bridge: &Arc<Bridge>, agent: &str, waiting: i32) {
    let is_new = {
        let mut agents = bridge.agents.lock().unwrap();
        let is_new = !agents.contains_key(agent);
        let a = agents.entry(agent.to_string()).or_insert(AgentSeen { last: Instant::now(), last_ms: 0, waiting: 0 });
        a.last = Instant::now();
        a.last_ms = now_ms();
        a.waiting = (a.waiting as i32 + waiting).max(0) as u32;
        is_new
    };
    if is_new {
        emit_presence(app, bridge);
    }
}

fn presence_list(bridge: &Arc<Bridge>) -> Value {
    let agents = bridge.agents.lock().unwrap();
    let mut list: Vec<Value> = agents
        .iter()
        .map(|(name, a)| json!({ "name": name, "lastSeen": a.last_ms, "waiting": a.waiting > 0 }))
        .collect();
    list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json!(list)
}

fn emit_presence(app: &AppHandle, bridge: &Arc<Bridge>) {
    let _ = app.emit("bridge://presence", presence_list(bridge));
}

/* ── 给前端的命令 ───────────────────────────────────── */

/// 前端已开始监听请求
#[tauri::command]
pub fn bridge_ready(bridge: State<Arc<Bridge>>) -> Value {
    bridge.ready.store(true, Ordering::SeqCst);
    let port = bridge.info.lock().unwrap().as_ref().map(|(p, _)| *p);
    json!({ "port": port, "agents": presence_list(&bridge) })
}

/// 前端对某个请求的回复：{ ok, result } 或 { ok: false, error }
#[tauri::command]
pub fn bridge_respond(id: u64, response: Value, bridge: State<Arc<Bridge>>) {
    if let Some(tx) = bridge.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(response);
    }
}

/// 发布一个事件，交给等待中的 agent
#[tauri::command]
pub fn bridge_publish(event: Value, bridge: State<Arc<Bridge>>) {
    let mut log = bridge.events.lock().unwrap();
    let mut event = event;
    if !event.is_object() {
        return;
    }
    event["seq"] = json!(log.next_seq);
    log.next_seq += 1;
    log.items.push_back(event);
    while log.items.len() > EVENT_CAP {
        log.items.pop_front();
    }
    bridge.events_cv.notify_all();
}
