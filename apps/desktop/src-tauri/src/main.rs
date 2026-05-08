#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::Url;

const DEFAULT_BACKEND_PORT: u16 = 13_773;
const LOOPBACK_HOST: &str = "127.0.0.1";
const APP_BASE_NAME: &str = "T3 Code";
const KEYRING_SERVICE: &str = "com.t3tools.t3code.saved-environment";
const UPDATE_STATE_EVENT: &str = "desktop:update-state";
const NIGHTLY_VERSION_MARKER: &str = "-nightly.";
const MAIN_WINDOW_LABEL: &str = "main";
const LOADING_WINDOW_PATH: &str = "loading.html";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAppBranding {
    base_name: String,
    stage_label: String,
    display_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEnvironmentBootstrap {
    label: String,
    http_base_url: Option<String>,
    ws_base_url: Option<String>,
    bootstrap_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    server_exposure_mode: String,
    tailscale_serve_enabled: bool,
    tailscale_serve_port: u16,
    update_channel: String,
    update_channel_configured_by_user: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopServerExposureState {
    mode: String,
    endpoint_url: Option<String>,
    advertised_host: Option<String>,
    tailscale_serve_enabled: bool,
    tailscale_serve_port: u16,
}

#[derive(Clone, Debug, Deserialize)]
struct TailscaleServeInput {
    enabled: bool,
    port: Option<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateState {
    enabled: bool,
    status: String,
    channel: String,
    current_version: String,
    host_arch: String,
    app_arch: String,
    running_under_arm64_translation: bool,
    available_version: Option<String>,
    downloaded_version: Option<String>,
    download_percent: Option<f64>,
    checked_at: Option<String>,
    message: Option<String>,
    error_context: Option<String>,
    can_retry: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateActionResult {
    accepted: bool,
    completed: bool,
    state: DesktopUpdateState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateCheckResult {
    checked: bool,
    state: DesktopUpdateState,
}

type SshHelperResponseSender = mpsc::Sender<Result<Value, String>>;

#[derive(Clone)]
struct SshHelperHandle {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, SshHelperResponseSender>>>,
    next_id: Arc<Mutex<u64>>,
}

struct SshHelperProcess {
    child: Child,
    handle: SshHelperHandle,
}

struct DownloadedUpdate {
    update: Update,
    bytes: Vec<u8>,
}

struct DesktopRuntime {
    app_root: PathBuf,
    base_dir: PathBuf,
    state_dir: PathBuf,
    app_version: String,
    settings: DesktopSettings,
    backend_process: Option<Child>,
    backend_port: u16,
    backend_bind_host: String,
    backend_http_url: String,
    backend_ws_url: String,
    backend_endpoint_url: Option<String>,
    backend_advertised_host: Option<String>,
    backend_bootstrap_token: String,
    is_development: bool,
    update_state: DesktopUpdateState,
    available_update: Option<Update>,
    downloaded_update: Option<DownloadedUpdate>,
    update_check_in_flight: bool,
    update_download_in_flight: bool,
    update_install_in_flight: bool,
}

struct DesktopAppState {
    runtime: Mutex<DesktopRuntime>,
    ssh_helper: Mutex<Option<SshHelperProcess>>,
}

impl Drop for SshHelperProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for DesktopRuntime {
    fn drop(&mut self) {
        stop_backend(self);
    }
}

impl SshHelperHandle {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = {
            let mut next_id = self.next_id.lock().map_err(|error| error.to_string())?;
            let id = *next_id;
            *next_id = next_id.saturating_add(1);
            id
        };
        let (sender, receiver) = mpsc::channel::<Result<Value, String>>();
        {
            let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
            pending.insert(id, sender);
        }

        let message = json!({
            "id": id,
            "method": method,
            "params": params
        });
        let write_result = {
            let mut stdin = self.stdin.lock().map_err(|error| error.to_string())?;
            writeln!(stdin, "{message}").and_then(|_| stdin.flush())
        };

        if let Err(error) = write_result {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(format!("Failed to write to SSH helper: {error}"));
        }

        receiver
            .recv()
            .map_err(|_| "SSH helper stopped before responding.".to_string())?
    }
}

fn spawn_ssh_helper_reader(
    app: tauri::AppHandle,
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<u64, SshHelperResponseSender>>>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                eprintln!("[desktop] ignored non-json SSH helper output: {line}");
                continue;
            };
            let kind = message
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match kind {
                "response" => {
                    let Some(id) = message.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    let ok = message.get("ok").and_then(Value::as_bool).unwrap_or(false);
                    let result = if ok {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(message
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("SSH helper request failed.")
                            .to_string())
                    };
                    if let Ok(mut pending) = pending.lock() {
                        if let Some(sender) = pending.remove(&id) {
                            let _ = sender.send(result);
                        }
                    }
                }
                "event" => {
                    let Some(event) = message.get("event").and_then(Value::as_str) else {
                        continue;
                    };
                    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
                    let _ = app.emit(event, payload);
                }
                _ => {}
            }
        }

        if let Ok(mut pending) = pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("SSH helper exited.".to_string()));
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_app_branding,
            get_local_environment_bootstrap,
            get_client_settings,
            set_client_settings,
            get_saved_environment_registry,
            set_saved_environment_registry,
            get_saved_environment_secret,
            set_saved_environment_secret,
            remove_saved_environment_secret,
            discover_ssh_hosts,
            ensure_ssh_environment,
            disconnect_ssh_environment,
            resolve_ssh_password_prompt,
            get_server_exposure_state,
            set_server_exposure_mode,
            set_tailscale_serve_enabled,
            get_advertised_endpoints,
            get_update_state,
            set_update_channel,
            check_for_update,
            download_update,
            install_update,
            set_theme
        ])
        .setup(|app| {
            let mut runtime = create_desktop_runtime(app.handle())?;
            start_backend(&mut runtime).map_err(|error| error.to_string())?;
            let window_url = build_window_url(&runtime).map_err(|error| error.to_string())?;
            let backend_port = runtime.backend_port;
            if env_flag("T3CODE_DESKTOP_STARTUP_SMOKE") {
                if let Err(error) = wait_for_backend_startup(&mut runtime, Duration::from_secs(60))
                {
                    stop_backend(&mut runtime);
                    eprintln!("[desktop] startup smoke failed: {error}");
                    std::process::exit(1);
                }

                match create_main_window(app.handle(), WebviewUrl::External(window_url), false) {
                    Ok(()) => {
                        stop_backend(&mut runtime);
                        println!("[desktop] startup smoke passed");
                        std::process::exit(0);
                    }
                    Err(error) => {
                        stop_backend(&mut runtime);
                        eprintln!("[desktop] startup smoke failed: {error}");
                        std::process::exit(1);
                    }
                }
            }
            app.manage(DesktopAppState {
                runtime: Mutex::new(runtime),
                ssh_helper: Mutex::new(None),
            });

            create_main_window(
                app.handle(),
                WebviewUrl::App(PathBuf::from(LOADING_WINDOW_PATH)),
                true,
            )?;

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if !wait_for_backend_http(LOOPBACK_HOST, backend_port, Duration::from_secs(60)) {
                    eprintln!(
                        "[desktop] backend did not serve HTTP on {LOOPBACK_HOST}:{backend_port}"
                    );
                    app_handle.exit(1);
                    return;
                }

                match app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                    Some(window) => {
                        if let Err(error) = window.navigate(window_url) {
                            eprintln!("[desktop] failed to navigate Tauri window: {error}");
                            app_handle.exit(1);
                            return;
                        }
                        let _ = window.set_focus();
                    }
                    None => {
                        eprintln!("[desktop] main Tauri window was closed before backend startup");
                        app_handle.exit(1);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.app_handle().try_state::<DesktopAppState>() {
                    if let Ok(mut runtime) = state.runtime.lock() {
                        stop_backend(&mut runtime);
                    }
                    stop_ssh_helper(&state);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running T3 Code desktop shell");
}

fn create_main_window(
    app: &tauri::AppHandle,
    window_url: WebviewUrl,
    visible: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, window_url)
        .title(resolve_app_branding(app).display_name)
        .inner_size(1320.0, 860.0)
        .min_inner_size(840.0, 620.0)
        .maximized(true)
        .resizable(true)
        .visible(visible)
        .build()?;
    if visible {
        window.set_focus()?;
    }
    Ok(())
}

fn create_desktop_runtime(app: &tauri::AppHandle) -> Result<DesktopRuntime, String> {
    let app_root = resolve_app_root(app)?;
    let base_dir = resolve_base_dir()?;
    let state_dir = base_dir.join("userdata");
    fs::create_dir_all(&state_dir).map_err(|error| error.to_string())?;
    let app_version = app.package_info().version.to_string();

    let settings_path = state_dir.join("desktop-settings.json");
    let settings = read_desktop_settings(&settings_path);
    let backend_port = resolve_backend_port()?;
    let backend_bind_host = resolve_backend_bind_host(&settings.server_exposure_mode);
    let backend_http_url = format!("http://{LOOPBACK_HOST}:{backend_port}");
    let backend_ws_url = format!("ws://{LOOPBACK_HOST}:{backend_port}");
    let backend_advertised_host = resolve_backend_advertised_host(&settings.server_exposure_mode);
    let backend_endpoint_url = backend_advertised_host
        .as_ref()
        .map(|host| format!("http://{host}:{backend_port}"));
    let is_development = std::env::var("VITE_DEV_SERVER_URL")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    let mut runtime = DesktopRuntime {
        app_root,
        base_dir,
        state_dir,
        app_version,
        settings,
        backend_process: None,
        backend_port,
        backend_bind_host,
        backend_http_url,
        backend_ws_url,
        backend_endpoint_url,
        backend_advertised_host,
        backend_bootstrap_token: generate_token(),
        is_development,
        update_state: DesktopUpdateState {
            enabled: false,
            status: "disabled".to_string(),
            channel: "latest".to_string(),
            current_version: String::new(),
            host_arch: resolve_arch(std::env::consts::ARCH),
            app_arch: resolve_arch(std::env::consts::ARCH),
            running_under_arm64_translation: false,
            available_version: None,
            downloaded_version: None,
            download_percent: None,
            checked_at: None,
            message: None,
            error_context: None,
            can_retry: false,
        },
        available_update: None,
        downloaded_update: None,
        update_check_in_flight: false,
        update_download_in_flight: false,
        update_install_in_flight: false,
    };
    runtime.update_state = initial_update_state(app, &runtime);
    Ok(runtime)
}

fn resolve_app_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("T3CODE_REPO_ROOT") {
        let trimmed = root.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    if std::env::var("VITE_DEV_SERVER_URL").is_ok() {
        let current = std::env::current_dir().map_err(|error| error.to_string())?;
        return Ok(current
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or(current));
    }

    if let Ok(path) = app.path().resolve(
        "apps/server/dist/bin.mjs",
        tauri::path::BaseDirectory::Resource,
    ) {
        return Ok(path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(".")));
    }

    std::env::current_dir().map_err(|error| error.to_string())
}

fn resolve_base_dir() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("T3CODE_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    dirs::home_dir()
        .map(|home| home.join(".t3"))
        .ok_or_else(|| "Could not resolve the current user's home directory.".to_string())
}

fn resolve_backend_port() -> Result<u16, String> {
    if let Ok(raw_port) = std::env::var("T3CODE_PORT") {
        if let Ok(port) = raw_port.trim().parse::<u16>() {
            return Ok(port);
        }
    }

    for port in DEFAULT_BACKEND_PORT..=u16::MAX {
        if TcpListener::bind((LOOPBACK_HOST, port)).is_ok() {
            return Ok(port);
        }
    }

    Err("No available backend port was found.".to_string())
}

fn resolve_backend_bind_host(mode: &str) -> String {
    if mode == "network-accessible" {
        "0.0.0.0".to_string()
    } else {
        LOOPBACK_HOST.to_string()
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn bundled_node_executable_path(runtime: &DesktopRuntime) -> Option<PathBuf> {
    let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = runtime
        .app_root
        .join("apps")
        .join("desktop")
        .join("dist")
        .join("node")
        .join(executable_name);

    path.exists().then_some(path)
}

fn resolve_node_executable(runtime: &DesktopRuntime) -> PathBuf {
    env_non_empty("T3CODE_NODE_PATH")
        .map(PathBuf::from)
        .or_else(|| bundled_node_executable_path(runtime))
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn normalize_process_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.as_os_str().to_string_lossy();
        if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{stripped}"));
        }
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }

    path.to_path_buf()
}

fn configure_child_process_window(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn is_usable_lan_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    !address.is_loopback()
        && !address.is_link_local()
        && !address.is_unspecified()
        && octets[0] != 0
}

fn is_tailscale_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn local_ipv4_addresses() -> Vec<Ipv4Addr> {
    local_ip_address::list_afinet_netifas()
        .map(|interfaces| {
            interfaces
                .into_iter()
                .filter_map(|(_, address)| match address {
                    IpAddr::V4(address) => Some(address),
                    IpAddr::V6(_) => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_lan_advertised_host() -> Option<String> {
    if let Some(override_host) = env_non_empty("T3CODE_DESKTOP_LAN_HOST") {
        return Some(override_host);
    }

    local_ipv4_addresses()
        .into_iter()
        .find(|address| is_usable_lan_ipv4(*address) && !is_tailscale_ipv4(*address))
        .map(|address| address.to_string())
}

fn resolve_backend_advertised_host(mode: &str) -> Option<String> {
    if mode == "network-accessible" {
        resolve_lan_advertised_host()
    } else {
        None
    }
}

fn refresh_backend_exposure(runtime: &mut DesktopRuntime) {
    runtime.backend_bind_host = resolve_backend_bind_host(&runtime.settings.server_exposure_mode);
    runtime.backend_advertised_host =
        resolve_backend_advertised_host(&runtime.settings.server_exposure_mode);
    runtime.backend_endpoint_url = runtime
        .backend_advertised_host
        .as_ref()
        .map(|host| format!("http://{host}:{}", runtime.backend_port));
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn start_backend(runtime: &mut DesktopRuntime) -> io::Result<()> {
    if runtime.backend_process.is_some() {
        return Ok(());
    }

    let backend_entry = runtime.app_root.join("apps/server/dist/bin.mjs");
    if !backend_entry.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("missing server entry at {}", backend_entry.display()),
        ));
    }

    let node = resolve_node_executable(runtime);
    let process_node = normalize_process_path(&node);
    let process_backend_entry = normalize_process_path(&backend_entry);
    let working_dir = if runtime.is_development {
        normalize_process_path(&runtime.app_root)
    } else {
        dirs::home_dir().unwrap_or_else(|| runtime.base_dir.clone())
    };

    let mut command = Command::new(&process_node);
    configure_child_process_window(&mut command);
    command
        .arg(&process_backend_entry)
        .arg("--no-browser")
        .current_dir(working_dir)
        .env("T3CODE_MODE", "desktop")
        .env("T3CODE_NO_BROWSER", "1")
        .env("T3CODE_PORT", runtime.backend_port.to_string())
        .env("T3CODE_HOST", runtime.backend_bind_host.clone())
        .env(
            "T3CODE_HOME",
            runtime.base_dir.to_string_lossy().to_string(),
        )
        .env(
            "T3CODE_DESKTOP_BOOTSTRAP_TOKEN",
            runtime.backend_bootstrap_token.clone(),
        )
        .env(
            "T3CODE_TAILSCALE_SERVE",
            if runtime.settings.tailscale_serve_enabled {
                "1"
            } else {
                "0"
            },
        )
        .env(
            "T3CODE_TAILSCALE_SERVE_PORT",
            runtime.settings.tailscale_serve_port.to_string(),
        )
        .stdin(Stdio::null());

    configure_backend_stdio(&mut command, runtime, &process_node, &process_backend_entry)?;

    runtime.backend_process = Some(command.spawn()?);
    Ok(())
}

fn backend_log_path(runtime: &DesktopRuntime) -> PathBuf {
    runtime.state_dir.join("desktop-backend.log")
}

fn configure_backend_stdio(
    command: &mut Command,
    runtime: &DesktopRuntime,
    node: &Path,
    backend_entry: &Path,
) -> io::Result<()> {
    if runtime.is_development {
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        return Ok(());
    }

    fs::create_dir_all(&runtime.state_dir)?;
    let mut stdout_log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(backend_log_path(runtime))?;
    writeln!(
        stdout_log,
        "\n[desktop] starting backend node={} entry={} app_root={} port={} home={}",
        node.display(),
        backend_entry.display(),
        runtime.app_root.display(),
        runtime.backend_port,
        runtime.base_dir.display()
    )?;
    let stderr_log = stdout_log.try_clone()?;
    command
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));
    Ok(())
}

fn stop_backend(runtime: &mut DesktopRuntime) {
    if let Some(mut child) = runtime.backend_process.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn restart_backend(runtime: &mut DesktopRuntime) -> Result<(), String> {
    stop_backend(runtime);
    start_backend(runtime).map_err(|error| error.to_string())
}

fn ssh_helper_entry_path(runtime: &DesktopRuntime) -> PathBuf {
    runtime
        .app_root
        .join("apps")
        .join("desktop")
        .join("dist")
        .join("ssh-helper.mjs")
}

fn start_ssh_helper_process(
    app: tauri::AppHandle,
    runtime: &DesktopRuntime,
) -> Result<SshHelperProcess, String> {
    let helper_entry = ssh_helper_entry_path(runtime);
    if !helper_entry.exists() {
        return Err(format!(
            "Missing SSH helper at {}. Run 'bun run build:desktop' first.",
            helper_entry.display()
        ));
    }

    let node = normalize_process_path(&resolve_node_executable(runtime));
    let process_helper_entry = normalize_process_path(&helper_entry);
    let process_app_root = normalize_process_path(&runtime.app_root);
    let mut command = Command::new(node);
    configure_child_process_window(&mut command);
    let mut child = command
        .arg(&process_helper_entry)
        .current_dir(&process_app_root)
        .env(
            "T3CODE_HOME",
            runtime.base_dir.to_string_lossy().to_string(),
        )
        .env("T3CODE_DESKTOP_APP_VERSION", runtime.app_version.clone())
        .env(
            "T3CODE_DESKTOP_UPDATE_CHANNEL",
            runtime.settings.update_channel.clone(),
        )
        .env(
            "T3CODE_DESKTOP_IS_DEV",
            if runtime.is_development { "1" } else { "0" },
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if runtime.is_development {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .spawn()
        .map_err(|error| format!("Failed to start SSH helper: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open SSH helper stdin.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open SSH helper stdout.".to_string())?;
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let handle = SshHelperHandle {
        stdin: Arc::new(Mutex::new(stdin)),
        pending: Arc::clone(&pending),
        next_id: Arc::new(Mutex::new(1)),
    };
    spawn_ssh_helper_reader(app, stdout, pending);

    Ok(SshHelperProcess { child, handle })
}

fn ensure_ssh_helper(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, DesktopAppState>,
) -> Result<SshHelperHandle, String> {
    let mut helper = state.ssh_helper.lock().map_err(|error| error.to_string())?;
    if let Some(process) = helper.as_mut() {
        match process.child.try_wait() {
            Ok(None) => return Ok(process.handle.clone()),
            Ok(Some(_)) => {
                *helper = None;
            }
            Err(error) => return Err(format!("Failed to inspect SSH helper: {error}")),
        }
    }

    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    let process = start_ssh_helper_process(app.clone(), &runtime)?;
    let handle = process.handle.clone();
    *helper = Some(process);
    Ok(handle)
}

fn stop_ssh_helper(state: &DesktopAppState) {
    if let Ok(mut helper) = state.ssh_helper.lock() {
        if let Some(mut process) = helper.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

fn backend_http_ready(host: &str, port: u16) -> bool {
    if let Ok(mut stream) = TcpStream::connect((host, port)) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let request = format!("GET / HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_ok() {
            let mut buffer = [0_u8; 256];
            if let Ok(bytes_read) = stream.read(&mut buffer) {
                return bytes_read > 0
                    && String::from_utf8_lossy(&buffer[..bytes_read]).starts_with("HTTP/1.1 ");
            }
        }
    }
    false
}

fn wait_for_backend_http(host: &str, port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if backend_http_ready(host, port) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn wait_for_backend_startup(runtime: &mut DesktopRuntime, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    let port = runtime.backend_port;
    let log_path = backend_log_path(runtime);

    while started.elapsed() < timeout {
        if backend_http_ready(LOOPBACK_HOST, port) {
            return Ok(());
        }

        let child = runtime
            .backend_process
            .as_mut()
            .ok_or_else(|| "backend process was not started".to_string())?;
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "backend exited before serving HTTP on {LOOPBACK_HOST}:{port} ({status}); log={}",
                    log_path.display()
                ));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(format!("failed to inspect backend process: {error}"));
            }
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err(format!(
        "backend did not serve HTTP on {LOOPBACK_HOST}:{port}; log={}",
        log_path.display()
    ))
}

fn build_window_url(runtime: &DesktopRuntime) -> Result<Url, url::ParseError> {
    let base_url = std::env::var("VITE_DEV_SERVER_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| runtime.backend_http_url.clone());
    let mut url = Url::parse(base_url.trim())?;
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", &runtime.backend_bootstrap_token)
        .append_pair("t3DesktopLabel", "Local environment")
        .append_pair("t3DesktopHttpBaseUrl", &runtime.backend_http_url)
        .append_pair("t3DesktopWsBaseUrl", &runtime.backend_ws_url)
        .finish();
    let route_fragment = format!("/?{fragment}");
    url.set_fragment(Some(&route_fragment));
    Ok(url)
}

fn resolve_app_branding(app: &tauri::AppHandle) -> DesktopAppBranding {
    let is_development = std::env::var("VITE_DEV_SERVER_URL")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let app_version = app.package_info().version.to_string();
    let stage_label = if is_development {
        "Dev"
    } else if is_nightly_version(&app_version) {
        "Nightly"
    } else {
        "Alpha"
    }
    .to_string();
    DesktopAppBranding {
        base_name: APP_BASE_NAME.to_string(),
        display_name: format!("{APP_BASE_NAME} ({stage_label})"),
        stage_label,
    }
}

fn default_desktop_settings() -> DesktopSettings {
    DesktopSettings {
        server_exposure_mode: "local-only".to_string(),
        tailscale_serve_enabled: false,
        tailscale_serve_port: 443,
        update_channel: "latest".to_string(),
        update_channel_configured_by_user: false,
    }
}

fn desktop_settings_path(runtime: &DesktopRuntime) -> PathBuf {
    runtime.state_dir.join("desktop-settings.json")
}

fn client_settings_path(runtime: &DesktopRuntime) -> PathBuf {
    runtime.state_dir.join("client-settings.json")
}

fn saved_environment_registry_path(runtime: &DesktopRuntime) -> PathBuf {
    runtime.state_dir.join("saved-environments.json")
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let data = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&tmp, format!("{data}\n")).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())?;
    Ok(())
}

fn read_desktop_settings(path: &Path) -> DesktopSettings {
    read_json(path)
        .and_then(|value| serde_json::from_value::<DesktopSettings>(value).ok())
        .map(|settings| DesktopSettings {
            server_exposure_mode: if settings.server_exposure_mode == "network-accessible" {
                "network-accessible".to_string()
            } else {
                "local-only".to_string()
            },
            tailscale_serve_enabled: settings.tailscale_serve_enabled,
            tailscale_serve_port: settings.tailscale_serve_port,
            update_channel: if settings.update_channel == "nightly" {
                "nightly".to_string()
            } else {
                "latest".to_string()
            },
            update_channel_configured_by_user: settings.update_channel_configured_by_user,
        })
        .unwrap_or_else(default_desktop_settings)
}

fn write_desktop_settings(runtime: &DesktopRuntime) -> Result<(), String> {
    let value = serde_json::to_value(&runtime.settings).map_err(|error| error.to_string())?;
    write_json(&desktop_settings_path(runtime), &value)
}

fn registry_records(path: &Path) -> Vec<Value> {
    read_json(path)
        .and_then(|value| value.get("records").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn record_environment_id(record: &Value) -> Option<String> {
    record
        .get("environmentId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn secret_entry(environment_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, environment_id).map_err(|error| error.to_string())
}

fn create_base_update_state(
    runtime: &DesktopRuntime,
    enabled: bool,
    message: Option<String>,
) -> DesktopUpdateState {
    DesktopUpdateState {
        enabled,
        status: if enabled { "idle" } else { "disabled" }.to_string(),
        channel: runtime.settings.update_channel.clone(),
        current_version: runtime.app_version.clone(),
        host_arch: resolve_arch(std::env::consts::ARCH),
        app_arch: resolve_arch(std::env::consts::ARCH),
        running_under_arm64_translation: false,
        available_version: None,
        downloaded_version: None,
        download_percent: None,
        checked_at: None,
        message,
        error_context: None,
        can_retry: false,
    }
}

fn initial_update_state(app: &tauri::AppHandle, runtime: &DesktopRuntime) -> DesktopUpdateState {
    match update_disabled_reason(app, runtime) {
        Some(message) => create_base_update_state(runtime, false, Some(message)),
        None => create_base_update_state(runtime, true, None),
    }
}

fn set_runtime_update_state(
    app: &tauri::AppHandle,
    runtime: &mut DesktopRuntime,
    next_state: DesktopUpdateState,
) {
    runtime.update_state = next_state.clone();
    let _ = app.emit(UPDATE_STATE_EVENT, next_state);
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn with_check_started(state: &DesktopUpdateState) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "checking".to_string(),
        checked_at: Some(now_iso()),
        message: None,
        download_percent: None,
        error_context: None,
        can_retry: false,
        ..state.clone()
    }
}

fn with_check_failed(state: &DesktopUpdateState, message: String) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "error".to_string(),
        checked_at: Some(now_iso()),
        message: Some(message),
        download_percent: None,
        error_context: Some("check".to_string()),
        can_retry: true,
        ..state.clone()
    }
}

fn with_update_available(state: &DesktopUpdateState, version: String) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "available".to_string(),
        available_version: Some(version),
        downloaded_version: None,
        download_percent: None,
        checked_at: Some(now_iso()),
        message: None,
        error_context: None,
        can_retry: false,
        ..state.clone()
    }
}

fn with_no_update(state: &DesktopUpdateState) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "up-to-date".to_string(),
        available_version: None,
        downloaded_version: None,
        download_percent: None,
        checked_at: Some(now_iso()),
        message: None,
        error_context: None,
        can_retry: false,
        ..state.clone()
    }
}

fn with_download_started(state: &DesktopUpdateState) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "downloading".to_string(),
        download_percent: Some(0.0),
        message: None,
        error_context: None,
        can_retry: false,
        ..state.clone()
    }
}

