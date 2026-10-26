/**
 * AI Voice & Text Invoice Maker (Vanilla JS)
 * Handles state, deterministic GST calculations, Web Speech API,
 * AI backend integration with fallback, UPI QR code generation, and PDF export.
 */

// ==========================================
// 1. STATE & STORAGE
// ==========================================

const STORAGE_KEY_SELLER = 'ai_invoice_seller_profile_v1';
const STORAGE_KEY_CURRENT = 'ai_invoice_current_draft_v1';

// Default seller profile
const defaultSeller = {
  name: 'Apex Retail & Apparel',
  address: 'Shop 12, Connaught Place, New Delhi, Delhi - 110001',
  phone: '+91 98765 43210',
  email: 'apexretail@gmail.com',
  gstin: '07AAAAA0000A1Z5',
  state: 'Delhi',
  upiId: 'apexretail@okhdfcbank',
  logoUrl: '',
};

// Initial invoice state (matching user prompt example)
const defaultInvoice = {
  invoiceNumber: '#INV-2026-001',
  invoiceDate: new Date().toISOString().split('T')[0],
  dueDate: '',
  seller: { ...defaultSeller },
  customer: {
    name: 'Rahul Sharma',
    address: 'Connaught Place, New Delhi, Delhi - 110001',
    phone: '+91 98111 22334',
    email: 'rahul.sharma@example.com',
    gstin: '07ABCDE1234F1Z8',
    state: 'Delhi',
  },
  items: [
    {
      id: 'item_1',
      description: 'Formal Cotton Shirts',
      hsnSac: '6205',
      quantity: 5,
      unitPrice: 500,
      discountPercent: 10,
      gstRate: 5,
    },
  ],
  isInterState: false, // Default intra-state (CGST + SGST)
  notes: 'Thank you for your business! Please scan the UPI QR code below for instant payment.',
  additionalCharges: 0,
  amountPaid: 0,
};

let invoiceState = loadInvoiceState();
let recognition = null;
let isRecording = false;
let qrCodeInstance = null;
let modalQrCodeInstance = null;

// ==========================================
// 2. INITIALIZATION
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
  initSpeechRecognition();
  bindEvents();
  renderInvoice();
  renderChatAssistantGreeting();
});

function loadInvoiceState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_CURRENT);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...defaultInvoice, ...parsed };
    }
  } catch (e) {
    console.error('Error loading saved draft:', e);
  }

  // Load custom seller profile if saved
  try {
    const savedSeller = localStorage.getItem(STORAGE_KEY_SELLER);
    if (savedSeller) {
      const parsedSeller = JSON.parse(savedSeller);
      return {
        ...defaultInvoice,
        seller: { ...defaultSeller, ...parsedSeller },
      };
    }
  } catch (e) {
    console.error('Error loading seller profile:', e);
  }

  return JSON.parse(JSON.stringify(defaultInvoice));
}

function saveInvoiceState() {
  try {
    localStorage.setItem(STORAGE_KEY_CURRENT, JSON.stringify(invoiceState));
  } catch (e) {
    console.error('Error saving invoice state:', e);
  }
}

// ==========================================
// 3. DETERMINISTIC CALCULATIONS (INDIAN GST)
// ==========================================

