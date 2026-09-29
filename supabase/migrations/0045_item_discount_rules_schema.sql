-- Item Discount Rules (trade discount sisi penjualan) + kolom pendukung diskon di
-- order_lines/goods_note_lines/transactions (sisi pembelian, header-level, manual admin).
-- Ref: docs/domain/accounts-receivable.md submodule "Diskon Penjualan (Trade Discount)",
-- docs/domain/accounts-payable.md submodule "Diskon Pembelian (Trade Discount)",
-- docs/architecture/item-discount-rules-schema.md.
--
-- Desain: diskon di sini SELALU trade discount, TIDAK PERNAH jadi baris jurnal tersendiri.
-- Sisi jual (OUTBOUND): harga per baris SUDAH dihitung net di lapisan aplikasi (TypeScript,
-- sama seperti create_goods_issue.p_credit_lines yang sudah final sekarang -- RPC gak pernah
-- hitung ulang harga dari item_units.price) SEBELUM dikirim ke create_order/create_goods_issue.
-- Kolom discount_rule_id/discount_amount yang ditambah di order_lines/goods_note_lines di sini
-- PURELY informational/audit trail buat sisi OUTBOUND -- gak dipakai aritmatika balance RPC.
-- Sisi beli (INBOUND): beda -- create_goods_receipt MENGHITUNG avg_cost di dalam RPC dari
-- unit_cost per baris, jadi diskon header (p_discount_amount, admin input manual, BUKAN dari
-- item_discount_rules) diproratakan ke tiap baris DI DALAM RPC supaya nilai Persediaan yang
-- didebit tetap konsisten dengan avg_cost/Kartu Stok -- satu-satunya tempat migration ini
-- benar-benar mengurangi angka, bukan cuma menyimpan untuk ditampilkan.

create table item_discount_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  item_id uuid references items(id),
  category_id uuid references item_categories(id),
  discount_type text not null check (discount_type in ('PERCENT', 'NOMINAL')),
  discount_value numeric(14,2) not null check (discount_value > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email'),
  constraint item_discount_rules_target_xor check (num_nonnulls(item_id, category_id) = 1),
  constraint item_discount_rules_percent_max_100 check (discount_type <> 'PERCENT' or discount_value <= 100)
);

comment on column item_discount_rules.created_by is 'Email snapshot saat insert (bukan FK) -- konvensi master data (items/counterparties/accounts/bom), beda dari created_by uuid FK di tabel transaksional sejak 0011+. NULL = data lama / insert di luar jalur aplikasi.';
comment on column item_discount_rules.discount_value is 'PERCENT: persentase (maks 100). NOMINAL: Rupiah per unit SATUAN DASAR barang (bukan per baris/lump sum) -- biar hasilnya otomatis benar walau qty yang ditransaksikan cuma sebagian dari qty_ordered di order (dihitung ULANG saat realisasi, bukan diwarisi/diprorata dari order_lines -- lihat komentar kolom order_lines.discount_amount/goods_note_lines.discount_amount di bawah).';

-- Cuma boleh 1 aturan AKTIF per item, dan 1 aturan AKTIF per kategori -- mencegah ambiguitas
-- "aturan mana yang berlaku" di sumber datanya, bukan cuma di UI. Kalau 1 barang match ke
-- aturan item DAN aturan kategori sekaligus, resolusi "aturan item menang" (lebih spesifik)
-- dilakukan di lapisan aplikasi (TypeScript) saat query kedua aturan itu -- constraint di sini
-- cuma menjamin gak ada 2 aturan aktif yang bersaing di LEVEL YANG SAMA (item vs item,
-- kategori vs kategori), bukan lintas level.
create unique index item_discount_rules_one_active_per_item
  on item_discount_rules(item_id) where item_id is not null and archived_at is null;
create unique index item_discount_rules_one_active_per_category
  on item_discount_rules(category_id) where category_id is not null and archived_at is null;

create trigger item_discount_rules_set_updated_at
  before update on item_discount_rules
  for each row execute function set_updated_at();

alter table item_discount_rules enable row level security;

create policy item_discount_rules_select on item_discount_rules for select using (auth.role() = 'authenticated');
create policy item_discount_rules_insert on item_discount_rules for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy item_discount_rules_update on item_discount_rules for update using (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert, update on item_discount_rules to authenticated;

-- Kolom pendukung diskon --------------------------------------------------------------------

alter table order_lines
  add column discount_rule_id uuid references item_discount_rules(id),
  add column discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0);

alter table goods_note_lines
  add column discount_rule_id uuid references item_discount_rules(id),
  add column discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0);

