-- Register doc_type buat create_fixed_asset_disposal (0054) -- generateDocumentNumber
-- (FE) butuh baris document_number_types dulu sebelum bisa generate p_source_ref.
insert into document_number_types (doc_type, prefix, label) values
  ('fixed_asset_disposals', 'FAD', 'Disposal Aset Tetap');