function formatINR(val) {
  const num = Number(val) || 0;
  return '₹' + num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

function calculateInvoice(data) {
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

  const calculatedItems = (data.items || []).map((item, idx) => {
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
      id: item.id || `item_${idx + 1}`,
      quantity: qty,
      unitPrice,
      grossAmount,
      discountPercent,
      discountAmount,
      taxableAmount,
      gstRate,
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

// UPI URI generation
function generateUpiUri(upiId, merchantName, amount, note) {
  if (!upiId) return '';
  const cleanUpi = upiId.trim();
  const cleanName = (merchantName || 'Merchant').trim();
  const cleanAmt = Math.max(0, Number(amount) || 0).toFixed(2);
  const cleanNote = (note || 'Invoice Payment').trim();
  return `upi://pay?pa=${encodeURIComponent(cleanUpi)}&pn=${encodeURIComponent(cleanName)}&am=${cleanAmt}&cu=INR&tn=${encodeURIComponent(cleanNote)}`;
}

// ==========================================
// 4. RENDERING THE INVOICE (MATCHING REFERENCE)
// ==========================================

function renderInvoice() {
  const calc = calculateInvoice(invoiceState);

  // Seller Details
  document.getElementById('invSellerName').textContent = invoiceState.seller.name || 'YOUR BUSINESS NAME';
  document.getElementById('invSellerAddress').textContent = invoiceState.seller.address || '';
  document.getElementById('invSellerPhone').textContent = invoiceState.seller.phone || '';
  document.getElementById('invSellerEmail').textContent = invoiceState.seller.email || '';
  
  const gstinRow = document.getElementById('invSellerGstinRow');
  if (invoiceState.seller.gstin) {
    gstinRow.classList.remove('hidden');
    document.getElementById('invSellerGstin').textContent = invoiceState.seller.gstin;
  } else {
    gstinRow.classList.add('hidden');
  }

  // Invoice Meta
  document.getElementById('invNumber').textContent = invoiceState.invoiceNumber || '#INV-001';
  document.getElementById('invDate').textContent = formatDate(invoiceState.invoiceDate);

  // Customer Details (BILL TO)
  document.getElementById('invCustomerName').textContent = invoiceState.customer.name || 'Customer Name';
  document.getElementById('invCustomerAddress').textContent = invoiceState.customer.address || 'Address, City, State, PIN';
  document.getElementById('invCustomerPhone').textContent = invoiceState.customer.phone || 'Phone not specified';
  document.getElementById('invCustomerEmail').textContent = invoiceState.customer.email || 'Email not specified';

  const custGstinRow = document.getElementById('invCustomerGstinRow');
  if (invoiceState.customer.gstin) {
    custGstinRow.classList.remove('hidden');
    document.getElementById('invCustomerGstin').textContent = invoiceState.customer.gstin;
  } else {
    custGstinRow.classList.add('hidden');
  }

  // Tax treatment badge
  const taxBadge = document.getElementById('taxModeBadge');
  if (calc.isInterState) {
    taxBadge.textContent = 'Inter-State (IGST)';
    taxBadge.className = 'text-[11px] font-medium px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200';
  } else {
    taxBadge.textContent = 'Intra-State (CGST + SGST)';
    taxBadge.className = 'text-[11px] font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200';
  }

  // Items Table
  const tbody = document.getElementById('invoiceTableBody');
  tbody.innerHTML = '';

  if (calc.items.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td colspan="5" class="py-6 text-center text-slate-400 italic">
        No items added yet. Speak or type to add items (e.g., "5 shirts at ₹500").
      </td>
    `;
    tbody.appendChild(emptyRow);
  } else {
    calc.items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/50 transition-colors';
      tr.innerHTML = `
        <td class="py-2.5 px-3 border-r border-slate-300">
          <div class="font-medium text-slate-900">${escapeHtml(item.description)}</div>
          ${item.hsnSac ? `<div class="text-[10px] text-slate-400 font-mono">HSN/SAC: ${escapeHtml(item.hsnSac)}</div>` : ''}
          ${item.gstRate > 0 ? `<div class="text-[10px] text-slate-500">GST: ${item.gstRate}%</div>` : ''}
        </td>
        <td class="py-2.5 px-2 text-center border-r border-slate-300 font-mono">
          ${formatINR(item.unitPrice)}
        </td>
        <td class="py-2.5 px-2 text-center border-r border-slate-300 font-medium">
          ${item.quantity}
        </td>
        <td class="py-2.5 px-2 text-right border-r border-slate-300 text-slate-600">
          ${item.discountPercent > 0 ? `${item.discountPercent}%` : '-'}
        </td>
        <td class="py-2.5 px-2 text-right font-semibold text-slate-900 font-mono">
          ${formatINR(item.lineTotal)}
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Notes
  document.getElementById('invNotes').textContent = invoiceState.notes || 'Thank you for your business!';

  // Totals Breakdown
  document.getElementById('totSubTotal').textContent = formatINR(calc.itemsSubtotal);
  document.getElementById('totDiscount').textContent = `- ${formatINR(calc.totalItemDiscount)}`;
  document.getElementById('totTaxable').textContent = formatINR(calc.taxableSubtotal);

  const cgstRow = document.getElementById('cgstRow');
  const sgstRow = document.getElementById('sgstRow');
  const igstRow = document.getElementById('igstRow');

  if (calc.isInterState) {
    cgstRow.classList.add('hidden');
    sgstRow.classList.add('hidden');
    igstRow.classList.remove('hidden');
    document.getElementById('totIgst').textContent = formatINR(calc.totalIgst);
  } else {
    cgstRow.classList.remove('hidden');
    sgstRow.classList.remove('hidden');
    igstRow.classList.add('hidden');
    document.getElementById('totCgst').textContent = formatINR(calc.totalCgst);
    document.getElementById('totSgst').textContent = formatINR(calc.totalSgst);
  }

  const roundOffRow = document.getElementById('roundOffRow');
  if (calc.roundOff !== 0) {
    roundOffRow.classList.remove('hidden');
    document.getElementById('totRoundOff').textContent = (calc.roundOff > 0 ? '+ ' : '') + formatINR(calc.roundOff);
  } else {
    roundOffRow.classList.add('hidden');
  }

  document.getElementById('totGrandTotal').textContent = formatINR(calc.grandTotal);

  // Paid & Balance Due
  document.getElementById('totPaid').textContent = formatINR(calc.amountPaid);
  document.getElementById('totBalanceDue').textContent = formatINR(calc.balanceDue);

  // UPI QR Code Update
  renderUpiQrCode(calc.grandTotal);

  // Persist state
  saveInvoiceState();
}

// Render scannable UPI QR Code using QRCode.js
function renderUpiQrCode(amount) {
  const upiId = (invoiceState.seller.upiId || '').trim();
  const sellerName = (invoiceState.seller.name || 'Merchant').trim();
  const upiCard = document.getElementById('upiPaymentCard');
  const qrCanvas = document.getElementById('qrcodeCanvas');
  
  if (!upiId) {
    upiCard.classList.add('opacity-50');
    qrCanvas.innerHTML = '<span class="text-[10px] text-slate-400 p-2 block text-center">Set UPI ID</span>';
    document.getElementById('invUpiIdText').textContent = 'Not configured';
    document.getElementById('invUpiAmountText').textContent = formatINR(amount);
    return;
  }

  upiCard.classList.remove('opacity-50');
  document.getElementById('invUpiIdText').textContent = upiId;
  document.getElementById('invUpiAmountText').textContent = formatINR(amount);

  const upiUri = generateUpiUri(upiId, sellerName, amount, `Invoice ${invoiceState.invoiceNumber}`);

  // Update QR Code on invoice sheet
  qrCanvas.innerHTML = '';
  if (window.QRCode) {
    try {
      new window.QRCode(qrCanvas, {
        text: upiUri,
        width: 84,
        height: 84,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } catch (e) {
      console.error('QRCode render error:', e);
    }
  }

  // Update modal QR code
  const modalCanvas = document.getElementById('modalQrcodeCanvas');
  if (modalCanvas && window.QRCode) {
    modalCanvas.innerHTML = '';
    try {
      new window.QRCode(modalCanvas, {
        text: upiUri,
        width: 160,
        height: 160,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } catch (e) {
      console.error('Modal QRCode error:', e);
    }
  }

  const modalUpiAmount = document.getElementById('modalUpiAmount');
  if (modalUpiAmount) modalUpiAmount.textContent = formatINR(amount);

  const modalUpiId = document.getElementById('modalUpiId');
  if (modalUpiId) modalUpiId.textContent = upiId;

  const btnDirectUpiPay = document.getElementById('btnDirectUpiPay');
  if (btnDirectUpiPay) btnDirectUpiPay.href = upiUri;
}

// ==========================================
// 5. WEB SPEECH API (VOICE INPUT)
// ==========================================

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btnMic = document.getElementById('btnMic');

  if (!SpeechRecognition) {
    btnMic.title = 'Speech recognition not supported in this browser. Use text input.';
    btnMic.classList.add('opacity-50', 'cursor-not-allowed');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isRecording = true;
    updateVoiceUI(true);
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    const transcript = (finalTranscript || interimTranscript).trim();
    if (transcript) {
      const input = document.getElementById('chatInput');
      input.value = transcript;
      document.getElementById('voiceReviewNotice').classList.remove('hidden');
    }
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    isRecording = false;
    updateVoiceUI(false);
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      appendChatMessage('assistant', `Microphone notice: ${event.error}. You can also type your instructions directly into the chat input.`);
    }
  };

  recognition.onend = () => {
    isRecording = false;
    updateVoiceUI(false);
  };
}

function toggleVoiceRecording() {
  if (!recognition) {
    alert('Voice recognition is not supported in this browser. Please use Chrome or Android Chrome for voice input, or type below.');
    return;
  }

  if (isRecording) {
    recognition.stop();
  } else {
    const langSelect = document.getElementById('voiceLangSelect');
    recognition.lang = langSelect ? langSelect.value : 'en-IN';
    try {
      recognition.start();
    } catch (e) {
      console.warn('Recognition already started:', e);
    }
  }
}

function updateVoiceUI(recording) {
  const banner = document.getElementById('voiceStatusBanner');
  const micNormal = document.getElementById('micIconNormal');
  const micWave = document.getElementById('micWaveAnim');
  const btnMic = document.getElementById('btnMic');

  if (recording) {
    banner.classList.remove('hidden');
    micNormal.classList.add('hidden');
    micWave.classList.remove('hidden');
    btnMic.classList.add('bg-red-50', 'border-red-400', 'text-red-600', 'ring-2', 'ring-red-400');
  } else {
    banner.classList.add('hidden');
    micNormal.classList.remove('hidden');
    micWave.classList.add('hidden');
    btnMic.classList.remove('bg-red-50', 'border-red-400', 'text-red-600', 'ring-2', 'ring-red-400');
  }
}

// ==========================================
// 6. CHAT & AI PARSER INTEGRATION
// ==========================================

async function handleUserInstruction(text) {
  if (!text || !text.trim()) return;

  const cleanText = text.trim();
  appendChatMessage('user', cleanText);

  // Clear input and review banner
  document.getElementById('chatInput').value = '';
  document.getElementById('voiceReviewNotice').classList.add('hidden');

  // Loading indicator
  const loadingMsgId = appendChatLoading();

  try {
    const response = await fetch('/api/ai/parse-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: cleanText,
        currentInvoice: invoiceState,
      }),
    });

    const data = await response.json();
    removeChatLoading(loadingMsgId);

    if (data.updates) {
      applyInvoiceUpdates(data.updates);
    }

    let reply = data.assistantResponse || 'Invoice updated successfully.';
    if (data.followUpQuestion) {
      reply += '\n\n' + data.followUpQuestion;
    }
    appendChatMessage('assistant', reply);

  } catch (err) {
    console.error('Error contacting AI service:', err);
    removeChatLoading(loadingMsgId);

    // Offline client fallback
    const fallback = clientRuleParse(cleanText);
    if (fallback.updates) {
      applyInvoiceUpdates(fallback.updates);
    }
    appendChatMessage('assistant', fallback.explanation || 'Updated invoice with your instructions.');
  }
}

function applyInvoiceUpdates(updates) {
  if (!updates || typeof updates !== 'object') return;

  // 1. Customer updates
  if (updates.customer) {
    invoiceState.customer = {
      ...invoiceState.customer,
      ...updates.customer,
    };
  }

  // 2. Seller updates
  if (updates.seller) {
    invoiceState.seller = {
      ...invoiceState.seller,
      ...updates.seller,
    };
  }

  // 3. Tax treatment
  if (typeof updates.isInterState === 'boolean') {
    invoiceState.isInterState = updates.isInterState;
  }

  // 4. Items updates
  if (Array.isArray(updates.items) && updates.items.length > 0) {
    if (updates.replaceItems) {
      invoiceState.items = updates.items.map((it, idx) => ({
        id: `item_${Date.now()}_${idx}`,
        description: it.description || 'Item',
        hsnSac: it.hsnSac || '',
        quantity: Math.max(1, Number(it.quantity) || 1),
        unitPrice: Math.max(0, Number(it.unitPrice) || 0),
        discountPercent: Number(it.discountPercent) || 0,
        gstRate: it.gstRate !== undefined ? Number(it.gstRate) : 18,
      }));
    } else {
      // Append or replace
      updates.items.forEach((it, idx) => {
        invoiceState.items.push({
          id: `item_${Date.now()}_${idx}`,
          description: it.description || 'Item',
          hsnSac: it.hsnSac || '',
          quantity: Math.max(1, Number(it.quantity) || 1),
          unitPrice: Math.max(0, Number(it.unitPrice) || 0),
          discountPercent: Number(it.discountPercent) || 0,
          gstRate: it.gstRate !== undefined ? Number(it.gstRate) : 18,
        });
      });
    }
  } else if (updates.defaultDiscount !== undefined) {
    // Apply discount to all existing items
    invoiceState.items = invoiceState.items.map(it => ({
      ...it,
      discountPercent: updates.defaultDiscount,
    }));
  }

  if (updates.defaultGst !== undefined) {
    // Apply GST to all existing items
    invoiceState.items = invoiceState.items.map(it => ({
      ...it,
      gstRate: updates.defaultGst,
    }));
  }

  // 5. Notes & Charges
  if (updates.notes) invoiceState.notes = updates.notes;
  if (updates.additionalCharges !== undefined) invoiceState.additionalCharges = updates.additionalCharges;
  if (updates.amountPaid !== undefined) invoiceState.amountPaid = updates.amountPaid;
  if (updates.invoiceNumber) invoiceState.invoiceNumber = updates.invoiceNumber;

  renderInvoice();
}

// Client-side rule parser for instant offline / no-server fallback
function clientRuleParse(text) {
  const lower = text.toLowerCase();
  const updates = {};
  let explanation = '';

  // Customer name
  const custMatch = text.match(/(?:for|to|customer|client|naam|name)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i);
  if (custMatch && !['invoice', 'gst', 'shirt', 'discount'].includes(custMatch[1].toLowerCase())) {
    updates.customer = { name: custMatch[1].trim() };
  }

  // Discount
  const discMatch = lower.match(/(?:discount|chhoot|off)\s*(?:of|is|:)?\s*(\d+(?:\.\d+)?)\s*%/i) ||
    lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:discount|off|chhoot)/i);
  if (discMatch) {
    updates.defaultDiscount = parseFloat(discMatch[1]);
  }

  // GST
  const gstMatch = lower.match(/(?:gst|tax)\s*(?:of|is|:)?\s*(\d+(?:\.\d+)?)\s*%/i) ||
    lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:gst|tax)/i);
  if (gstMatch) {
    updates.defaultGst = parseFloat(gstMatch[1]);
  } else if (lower.includes('no gst') || lower.includes('remove gst')) {
    updates.defaultGst = 0;
  }

  // Items pattern: "5 shirts at ₹500 each"
  const itemMatch = text.match(/(\d+)\s+([a-zA-Z\s]{2,20}?)\s+(?:at|@|for|rate|each|ke|rupaye|rs\.?|₹)?\s*(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)(?:\s*each|\s*per\s*piece|\s*prat)?/i);
  if (itemMatch) {
    const qty = parseInt(itemMatch[1], 10);
    const desc = itemMatch[2].trim().replace(/^(for|to|make|create|an|a)\s+/i, '');
    const price = parseFloat(itemMatch[3]);
    if (qty > 0 && price > 0 && desc.length > 1) {
      updates.items = [
        {
          id: 'item_' + Date.now(),
          description: desc.charAt(0).toUpperCase() + desc.slice(1),
          quantity: qty,
          unitPrice: price,
          discountPercent: updates.defaultDiscount !== undefined ? updates.defaultDiscount : 0,
          gstRate: updates.defaultGst !== undefined ? updates.defaultGst : 18,
        }
      ];
      updates.replaceItems = !lower.includes('add') && !lower.includes('also');
    }
  }

  if (lower.includes('inter-state') || lower.includes('igst')) {
    updates.isInterState = true;
  } else if (lower.includes('intra-state') || lower.includes('cgst')) {
    updates.isInterState = false;
  }

  explanation = 'Processed invoice instruction offline.';
  return { updates, explanation };
}

