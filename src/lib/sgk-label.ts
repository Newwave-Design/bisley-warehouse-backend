/**
 * SGK carton labels, printed when an order is queued for SGK. One 102 × 152 mm (4 × 6 inch) label per carton, the same
 * roll as the APC and DX labels: SGK order number, customer, delivery address and the carton count (1/3, 2/3, 3/3).
 */

const WIDTH = 812;
const HEIGHT = 1218;

export interface SgkLabelInput {
  /** 000161OV */
  orderNo: string;
  /** The shop order number, 161 */
  shopNumber: string;
  name: string;
  /** Address lines in order, without the name and postcode. */
  lines: string[];
  postcode: string;
  driverNotes?: string;
  /** One entry per carton, in label order. pack is the box or sleeve it goes in (see packagingText). */
  cartons: { title: string; sku?: string; pack?: string }[];
}

/** What a product's packaging record says, as the packer reads it. Shape of pick-list-packaging's `packaging`. */
export interface CartonPackaging {
  method?: string | null;
  items?: { code?: string | null; name?: string | null; item_type?: string | null; qty?: number | null }[];
}

const METHOD_WORDS: Record<string, string> = {
  own_box: 'Own box',
  pack_to_fit: 'Pack to fit',
  pallet_wrap: 'Pallet wrap',
};

/**
 * The box, or the sleeve and tray, a carton is packed in: "Box BOX-8", "Sleeve SL-29 + Tray TR-29", "Own box".
 * Edge guards, tape and other consumables are left off. Empty when nothing is recorded.
 */
export function packagingText(packaging: CartonPackaging | null | undefined): string {
  if (!packaging) return '';
  const parts: string[] = [];
  for (const type of ['box', 'sleeve', 'tray']) {
    const codes = [...new Set((packaging.items || [])
      .filter((item) => String(item.item_type || '').toLowerCase() === type)
      .map((item) => String(item.code || item.name || '').trim())
      .filter(Boolean))];
    if (codes.length) parts.push(`${type[0].toUpperCase()}${type.slice(1)} ${codes.join(', ')}`);
  }
  if (parts.length) return parts.join(' + ');
  return METHOD_WORDS[String(packaging.method || '')] || '';
}

function zpl(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/[\^~\\]/g, ' ').trim();
}

function clip(value: string, max: number): string {
  const text = zpl(value);
  return text.length > max ? `${text.slice(0, max - 1)}.` : text;
}

export function sgkCartonLabel(input: SgkLabelInput, index: number): string {
  const total = input.cartons.length;
  const carton = input.cartons[index] || { title: '' };
  const cmds: string[] = [
    '^XA',
    '^CI27',
    '^PON',
    '^MMT',
    `^PW${WIDTH}`,
    `^LL${HEIGHT}`,
    '^LH0,0',
    '^PR2',
    // Header band
    '^FO20,20^GB772,110,110^FS',
    '^FO40,36^A0N,70,70^FR^FDSGK^FS',
    `^FO330,44^A0N,52,52^FR^FDORDER ${zpl(input.shopNumber ? `#${input.shopNumber}` : '')}^FS`,
    // Order number as text and as a barcode
    `^FO30,160^A0N,110,110^FD${zpl(input.orderNo)}^FS`,
    `^FO30,290^BY3,3,90^BCN,90,N,N,N^FD${zpl(input.orderNo)}^FS`,
    // Carton count, as large as the label allows
    `^FO30,410^A0N,200,200^FD${index + 1}/${total}^FS`,
    '^FO20,625^GB772,4,4^FS',
  ];
  let y = 645;
  cmds.push(`^FO30,${y}^A0N,60,60^FD${clip(input.name, 30)}^FS`);
  y += 68;
  for (const line of input.lines.slice(0, 4)) {
    cmds.push(`^FO30,${y}^A0N,46,46^FD${clip(line, 40)}^FS`);
    y += 52;
  }
  cmds.push(`^FO30,${y + 6}^A0N,80,80^FD${clip(input.postcode, 10)}^FS`);
  const what = [carton.sku, carton.title].filter(Boolean).join('  ');
  if (what || carton.pack) {
    cmds.push('^FO20,1040^GB772,3,3^FS');
    if (what) cmds.push(`^FO30,1052^A0N,34,34^FD${clip(what, 54)}^FS`);
    // The box or sleeve this carton goes in, bold, so the packer can check it at a glance
    if (carton.pack) cmds.push(`^FO30,1094^A0N,44,44^FDPACK: ${clip(carton.pack, 36)}^FS`);
  }
  if (input.driverNotes) cmds.push(`^FO30,1152^A0N,32,32^FDNOTE: ${clip(input.driverNotes, 48)}^FS`);
  cmds.push('^XZ');
  return `${cmds.join('\n')}\n`;
}

/** Every carton's label as one ZPL job per carton. */
export function sgkCartonLabels(input: SgkLabelInput): string[] {
  return input.cartons.map((_, index) => sgkCartonLabel(input, index));
}