fn with_download_progress(state: &DesktopUpdateState, percent: f64) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "downloading".to_string(),
        download_percent: Some(percent),
        message: None,
        error_context: None,
        can_retry: false,
        ..state.clone()
    }
}

fn with_download_failed(state: &DesktopUpdateState, message: String) -> DesktopUpdateState {
    DesktopUpdateState {
        status: if state.available_version.is_some() {
            "available"
        } else {
            "error"
        }
        .to_string(),
        message: Some(message),
        download_percent: None,
        error_context: Some("download".to_string()),
        can_retry: state.available_version.is_some(),
        ..state.clone()
    }
}

fn with_download_complete(state: &DesktopUpdateState, version: String) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "downloaded".to_string(),
        available_version: Some(version.clone()),
        downloaded_version: Some(version),
        download_percent: Some(100.0),
        message: None,
        error_context: None,
        can_retry: true,
        ..state.clone()
    }
}

fn with_install_failed(state: &DesktopUpdateState, message: String) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "downloaded".to_string(),
        message: Some(message),
        error_context: Some("install".to_string()),
        can_retry: true,
        ..state.clone()
    }
}

fn with_install_started(state: &DesktopUpdateState) -> DesktopUpdateState {
    DesktopUpdateState {
        status: "installing".to_string(),
        message: Some("Installing update and restarting T3 Code.".to_string()),
        error_context: None,
        can_retry: false,
        ..state.clone()
    }
}

