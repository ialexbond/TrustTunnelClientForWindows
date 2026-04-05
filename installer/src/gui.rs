use crate::install;
use crate::uninstall;
use crate::InstallerConfig;
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use windows::core::*;
#[cfg(windows)]
use windows::Win32::Foundation::*;
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::*;
#[cfg(windows)]
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::*;

// ─── Colors ───────────────────────────────────────────

const BG_COLOR: u32 = 0x00140f0f; // #0f0f14 (BGR)
const TEXT_COLOR: u32 = 0x00ffffff; // white
const TEXT_MUTED: u32 = 0x00999999; // gray
const ACCENT_COLOR: u32 = 0x00f16663; // #6366f1 (BGR)
const _ACCENT_HOVER: u32 = 0x00ff8180; // lighter accent
const BTN_TEXT: u32 = 0x00ffffff;
const PROGRESS_BG: u32 = 0x00302828; // dark track
const CHECK_COLOR: u32 = 0x00f16663; // same as accent

// ─── Window dimensions ────────────────────────────────

const WIN_W: i32 = 500;
const WIN_H: i32 = 440;

// ─── Control IDs (reserved for future use) ───────────

const _ID_BTN_INSTALL: u16 = 101;
const _ID_BTN_CLOSE: u16 = 102;
const _ID_CHECK_DESKTOP: u16 = 103;
const _ID_CHECK_LAUNCH: u16 = 104;
const _ID_BTN_CANCEL: u16 = 105;

// ─── Shared state ─────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum InstallerState {
    Ready,
    Installing,
    Done,
    Error,
}

struct SharedState {
    state: InstallerState,
    progress: f32,          // 0.0..1.0
    status_text: String,
    error_text: String,
    desktop_shortcut: bool,
    launch_after: bool,
    is_update: bool,
    old_version: String,
}

static mut G_STATE: Option<Arc<Mutex<SharedState>>> = None;
static mut G_CONFIG: Option<&'static InstallerConfig> = None;
static mut G_HWND: HWND = HWND(std::ptr::null_mut());

// ─── Public entry points ──────────────────────────────

#[cfg(windows)]
pub fn run_installer(config: &InstallerConfig) {
    // Leak config to static (lives for program duration)
    let config: &'static InstallerConfig = unsafe {
        let ptr = config as *const InstallerConfig;
        &*ptr
    };

    let prev = install::detect_previous_install(config);
    let (is_update, old_ver) = prev
        .as_ref()
        .map(|p| (true, p.version.clone()))
        .unwrap_or((false, String::new()));

    let state = Arc::new(Mutex::new(SharedState {
        state: InstallerState::Ready,
        progress: 0.0,
        status_text: String::new(),
        error_text: String::new(),
        desktop_shortcut: true,
        launch_after: true,
        is_update,
        old_version: old_ver,
    }));

    unsafe {
        G_STATE = Some(state);
        G_CONFIG = Some(config);
    }

    create_window(config, false);
}

#[cfg(windows)]
pub fn run_uninstaller(config: &InstallerConfig) {
    let config: &'static InstallerConfig = unsafe {
        let ptr = config as *const InstallerConfig;
        &*ptr
    };

    let state = Arc::new(Mutex::new(SharedState {
        state: InstallerState::Ready,
        progress: 0.0,
        status_text: String::new(),
        error_text: String::new(),
        desktop_shortcut: false,
        launch_after: false,
        is_update: false,
        old_version: String::new(),
    }));

    unsafe {
        G_STATE = Some(state);
        G_CONFIG = Some(config);
    }

    create_window(config, true);
}

// ─── Window creation ──────────────────────────────────

#[cfg(windows)]
fn create_window(config: &InstallerConfig, uninstall_mode: bool) {
    unsafe {
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let hinstance: HINSTANCE = std::mem::transmute(instance);
        let class_name = w!("TrustTunnelInstaller");

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(if uninstall_mode {
                wnd_proc_uninstall
            } else {
                wnd_proc_install
            }),
            hInstance: hinstance,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: class_name,
            hbrBackground: CreateSolidBrush(COLORREF(BG_COLOR)),
            ..Default::default()
        };
        RegisterClassExW(&wc);

        // Center on screen
        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let screen_h = GetSystemMetrics(SM_CYSCREEN);
        let x = (screen_w - WIN_W) / 2;
        let y = (screen_h - WIN_H) / 2;

        let title = if uninstall_mode {
            format!("Удаление {}", config.product_name)
        } else {
            format!("Установка {}", config.product_name)
        };
        let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            PCWSTR(title_w.as_ptr()),
            WS_POPUP | WS_VISIBLE,
            x,
            y,
            WIN_W,
            WIN_H,
            None,
            None,
            hinstance,
            None,
        )
        .unwrap();

        G_HWND = hwnd;

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// ─── Install window proc ──────────────────────────────

