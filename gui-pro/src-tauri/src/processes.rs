use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub name: String,
    pub path: Option<String>,
}

/// List unique running processes on Windows using CreateToolhelp32Snapshot.
#[cfg(windows)]
#[tauri::command]
pub fn list_running_processes() -> Result<Vec<ProcessInfo>, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::mem;

    // Windows API constants and types
    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;
    const MAX_PATH: usize = 260;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESSENTRY32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; MAX_PATH],
    }

    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
        fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(hObject: isize) -> i32;
    }

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Failed to create process snapshot".into());
        }

        let mut entry: PROCESSENTRY32W = mem::zeroed();
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut names = BTreeSet::new();

        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(MAX_PATH);
                let name = OsString::from_wide(&entry.szExeFile[..len])
                    .to_string_lossy()
                    .to_string()
                    .to_lowercase();

                // Skip system processes
                if !name.is_empty()
                    && name != "[system process]"
                    && name != "system"
                    && name != "idle"
                    && name != "registry"
                    && name != "secure system"
                    && name != "memory compression"
                {
                    names.insert(name);
                }

                entry = mem::zeroed();
                entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);

        let processes: Vec<ProcessInfo> = names.into_iter()
            .map(|name| ProcessInfo { name, path: None })
            .collect();

        eprintln!("[processes] Found {} unique processes", processes.len());
        Ok(processes)
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn list_running_processes() -> Result<Vec<ProcessInfo>, String> {
    Ok(Vec::new())
}