alter table transactions
  add column discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0);

comment on column order_lines.discount_amount is 'Estimasi diskon saat Sales Order dibuat (dihitung dari item_discount_rules aktif saat itu, qty_ordered penuh) -- PURELY informational, order gak pernah bikin jurnal (docs/architecture/orders-schema.md). Dihitung ULANG dari nol saat realisasi ke goods_note_lines (TIDAK diwarisi/diprorata dari sini), karena qty riil yang dikirim & aturan yang aktif saat itu boleh beda dari saat order dibuat.';
comment on column goods_note_lines.discount_amount is 'OUTBOUND (jual): diskon yang BENERAN dipakai di baris invoice ini, resolusi fresh dari item_discount_rules aktif saat baris dibuat -- sudah baked-in ke unit_price/jumlah yang dikirim TypeScript ke create_goods_issue (RPC gak menghitung ulang, kolom ini murni audit trail). INBOUND (beli): porsi dari p_discount_amount header (diskon manual admin, BUKAN dari item_discount_rules) yang diproratakan create_goods_receipt ke baris ini -- SATU-SATUNYA kolom di sini yang dipakai RPC untuk aritmatika (mengoreksi avg_cost biar konsisten sama Persediaan yang didebit).';
comment on column transactions.discount_amount is 'Total diskon yang sudah baked-in ke amount, murni buat breakdown tampilan (subtotal/diskon/total) -- OUTBOUND: akumulasi discount_amount seluruh baris terkait, informational. INBOUND: nominal yang diinput admin manual saat bikin Bill/Goods Receipt. Di KEDUA arah kolom ini TIDAK dipakai untuk menghitung ulang v_total_amount/saldo jurnal di create_transaction -- p_lines yang dikirim ke situ sudah net dari awal (lihat catatan di kepala file ini).';

-- create_transaction -- tambah p_discount_amount (trailing, default 0) buat nyimpen breakdown
-- diskon yang ditampilkan UI. Signature berubah (nambah parameter) -- drop dulu biar gak
-- ninggalin overload 9-argumen lama nganggur (bisa bikin PostgREST bingung pilih overload).
drop function if exists create_transaction(text, uuid, date, text, text, jsonb, uuid, boolean, text);

create function create_transaction(
  p_type text,
  p_counterparty_id uuid,
  p_date date,
  p_description text,
  p_source_ref text,
  p_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- BUKAN termasuk PPN, SUDAH net diskon
  p_control_account_id uuid,
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null,
  p_discount_amount numeric default 0 -- murni disimpan buat breakdown tampilan, lihat comment kolom transactions.discount_amount
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_transaction_id uuid;
  v_line jsonb;
  v_total_amount numeric := 0;
  v_journal_lines jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_counterparty counterparties%rowtype;
  v_due_date date;
  v_ppn_rate numeric;
  v_ppn_account_id uuid;
  v_ppn_amount numeric := 0;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Transaksi butuh minimal 1 baris kategori';
  end if;

  if p_discount_amount < 0 then
    raise exception 'p_discount_amount gak boleh negatif';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if (v_line->>'amount')::numeric <= 0 then
      raise exception 'Nominal baris harus > 0';
    end if;
    v_total_amount := v_total_amount + (v_line->>'amount')::numeric;
  end loop;

  select * into v_counterparty from counterparties where id = p_counterparty_id;
  v_due_date := p_date + (v_counterparty.payment_term_days || ' days')::interval;

  if p_apply_tax then
    select ppn_rate,
           case when p_type = 'OUTBOUND' then ppn_keluaran_account_id else ppn_masukan_account_id end
      into v_ppn_rate, v_ppn_account_id
      from app_settings where id = true and is_active = true;

    if v_ppn_rate is null or v_ppn_account_id is null then
      raise exception 'PPN belum aktif/diset -- cek Pengaturan Pajak';
    end if;

    v_ppn_amount := round(v_total_amount * v_ppn_rate / 100, 2);
  end if;

  -- baris FIXED (control account, Piutang/Utang) + baris VARIABEL (kategori) + PPN opsional
  v_journal_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', p_control_account_id,
      'debit', case when p_type = 'OUTBOUND' then v_total_amount + v_ppn_amount else 0 end,
      'credit', case when p_type = 'INBOUND' then v_total_amount + v_ppn_amount else 0 end
    )
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_line->>'account_id',
        'debit', case when p_type = 'INBOUND' then (v_line->>'amount')::numeric else 0 end,
        'credit', case when p_type = 'OUTBOUND' then (v_line->>'amount')::numeric else 0 end
      )
    );
  end loop;

  if p_apply_tax then
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_ppn_account_id,
        'debit', case when p_type = 'INBOUND' then v_ppn_amount else 0 end,
        'credit', case when p_type = 'OUTBOUND' then v_ppn_amount else 0 end
      )
    );
  end if;

  v_entry_id := create_journal_entry(p_date, p_description, p_source_ref, v_journal_lines);

  insert into transactions (
    type, counterparty_id, date, due_date, description, source_ref, amount, outstanding,
    origin, supplier_document_ref, journal_entry_id, discount_amount, created_by
  )
  values (
    p_type, p_counterparty_id, p_date, v_due_date, p_description, p_source_ref,
    v_total_amount + v_ppn_amount, v_total_amount + v_ppn_amount,
    'financial_only', p_supplier_document_ref, v_entry_id, p_discount_amount, auth.uid()
  )
  returning id into v_transaction_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, v_ppn_account_id, v_ppn_amount, true);
  end if;

  return v_transaction_id;