#[cfg(windows)]
unsafe extern "system" fn wnd_proc_install(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            paint_installer(hdc, hwnd);
            EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            handle_click_install(hwnd, x, y);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[cfg(windows)]
unsafe extern "system" fn wnd_proc_uninstall(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            paint_uninstaller(hdc, hwnd);
            EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            handle_click_uninstall(hwnd, x, y);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// ─── Paint helpers ────────────────────────────────────

#[cfg(windows)]
unsafe fn draw_text_centered(hdc: HDC, text: &str, y: i32, color: u32, font_size: i32, bold: bool) {
    let font = CreateFontW(
        font_size, 0, 0, 0,
        if bold { 700 } else { 400 },
        0, 0, 0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
        w!("Segoe UI"),
    );
    let old_font = SelectObject(hdc, font);
    SetTextColor(hdc, COLORREF(color));
    SetBkMode(hdc, TRANSPARENT);

    let mut text_w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut rect = RECT {
        left: 0,
        top: y,
        right: WIN_W,
        bottom: y + font_size.unsigned_abs() as i32 + 10,
    };
    DrawTextW(hdc, &mut text_w, &mut rect, DT_CENTER | DT_SINGLELINE | DT_NOCLIP);

    SelectObject(hdc, old_font);
    let _ = DeleteObject(font);
}

#[cfg(windows)]
unsafe fn draw_text_right(hdc: HDC, text: &str, y: i32, color: u32, font_size: i32, bold: bool) {
    let font = CreateFontW(
        font_size, 0, 0, 0,
        if bold { 700 } else { 400 },
        0, 0, 0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
        w!("Segoe UI"),
    );
    let old_font = SelectObject(hdc, font);
    SetTextColor(hdc, COLORREF(color));
    SetBkMode(hdc, TRANSPARENT);

    let mut text_w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut rect = RECT {
        left: WIN_W - 40,
        top: y,
        right: WIN_W - 8,
        bottom: y + font_size.unsigned_abs() as i32 + 10,
    };
    DrawTextW(hdc, &mut text_w, &mut rect, DT_CENTER | DT_SINGLELINE | DT_NOCLIP);

    SelectObject(hdc, old_font);
    let _ = DeleteObject(font);
}

#[cfg(windows)]
unsafe fn draw_shield_logo(hdc: HDC, x: i32, y: i32, size: i32, color: u32) {
    let brush = CreateSolidBrush(COLORREF(color));
    // Shield body (rounded rect)
    let body = CreateRoundRectRgn(x, y, x + size, y + size - size / 4, size / 4, size / 4);
    FillRgn(hdc, body, brush);
    let _ = DeleteObject(body);
    // Shield bottom point (triangle-ish)
    let points = [
        POINT { x, y: y + size / 2 },
        POINT { x: x + size / 2, y: y + size },
        POINT { x: x + size, y: y + size / 2 },
    ];
    let tri = CreatePolygonRgn(&points, ALTERNATE);
    FillRgn(hdc, tri, brush);
    let _ = DeleteObject(tri);
    let _ = DeleteObject(brush);

    // Checkmark inside shield
    let check_font = CreateFontW(
        -(size / 2), 0, 0, 0, 700, 0, 0, 0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
        w!("Segoe UI"),
    );
    let old = SelectObject(hdc, check_font);
    SetTextColor(hdc, COLORREF(0x00ffffff));
    SetBkMode(hdc, TRANSPARENT);
    let mut check: Vec<u16> = "\u{2713}".encode_utf16().chain(std::iter::once(0)).collect();
    let mut cr = RECT { left: x, top: y + size / 6, right: x + size, bottom: y + size * 3 / 4 };
    DrawTextW(hdc, &mut check, &mut cr, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    SelectObject(hdc, old);
    let _ = DeleteObject(check_font);
}

#[cfg(windows)]
unsafe fn draw_text_wrapped(hdc: HDC, text: &str, x: i32, y: i32, w: i32, color: u32, font_size: i32) {
    let font = CreateFontW(
        font_size, 0, 0, 0, 400, 0, 0, 0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
        w!("Segoe UI"),
    );
    let old_font = SelectObject(hdc, font);
    SetTextColor(hdc, COLORREF(color));
    SetBkMode(hdc, TRANSPARENT);

    let mut text_w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut rect = RECT { left: x, top: y, right: x + w, bottom: y + 100 };
    DrawTextW(hdc, &mut text_w, &mut rect, DT_LEFT | DT_WORDBREAK | DT_NOCLIP);

    SelectObject(hdc, old_font);
    let _ = DeleteObject(font);
}

#[cfg(windows)]
unsafe fn draw_button(hdc: HDC, text: &str, x: i32, y: i32, w: i32, h: i32, color: u32) {
    let brush = CreateSolidBrush(COLORREF(color));
    let rect = RECT { left: x, top: y, right: x + w, bottom: y + h };

    // Rounded rect
    let rgn = CreateRoundRectRgn(x, y, x + w, y + h, 8, 8);
    FillRgn(hdc, rgn, brush);
    let _ = DeleteObject(rgn);
    let _ = DeleteObject(brush);

    // Button text
    let font = CreateFontW(
        -16, 0, 0, 0, 600, 0, 0, 0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
        w!("Segoe UI"),
    );
    let old_font = SelectObject(hdc, font);
    SetTextColor(hdc, COLORREF(BTN_TEXT));
    SetBkMode(hdc, TRANSPARENT);

    let mut text_w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut text_rect = rect;
    DrawTextW(hdc, &mut text_w, &mut text_rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    SelectObject(hdc, old_font);
    let _ = DeleteObject(font);
}

#[cfg(windows)]
unsafe fn draw_progress_bar(hdc: HDC, x: i32, y: i32, w: i32, h: i32, progress: f32) {
    // Background track
    let bg_brush = CreateSolidBrush(COLORREF(PROGRESS_BG));
    let bg_rgn = CreateRoundRectRgn(x, y, x + w, y + h, 6, 6);
    FillRgn(hdc, bg_rgn, bg_brush);
    let _ = DeleteObject(bg_rgn);
    let _ = DeleteObject(bg_brush);

    // Filled portion
    if progress > 0.0 {
        let fill_w = ((w as f32) * progress.min(1.0)) as i32;
        if fill_w > 0 {
            let fill_brush = CreateSolidBrush(COLORREF(ACCENT_COLOR));
            let fill_rgn = CreateRoundRectRgn(x, y, x + fill_w, y + h, 6, 6);
            FillRgn(hdc, fill_rgn, fill_brush);
            let _ = DeleteObject(fill_rgn);
            let _ = DeleteObject(fill_brush);
        }
    }
}

#[cfg(windows)]
unsafe fn draw_checkbox(hdc: HDC, x: i32, y: i32, text: &str, checked: bool) {
    let box_size = 16;

    // Box border
    let border_brush = CreateSolidBrush(COLORREF(if checked { CHECK_COLOR } else { TEXT_MUTED }));
    let border_rect = RECT {
        left: x,
        top: y,
        right: x + box_size,
        bottom: y + box_size,
    };
    FrameRect(hdc, &border_rect, border_brush);
    let _ = DeleteObject(border_brush);

    // Fill if checked
    if checked {
        let fill_brush = CreateSolidBrush(COLORREF(CHECK_COLOR));
        let inner = RECT {
            left: x + 2,
            top: y + 2,
            right: x + box_size - 2,
            bottom: y + box_size - 2,
        };
        FillRect(hdc, &inner, fill_brush);
        let _ = DeleteObject(fill_brush);
    }

    // Label
    let font = CreateFontW(
        -13, 0, 0, 0, 400, 0, 0, 0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
        w!("Segoe UI"),
    );
    let old_font = SelectObject(hdc, font);
    SetTextColor(hdc, COLORREF(TEXT_COLOR));
    SetBkMode(hdc, TRANSPARENT);

    let mut text_w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut rect = RECT {
        left: x + box_size + 8,
        top: y - 1,
        right: WIN_W - 40,
        bottom: y + box_size + 4,
    };
    DrawTextW(hdc, &mut text_w, &mut rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

    SelectObject(hdc, old_font);
    let _ = DeleteObject(font);
}

// ─── Paint: Installer ─────────────────────────────────

#[cfg(windows)]
unsafe fn paint_installer(hdc: HDC, _hwnd: HWND) {
    let state_arc = G_STATE.as_ref().unwrap().clone();
    let state = state_arc.lock().unwrap();
    let config = G_CONFIG.unwrap();

    // Background
    let bg = CreateSolidBrush(COLORREF(BG_COLOR));
    let rect = RECT { left: 0, top: 0, right: WIN_W, bottom: WIN_H };
    FillRect(hdc, &rect, bg);
    let _ = DeleteObject(bg);

    // Close button (X) — only top-right
    draw_text_right(hdc, "\u{00D7}", 10, TEXT_MUTED, -18, false); // × symbol

    // Title bar line
    let line_brush = CreateSolidBrush(COLORREF(0x00282020));
    let line_rect = RECT { left: 0, top: 36, right: WIN_W, bottom: 37 };
    FillRect(hdc, &line_rect, line_brush);
    let _ = DeleteObject(line_brush);

    // Logo: draw shield shape with GDI
    draw_shield_logo(hdc, WIN_W / 2 - 24, 55, 48, ACCENT_COLOR);

    // Product name
    let title = format!("{} v{}", config.product_name, config.version);
    draw_text_centered(hdc, &title, 125, TEXT_COLOR, -20, true);

    // Subtitle
    draw_text_centered(hdc, "VPN-client for Windows", 155, TEXT_MUTED, -14, false);

    match state.state {
        InstallerState::Ready => {
            // Install/Update button
            let btn_text = if state.is_update {
                format!("Update ({}->{})", state.old_version, config.version)
            } else {
                "Install".to_string()
            };
            draw_button(hdc, &btn_text, 80, 200, WIN_W - 160, 44, ACCENT_COLOR);

            // Checkboxes
            draw_checkbox(hdc, 80, 268, "Desktop shortcut", state.desktop_shortcut);
            draw_checkbox(hdc, 80, 296, "Launch after install", state.launch_after);
        }
        InstallerState::Installing => {
            // Progress bar
            draw_progress_bar(hdc, 60, 210, WIN_W - 120, 12, state.progress);

            // Status text
            draw_text_centered(hdc, &state.status_text, 235, TEXT_MUTED, -13, false);

            // Cancel button
            draw_button(hdc, "Отмена", 160, 270, WIN_W - 320, 36, PROGRESS_BG);
        }
        InstallerState::Done => {
            draw_text_centered(hdc, "\u{2713} Установка завершена!", 200, 0x0080ff80, -18, true);

            draw_button(hdc, "Готово", 80, 260, WIN_W - 160, 44, ACCENT_COLOR);
        }
        InstallerState::Error => {
            draw_text_centered(hdc, "Ошибка установки", 195, 0x004040ff, -16, true);
            draw_text_wrapped(hdc, &state.error_text, 30, 220, WIN_W - 60, TEXT_MUTED, -11);

            draw_button(hdc, "Закрыть", 80, 330, WIN_W - 160, 44, PROGRESS_BG);
        }
    }

    // Version footer
    draw_text_centered(hdc, "(c) 2025 TrustTunnel", WIN_H - 30, 0x00555555, -11, false);
}

// ─── Paint: Uninstaller ───────────────────────────────

#[cfg(windows)]
unsafe fn paint_uninstaller(hdc: HDC, _hwnd: HWND) {
    let state_arc = G_STATE.as_ref().unwrap().clone();
    let state = state_arc.lock().unwrap();
    let config = G_CONFIG.unwrap();

    let bg = CreateSolidBrush(COLORREF(BG_COLOR));
    let rect = RECT { left: 0, top: 0, right: WIN_W, bottom: WIN_H };
    FillRect(hdc, &rect, bg);
    let _ = DeleteObject(bg);

    // Close button (X) — only top-right
    draw_text_right(hdc, "\u{00D7}", 10, TEXT_MUTED, -18, false);

    let line_brush = CreateSolidBrush(COLORREF(0x00282020));
    let line_rect = RECT { left: 0, top: 36, right: WIN_W, bottom: 37 };
    FillRect(hdc, &line_rect, line_brush);
    let _ = DeleteObject(line_brush);

    // Logo
    draw_shield_logo(hdc, WIN_W / 2 - 24, 55, 48, 0x004040cc);

    let title = format!("Удаление {}", config.product_name);
    draw_text_centered(hdc, &title, 125, TEXT_COLOR, -20, true);

    match state.state {
        InstallerState::Ready => {
            draw_text_centered(hdc, "Вы хотите удалить приложение?", 165, TEXT_MUTED, -14, false);
            draw_button(hdc, "Удалить", 80, 210, WIN_W - 160, 44, 0x004040cc);
            draw_button(hdc, "Отмена", 80, 268, WIN_W - 160, 36, PROGRESS_BG);
        }
        InstallerState::Installing => {
            draw_progress_bar(hdc, 60, 200, WIN_W - 120, 12, state.progress);
            draw_text_centered(hdc, &state.status_text, 225, TEXT_MUTED, -13, false);
        }
        InstallerState::Done => {
            draw_text_centered(hdc, "Uninstall complete!", 200, 0x0080ff80, -18, true);
            draw_button(hdc, "Close", 80, 260, WIN_W - 160, 44, ACCENT_COLOR);
        }
        InstallerState::Error => {
            draw_text_centered(hdc, "Uninstall error", 195, 0x004040ff, -16, true);
            draw_text_centered(hdc, &state.error_text, 225, TEXT_MUTED, -12, false);
            draw_button(hdc, "Close", 80, 270, WIN_W - 160, 44, PROGRESS_BG);
        }
    }

    draw_text_centered(hdc, "(c) 2025 TrustTunnel", WIN_H - 30, 0x00555555, -11, false);
}

// ─── Click handlers ───────────────────────────────────

#[cfg(windows)]
unsafe fn handle_click_install(hwnd: HWND, x: i32, y: i32) {
    let state_arc = G_STATE.as_ref().unwrap().clone();
    let config = G_CONFIG.unwrap();

    // Close button (X)
    if x >= WIN_W - 35 && x <= WIN_W - 10 && y >= 8 && y <= 30 {
        let _ = DestroyWindow(hwnd);
        return;
    }

    let current_state = state_arc.lock().unwrap().state;

    match current_state {
        InstallerState::Ready => {
            // Desktop shortcut checkbox area
            if x >= 80 && x <= 380 && y >= 260 && y <= 284 {
                let mut s = state_arc.lock().unwrap();
                s.desktop_shortcut = !s.desktop_shortcut;
                InvalidateRect(hwnd, None, true);
                return;
            }
            // Launch after checkbox area
            if x >= 80 && x <= 380 && y >= 288 && y <= 312 {
                let mut s = state_arc.lock().unwrap();
                s.launch_after = !s.launch_after;
                InvalidateRect(hwnd, None, true);
                return;
            }
            // Install button
            if x >= 80 && x <= WIN_W - 80 && y >= 200 && y <= 244 {
                start_installation(hwnd, state_arc.clone(), config);
            }
        }
        InstallerState::Done => {
            // "Finish" button
            if x >= 80 && x <= WIN_W - 80 && y >= 260 && y <= 304 {
                // Launch app if checked
                let launch = state_arc.lock().unwrap().launch_after;
                if launch {
                    let install_dir = install::default_install_dir(config);
                    let exe = install_dir.join(config.exe_name);
                    if exe.exists() {
                        let _ = std::process::Command::new(exe).spawn();
                    }
                }
                let _ = DestroyWindow(hwnd);
            }
        }
        InstallerState::Error => {
            // "Close" button
            if x >= 80 && x <= WIN_W - 80 && y >= 270 && y <= 314 {
                let _ = DestroyWindow(hwnd);
            }
        }
        _ => {}
    }
}

#[cfg(windows)]
unsafe fn handle_click_uninstall(hwnd: HWND, x: i32, y: i32) {
    let state_arc = G_STATE.as_ref().unwrap().clone();
    let config = G_CONFIG.unwrap();

    // Close button (X)
    if x >= WIN_W - 35 && x <= WIN_W - 10 && y >= 8 && y <= 30 {
        let _ = DestroyWindow(hwnd);
        return;
    }

    let current_state = state_arc.lock().unwrap().state;

    match current_state {
        InstallerState::Ready => {
            // "Uninstall" button
            if x >= 80 && x <= WIN_W - 80 && y >= 210 && y <= 254 {
                start_uninstallation(hwnd, state_arc.clone(), config);
            }
            // "Cancel" button
            if x >= 80 && x <= WIN_W - 80 && y >= 268 && y <= 304 {
                let _ = DestroyWindow(hwnd);
            }
        }
        InstallerState::Done | InstallerState::Error => {
            if x >= 80 && x <= WIN_W - 80 && y >= 260 && y <= 304 {
                let _ = DestroyWindow(hwnd);
            }
        }
        _ => {}
    }
}

// ─── Send wrapper for HWND ────────────────────────────

/// HWND contains a raw pointer which is not Send.
/// We know it's safe to send across threads for InvalidateRect calls.
#[cfg(windows)]
#[derive(Clone, Copy)]
struct SendHwnd(isize);

#[cfg(windows)]
unsafe impl Send for SendHwnd {}

#[cfg(windows)]
impl SendHwnd {
    fn new(hwnd: HWND) -> Self {
        Self(hwnd.0 as isize)
    }
    fn get(self) -> HWND {
        HWND(self.0 as *mut _)
    }
}

// ─── Background install/uninstall ─────────────────────

#[cfg(windows)]
fn start_installation(
    hwnd: HWND,
    state: Arc<Mutex<SharedState>>,
    config: &'static InstallerConfig,
) {
    {
        let mut s = state.lock().unwrap();
        s.state = InstallerState::Installing;
        s.status_text = "Preparing...".to_string();
    }
    unsafe { InvalidateRect(hwnd, None, true) };

    let state_clone = state.clone();
    let create_desktop = state.lock().unwrap().desktop_shortcut;
    let send_hwnd = SendHwnd::new(hwnd);

    // Detect previous install for install dir
    let install_dir = install::detect_previous_install(config)
        .map(|p| p.install_dir)
        .unwrap_or_else(|| install::default_install_dir(config));

    std::thread::spawn(move || {
        let hwnd = send_hwnd.get();
        let result = install::perform_install(config, &install_dir, create_desktop, |p| {
            let mut s = state_clone.lock().unwrap();
            s.progress = p.current as f32 / p.total as f32;
            s.status_text = format!("Extracting: {}", p.file_name);
            drop(s);
            unsafe { InvalidateRect(hwnd, None, true) };
        });

        let mut s = state_clone.lock().unwrap();
        match result {
            Ok(()) => {
                s.state = InstallerState::Done;
                s.progress = 1.0;
            }
            Err(e) => {
                s.state = InstallerState::Error;
                s.error_text = e;
            }
        }
        drop(s);
        unsafe { InvalidateRect(hwnd, None, true) };
    });
}

#[cfg(windows)]
fn start_uninstallation(
    hwnd: HWND,
    state: Arc<Mutex<SharedState>>,
    config: &'static InstallerConfig,
) {
    {
        let mut s = state.lock().unwrap();
        s.state = InstallerState::Installing;
        s.status_text = "Uninstalling...".to_string();
        s.progress = 0.2;
    }
    unsafe { InvalidateRect(hwnd, None, true) };

    let state_clone = state.clone();
    let send_hwnd = SendHwnd::new(hwnd);

    std::thread::spawn(move || {
        let hwnd = send_hwnd.get();
        let result = uninstall::perform_uninstall(config, |status| {
            let mut s = state_clone.lock().unwrap();
            s.status_text = status.to_string();
            s.progress += 0.15;
            drop(s);
            unsafe { InvalidateRect(hwnd, None, true) };
        });

        let mut s = state_clone.lock().unwrap();
        match result {
            Ok(()) => {
                s.state = InstallerState::Done;
                s.progress = 1.0;
            }
            Err(e) => {
                s.state = InstallerState::Error;
                s.error_text = e;
            }
        }
        drop(s);
        unsafe { InvalidateRect(hwnd, None, true) };
    });
}
