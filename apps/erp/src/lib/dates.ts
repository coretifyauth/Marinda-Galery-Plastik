/** Tanggal hari ini di zona waktu perangkat (YYYY-MM-DD). `toISOString()` memakai UTC, jadi sebelum jam 07.00 WIB hasilnya kemarin. */
export function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