fn should_broadcast_download_progress(state: &DesktopUpdateState, next_percent: f64) -> bool {
    if state.status != "downloading" {
        return true;
    }
    let Some(current_percent) = state.download_percent else {
        return true;
    };
    let previous_step = (current_percent / 10.0).floor();
    let next_step = (next_percent / 10.0).floor();
    previous_step != next_step || next_percent >= 100.0
}

fn resolve_arch(arch: &str) -> String {
    match arch {
        "x86_64" => "x64".to_string(),
        "aarch64" => "arm64".to_string(),
        _ => "other".to_string(),
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !normalized.is_empty() && normalized != "0" && normalized != "false"
        })
        .unwrap_or(false)
}

fn is_nightly_version(version: &str) -> bool {
    let Some((_, suffix)) = version.rsplit_once(NIGHTLY_VERSION_MARKER) else {
        return false;
    };
    let Some((date, sequence)) = suffix.split_once('.') else {
        return false;
    };
    date.len() == 8
        && date.chars().all(|ch| ch.is_ascii_digit())
        && !sequence.is_empty()
        && sequence.chars().all(|ch| ch.is_ascii_digit())
}

fn does_version_match_update_channel(version: &str, channel: &str) -> bool {
    if channel == "nightly" {
        is_nightly_version(version)
    } else {
        !is_nightly_version(version)
    }
}

