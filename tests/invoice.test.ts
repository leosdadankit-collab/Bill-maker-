import test from 'node:test';
import assert from 'node:assert/strict';

export interface InvoiceItem {
  id: string;
  description: string;
  hsnSac?: string;
  quantity: number;
  unitPrice: number;
  discountPercent?: number;
  gstRate?: number;
}

export interface InvoiceData {
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  seller: {
    name: string;
    address: string;
    phone: string;
    email: string;
    gstin?: string;
    state?: string;
    upiId?: string;
    logoUrl?: string;
  };
  customer: {
    name: string;
    address: string;
    phone: string;
    email: string;
    gstin?: string;
    state?: string;
  };
  items: InvoiceItem[];
  isInterState?: boolean;
  notes?: string;
  additionalCharges?: number;
  amountPaid?: number;
}

export function calculateInvoice(data: InvoiceData) {
  const isInterState = Boolean(
    data.isInterState ||
    (data.seller.state && data.customer.state && data.seller.state.trim().toLowerCase() !== data.customer.state.trim().toLowerCase())
  );

  let itemsSubtotal = 0;
  let totalItemDiscount = 0;
  let taxableSubtotal = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;

  const calculatedItems = (data.items || []).map((item) => {
    const qty = Math.max(0, Number(item.quantity) || 0);
    const unitPrice = Math.max(0, Number(item.unitPrice) || 0);
    const grossAmount = qty * unitPrice;
    const discountPercent = Math.min(100, Math.max(0, Number(item.discountPercent) || 0));
    const discountAmount = Number(((grossAmount * discountPercent) / 100).toFixed(2));
    const taxableAmount = Number((grossAmount - discountAmount).toFixed(2));
    const gstRate = Math.max(0, Number(item.gstRate) || 0);

    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    if (gstRate > 0) {
      if (isInterState) {
        igst = Number(((taxableAmount * gstRate) / 100).toFixed(2));
      } else {
        const halfRate = gstRate / 2;
        cgst = Number(((taxableAmount * halfRate) / 100).toFixed(2));
        sgst = Number(((taxableAmount * halfRate) / 100).toFixed(2));
      }
    }

    const lineTotal = Number((taxableAmount + cgst + sgst + igst).toFixed(2));

    itemsSubtotal += grossAmount;
    totalItemDiscount += discountAmount;
    taxableSubtotal += taxableAmount;
    totalCgst += cgst;
    totalSgst += sgst;
    totalIgst += igst;

    return {
      ...item,
      quantity: qty,
      unitPrice,
      grossAmount,
      discountAmount,
      taxableAmount,
      cgst,
      sgst,
      igst,
      lineTotal,
    };
  });

  const additionalCharges = Math.max(0, Number(data.additionalCharges) || 0);
  const totalTax = Number((totalCgst + totalSgst + totalIgst).toFixed(2));
  const rawGrandTotal = taxableSubtotal + totalTax + additionalCharges;
  const roundedGrandTotal = Math.round(rawGrandTotal);
  const roundOff = Number((roundedGrandTotal - rawGrandTotal).toFixed(2));
  const grandTotal = roundedGrandTotal;

  const amountPaid = Math.max(0, Number(data.amountPaid) || 0);
  const balanceDue = Math.max(0, Number((grandTotal - amountPaid).toFixed(2)));

  return {
    isInterState,
    items: calculatedItems,
    itemsSubtotal: Number(itemsSubtotal.toFixed(2)),
    totalItemDiscount: Number(totalItemDiscount.toFixed(2)),
    taxableSubtotal: Number(taxableSubtotal.toFixed(2)),
    totalCgst: Number(totalCgst.toFixed(2)),
    totalSgst: Number(totalSgst.toFixed(2)),
    totalIgst: Number(totalIgst.toFixed(2)),
    totalTax,
    additionalCharges,
    roundOff,
    grandTotal,
    amountPaid,
    balanceDue,
  };
}

export function generateUpiUri(upiId: string, name: string, amount: number, note?: string): string {
  if (!upiId) return '';
  const cleanUpi = upiId.trim();
  const cleanName = (name || 'Merchant').trim();
  const cleanAmt = Math.max(0, amount).toFixed(2);
  const cleanNote = (note || 'Invoice Payment').trim();
  return `upi://pay?pa=${encodeURIComponent(cleanUpi)}&pn=${encodeURIComponent(cleanName)}&am=${cleanAmt}&cu=INR&tn=${encodeURIComponent(cleanNote)}`;
}

export function validateUpiId(upiId: string): boolean {
  if (!upiId) return false;
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upiId.trim());
}

test('deterministic calculation: 5 shirts at 500, 10% discount, 5% intra-state GST', () => {
  const result = calculateInvoice({
    invoiceNumber: '#INV-001',
    invoiceDate: '2026-10-26',
    seller: { name: 'Apex Retail', address: 'Delhi', phone: '9999999999', email: 'apex@example.com', state: 'Delhi' },
    customer: { name: 'Rahul Sharma', address: 'Delhi', phone: '8888888888', email: 'rahul@example.com', state: 'Delhi' },
    items: [
      { id: '1', description: 'Shirts', quantity: 5, unitPrice: 500, discountPercent: 10, gstRate: 5 }
    ]
  });

  assert.equal(result.itemsSubtotal, 2500);
  assert.equal(result.totalItemDiscount, 250);
  assert.equal(result.taxableSubtotal, 2250);
  // 5% GST = 112.50 split into CGST 2.5% = 56.25 and SGST 2.5% = 56.25
  assert.equal(result.totalCgst, 56.25);
  assert.equal(result.totalSgst, 56.25);
  assert.equal(result.totalIgst, 0);
  assert.equal(result.totalTax, 112.50);
  assert.equal(result.grandTotal, 2363); // 2250 + 112.50 = 2362.50 rounded to 2363
  assert.equal(result.roundOff, 0.50);
});

test('inter-state calculation switches to IGST', () => {
  const result = calculateInvoice({
    invoiceNumber: '#INV-002',
    invoiceDate: '2026-10-26',
    seller: { name: 'Apex Retail', address: 'Mumbai', phone: '9999999999', email: 'apex@example.com', state: 'Maharashtra' },
    customer: { name: 'Rahul Sharma', address: 'Bengaluru', phone: '8888888888', email: 'rahul@example.com', state: 'Karnataka' },
    isInterState: true,
    items: [
      { id: '1', description: 'Laptop Sleeve', quantity: 1, unitPrice: 1000, discountPercent: 0, gstRate: 18 }
    ]
  });

  assert.equal(result.isInterState, true);
  assert.equal(result.totalCgst, 0);
  assert.equal(result.totalSgst, 0);
  assert.equal(result.totalIgst, 180);
  assert.equal(result.grandTotal, 1180);
});

test('UPI URI generator outputs standard format', () => {
  const uri = generateUpiUri('merchant@okhdfcbank', 'Apex Traders', 2363, 'Invoice INV-001');
  assert.equal(uri, 'upi://pay?pa=merchant%40okhdfcbank&pn=Apex%20Traders&am=2363.00&cu=INR&tn=Invoice%20INV-001');
  assert.equal(validateUpiId('merchant@okhdfcbank'), true);
  assert.equal(validateUpiId('invalid-upi'), false);
});
