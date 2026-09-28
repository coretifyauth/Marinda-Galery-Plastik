use std::io::Write;
use std::time::Duration;

// RPP02N (dan sejenisnya) muncul di Windows sebagai "Standard Serial over
// Bluetooth link" COM port virtual setelah di-pairing -- baud rate diabaikan
// driver-nya (koneksi Bluetooth, bukan serial fisik beneran), tapi API
// serialport tetap wajib dikasih angka. 9600 aman buat semua printer ESC/POS
// yang pernah dicoba.
#[tauri::command]
fn print_escpos(port: String, data: Vec<u8>) -> Result<(), String> {
  let mut sp = serialport::new(&port, 9600)
    .timeout(Duration::from_secs(5))
    .open()
    .map_err(|e| format!("Gagal buka port {port}: {e}"))?;
  sp.write_all(&data)
    .map_err(|e| format!("Gagal kirim data ke printer: {e}"))?;
  sp.flush()
    .map_err(|e| format!("Gagal flush data ke printer: {e}"))?;
  Ok(())
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<String>, String> {
  let ports = serialport::available_ports().map_err(|e| e.to_string())?;
  Ok(ports.into_iter().map(|p| p.port_name).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![print_escpos, list_serial_ports])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