fn parse_update_endpoints(raw: &str) -> Result<Vec<Url>, String> {
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Url::parse(value).map_err(|error| error.to_string()))
        .collect()
}

fn resolve_env_update_pubkey() -> Option<String> {
    env_non_empty("T3CODE_TAURI_UPDATER_PUBKEY")
        .or_else(|| env_non_empty("T3CODE_DESKTOP_UPDATER_PUBKEY"))
        .or_else(|| env_non_empty("TAURI_UPDATER_PUBKEY"))
        .or_else(|| env_non_empty("TAURI_SIGNING_PUBLIC_KEY"))
}

fn resolve_env_update_endpoints() -> Result<Option<Vec<Url>>, String> {
    let mut endpoints = Vec::<Url>::new();

    if env_flag("T3CODE_DESKTOP_MOCK_UPDATES") {
        let port = env_non_empty("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT")
            .unwrap_or_else(|| "3000".to_string());
        let parsed_port = port
            .parse::<u16>()
            .map_err(|_| "Invalid T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT.".to_string())?;
        endpoints.push(
            Url::parse(&format!("http://localhost:{parsed_port}/latest.json"))
                .map_err(|error| error.to_string())?,
        );
    }

    for env_name in [
        "T3CODE_TAURI_UPDATER_ENDPOINTS",
        "T3CODE_DESKTOP_UPDATER_ENDPOINTS",
        "TAURI_UPDATER_ENDPOINTS",
    ] {
        if let Some(raw) = env_non_empty(env_name) {
            endpoints.extend(parse_update_endpoints(&raw)?);
        }
    }

    if endpoints.is_empty() {
        Ok(None)
    } else {
        Ok(Some(endpoints))
    }
}

