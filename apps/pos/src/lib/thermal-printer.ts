/** Print struk langsung ke printer thermal Bluetooth (RPP02N & sejenisnya) lewat
 * command Rust `print_escpos` (src-tauri/src/lib.rs) -- kirim raw ESC/POS bytes
 * ke COM port virtual hasil Bluetooth pairing, TANPA lewat dialog print OS.
 * Beda dari print-window.ts (window.print(), butuh klik manual) -- ini silent,
 * dipilih karena kasir butuh cetak cepat tanpa interupsi tiap transaksi.
 */
import { invoke } from "@tauri-apps/api/core";
import { RECEIPT_FOOTER, roundingReceiptLine, type ReceiptData } from "./print-window";

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  init: [ESC, 0x40],
  alignLeft: [ESC, 0x61, 0],
  alignCenter: [ESC, 0x61, 1],
  boldOn: [ESC, 0x45, 1],
  boldOff: [ESC, 0x45, 0],
  doubleSizeOn: [GS, 0x21, 0x11],
  doubleSizeOff: [GS, 0x21, 0x00],
  feed: (lines: number) => [ESC, 0x64, lines],
};

// 58mm kertas, font A default -> ~32 kolom. Kalau printer kamu ternyata 80mm,
// ganti ke 48.
const LINE_WIDTH = 32;

function rp(n: number): string {
  return `Rp${Math.round(n).toLocaleString("id-ID")}`;
}

function padRow(left: string, right: string, width = LINE_WIDTH): string {
  const space = width - left.length - right.length;
  if (space <= 0) return `${left.slice(0, width - right.length - 1)} ${right}`;
  return left + " ".repeat(space) + right;
}

/** Bungkus teks ke baris <= width kolom (per kata), buat teks rata tengah yang panjang. */
function wrapText(text: string, width = LINE_WIDTH): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > width) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function dashLine(width = LINE_WIDTH): string {
  return "-".repeat(width);
}

class EscPosBuilder {
  private bytes: number[] = [];

  raw(cmd: number[]): this {
    this.bytes.push(...cmd);
    return this;
  }

  text(line: string): this {
    this.bytes.push(...Array.from(new TextEncoder().encode(line + "\n")));
    return this;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export function buildReceiptEscPos(data: ReceiptData): Uint8Array {
  const b = new EscPosBuilder().raw(CMD.init).raw(CMD.alignCenter);

  if (data.companyName) {
    // Double size = lebar kolom jadi setengah (16), nama panjang dibungkus manual.
    b.raw(CMD.boldOn).raw(CMD.doubleSizeOn);
    for (const l of wrapText(data.companyName, LINE_WIDTH / 2)) b.text(l);
    b.raw(CMD.doubleSizeOff).raw(CMD.boldOff);
  }
  if (data.companyAddress) for (const l of wrapText(data.companyAddress)) b.text(l);
  b.text(data.dateTime).raw(CMD.alignLeft).text(dashLine());

  for (const l of data.lines) {
    b.text(l.name);
    b.text(padRow(`  ${l.qty} ${l.uom} x ${rp(l.unitPrice)}`, rp(l.amount)));
  }

  b.text(dashLine());
  b.text(padRow("Subtotal", rp(data.subtotal)));
  if (data.discountTotal > 0) b.text(padRow("Diskon", `-${rp(data.discountTotal)}`));
  for (const l of data.extraLines) b.text(padRow(l.label, rp(l.amount)));
  if (data.taxAmount > 0) {
    b.text(padRow(`PPN${data.taxRate != null ? ` (${data.taxRate}%)` : ""}`, rp(data.taxAmount)));
  }
  b.text(dashLine());
  b.raw(CMD.boldOn).text(padRow("Total", rp(data.total))).raw(CMD.boldOff);
  b.text(padRow(`Bayar (${data.paymentLabel})`, data.cashReceived != null ? rp(data.cashReceived) : "-"));
  if (data.change != null) b.text(padRow("Kembalian", rp(data.change)));
  const rounding = roundingReceiptLine(data);
  if (rounding) b.text(padRow(rounding.label, rounding.value));
  if (data.customerName) b.text(`Pelanggan: ${data.customerName}`);
  b.raw(CMD.alignCenter);
  for (const line of RECEIPT_FOOTER) for (const l of wrapText(line)) b.text(l);
  b.raw(CMD.feed(3));

  return b.toBytes();
}

export async function listSerialPorts(): Promise<string[]> {
  return invoke<string[]>("list_serial_ports");
}

export async function printEscPos(port: string, data: ReceiptData): Promise<void> {
  const bytes = buildReceiptEscPos(data);
  await invoke("print_escpos", { port, data: Array.from(bytes) });
}
