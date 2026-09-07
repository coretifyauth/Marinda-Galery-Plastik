-- Fix bug laten di create_pos_sale, warisan dari migration 0076 (dibawa gak berubah ke 0078)
-- -- ketauan lewat smoke-test manual pasca-push 0078, BUKAN dari review schema-reviewer
-- (5 ronde review 0076 + 1 ronde review 0078 semuanya gak nangkep ini, karena efeknya cuma
-- muncul kalau fungsi ini BENERAN dieksekusi end-to-end -- dan 0 transaksi POS nyata pernah
-- lewat sejak 0076 live sampai migration ini ditulis, jadi bug-nya gak pernah kepicu).
--
-- Akar masalah: create_goods_issue RETURN v_issue_id (PK tabel goods_issues sendiri), BUKAN
-- id transaksi (`invoice_id`-nya, FK ke transactions) -- lihat definisi fungsi itu, gak
-- berubah dari 0074 s/d 0078: "insert into goods_issues (id, invoice_id, ...) values
-- (v_issue_id, v_invoice_id, ...); ... return v_issue_id;". Semua caller LAIN (goods-issues
-- module, sales-orders module) gak pernah pakai return value ini (cuma cek `{ error }`), jadi
-- gak ada yang pernah ketauan salah pakai -- create_pos_sale (0076) JUSTRU CALLER PERTAMA yang
-- pakai return value-nya, dan salah nganggep itu langsung id transaksi:
--
--   v_transaction_id := create_goods_issue(...);  -- padahal isinya goods_issue.id, bukan invoice_id
--   select amount into v_settle_amount from transactions where id = v_transaction_id;  -- SELALU 0 baris
--
-- Konsekuensi: `select ... into` yang gak ketemu baris ninggalin v_settle_amount NULL (bukan
-- error). record_payment kebagian p_amount NULL, journal_lines-nya insert
-- `coalesce(NULL,0)=0` di KEDUA sisi debit/credit sekaligus -> ngelanggar check constraint
-- `journal_lines_check` -> RPC raise exception -> transaksi Postgres rollback total -> checkout
-- kasir SELALU GAGAL (no partial write, sesuai desain -- tapi gagalnya di titik yang salah,
-- bukan validasi bisnis). Diverifikasi manual lewat `supabase db query --linked` (simulasi
-- auth.uid() pakai `set_config('request.jwt.claim.sub', ...)`, dibungkus transaksi yang
-- di-ROLLBACK -- gak ninggalin data test di database live) SEBELUM fix ini ditulis, dan SETELAH
-- fix ini buat konfirmasi checkout beneran jalan.
--
-- Fix: tangkep return value `create_goods_issue` sebagai `v_goods_issue_id` (nama variable
-- sesuai isinya), baru lookup `invoice_id`-nya (FK ke transactions) buat dapetin id transaksi
-- asli yang beneran dibutuhkan `record_payment`/return value RPC ini.

create or replace function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb, -- array of {"account_id":uuid,"amount":numeric}
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_receivable_account_id uuid;
  v_line jsonb;
  v_qty numeric;
  v_unit_price numeric;
  v_total_amount numeric := 0;
  v_credit_lines jsonb;
  v_issue_lines jsonb := '[]'::jsonb;
  v_goods_issue_id uuid;
  v_transaction_id uuid;
  v_settle_amount numeric;
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant', 'cashier')
  ) then
    raise exception 'Gak punya akses buat bikin POS Sale';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'POS sale wajib punya minimal 1 baris item';
  end if;

  v_customer_id := p_customer_id;
  if v_customer_id is null then
    select walk_in_customer_id into v_customer_id from pos_settings where id = true;
    if v_customer_id is null then
      raise exception 'pos_settings.walk_in_customer_id belum diset -- hubungi admin';
    end if;
  end if;

  select account_id into v_receivable_account_id
    from default_account_settings where role_key = 'ar.receivable';
  if v_receivable_account_id is null then
    raise exception 'default_account_settings ar.receivable belum diset -- hubungi admin';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line ->> 'qty_sold')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    if v_qty <= 0 then
      raise exception 'qty_sold harus > 0';
    end if;
    if v_unit_price < 0 then
      raise exception 'unit_price gak boleh negatif';
    end if;

    v_total_amount := v_total_amount + v_qty * v_unit_price;

    v_issue_lines := v_issue_lines || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_line ->> 'item_id',
        'qty_issued', v_qty,
        'order_line_id', null,
        'unit_price', v_unit_price
      )
    );
  end loop;

  v_credit_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_revenue_account_id, 'amount', v_total_amount)
  );

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      if (v_line ->> 'amount')::numeric <= 0 then
        raise exception 'Nominal baris biaya tambahan harus > 0';
      end if;
      v_credit_lines := v_credit_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_line ->> 'account_id', 'amount', (v_line ->> 'amount')::numeric)
      );
    end loop;
  end if;

  v_goods_issue_id := create_goods_issue(
    v_customer_id, p_sale_date, 'Penjualan POS', p_source_ref,
    v_credit_lines, v_receivable_account_id,
    v_issue_lines, p_hpp_account_id, p_finished_good_account_id,
    p_apply_tax
  );

  select invoice_id into v_transaction_id from goods_issues where id = v_goods_issue_id;

  -- Lunasi SELURUH outstanding seketika (bukan v_total_amount -- pakai amount asli hasil
  -- create_transaction, karena itu udah termasuk PPN kalau p_apply_tax, dihitung 1 tempat
  -- doang biar gak ada 2 sumber kebenaran buat angka pajak).
  select amount into v_settle_amount from transactions where id = v_transaction_id;

  perform record_payment(
    'OUTBOUND', v_customer_id, p_sale_date, v_settle_amount, p_source_ref,
    p_cash_account_id, v_receivable_account_id, v_transaction_id
  );

  return v_transaction_id;
end;
$$;