fn build_updater(
    app: &tauri::AppHandle,
    runtime: &DesktopRuntime,
) -> Result<tauri_plugin_updater::Updater, String> {
    let channel = runtime.settings.update_channel.clone();
    let mut builder =
        app.updater_builder()
            .version_comparator(move |current_version, remote_release| {
                remote_release.version > current_version
                    && does_version_match_update_channel(
                        &remote_release.version.to_string(),
                        &channel,
                    )
            });

    if let Some(pubkey) = resolve_env_update_pubkey() {
        builder = builder.pubkey(pubkey);
    }

    if let Some(endpoints) = resolve_env_update_endpoints()? {
        if resolve_env_update_pubkey().is_none() {
            return Err(
                "Update endpoints are configured, but no updater public key is configured."
                    .to_string(),
            );
        }
        builder = builder
            .endpoints(endpoints)
            .map_err(|error| error.to_string())?;
    }

    builder.build().map_err(|error| error.to_string())
}

fn update_disabled_reason(app: &tauri::AppHandle, runtime: &DesktopRuntime) -> Option<String> {
    if env_flag("T3CODE_DISABLE_AUTO_UPDATE") {
        return Some(
            "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.".to_string(),
        );
    }

    match build_updater(app, runtime) {
        Ok(_) => None,
        Err(error) => {
            if error.contains("endpoints") || error.contains("Endpoints") {
                Some(
                    "Automatic updates are not available because no update feed is configured."
                        .to_string(),
                )
            } else {
                Some(format!("Automatic updates are not available: {error}"))
            }
        }
    }
}

fn websocket_base_url(http_base_url: &str) -> Option<String> {
    let mut url = Url::parse(http_base_url).ok()?;
    let ws_scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => return None,
    };
    url.set_scheme(ws_scheme).ok()?;
    Some(url.to_string())
}

fn strip_inline_comment(line: &str) -> String {
    line.split_once('#')
        .map(|(value, _)| value)
        .unwrap_or(line)
        .trim()
        .to_string()
}

fn split_ssh_directive_args(value: &str) -> Vec<String> {
    value
        .replace('=', " ")
        .split_whitespace()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

fn has_ssh_pattern(value: &str) -> bool {
    value.contains('*') || value.contains('?') || value.starts_with('!')
}

fn expand_ssh_path(input: &str, home_dir: &Path) -> PathBuf {
    if input == "~" {
        return home_dir.to_path_buf();
    }
    if let Some(rest) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        return home_dir.join(rest);
    }
    let path = PathBuf::from(input);
    if path.is_absolute() {
        path
    } else {
        home_dir.join(".ssh").join(path)
    }
}

