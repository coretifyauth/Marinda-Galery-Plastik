-- 0064_satukan_akun_persediaan.sql
-- Toko murni jual-beli memakai SATU akun persediaan. Sebelumnya pembelian mendebit 1400 Persediaan Bahan Baku
-- (Default Akun inventory.raw_material) sedangkan penjualan mengkredit 1420 Persediaan Barang Jadi (inventory.finished_good,
-- dan POS menulis kode 1420 langsung): 1420 bersaldo minus, 1400 kelebihan dengan jumlah yang sama. Konsep:
-- docs/domain/inventory.md submodule "Satu Akun Persediaan untuk Toko Jual-Beli".
--
-- Yang dilakukan (semuanya hanya jika akun 1400 dan 1420 ada; database tanpa COA itu melewatinya dengan NOTICE):
--   1. Akun 1400 diganti nama "Persediaan Bahan Baku" -> "Persediaan Barang Dagang" (hanya jika namanya masih yang lama).
--   2. Default Akun inventory.finished_good dipindah dari 1420 ke 1400 (hanya jika masih menunjuk 1420).
--   3. Barang yang akun persediaannya masih 1420 dipindah ke 1400, supaya stock opname dkk tidak memposting ke 1420 lagi.
--   4. Satu jurnal reklasifikasi memindahkan seluruh saldo 1420 ke 1400 (nominal dihitung dari buku besar saat apply):
--      saldo minus -> Debit 1420 / Kredit 1400; saldo plus -> Debit 1400 / Kredit 1420. Jurnal lama tidak disentuh.
--   5. Diverifikasi di akhir: saldo 1420 harus 0, kalau tidak seluruh migration dibatalkan.
-- Akun 1420 TIDAK diarsipkan di sini: POS versi lama yang masih menulis 1420 akan gagal sepenuhnya kalau akunnya
-- diarsipkan, jadi arsipkan manual setelah semua kasir memakai versi baru.
--
-- URUTAN APPLY: deploy aplikasi POS versi baru (membaca akun persediaan dari Default Akun) SEBELUM atau BERSAMAAN dengan
-- migration ini. POS lama setelah migration ini tetap mengkredit 1420 dan membuat saldo minus kembali. Transaksi POS offline
-- dari versi lama yang baru tersinkron sesudahnya juga masuk 1420 -- cek saldo 1420 lagi dan reklasifikasi ulang kalau perlu.

-- Supabase CLI menjalankan tiap statement TERPISAH (bukan satu transaksi per file) -- transaksi harus eksplisit supaya gagal di tengah = batal semua.
begin;

do $$
declare
  v_keep uuid; -- 1400 -> jadi akun persediaan tunggal
  v_old uuid;  -- 1420
  v_net numeric;
  v_check numeric;
  v_ref text;
begin
  select id into v_keep from accounts where code = '1400' and category = 'asset' and not is_contra;
  select id into v_old from accounts where code = '1420' and category = 'asset' and not is_contra;

  if v_keep is null or v_old is null then
    raise notice '0064 dilewati: akun 1400 dan/atau 1420 tidak ditemukan (database baru atau COA berbeda)';
    return;
  end if;

  update accounts set name = 'Persediaan Barang Dagang'
    where id = v_keep and name = 'Persediaan Bahan Baku';

  update app_default_account_settings set account_id = v_keep, updated_at = now()
    where role_key = 'inventory.finished_good' and account_id = v_old;

  update items set inventory_account_id = v_keep where inventory_account_id = v_old;

  select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) into v_net
    from journal_lines where account_id = v_old;

  if v_net <> 0 then
    v_ref := generate_document_number('journal_entries');
    perform create_journal_entry(
      (now() at time zone 'Asia/Jakarta')::date,
      'Reklasifikasi Persediaan Barang Jadi ke Persediaan Barang Dagang (satu akun persediaan)',
      v_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', v_keep, 'debit', greatest(v_net, 0), 'credit', greatest(-v_net, 0)),
        jsonb_build_object('account_id', v_old, 'debit', greatest(-v_net, 0), 'credit', greatest(v_net, 0))
      )
    );
    raise notice '0064: saldo 1420 % dipindahkan ke 1400 (jurnal %)', v_net, v_ref;
  end if;

  select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) into v_check
    from journal_lines where account_id = v_old;
  if v_check <> 0 then
    raise exception '0064 dibatalkan: saldo 1420 masih % setelah reklasifikasi', v_check;
  end if;
end;
$$;

commit;