end;
$$;

grant execute on function create_transaction(text, uuid, date, text, text, jsonb, uuid, boolean, text, numeric) to authenticated;

-- create_goods_issue -- signature TIDAK berubah (persis sama kayak versi lama) -- p_lines
-- sekarang boleh bawa "discount_rule_id"/"discount_amount" opsional per baris (informational,
-- disimpan ke goods_note_lines, gak dipakai ngitung HPP/avg_cost -- HPP di sini soal cost
-- barang yang KELUAR dari stok, gak ada hubungannya sama harga jual/diskon). Total diskon buat
-- transactions.discount_amount DIHITUNG DARI p_lines-nya sendiri (v_total_discount, akumulasi
-- dalam loop yang sama kayak v_total_cost) -- BUKAN parameter terpisah yang dipercaya dari
-- client, biar gak ada celah drift antara breakdown tampilan dan discount_amount per baris yang
-- beneran tersimpan. Karena signature gak berubah, aman CREATE OR REPLACE biasa, gak perlu drop.
create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"order_line_id":uuid|null,"unit_price":numeric|null,"discount_rule_id":uuid|null,"discount_amount":numeric|null}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_issue_id uuid := gen_random_uuid();
  v_invoice_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_order_line_id uuid;
  v_unit_price numeric;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_total_discount numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_order_lines uuid[] := '{}';
  v_line_unit_prices numeric[] := '{}';
  v_line_discount_rule_ids uuid[] := '{}';
  v_line_discount_amounts numeric[] := '{}';
  v_line_id uuid;
  i int;