fn collect_ssh_config_aliases_from_file(
    file_path: &Path,
    home_dir: &Path,
    visited: &mut Vec<PathBuf>,
) -> Vec<String> {
    let Ok(resolved_path) = file_path.canonicalize() else {
        return Vec::new();
    };
    if visited.contains(&resolved_path) {
        return Vec::new();
    }
    visited.push(resolved_path.clone());

    let Ok(raw) = fs::read_to_string(&resolved_path) else {
        return Vec::new();
    };
    let mut aliases = Vec::<String>::new();

    for line in raw.lines() {
        let stripped = strip_inline_comment(line);
        if stripped.is_empty() {
            continue;
        }

        let args = split_ssh_directive_args(&stripped);
        let Some((directive, raw_args)) = args.split_first() else {
            continue;
        };
        let normalized_directive = directive.to_lowercase();
        if normalized_directive == "include" {
            for include_path in raw_args {
                if has_ssh_pattern(include_path) {
                    continue;
                }
                aliases.extend(collect_ssh_config_aliases_from_file(
                    &expand_ssh_path(include_path, home_dir),
                    home_dir,
                    visited,
                ));
            }
            continue;
        }

        if normalized_directive != "host" {
            continue;
        }

        for alias in raw_args {
            if alias.is_empty() || has_ssh_pattern(alias) || aliases.contains(alias) {
                continue;
            }
            aliases.push(alias.clone());
        }
    }

    aliases
}

fn normalize_known_hosts_hostname(raw_host: &str) -> String {
    if let Some(bracketed) = raw_host.strip_prefix('[') {
        if let Some((host, _)) = bracketed.split_once("]:") {
            return host.to_string();
        }
    }

    let first_colon = raw_host.find(':');
    let last_colon = raw_host.rfind(':');
    if first_colon.is_some() && first_colon == last_colon {
        return raw_host[..last_colon.unwrap_or(raw_host.len())].to_string();
    }

    raw_host.to_string()
}

fn parse_known_hosts_hostnames(raw: &str) -> Vec<String> {
    let mut hostnames = Vec::<String>::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let without_marker = if trimmed.starts_with('@') {
            trimmed
                .split_whitespace()
                .skip(1)
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            trimmed.to_string()
        };
        let host_field = without_marker.split_whitespace().next().unwrap_or("");
        if host_field.is_empty() || host_field.starts_with('|') {
            continue;
        }
        for raw_host in host_field.split(',') {
            let host = normalize_known_hosts_hostname(raw_host).trim().to_string();
            if host.is_empty() || has_ssh_pattern(&host) || hostnames.contains(&host) {
                continue;
            }
            hostnames.push(host);
        }
    }
    hostnames
}

fn discover_local_ssh_hosts() -> Vec<Value> {
    let Some(home_dir) = dirs::home_dir() else {
        return Vec::new();
    };
    let ssh_dir = home_dir.join(".ssh");
    let mut discovered = HashMap::<String, Value>::new();
    let mut visited = Vec::<PathBuf>::new();

    for alias in
        collect_ssh_config_aliases_from_file(&ssh_dir.join("config"), &home_dir, &mut visited)
    {
        discovered.insert(
            alias.clone(),
            json!({
              "alias": alias,
              "hostname": alias,
              "username": null,
              "port": null,
              "source": "ssh-config"
            }),
        );
    }

    if let Ok(raw_known_hosts) = fs::read_to_string(ssh_dir.join("known_hosts")) {
        for hostname in parse_known_hosts_hostnames(&raw_known_hosts) {
            discovered.entry(hostname.clone()).or_insert_with(|| {
                json!({
                  "alias": hostname,
                  "hostname": hostname,
                  "username": null,
                  "port": null,
                  "source": "known-hosts"
                })
            });
        }
    }

    let mut hosts = discovered.into_values().collect::<Vec<_>>();
    hosts.sort_by(|left, right| {
        left.get("alias")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("alias")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    });
    hosts
}

#[tauri::command]
fn get_app_branding(app: tauri::AppHandle) -> DesktopAppBranding {
    resolve_app_branding(&app)
}

#[tauri::command]
fn set_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    let resolved_theme = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        "blurple-twilight" => Some(tauri::Theme::Dark),
        "system" => None,
        _ => return Err("Invalid desktop theme input.".to_string()),
    };

    app.set_theme(resolved_theme);
    Ok(())
}

#[tauri::command]
fn get_local_environment_bootstrap(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<DesktopEnvironmentBootstrap, String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    Ok(DesktopEnvironmentBootstrap {
        label: "Local environment".to_string(),
        http_base_url: Some(runtime.backend_http_url.clone()),
        ws_base_url: Some(runtime.backend_ws_url.clone()),
        bootstrap_token: runtime.backend_bootstrap_token.clone(),
    })
}

#[tauri::command]
fn get_client_settings(state: tauri::State<'_, DesktopAppState>) -> Result<Option<Value>, String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    Ok(read_json(&client_settings_path(&runtime)).and_then(|value| value.get("settings").cloned()))
}

#[tauri::command]
fn set_client_settings(
    state: tauri::State<'_, DesktopAppState>,
    settings: Value,
) -> Result<(), String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    write_json(
        &client_settings_path(&runtime),
        &json!({ "settings": settings }),
    )
}

#[tauri::command]
fn get_saved_environment_registry(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<Vec<Value>, String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    Ok(registry_records(&saved_environment_registry_path(&runtime)))
}

#[tauri::command]
fn set_saved_environment_registry(
    state: tauri::State<'_, DesktopAppState>,
    records: Vec<Value>,
) -> Result<(), String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    let path = saved_environment_registry_path(&runtime);
    let existing_tokens: HashMap<String, Value> = registry_records(&path)
        .into_iter()
        .filter_map(|record| {
            let id = record_environment_id(&record)?;
            let token = record.get("encryptedBearerToken")?.clone();
            Some((id, token))
        })
        .collect();

    let merged: Vec<Value> = records
        .into_iter()
        .map(|mut record| {
            if let Some(id) = record_environment_id(&record) {
                if let Some(token) = existing_tokens.get(&id) {
                    if let Some(object) = record.as_object_mut() {
                        object.insert("encryptedBearerToken".to_string(), token.clone());
                    }
                }
            }
            record
        })
        .collect();

    write_json(&path, &json!({ "records": merged }))
}

