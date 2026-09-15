-- Cabut total modul Fixed Assets (keputusan owner 2026-09-15). Ref: docs/domain/general-ledger.md
-- bagian preset jurnal (app_preset_journal_entries) -- akuisisi/penyusutan/disposal aset tetap
-- sekarang tanggung jawab user sepenuhnya lewat preset JE manual, bukan modul dedicated.
--
-- Data live sudah dicek sebelum migration ini ditulis: fixed_assets/depreciation_entries/
-- fixed_asset_disposals kosong (0 baris), fixed_asset_account_presets cuma 2 baris seed
-- ("Rak Display Toko"/"Mobil Pickup Antar Barang") -- gak ada data transaksional nyata yang
-- hilang.
--
-- Akun COA terkait (1600/1610/1620/1630/1640/5600/5610/6200 dari 0002_coa_schema.sql) TIDAK
-- dihapus -- itu tabel accounts generic, tetap valid dipakai user lewat preset JE manual,
-- cuma gak lagi "dikunci" otomatis oleh fixed_asset_account_presets.

drop table if exists fixed_asset_disposals;
drop table if exists depreciation_entries;
drop table if exists fixed_assets;
drop table if exists fixed_asset_account_presets;

drop function if exists create_fixed_asset_disposal(uuid, date, fixed_asset_disposal_type, text, numeric, uuid, uuid, uuid, text);
drop function if exists post_depreciation(uuid, date, text, numeric);
drop function if exists create_fixed_asset(text, uuid, uuid, uuid, numeric, numeric, int, date, depreciation_method, numeric);
drop function if exists fixed_assets_published_lock();
drop function if exists depreciation_entries_cap_check();
drop function if exists fixed_assets_validate_accounts();

drop type if exists fixed_asset_disposal_type;
drop type if exists depreciation_method;