begin
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as l
    join order_lines ol on ol.id = nullif(l->>'order_line_id', '')::uuid
    join orders o on o.id = ol.order_id
    where o.cancelled_at is not null
  ) then
    raise exception 'Salah satu baris menunjuk sales order yang udah dibatalkan';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_discount := v_total_discount + coalesce((v_line->>'discount_amount')::numeric, 0);
  end loop;

  v_invoice_id := create_transaction(
    'OUTBOUND', p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax, null, v_total_discount
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;
    v_order_line_id := nullif(v_line->>'order_line_id', '')::uuid;
    v_unit_price := (v_line->>'unit_price')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_order_lines := array_append(v_line_order_lines, v_order_line_id);
    v_line_unit_prices := array_append(v_line_unit_prices, v_unit_price);
    v_line_discount_rule_ids := array_append(v_line_discount_rule_ids, nullif(v_line->>'discount_rule_id', '')::uuid);
    v_line_discount_amounts := array_append(v_line_discount_amounts, coalesce((v_line->>'discount_amount')::numeric, 0));
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_invoice_date, 'HPP ' || p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into goods_notes (id, type, transaction_id, journal_entry_id, source_ref, note_date, created_by)
  values (v_issue_id, 'OUTBOUND', v_invoice_id, v_entry_id, p_source_ref, p_invoice_date, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into goods_note_lines (
      goods_note_id, item_id, qty, total_cost, order_line_id, unit_price,
      discount_rule_id, discount_amount
    )
    values (
      v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_order_lines[i], v_line_unit_prices[i],
      v_line_discount_rule_ids[i], v_line_discount_amounts[i]
    )
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line_items[i], p_invoice_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_issue_id;
end;
$$;

-- create_goods_issue -- signature gak berubah, CREATE OR REPLACE otomatis mempertahankan
-- grant execute lama, gak perlu re-grant (beda dari create_transaction/create_goods_receipt
-- di bawah yang di-drop+create ulang).

-- create_goods_receipt -- tambah p_discount_amount (trailing, nominal manual admin, header-level).
-- BEDA dari create_goods_issue: diskon di sini diproratakan KE TIAP BARIS di dalam RPC (bukan
-- cuma dikurangi dari total), karena avg_cost/Kartu Stok dihitung di sini dari unit_cost per
-- baris -- kalau cuma dikurangi di angka agregat, Persediaan yang didebit gak akan konsisten
-- sama valuasi avg_cost*qty_on_hand di inventory_balances. Proration pakai teknik CUMULATIVE
-- ROUNDING (target kumulatif dibulatin per baris, diskon baris = selisih target kumulatif
-- sekarang vs sebelumnya) -- BUKAN "hitung proporsional per baris lalu bebankan semua sisa
-- pembulatan ke baris terakhir", karena itu bisa bikin baris terakhir kebagian diskon yang
-- melebihi subtotalnya sendiri (net unit cost jadi negatif/nol, avg_cost rusak permanen --
-- ketemu review sebelum migration ini diapply). Tetap dijaga eksplisit dengan guard qty>0 dan
-- guard net unit cost>0 per baris, bukan cuma dipercaya dari matematika proration-nya doang.
drop function if exists create_goods_receipt(uuid, date, text, jsonb, text, text, uuid, uuid, jsonb, boolean, uuid);

create function create_goods_receipt(
  p_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"order_line_id":uuid|null,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric}
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null,
  p_apply_tax boolean default false,
  p_supplier_id uuid default null,
  p_discount_amount numeric default 0 -- diskon pembelian, nominal manual admin (bukan dari item_discount_rules)
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_supplier_id uuid;
  v_line jsonb;
  v_total_amount numeric := 0;
  v_net_total numeric;
  v_bill_id uuid;
  v_grn_id uuid;
  v_item_id uuid;
  v_qty_received numeric;
  v_unit_cost numeric;
  v_qty_before numeric;
  v_avg_before numeric;
  v_debit_lines jsonb;
  v_line_id uuid;
  v_line_count int;
  v_idx int := 0;
  v_line_subtotal numeric;
  v_line_discount numeric;
  v_cumulative_subtotal numeric := 0;
  v_prev_cumulative_discount numeric := 0;
  v_target_cumulative_discount numeric;
  v_line_net_unit_cost numeric;
begin
  if p_order_id is not null then
    select counterparty_id into v_supplier_id from orders where id = p_order_id and direction = 'PURCHASE';

    if v_supplier_id is null then
      raise exception 'Order % gak ditemukan atau bukan Purchase Order', p_order_id;
    end if;

    if exists (select 1 from orders where id = p_order_id and cancelled_at is not null) then
      raise exception 'Order % udah dibatalkan — gak bisa dibuat penerimaan barang', p_order_id;
    end if;
  else
    if p_supplier_id is null then
      raise exception 'Wajib pilih supplier kalau terima barang langsung tanpa Purchase Order';
    end if;

    if not exists (
      select 1 from counterparty_type_mapping
      where counterparty_id = p_supplier_id and role = 'supplier'
    ) then
      raise exception 'Supplier % gak ditemukan', p_supplier_id;
    end if;

    v_supplier_id := p_supplier_id;
  end if;

  if p_discount_amount < 0 then
    raise exception 'p_discount_amount gak boleh negatif';
  end if;

  v_line_count := jsonb_array_length(p_lines);

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_amount := v_total_amount + (v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric;
  end loop;

  if p_discount_amount > v_total_amount then
    raise exception 'Diskon (%) gak boleh melebihi subtotal pembelian (%)', p_discount_amount, v_total_amount;
  end if;

  v_net_total := v_total_amount - p_discount_amount;

  v_debit_lines := jsonb_build_array(jsonb_build_object('account_id', p_debit_account_id, 'amount', v_net_total));
  if p_extra_debit_lines is not null then
    for v_line in select * from jsonb_array_elements(p_extra_debit_lines)
    loop
      v_debit_lines := v_debit_lines || jsonb_build_array(v_line);
    end loop;
  end if;

  v_bill_id := create_transaction(
    'INBOUND', v_supplier_id, p_receipt_date, p_bill_description, p_bill_source_ref,
    v_debit_lines,
    p_payable_account_id,
    p_apply_tax,
    null,
    p_discount_amount
  );

  insert into goods_notes (type, order_id, transaction_id, delivery_note_ref, note_date, created_by)
  values ('INBOUND', p_order_id, v_bill_id, p_delivery_note_ref, p_receipt_date, auth.uid())
  returning id into v_grn_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_idx := v_idx + 1;
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_received := (v_line->>'qty_received')::numeric;
    v_unit_cost := (v_line->>'unit_cost')::numeric;

    if v_qty_received <= 0 then
      raise exception 'Qty diterima baris ke-% harus lebih dari 0', v_idx;
    end if;
    if v_unit_cost <= 0 then
      raise exception 'Harga beli per unit baris ke-% harus lebih dari 0', v_idx;
    end if;

    v_line_subtotal := v_qty_received * v_unit_cost;
    v_cumulative_subtotal := v_cumulative_subtotal + v_line_subtotal;

    if p_discount_amount = 0 then
      v_line_discount := 0;
    elsif v_idx = v_line_count then
      -- baris terakhir: sisa persis biar total tetap pas (bukan dibulatkan lagi)
      v_line_discount := p_discount_amount - v_prev_cumulative_discount;
    else
      -- cumulative rounding: target kumulatif dibulatin, diskon baris = selisih dari target
      -- sebelumnya -- menyebar sisa pembulatan ke banyak baris, bukan numpuk di 1 baris terakhir
      v_target_cumulative_discount := round(p_discount_amount * v_cumulative_subtotal / v_total_amount, 2);
      v_line_discount := v_target_cumulative_discount - v_prev_cumulative_discount;
    end if;
    v_prev_cumulative_discount := v_prev_cumulative_discount + v_line_discount;

    if v_line_discount < 0 or v_line_discount > v_line_subtotal then
      raise exception 'Diskon gak bisa diproratakan wajar ke baris ke-% (diskon % > subtotal baris %) -- coba kurangi nominal diskon atau urutan barisnya',
        v_idx, v_line_discount, v_line_subtotal;
    end if;

    v_line_net_unit_cost := (v_line_subtotal - v_line_discount) / v_qty_received;

    if v_line_net_unit_cost <= 0 then
      raise exception 'Diskon bikin harga net baris ke-% jadi <= 0 -- kurangi nominal diskon', v_idx;
    end if;

    insert into goods_note_lines (goods_note_id, order_line_id, item_id, qty, unit_cost, discount_amount)
    values (v_grn_id, nullif(v_line->>'order_line_id', '')::uuid, v_item_id, v_qty_received, v_unit_cost, v_line_discount)
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_item_id, p_receipt_date, v_qty_received, v_line_id);

    select qty_on_hand, avg_cost into v_qty_before, v_avg_before
      from inventory_balances where item_id = v_item_id;

    if not found then
      insert into inventory_balances (item_id, qty_on_hand, avg_cost)
      values (v_item_id, v_qty_received, v_line_net_unit_cost);
    else
      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty_received,
            avg_cost = (v_qty_before * v_avg_before + v_qty_received * v_line_net_unit_cost) / (v_qty_before + v_qty_received),
            updated_at = now()
        where item_id = v_item_id;
    end if;
  end loop;

  return v_grn_id;
end;
$$;

grant execute on function create_goods_receipt(uuid, date, text, jsonb, text, text, uuid, uuid, jsonb, boolean, uuid, numeric) to authenticated;

-- create_order -- signature TIDAK berubah (p_lines tetap jsonb), cuma tambah parsing kolom
-- opsional "discount_rule_id"/"discount_amount" per baris -- aman CREATE OR REPLACE biasa,
-- gak perlu drop (grant lama tetap berlaku).
create or replace function create_order(
  p_direction text,
  p_counterparty_id uuid,
  p_order_date date,
  p_expected_date date,
  p_source_ref text,
  p_lines jsonb -- array of {"item_id":uuid,"qty_ordered":numeric,"unit_price":numeric,"discount_rule_id":uuid|null,"discount_amount":numeric|null}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_order_id uuid;
  v_line jsonb;
begin
  if p_direction not in ('PURCHASE','SALE') then
    raise exception 'p_direction harus PURCHASE atau SALE, dapat %', p_direction;
  end if;

  insert into orders (counterparty_id, direction, order_date, expected_date, source_ref, created_by)
  values (p_counterparty_id, p_direction, p_order_date, p_expected_date, p_source_ref, auth.uid())
  returning id into v_order_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into order_lines (order_id, item_id, qty_ordered, unit_price, discount_rule_id, discount_amount)
    values (
      v_order_id,
      (v_line->>'item_id')::uuid,
      (v_line->>'qty_ordered')::numeric,
      (v_line->>'unit_price')::numeric,
      nullif(v_line->>'discount_rule_id', '')::uuid,
      coalesce((v_line->>'discount_amount')::numeric, 0)
    );
  end loop;

  return v_order_id;
end;
$$;
