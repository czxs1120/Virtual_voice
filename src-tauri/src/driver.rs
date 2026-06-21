//! VB-CABLE Virtual Audio Driver management module.
//!
//! Provides functions to detect, install, and uninstall the VB-CABLE
//! virtual audio driver. The driver files are bundled as Tauri resources
//! and extracted at runtime.
//!
//! The primary installation is done by the NSIS installer during setup;
//! this module serves as a fallback and status reporter at runtime.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW constant — prevents console window flashing from GUI apps
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Whether the current process is running with Administrator privileges.
/// Used to give clearer guidance when driver install/uninstall will fail.
#[cfg(windows)]
fn is_admin() -> bool {
    Command::new("net")
        .args(["session"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_admin() -> bool {
    true
}

/// Appends an admin-privilege hint to an error message when not elevated.
fn with_admin_hint(msg: &str) -> String {
    if is_admin() {
        msg.to_string()
    } else {
        format!(
            "{}\n\n⚠️ 当前未以管理员身份运行。安装/卸载驱动需要管理员权限，请右键应用 → \"以管理员身份运行\"后重试。",
            msg
        )
    }
}

/// The registry path where audio drivers are registered.
const DRIVER_REG_KEY: &str = r"SYSTEM\CurrentControlSet\Services\VbaudioVACWDM";

/// Status of the VB-CABLE driver.
#[derive(Debug, Clone, Serialize)]
pub enum DriverStatus {
    /// Driver is installed and appears to be working.
    Installed,
    /// Driver is not installed.
    NotInstalled,
    /// Could not determine status (e.g., permission issue).
    Unknown,
}

/// Result of a driver operation.
#[derive(Debug, Clone, Serialize)]
pub struct DriverActionResult {
    pub success: bool,
    pub message: String,
}

/// Get the path to the bundled driver files directory.
fn get_driver_dir(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    // First try the standard resource directory (packaged mode).
    // Tauri bundles "resources/drivers/vbcable/*" relative to the resource dir.
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .ok()?
        .join("resources")
        .join("drivers")
        .join("vbcable");
    if resource_dir.exists() {
        return Some(resource_dir);
    }

    // Fallback for dev mode: check relative to the project source directory.
    // The executable is at target/debug/virtual-voice.exe, so go up 3 levels.
    if let Ok(exe) = std::env::current_exe() {
        let dev_path = exe
            .parent()?          // target/debug/
            .parent()?          // target/
            .parent()?          // project root
            .join("src-tauri")
            .join("resources")
            .join("drivers")
            .join("vbcable");
        if dev_path.exists() {
            return Some(dev_path);
        }
    }

    None
}

/// Determine the correct INF file for the current system architecture.
fn get_inf_path(driver_dir: &PathBuf) -> PathBuf {
    if cfg!(target_arch = "x86_64") {
        driver_dir.join("vbMmeCable64_win7.inf")
    } else {
        driver_dir.join("vbMmeCable_win7.inf")
    }
}

/// Check if the VB-CABLE driver is currently installed on the system.
///
/// This checks the Windows registry for the driver service entry.
/// Returns `DriverStatus::Installed` if found, `NotInstalled` otherwise.
pub fn check_driver_installed() -> DriverStatus {
    // Check if the driver package is present in the Windows driver store.
    // This is more reliable than checking the registry, as pnputil
    // installs the driver package but may not create a registry service entry
    // for software-enumerated virtual audio devices.
    let output = Command::new("pnputil")
        .args(["/enum-drivers"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if stdout.contains("vbaudio_cable64_win7")
                || stdout.contains("vbaudio_cable_win7")
                || stdout.contains("vbmmecable64_win7")
                || stdout.contains("vbmmecable_win7")
            {
                return DriverStatus::Installed;
            }
            DriverStatus::NotInstalled
        }
        Err(_) | Ok(_) => {
            // Fallback: check registry with full HKLM path
            let key = format!("HKLM\\{}", DRIVER_REG_KEY);
            if let Ok(out) = Command::new("reg").args(["query", &key]).creation_flags(CREATE_NO_WINDOW).output() {
                if out.status.success() {
                    return DriverStatus::Installed;
                }
            }
            DriverStatus::NotInstalled
        }
    }
}

/// Check if the VB-CABLE driver is installed (Tauri command version).
#[tauri::command]
pub fn is_vbcable_installed() -> DriverStatus {
    check_driver_installed()
}

/// Install the VB-CABLE driver from bundled resources.
///
/// Extracts VBCABLE_Setup_x64.exe from the driver pack and runs it.
/// This requires Administrator privileges to succeed.
#[tauri::command]
pub fn install_vbcable_driver(app_handle: tauri::AppHandle) -> DriverActionResult {
    let driver_dir = match get_driver_dir(&app_handle) {
        Some(dir) => dir,
        None => {
            return DriverActionResult {
                success: false,
                message: "无法找到驱动资源文件。驱动文件可能未正确打包。".to_string(),
            };
        }
    };

    // Check if the driver pack zip exists
    let zip_path = driver_dir.join("VBCABLE_Driver_Pack43.zip");
    if !zip_path.exists() {
        return DriverActionResult {
            success: false,
            message: "驱动压缩包未找到。".to_string(),
        };
    }

    // Extract the zip to a temp directory
    let tmp_dir = std::env::temp_dir().join("vb_cable_install");
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let _ = std::fs::create_dir_all(&tmp_dir);

    let zip_file = match std::fs::File::open(&zip_path) {
        Ok(f) => f,
        Err(e) => return DriverActionResult {
            success: false,
            message: format!("无法打开驱动压缩包: {}", e),
        },
    };

    let mut archive = match zip::ZipArchive::new(zip_file) {
        Ok(a) => a,
        Err(e) => return DriverActionResult {
            success: false,
            message: format!("无法读取驱动压缩包: {}", e),
        },
    };

    let setup_name = if cfg!(target_arch = "x86_64") {
        "VBCABLE_Setup_x64.exe"
    } else {
        "VBCABLE_Setup.exe"
    };

    let mut setup_extracted = false;
    for i in 0..archive.len() {
        let mut file = match archive.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let name = file.name().to_string();
        let out_path = tmp_dir.join(&name);
        if let Some(parent) = out_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Extract only the setup and driver files needed
        if file.is_file() && (name == setup_name || name.ends_with(".sys") || name.ends_with(".inf") || name.ends_with(".cat")) {
            if let Ok(mut out) = std::fs::File::create(&out_path) {
                if std::io::copy(&mut file, &mut out).is_ok() {
                    if name == setup_name {
                        setup_extracted = true;
                    }
                }
            }
        }
    }

    if !setup_extracted {
        return DriverActionResult {
            success: false,
            message: format!("驱动压缩包中未找到 {}", setup_name),
        };
    }

    let setup_path = tmp_dir.join(setup_name);

    // Run the VB-Audio installer (uses Inno Setup: /VERYSILENT suppresses UI)
    let result = Command::new(&setup_path)
        .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let _stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let all_output = format!("{}", stdout.trim());

            // Cleanup temp dir
            let _ = std::fs::remove_dir_all(&tmp_dir);

            // pnputil exit 0 or 2 both typically mean success for Inno Setup /VERYSILENT
            if output.status.success() {
                DriverActionResult {
                    success: true,
                    message: format!(
                        "✅ VB-CABLE 虚拟音频驱动安装成功！\n\n建议重启计算机以确保驱动生效。\n\n{}",
                        all_output
                    ),
                }
            } else {
                let code = output.status.code().unwrap_or(-1);
                // Inno Setup returns 2 for some successful silent installs
                if code == 2 {
                    DriverActionResult {
                        success: true,
                        message: "✅ VB-CABLE 虚拟音频驱动安装成功！\n\n建议重启计算机以确保驱动生效。".to_string(),
                    }
                } else {
                    DriverActionResult {
                        success: false,
                        message: with_admin_hint(&format!(
                            "❌ 驱动安装失败 (退出码: {})\n\n{}",
                            code,
                            all_output
                        )),
                    }
                }
            }
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            DriverActionResult {
                success: false,
                message: with_admin_hint(&format!(
                    "❌ 无法执行驱动安装程序: {}", e
                )),
            }
        }
    }
}

/// Uninstall the VB-CABLE driver.
///
/// Returns a `DriverActionResult` indicating success or failure.
/// This requires Administrator privileges to succeed.
#[tauri::command]
pub fn uninstall_vbcable_driver(app_handle: tauri::AppHandle) -> DriverActionResult {
    let driver_dir = match get_driver_dir(&app_handle) {
        Some(dir) => dir,
        None => {
            return DriverActionResult {
                success: false,
                message: "无法找到驱动资源文件。".to_string(),
            };
        }
    };

    let inf_path = get_inf_path(&driver_dir);
    if !inf_path.exists() {
        return DriverActionResult {
            success: false,
            message: format!("驱动 INF 文件未找到: {}", inf_path.display()),
        };
    }

    // Run pnputil to uninstall the driver
    let result = Command::new("pnputil")
        .args([
            "/delete-driver",
            &inf_path.to_string_lossy(),
            "/uninstall",
        ])
        .output();

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let all_output = format!("{}\n{}", stdout.trim(), stderr.trim());

            if output.status.success() {
                DriverActionResult {
                    success: true,
                    message: format!("✅ VB-CABLE 驱动卸载成功！\n\n{}", all_output),
                }
            } else {
                DriverActionResult {
                    success: false,
                    message: with_admin_hint(&format!(
                        "❌ 驱动卸载失败 (退出码: {})\n\n{}",
                        output.status.code().unwrap_or(-1),
                        all_output
                    )),
                }
            }
        }
        Err(e) => {
            DriverActionResult {
                success: false,
                message: with_admin_hint(&format!("❌ 无法执行 pnputil: {}", e)),
            }
        }
    }
}
