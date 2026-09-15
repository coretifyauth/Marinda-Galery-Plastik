-- Bersihin dead config sisa cabut modul Fixed Assets (0030_drop_fixed_assets_module.sql).
-- Doc type 'depreciation_entries' (prefix DEPR) di document_number_types gak ada lagi
-- pemakainya -- modul Fixed Assets sudah dicabut total, gak ada tabel document_number_counters
-- yang kepakai (dicek: 0 baris counter buat doc_type ini di remote sebelum migration ini
-- ditulis).

delete from document_number_types where doc_type = 'depreciation_entries';
