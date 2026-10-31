# Draf Form Create

Diputuskan 2026-10-31 (permintaan user): isian form create gak boleh hilang saat halaman ter-refresh. Form create baru wajib ikut pola ini.

## Cara pakai

```ts
const draft = useFormDraft("nama-form", { fieldA, lines }, (d) => { setFieldA(d.fieldA); setLines(d.lines); }, !checkingSession);
```

- Pasang `<DraftNotice draft={draft} />` di bawah `<BackLink>`, dan panggil `draft.clear()` tepat sebelum pindah halaman setelah simpan berhasil.
- `formKey` harus unik per konteks. Form yang tergantung dokumen lain menyertakan id-nya (mis. `purchase-orders/${id}/receive`).
- `enabled` = data awal form sudah selesai dimuat: isian saat itu jadi patokan "form masih kosong".

## Gotcha: input yang menyimpan isian sendiri

`UnitCostQtyInput`, `UomPriceQtyInput`, dan `MultiUomQtyInput` membaca nilai awal hanya saat terpasang:

- Teruskan `initialEntered` + `onEnteredChange` (dua input harga, supaya satuan yang dipilih ikut pulih) atau `initialBaseQty` (`MultiUomQtyInput`, breakdown per satuan pulih sebagai total satuan dasar).
- Pasang input hanya setelah barangnya ter-resolve (`line.item_id && selectedItem`), karena daftar satuannya datang belakangan.
- Input yang sudah terpasang sebelum pemulihan memakai `key` berisi `draft.restoreKey`.

## Kenapa localStorage

Tujuannya tahan refresh, jadi cukup di perangkat itu. Draf di server butuh tabel, RLS, dan pembersihan untuk manfaat lintas perangkat yang belum dibutuhkan. sessionStorage hilang saat tab ditutup. Kunci menyertakan user id karena perangkat bisa dipakai bergantian, dan draf kedaluwarsa setelah 14 hari.