function appendChatMessage(sender, text) {
  const container = document.getElementById('chatMessages');
  const msg = document.createElement('div');

  if (sender === 'user') {
    msg.className = 'chat-msg user';
    msg.innerHTML = `<div>${escapeHtml(text)}</div>`;
  } else {
    msg.className = 'chat-msg assistant';
    msg.innerHTML = `
      <div class="assistant-badge">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a8 8 0 100 16 8 8 0 000-16zm1 11H9v-2h2v2zm0-4H9V5h2v4z"></path></svg>
        <span>Assistant</span>
      </div>
      <div style="line-height: 1.45; white-space: pre-line;">${escapeHtml(text)}</div>
    `;
  }

  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function appendChatLoading() {
  const container = document.getElementById('chatMessages');
  const id = 'loading_' + Date.now();
  const msg = document.createElement('div');
  msg.id = id;
  msg.className = 'chat-msg assistant bg-white border border-slate-200 rounded-2xl rounded-tl-xs p-3 shadow-xs text-xs text-slate-500 flex items-center gap-2';
  msg.innerHTML = `
    <span class="inline-block w-2 h-2 rounded-full bg-indigo-600 animate-ping"></span>
    <span>Interpreting instructions and calculating invoice...</span>
  `;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeChatLoading(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function renderChatAssistantGreeting() {
  // Check API health status quietly in background
  fetch('/api/status')
    .then(r => r.json())
    .then(data => {
      if (!data.aiConfigured) {
        console.info('AI backend running in rule-based fallback mode.');
      }
    })
    .catch(() => {
      console.warn('Backend not reached; running fully offline in browser.');
    });
}

// ==========================================
// 7. PDF GENERATION & EXPORT
// ==========================================

function downloadInvoicePdf() {
  const element = document.getElementById('invoiceDocument');
  if (!element || !window.html2pdf) {
    alert('PDF library is loading. You can also use the Print button to Save as PDF.');
    window.print();
    return;
  }

  const opt = {
    margin: [8, 8, 8, 8],
    filename: `${invoiceState.invoiceNumber.replace('#', '') || 'invoice'}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, letterRendering: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
  };

  const btn = document.getElementById('btnDownloadPdf');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span>Generating PDF...</span>';
  btn.disabled = true;

  window.html2pdf()
    .set(opt)
    .from(element)
    .save()
    .then(() => {
      btn.innerHTML = originalText;
      btn.disabled = false;
    })
    .catch((err) => {
      console.error('PDF error:', err);
      btn.innerHTML = originalText;
      btn.disabled = false;
      alert('PDF generation encountered an issue. Opening standard print dialog instead.');
      window.print();
    });
}

// ==========================================
// 8. MODAL HANDLERS (SELLER & INVOICE EDIT)
// ==========================================

function openSellerModal() {
  document.getElementById('setSellerName').value = invoiceState.seller.name || '';
  document.getElementById('setSellerPhone').value = invoiceState.seller.phone || '';
  document.getElementById('setSellerEmail').value = invoiceState.seller.email || '';
  document.getElementById('setSellerAddress').value = invoiceState.seller.address || '';
  document.getElementById('setSellerState').value = invoiceState.seller.state || '';
  document.getElementById('setSellerGstin').value = invoiceState.seller.gstin || '';
  document.getElementById('setSellerUpi').value = invoiceState.seller.upiId || '';

  document.getElementById('modalSellerSettings').classList.remove('hidden');
}

function closeSellerModal() {
  document.getElementById('modalSellerSettings').classList.add('hidden');
}

function handleSaveSeller(e) {
  e.preventDefault();
  const upi = document.getElementById('setSellerUpi').value.trim();

  invoiceState.seller = {
    ...invoiceState.seller,
    name: document.getElementById('setSellerName').value.trim(),
    phone: document.getElementById('setSellerPhone').value.trim(),
    email: document.getElementById('setSellerEmail').value.trim(),
    address: document.getElementById('setSellerAddress').value.trim(),
    state: document.getElementById('setSellerState').value.trim(),
    gstin: document.getElementById('setSellerGstin').value.trim().toUpperCase(),
    upiId: upi,
  };

  // Save seller as reusable default
  try {
    localStorage.setItem(STORAGE_KEY_SELLER, JSON.stringify(invoiceState.seller));
  } catch (err) {
    console.error('Save seller err:', err);
  }

  closeSellerModal();
  renderInvoice();
  appendChatMessage('assistant', `Updated business profile for ${invoiceState.seller.name} with UPI ID: ${upi}`);
}

function openEditInvoiceModal() {
  document.getElementById('editInvNumber').value = invoiceState.invoiceNumber;
  document.getElementById('editInvDate').value = invoiceState.invoiceDate;
  document.getElementById('editTaxType').value = invoiceState.isInterState ? 'inter' : 'intra';

  document.getElementById('editCustName').value = invoiceState.customer.name || '';
  document.getElementById('editCustPhone').value = invoiceState.customer.phone || '';
  document.getElementById('editCustEmail').value = invoiceState.customer.email || '';
  document.getElementById('editCustAddress').value = invoiceState.customer.address || '';
  document.getElementById('editCustGstin').value = invoiceState.customer.gstin || '';

  document.getElementById('editInvNotes').value = invoiceState.notes || '';
  document.getElementById('editAmountPaid').value = invoiceState.amountPaid || 0;
  document.getElementById('editAdditionalCharges').value = invoiceState.additionalCharges || 0;

  renderEditItemsList();
  document.getElementById('modalEditInvoice').classList.remove('hidden');
}

function closeEditInvoiceModal() {
  document.getElementById('modalEditInvoice').classList.add('hidden');
}

function renderEditItemsList() {
  const container = document.getElementById('editItemsList');
  container.innerHTML = '';

  invoiceState.items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'grid grid-cols-12 gap-1.5 items-center p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs';
    row.dataset.idx = idx;

    row.innerHTML = `
      <div class="col-span-5">
        <input type="text" placeholder="Item description" value="${escapeHtml(item.description)}" class="item-desc w-full px-2 py-1 border border-slate-300 rounded bg-white" required />
      </div>
      <div class="col-span-2">
        <input type="number" placeholder="Price" step="0.01" min="0" value="${item.unitPrice}" class="item-price w-full px-2 py-1 border border-slate-300 rounded bg-white text-right" required />
      </div>
      <div class="col-span-1">
        <input type="number" placeholder="Qty" min="1" value="${item.quantity}" class="item-qty w-full px-2 py-1 border border-slate-300 rounded bg-white text-center" required />
      </div>
      <div class="col-span-2">
        <select class="item-gst w-full px-1.5 py-1 border border-slate-300 rounded bg-white text-center">
          <option value="0" ${item.gstRate === 0 ? 'selected' : ''}>0%</option>
          <option value="5" ${item.gstRate === 5 ? 'selected' : ''}>5%</option>
          <option value="12" ${item.gstRate === 12 ? 'selected' : ''}>12%</option>
          <option value="18" ${item.gstRate === 18 ? 'selected' : ''}>18%</option>
          <option value="28" ${item.gstRate === 28 ? 'selected' : ''}>28%</option>
        </select>
      </div>
      <div class="col-span-1">
        <input type="number" placeholder="Disc %" min="0" max="100" value="${item.discountPercent || 0}" class="item-disc w-full px-1.5 py-1 border border-slate-300 rounded bg-white text-right" />
      </div>
      <div class="col-span-1 text-center">
        <button type="button" class="btn-remove-item text-red-500 hover:text-red-700 font-bold p-1">&times;</button>
      </div>
    `;

    row.querySelector('.btn-remove-item').addEventListener('click', () => {
      invoiceState.items.splice(idx, 1);
      renderEditItemsList();
    });

    container.appendChild(row);
  });
}

function handleSaveEditInvoice(e) {
  e.preventDefault();

  invoiceState.invoiceNumber = document.getElementById('editInvNumber').value.trim();
  invoiceState.invoiceDate = document.getElementById('editInvDate').value;
  invoiceState.isInterState = document.getElementById('editTaxType').value === 'inter';

  invoiceState.customer = {
    name: document.getElementById('editCustName').value.trim(),
    phone: document.getElementById('editCustPhone').value.trim(),
    email: document.getElementById('editCustEmail').value.trim(),
    address: document.getElementById('editCustAddress').value.trim(),
    gstin: document.getElementById('editCustGstin').value.trim().toUpperCase(),
  };

  invoiceState.notes = document.getElementById('editInvNotes').value.trim();
  invoiceState.amountPaid = parseFloat(document.getElementById('editAmountPaid').value) || 0;
  invoiceState.additionalCharges = parseFloat(document.getElementById('editAdditionalCharges').value) || 0;

  // Gather items
  const rows = document.querySelectorAll('#editItemsList > div');
  const newItems = [];
  rows.forEach((row, idx) => {
    const desc = row.querySelector('.item-desc').value.trim();
    const price = parseFloat(row.querySelector('.item-price').value) || 0;
    const qty = parseInt(row.querySelector('.item-qty').value, 10) || 1;
    const gst = parseFloat(row.querySelector('.item-gst').value) || 0;
    const disc = parseFloat(row.querySelector('.item-disc').value) || 0;

    if (desc) {
      newItems.push({
        id: `item_${Date.now()}_${idx}`,
        description: desc,
        unitPrice: price,
        quantity: qty,
        gstRate: gst,
        discountPercent: disc,
      });
    }
  });

  invoiceState.items = newItems;

  closeEditInvoiceModal();
  renderInvoice();
  appendChatMessage('assistant', 'Manual invoice modifications saved.');
}

// ==========================================
// 9. EVENT BINDINGS
// ==========================================

function bindEvents() {
  // Chat form submit
  document.getElementById('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = document.getElementById('chatInput').value;
    handleUserInstruction(text);
  });

  // Mic button
  document.getElementById('btnMic').addEventListener('click', () => {
    toggleVoiceRecording();
  });

  // Cancel voice banner
  document.getElementById('btnCancelVoice').addEventListener('click', () => {
    if (recognition && isRecording) {
      recognition.abort();
      isRecording = false;
      updateVoiceUI(false);
    }
  });

  // Clear voice draft
  document.getElementById('btnClearVoiceDraft').addEventListener('click', () => {
    document.getElementById('chatInput').value = '';
    document.getElementById('voiceReviewNotice').classList.add('hidden');
  });

  // Quick Prompt chips
  document.querySelectorAll('.quick-prompt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt;
      if (prompt) {
        document.getElementById('chatInput').value = prompt;
        handleUserInstruction(prompt);
      }
    });
  });

  // New Invoice button
  document.getElementById('btnNewInvoice').addEventListener('click', () => {
    if (confirm('Create a fresh invoice? (Saved business details will be preserved)')) {
      invoiceState = {
        ...defaultInvoice,
        invoiceNumber: '#INV-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random() * 900) + 100),
        invoiceDate: new Date().toISOString().split('T')[0],
        seller: { ...invoiceState.seller },
        customer: { name: '', address: '', phone: '', email: '', gstin: '', state: '' },
        items: [],
      };
      renderInvoice();
      appendChatMessage('assistant', 'Created a fresh blank invoice. Speak or type instructions to fill it out.');
    }
  });

  // PDF & Print
  document.getElementById('btnDownloadPdf').addEventListener('click', downloadInvoicePdf);
  document.getElementById('btnPrintInvoice').addEventListener('click', () => {
    window.print();
  });

  // UPI Modal
  document.getElementById('btnOpenUpiModal').addEventListener('click', () => {
    const calc = calculateInvoice(invoiceState);
    renderUpiQrCode(calc.grandTotal);
    document.getElementById('modalUpiPayment').classList.remove('hidden');
  });
  document.getElementById('btnCloseUpiModal').addEventListener('click', () => {
    document.getElementById('modalUpiPayment').classList.add('hidden');
  });

  // Seller Settings Modal
  document.getElementById('btnOpenSellerSettings').addEventListener('click', openSellerModal);
  document.getElementById('btnCloseSellerSettings').addEventListener('click', closeSellerModal);
  document.getElementById('btnCancelSellerSettings').addEventListener('click', closeSellerModal);
  document.getElementById('sellerSettingsForm').addEventListener('submit', handleSaveSeller);

  // Manual Edit Invoice Modal
  document.getElementById('btnEditInvoiceModal').addEventListener('click', openEditInvoiceModal);
  document.getElementById('btnCloseEditInvoice').addEventListener('click', closeEditInvoiceModal);
  document.getElementById('btnCancelEditInvoice').addEventListener('click', closeEditInvoiceModal);
  document.getElementById('editInvoiceForm').addEventListener('submit', handleSaveEditInvoice);

  document.getElementById('btnAddItemRow').addEventListener('click', () => {
    invoiceState.items.push({
      id: 'item_' + Date.now(),
      description: 'New Product/Service',
      unitPrice: 100,
      quantity: 1,
      gstRate: 18,
      discountPercent: 0,
    });
    renderEditItemsList();
  });

  // Mobile Tab Switcher
  const mobileTabChat = document.getElementById('mobileTabChat');
  const mobileTabInvoice = document.getElementById('mobileTabInvoice');
  const chatPanel = document.getElementById('chatPanel');
  const invoicePanel = document.getElementById('invoicePanel');

  if (mobileTabChat && mobileTabInvoice) {
    mobileTabChat.addEventListener('click', () => {
      mobileTabChat.className = 'mobile-tab-btn active';
      mobileTabChat.setAttribute('aria-selected', 'true');
      mobileTabInvoice.className = 'mobile-tab-btn';
      mobileTabInvoice.setAttribute('aria-selected', 'false');

      chatPanel.classList.remove('hidden-mobile');
      invoicePanel.classList.add('hidden-mobile');
    });

    mobileTabInvoice.addEventListener('click', () => {
      mobileTabInvoice.className = 'mobile-tab-btn active';
      mobileTabInvoice.setAttribute('aria-selected', 'true');
      mobileTabChat.className = 'mobile-tab-btn';
      mobileTabChat.setAttribute('aria-selected', 'false');

      invoicePanel.classList.remove('hidden-mobile');
      chatPanel.classList.add('hidden-mobile');
    });

    if (window.innerWidth <= 1024) {
      invoicePanel.classList.add('hidden-mobile');
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
