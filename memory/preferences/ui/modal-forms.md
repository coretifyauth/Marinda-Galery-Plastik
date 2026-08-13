# Form pakai Modal, bukan Panel Inline Toggle

Lanjutan dari `form-components.md` (komponen `Input`/`Select`/`Label`/`Button`/`FormError` tetap dipakai sama persis di dalam modal). Bedanya di sini soal **wadah**-nya: form create/edit/action sekarang selalu dibungkus `<Modal>`, bukan div bordered yang di-toggle inline di bawah tabel.

Diputuskan 2026-08-12 (preferensi user), langsung diterapkan ke semua ~31 form di seluruh modul `apps/erp/src/app/(app)/*` dalam sesi yang sama — bukan pola opsional, form baru ke depannya wajib ikut pola ini.

## Komponen

`src/components/ui/modal.tsx` — `Modal({ open, onClose, title, children, maxWidth = "max-w-lg" })`. Native `<dialog>` (bukan portal custom, gak butuh Radix/shadcn) — udah nyediain header (title + tombol close X), backdrop, dan `onCancel`/klik-backdrop buat nutup. Isi (`children`) cukup form-nya doang, jangan dibungkus div border/shadow lagi karena Modal udah nyediain chrome itu.

## Gotcha wajib tau: centering

Tailwind v4 preflight (`@import "tailwindcss"` di `globals.css`) nge-reset `margin: 0` global — ini diam-diam mematikan centering bawaan browser buat `<dialog>` (UA stylesheet asli: `dialog:modal { margin: auto }`). Tanpa fix, modal nongkrong mepet pojok kiri atas layar, bukan di tengah. Fix-nya di `modal.tsx`: className dialog dikasih `fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 m-0` secara eksplisit, gak ngandelin default browser. Kalau bikin implementasi modal/dialog lain di luar komponen ini, cek ulang hal ini — gak keliatan dari kode komponennya doang.

## Pola konversi (dari panel inline ke Modal)

1. State boolean yang gating visibility (`showForm`, `editing`, `showXForm`) — tombol pembukanya **selalu** `setX(true)`, bukan toggle (`(v) => !v)`). Nutup modal udah dihandle Modal sendiri (X/ESC/klik backdrop) + tombol Batal di footer.
2. `{x && (<div className="rounded-xl border ...">...</div>)}` → `<Modal open={x} onClose={() => setX(false)} title="...">...</Modal>`.
3. Layout field di dalam modal: vertikal (`flex flex-col gap-4`), field pendek berpasangan boleh `grid grid-cols-2 gap-4`. Form gemuk (banyak field / Select panjang / ada line-item editor) pakai `maxWidth="max-w-xl"` sampai `"max-w-4xl"` — default `max-w-lg` kekecilan buat itu.
4. Footer wajib: `<div className="flex justify-end gap-2 pt-2"><Button type="button" variant="secondary" onClick={() => setX(false)}>Batal</Button><Button type="submit" ...>...</Button></div>`.
5. `FormError` tetap di dalam form, persis sebelum footer.

## Pengecualian (tetap inline, gak dipaksa jadi modal)

Form yang gak punya list/tabel di sebelahnya buat "ditutupin" — gak ada gunanya dibikin modal karena gak ada apa-apa "di belakang"-nya. Contoh: `TaxSettingsCard` di `src/app/(app)/settings/charges/page.tsx` (form pengaturan PPN global, 1 record, bukan create-new-dari-list).

## Referensi implementasi

`src/app/(app)/customers/page.tsx` (create) + `src/app/(app)/customers/[id]/view.tsx` (edit) — pasangan file ini jadi template pertama yang dikonversi, paling representatif buat dicontek kalau bikin form baru.