#[tauri::command]
fn get_saved_environment_secret(environment_id: String) -> Result<Option<String>, String> {
    if environment_id.trim().is_empty() {
        return Ok(None);
    }
    match secret_entry(environment_id.trim())?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn set_saved_environment_secret(
    state: tauri::State<'_, DesktopAppState>,
    environment_id: String,
    secret: String,
) -> Result<bool, String> {
    let environment_id = environment_id.trim();
    if environment_id.is_empty() || secret.trim().is_empty() {
        return Err("Invalid saved environment secret input.".to_string());
    }

    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    let exists = registry_records(&saved_environment_registry_path(&runtime))
        .iter()
        .any(|record| environment_id == record_environment_id(record).unwrap_or_default());
    if !exists {
        return Ok(false);
    }

    secret_entry(environment_id)?
        .set_password(&secret)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn remove_saved_environment_secret(environment_id: String) -> Result<(), String> {
    if environment_id.trim().is_empty() {
        return Ok(());
    }
    let entry = secret_entry(environment_id.trim())?;
    let _ = entry.delete_credential();
    Ok(())
}

#[tauri::command]
fn discover_ssh_hosts(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
) -> Result<Vec<Value>, String> {
    match ensure_ssh_helper(&app, &state) {
        Ok(helper) => serde_json::from_value(helper.request("discoverSshHosts", json!({}))?)
            .map_err(|error| error.to_string()),
        Err(_) => Ok(discover_local_ssh_hosts()),
    }
}

#[tauri::command]
fn ensure_ssh_environment(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
    target: Value,
    options: Option<Value>,
) -> Result<Value, String> {
    let helper = ensure_ssh_helper(&app, &state)?;
    helper.request(
        "ensureSshEnvironment",
        json!({
            "target": target,
            "options": options.unwrap_or(Value::Null)
        }),
    )
}

#[tauri::command]
fn disconnect_ssh_environment(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
    target: Value,
) -> Result<(), String> {
    let helper = ensure_ssh_helper(&app, &state)?;
    helper
        .request("disconnectSshEnvironment", json!({ "target": target }))
        .map(|_| ())
}

#[tauri::command]
fn resolve_ssh_password_prompt(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
    request_id: String,
    password: Option<String>,
) -> Result<(), String> {
    let helper = ensure_ssh_helper(&app, &state)?;
    helper
        .request(
            "resolveSshPasswordPrompt",
            json!({
                "requestId": request_id,
                "password": password
            }),
        )
        .map(|_| ())
}

#[tauri::command]
fn get_server_exposure_state(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<DesktopServerExposureState, String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    Ok(DesktopServerExposureState {
        mode: runtime.settings.server_exposure_mode.clone(),
        endpoint_url: runtime.backend_endpoint_url.clone(),
        advertised_host: runtime.backend_advertised_host.clone(),
        tailscale_serve_enabled: runtime.settings.tailscale_serve_enabled,
        tailscale_serve_port: runtime.settings.tailscale_serve_port,
    })
}

#[tauri::command]
fn set_server_exposure_mode(
    state: tauri::State<'_, DesktopAppState>,
    mode: String,
) -> Result<DesktopServerExposureState, String> {
    if mode != "local-only" && mode != "network-accessible" {
        return Err("Invalid desktop server exposure input.".to_string());
    }

    {
        let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
        if mode == "network-accessible" && resolve_lan_advertised_host().is_none() {
            return Err(
                "No reachable network address is available for this desktop right now.".to_string(),
            );
        }
        runtime.settings.server_exposure_mode = mode;
        refresh_backend_exposure(&mut runtime);
        write_desktop_settings(&runtime)?;
        restart_backend(&mut runtime)?;
    }

    get_server_exposure_state(state)
}

#[tauri::command]
fn set_tailscale_serve_enabled(
    state: tauri::State<'_, DesktopAppState>,
    input: TailscaleServeInput,
) -> Result<DesktopServerExposureState, String> {
    {
        let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
        runtime.settings.tailscale_serve_enabled = input.enabled;
        if let Some(port) = input.port {
            runtime.settings.tailscale_serve_port = port;
        }
        write_desktop_settings(&runtime)?;
        restart_backend(&mut runtime)?;
    }

    get_server_exposure_state(state)
}

#[tauri::command]
fn get_advertised_endpoints(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<Vec<Value>, String> {
    let runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    let mut endpoints = vec![json!({
      "id": format!("desktop-loopback:{}", runtime.backend_port),
      "label": "This machine",
      "provider": {
        "id": "desktop-core",
        "label": "Desktop",
        "kind": "core",
        "isAddon": false
      },
      "httpBaseUrl": runtime.backend_http_url.clone(),
      "wsBaseUrl": runtime.backend_ws_url.clone(),
      "reachability": "loopback",
      "compatibility": {
        "hostedHttpsApp": "requires-configuration",
        "desktopApp": "compatible"
      },
      "source": "desktop-core",
      "status": "available",
      "isDefault": runtime.backend_endpoint_url.is_none(),
      "description": "Loopback endpoint for this desktop app."
    })];

    if let Some(endpoint_url) = runtime.backend_endpoint_url.clone() {
        let ws_base_url =
            websocket_base_url(&endpoint_url).unwrap_or_else(|| runtime.backend_ws_url.clone());
        endpoints.push(json!({
          "id": format!("desktop-lan:{endpoint_url}"),
          "label": "Local network",
          "provider": {
            "id": "desktop-core",
            "label": "Desktop",
            "kind": "core",
            "isAddon": false
          },
          "httpBaseUrl": endpoint_url,
          "wsBaseUrl": ws_base_url,
          "reachability": "lan",
          "compatibility": {
            "hostedHttpsApp": "requires-configuration",
            "desktopApp": "compatible"
          },
          "source": "desktop-core",
          "status": "available",
          "isDefault": true,
          "description": "Reachable from devices on the same network."
        }));
    }

    let mut seen_tailscale_hosts = Vec::<Ipv4Addr>::new();
    for address in local_ipv4_addresses() {
        if !is_tailscale_ipv4(address) || seen_tailscale_hosts.contains(&address) {
            continue;
        }
        seen_tailscale_hosts.push(address);
        let http_base_url = format!("http://{address}:{}", runtime.backend_port);
        endpoints.push(json!({
      "id": format!("tailscale-ip:{http_base_url}"),
      "label": "Tailscale IP",
      "provider": {
        "id": "tailscale",
        "label": "Tailscale",
        "kind": "private-network",
        "isAddon": true
      },
      "httpBaseUrl": http_base_url,
      "wsBaseUrl": websocket_base_url(&format!("http://{address}:{}", runtime.backend_port)).unwrap_or_else(|| runtime.backend_ws_url.clone()),
      "reachability": "private-network",
      "compatibility": {
        "hostedHttpsApp": "requires-configuration",
        "desktopApp": "compatible"
      },
      "source": "desktop-addon",
      "status": "available",
      "description": "Reachable from devices on the same Tailnet."
    }));
    }

    for raw_endpoint in (std::env::var("T3CODE_DESKTOP_HTTPS_ENDPOINTS").unwrap_or_default())
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let Ok(parsed_url) = Url::parse(raw_endpoint) else {
            continue;
        };
        if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
            continue;
        }
        let http_base_url = parsed_url.to_string();
        let Some(ws_base_url) = websocket_base_url(&http_base_url) else {
            continue;
        };
        endpoints.push(json!({
      "id": format!("manual:{http_base_url}"),
      "label": if parsed_url.scheme() == "https" { "Custom HTTPS" } else { "Custom endpoint" },
      "provider": {
        "id": "manual",
        "label": "Manual",
        "kind": "manual",
        "isAddon": false
      },
      "httpBaseUrl": http_base_url,
      "wsBaseUrl": ws_base_url,
      "reachability": "public",
      "compatibility": {
        "hostedHttpsApp": if parsed_url.scheme() == "https" { "compatible" } else { "requires-configuration" },
        "desktopApp": "compatible"
      },
      "source": "user",
      "status": "unknown",
      "description": if parsed_url.scheme() == "https" {
        "User-configured HTTPS endpoint for this desktop backend."
      } else {
        "User-configured endpoint for this desktop backend."
      }
    }));
    }

    Ok(endpoints)
}

#[tauri::command]
fn get_update_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
) -> Result<DesktopUpdateState, String> {
    let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    if runtime.update_state.status == "disabled" {
        runtime.update_state = initial_update_state(&app, &runtime);
    }
    Ok(runtime.update_state.clone())
}

