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
  /** One entry per carton, in label order. */
  cartons: { title: string; sku?: string }[];
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
  if (what) {
    cmds.push('^FO20,1090^GB772,3,3^FS');
    cmds.push(`^FO30,1102^A0N,34,34^FD${clip(what, 54)}^FS`);
  }
  if (input.driverNotes) cmds.push(`^FO30,1150^A0N,32,32^FDNOTE: ${clip(input.driverNotes, 48)}^FS`);
  cmds.push('^XZ');
  return `${cmds.join('\n')}\n`;
}

/** Every carton's label as one ZPL job per carton. */
export function sgkCartonLabels(input: SgkLabelInput): string[] {
  return input.cartons.map((_, index) => sgkCartonLabel(input, index));
}
