/**
 * Barcode Scanning Module
 * Handles USB scanner input, supercode parsing, and validation
 */

export interface BarcodeData {
  rawInput: string;
  productSku: string;
  colourCode?: string;
  colourName?: string;
  isValid: boolean;
  error?: string;
}

/**
 * Parse a supercode (SKU+Colour) or plain SKU
 * 
 * Supercodes format: "SKU-COLOURCODE" or similar
 * Falls back to plain SKU if no colour info
 * 
 * @param rawBarcode - Raw input from scanner
 * @returns Parsed barcode data
 */
export function parseSupercode(rawBarcode: string): BarcodeData {
  const trimmed = rawBarcode.trim();

  // Empty input
  if (!trimmed) {
    return {
      rawInput: rawBarcode,
      productSku: '',
      isValid: false,
      error: 'Empty barcode',
    };
  }

  // Try to detect supercode format: "SKU-COLOURCODE"
  // Example: "H2910NL-BLK" (SKU + colour code)
  const match = trimmed.match(/^([A-Z0-9]+)(?:-([A-Z0-9]+))?$/i);

  if (!match) {
    return {
      rawInput: rawBarcode,
      productSku: '',
      isValid: false,
      error: 'Invalid barcode format. Expected: SKU or SKU-COLOURCODE',
    };
  }

  const productSku = match[1];
  const colourCode = match[2] || undefined;

  // Validate SKU length (typically 6-10 chars for Bisley)
  if (productSku.length < 4 || productSku.length > 20) {
    return {
      rawInput: rawBarcode,
      productSku: productSku,
      isValid: false,
      error: `SKU length invalid: ${productSku.length} chars (expected 4-20)`,
    };
  }

  return {
    rawInput: trimmed,
    productSku,
    colourCode,
    isValid: true,
  };
}

/**
 * Map colour codes to full colour names
 * This should eventually come from the database, but we'll start with a static map
 * 
 * @param colourCode - Colour code from barcode
 * @returns Full colour name or undefined
 */
export const COLOUR_MAP: Record<string, string> = {
  'BLK': 'Black',
  'WHT': 'White',
  'RED': 'Red',
  'BLU': 'Blue',
  'GRN': 'Green',
  'GRY': 'Grey',
  'CRM': 'Cream',
  'OLV': 'Olive',
  'OXF': 'Oxford',
  'CHL': 'Chalk',
  'PNK': 'Pink',
  'YEL': 'Yellow',
  'ONG': 'Orange',
  'PRP': 'Purple',
};

export function getColourName(colourCode?: string): string | undefined {
  if (!colourCode) return undefined;
  return COLOUR_MAP[colourCode.toUpperCase()];
}

/**
 * Beep sound for barcode scanner feedback
 * Note: In Node.js backend, audio is not available.
 * USB barcode scanners typically provide their own audio feedback.
 * This function is a no-op in the backend context.
 */
export function playBarcodeBeep() {
  // No-op for backend. Barcode scanners handle their own beeping.
}

/**
 * Validate barcode against Medusa product catalog
 * Will call the barcode_mappings table to verify it exists
 * 
 * @param barcode - Parsed barcode data
 * @param dbQuery - Database query function
 * @returns Enhanced barcode data with product info
 */
export async function validateBarcodeExists(
  barcode: BarcodeData,
  dbQuery: (text: string, params?: any[]) => Promise<any>
): Promise<BarcodeData> {
  if (!barcode.isValid) return barcode;

  try {
    const result = await dbQuery(
      'SELECT * FROM barcode_mappings WHERE product_sku = $1 AND is_active = true',
      [barcode.productSku]
    );

    if (result.rows.length === 0) {
      return {
        ...barcode,
        isValid: false,
        error: `SKU not found in system: ${barcode.productSku}`,
      };
    }

    const mapping = result.rows[0];

    // If no colour was scanned, use the one from database
    if (!barcode.colourCode && mapping.colour_code) {
      barcode.colourCode = mapping.colour_code;
      barcode.colourName = mapping.colour_name;
    }

    return {
      ...barcode,
      colourName: barcode.colourName || getColourName(barcode.colourCode),
    };
  } catch (error) {
    return {
      ...barcode,
      isValid: false,
      error: `Database error validating barcode: ${error}`,
    };
  }
}
