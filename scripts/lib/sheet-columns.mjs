// Generic header -> canonical-field detection, ported from the original static
// prototype's client-side detectMapping()/SYNONYMS logic. Handles the tabs whose headers
// are close enough to these synonyms; the handful of tabs that aren't (EOSS 26's "EOSS"
// column, June 2026 / EOSS's blank first column) get an explicit override below instead
// of trying to stretch the synonym list to cover them.

export const CANONICAL_FIELDS = [
  'orderNo',
  'customerName',
  'country',
  'productName',
  'sku',
  'orderDate',
  'shippingDate',
  'orderStatus',
  'sizeMeasurements',
  'paymentMode',
  'orderAmountMrp',
  'shippingCharges',
  'customizationCharges',
  'discount',
  'total',
  'paymentReceived',
  'balance',
  // Not persisted to raw_orders -- read only in-memory as a fallback source for
  // `country` when the dedicated Country cell is blank. See extractCountryFromAddress.
  'address',
];

export const SYNONYMS = {
  // Deliberately no bare 'order' catch-all here: real tabs also have "Order Date",
  // "Order Amount (MRP)", "Order Source" columns, and a loose substring match against
  // just 'order' will grab one of those instead (this actually happened against the live
  // sheet -- see TAB_OVERRIDES['May 2026']). Every configured tab has an explicit
  // override below; this list is only a last-resort net for an unconfigured new tab.
  orderNo: ['orderno', 'orderid', 'ordernumber', 'order#', 'sono'],
  customerName: ['customername', 'customer', 'clientname', 'name', 'client'],
  country: ['country', 'shipcountry', 'nation', 'destinationcountry'],
  productName: ['productname', 'product', 'item', 'itemname'],
  sku: ['sku', 'skucode', 'itemcode', 'stylecode'],
  orderDate: ['orderdate', 'date', 'orderplaced', 'orderedon'],
  shippingDate: ['shippingdate', 'shipdate', 'dispatchdate', 'deliverydate'],
  orderStatus: ['operationalstatus', 'status', 'orderstatus', 'dispatchstatus'],
  sizeMeasurements: [
    'sizemeasurementsyesno',
    'sizeandmeasurementsyesno',
    'measurementstakenyesno',
    'sizemeasurements',
    'sizemeasurement',
  ],
  paymentMode: ['paymentmode', 'modeofpayment', 'paymentmethod'],
  orderAmountMrp: ['orderamountmrp', 'amountmrp', 'mrp', 'orderamount'],
  shippingCharges: ['shippingcharges', 'shippingcharge', 'shipping'],
  customizationCharges: ['customizationcharges', 'customisationcharges', 'customizationcharge'],
  discount: ['discount'],
  total: ['total', 'totalamount', 'grandtotal'],
  paymentReceived: ['paymentreceived', 'amountreceived', 'received'],
  balance: ['balance', 'balancedue', 'balanceleft', 'amountdue', 'dueamount', 'pendingamount', 'outstandingbalance'],
  address: ['address', 'shippingaddress', 'deliveryaddress'],
};

// Per-tab fixes for columns the generic synonym match can't resolve, from the build spec
// section 3. `orderNoColumn`: exact header text to use for order_no on this tab.
// `orderNoColumnIndex`: use this column position instead, when the header is blank.
export const TAB_OVERRIDES = {
  'Mehfill orders': { orderNoColumn: 'order no' },
  'EOSS 26': { orderNoColumn: 'EOSS' },
  'Jan 2026': { orderNoColumn: 'order no' },
  'Feb 2026': { orderNoColumn: 'order no' },
  'MARCH 2026': { orderNoColumn: 'Order Numer ' },
  'April 2026': { orderNoColumn: 'Order Number ' },
  // The header cell for this column is corrupted in the live sheet -- it contains a
  // stray product-link URL instead of the label "Order No" -- so match by position
  // instead of name, same as June 2026 / EOSS. Data confirms column 0 holds the real
  // order number ("#5621" etc.) despite the bad header text.
  'May 2026': { orderNoColumnIndex: 0 },
  'June 2026 / EOSS': { orderNoColumnIndex: 0 },
  // Header cell for this column now reads blank in the live sheet (used to say "Order
  // No" -- someone cleared it). Match by position instead, same as May 2026 / June 2026
  // EOSS: confirmed the real order number ("#6019" etc.) still lives in column 0.
  // Discovered 2026-08-05 when this exact-name lookup started failing and the generic
  // synonym fallback found nothing at all (safe, but still meant every row in this tab
  // got order_no = null, which silently dropped the entire tab from fact_orders).
  'July 2026': { orderNoColumnIndex: 0 },
  'August 2026': { orderNoColumn: 'Order No' },
  'MMVM 2026': { orderNoColumn: 'Order Number ' },
  'September 2026': { orderNoColumn: 'Order No' },
};

export function normHeader(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function detectMapping(headers) {
  const map = {};
  const normed = headers.map(normHeader);
  for (const field of CANONICAL_FIELDS) {
    const syns = SYNONYMS[field];
    let foundIdx = -1;
    for (let i = 0; i < normed.length; i++) {
      if (syns.includes(normed[i])) {
        foundIdx = i;
        break;
      }
    }
    if (foundIdx === -1) {
      for (let i = 0; i < normed.length; i++) {
        if (syns.some((s) => normed[i].includes(s))) {
          foundIdx = i;
          break;
        }
      }
    }
    map[field] = foundIdx;
  }
  return map;
}

// Header row is "the row that yields an order-date column" (generic, present on every
// tab) -- scans the first few rows since some tabs have a spurious blank row above the
// real header.
export function findHeaderRowIndex(rows, maxScan = 3) {
  for (let i = 0; i < Math.min(maxScan, rows.length); i++) {
    const mapping = detectMapping(rows[i] || []);
    if (mapping.orderDate !== -1) return i;
  }
  return 0;
}

export function resolveOrderNoColumnIndex(sheetName, headers) {
  const override = TAB_OVERRIDES[sheetName];
  if (override?.orderNoColumnIndex !== undefined) return override.orderNoColumnIndex;
  if (override?.orderNoColumn) {
    const target = normHeader(override.orderNoColumn);
    const idx = headers.findIndex((h) => normHeader(h) === target);
    if (idx !== -1) return idx;
    console.warn(
      `[sync] "${sheetName}": configured order-no header "${override.orderNoColumn}" not found ` +
        `(sheet header may have changed) -- falling back to generic detection, which can mismatch. ` +
        `Verify order_no values for this tab after this run.`,
    );
  }
  // Fall back to generic synonym detection -- only reached for a tab with no override at
  // all, or one whose override just stopped matching (warned above).
  const mapping = detectMapping(headers);
  return mapping.orderNo;
}