#[tauri::command]
fn set_update_channel(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
    channel: String,
) -> Result<DesktopUpdateState, String> {
    if channel != "latest" && channel != "nightly" {
        return Err("Invalid desktop update channel input.".to_string());
    }

    let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    runtime.settings.update_channel = channel;
    runtime.settings.update_channel_configured_by_user = true;
    write_desktop_settings(&runtime)?;
    runtime.available_update = None;
    runtime.downloaded_update = None;
    let next_state = initial_update_state(&app, &runtime);
    set_runtime_update_state(&app, &mut runtime, next_state.clone());
    Ok(next_state)
}

#[tauri::command]
async fn check_for_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
) -> Result<DesktopUpdateCheckResult, String> {
    let updater = {
        let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
        if runtime.update_check_in_flight
            || runtime.update_state.status == "downloading"
            || runtime.update_state.status == "downloaded"
        {
            return Ok(DesktopUpdateCheckResult {
                checked: false,
                state: runtime.update_state.clone(),
            });
        }
        if let Some(message) = update_disabled_reason(&app, &runtime) {
            let next_state = create_base_update_state(&runtime, false, Some(message));
            set_runtime_update_state(&app, &mut runtime, next_state.clone());
            return Ok(DesktopUpdateCheckResult {
                checked: false,
                state: next_state,
            });
        }

        let updater = build_updater(&app, &runtime)?;
        runtime.update_check_in_flight = true;
        let next_state = with_check_started(&runtime.update_state);
        set_runtime_update_state(&app, &mut runtime, next_state);
        updater
    };

    let check_result = updater.check().await;

    let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    runtime.update_check_in_flight = false;
    match check_result {
        Ok(Some(update)) => {
            let version = update.version.clone();
            runtime.available_update = Some(update);
            runtime.downloaded_update = None;
            let next_state = with_update_available(&runtime.update_state, version);
            set_runtime_update_state(&app, &mut runtime, next_state.clone());
            Ok(DesktopUpdateCheckResult {
                checked: true,
                state: next_state,
            })
        }
        Ok(None) => {
            runtime.available_update = None;
            runtime.downloaded_update = None;
            let next_state = with_no_update(&runtime.update_state);
            set_runtime_update_state(&app, &mut runtime, next_state.clone());
            Ok(DesktopUpdateCheckResult {
                checked: true,
                state: next_state,
            })
        }
        Err(error) => {
            let next_state = with_check_failed(&runtime.update_state, error.to_string());
            set_runtime_update_state(&app, &mut runtime, next_state.clone());
            Ok(DesktopUpdateCheckResult {
                checked: true,
                state: next_state,
            })
        }
    }
}

#[tauri::command]
async fn download_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
) -> Result<DesktopUpdateActionResult, String> {
    let update = {
        let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
        if runtime.update_download_in_flight || runtime.update_state.status != "available" {
            return Ok(DesktopUpdateActionResult {
                accepted: false,
                completed: false,
                state: runtime.update_state.clone(),
            });
        }
        let Some(update) = runtime.available_update.clone() else {
            return Ok(DesktopUpdateActionResult {
                accepted: false,
                completed: false,
                state: runtime.update_state.clone(),
            });
        };
        runtime.update_download_in_flight = true;
        let next_state = with_download_started(&runtime.update_state);
        set_runtime_update_state(&app, &mut runtime, next_state);
        update
    };

    let mut downloaded_bytes = 0_u64;
    let download_result = update
        .download(
            |chunk_length, content_length| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                let Some(total) = content_length else {
                    return;
                };
                if total == 0 {
                    return;
                }
                let percent = ((downloaded_bytes as f64 / total as f64) * 100.0).clamp(0.0, 100.0);
                if let Some(app_state) = app.try_state::<DesktopAppState>() {
                    if let Ok(mut runtime) = app_state.runtime.lock() {
                        if should_broadcast_download_progress(&runtime.update_state, percent)
                            || runtime.update_state.message.is_some()
                        {
                            let next_state = with_download_progress(&runtime.update_state, percent);
                            set_runtime_update_state(&app, &mut runtime, next_state);
                        }
                    }
                }
            },
            || {},
        )
        .await;

    let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
    runtime.update_download_in_flight = false;
    match download_result {
        Ok(bytes) => {
            let version = update.version.clone();
            runtime.downloaded_update = Some(DownloadedUpdate { update, bytes });
            let next_state = with_download_complete(&runtime.update_state, version);
            set_runtime_update_state(&app, &mut runtime, next_state.clone());
            Ok(DesktopUpdateActionResult {
                accepted: true,
                completed: true,
                state: next_state,
            })
        }
        Err(error) => {
            let next_state = with_download_failed(&runtime.update_state, error.to_string());
            set_runtime_update_state(&app, &mut runtime, next_state.clone());
            Ok(DesktopUpdateActionResult {
                accepted: true,
                completed: false,
                state: next_state,
            })
        }
    }
}

#[tauri::command]
fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopAppState>,
) -> Result<DesktopUpdateActionResult, String> {
    let downloaded = {
        let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
        if runtime.update_install_in_flight || runtime.update_state.status != "downloaded" {
            return Ok(DesktopUpdateActionResult {
                accepted: false,
                completed: false,
                state: runtime.update_state.clone(),
            });
        }
        let Some(downloaded) = runtime.downloaded_update.take() else {
            return Ok(DesktopUpdateActionResult {
                accepted: false,
                completed: false,
                state: runtime.update_state.clone(),
            });
        };
        runtime.update_install_in_flight = true;
        let next_state = with_install_started(&runtime.update_state);
        set_runtime_update_state(&app, &mut runtime, next_state);
        downloaded
    };

    {
        let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
        stop_backend(&mut runtime);
    }
    stop_ssh_helper(&state);

    match downloaded.update.install(&downloaded.bytes) {
        Ok(()) => Ok(DesktopUpdateActionResult {
            accepted: true,
            completed: false,
            state: state
                .runtime
                .lock()
                .map_err(|error| error.to_string())?
                .update_state
                .clone(),
        }),
        Err(error) => {
            let mut runtime = state.runtime.lock().map_err(|error| error.to_string())?;
            runtime.update_install_in_flight = false;
            runtime.downloaded_update = Some(downloaded);
            let next_state = with_install_failed(&runtime.update_state, error.to_string());
            set_runtime_update_state(&app, &mut runtime, next_state.clone());
            Ok(DesktopUpdateActionResult {
                accepted: true,
                completed: false,
                state: next_state,
            })
        }
    }
}
