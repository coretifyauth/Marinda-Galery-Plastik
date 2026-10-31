// Tanggal HARI INI menurut jam lokal kasir (YYYY-MM-DD). new Date().toISOString() itu UTC --
// di WIB (UTC+7) antara 00:00-07:00 hasilnya masih tanggal kemarin.
export function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
