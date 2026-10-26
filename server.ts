import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));

const apiKey = process.env.GEMINI_API_KEY;
let aiClient: GoogleGenAI | null = null;
if (apiKey && apiKey !== 'AQ.Ab8RN6JfBN0P-LTTNijXIjji5QMZEgyl5pFWcqwcXRusaCTECA' && apiKey.trim().length > 0) {
  try {
    aiClient = new GoogleGenAI({ apiKey });
  } catch (err) {
    console.error('Failed to initialize GoogleGenAI client:', err);
  }
}

// Rule-based fallback parser for natural language
function ruleBasedParse(input: string, currentInvoice: any) {
  const text = input.trim();
  const lower = text.toLowerCase();
  const updates: any = {};
  let explanation = '';

  // 1. Detect customer name
  const customerMatch = text.match(/(?:for|to|customer|client|naam|name)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i);
  if (customerMatch && !['invoice', 'gst', 'shirt', 'discount'].includes(customerMatch[1].toLowerCase())) {
    updates.customer = updates.customer || {};
    updates.customer.name = customerMatch[1].trim();
  }

  // 2. Detect discount
  const discountMatch = lower.match(/(?:discount|chhoot|off)\s*(?:of|is|:)?\s*(\d+(?:\.\d+)?)\s*%/i) ||
    lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:discount|off|chhoot)/i);
  if (discountMatch) {
    const disc = parseFloat(discountMatch[1]);
    updates.defaultDiscount = disc;
  }

  // 3. Detect GST
  const gstMatch = lower.match(/(?:gst|tax)\s*(?:of|is|:)?\s*(\d+(?:\.\d+)?)\s*%/i) ||
    lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:gst|tax)/i);
  if (gstMatch) {
    const gst = parseFloat(gstMatch[1]);
    updates.defaultGst = gst;
  } else if (lower.includes('no gst') || lower.includes('remove gst') || lower.includes('without gst')) {
    updates.defaultGst = 0;
  }

  // 4. Detect items pattern like: "5 shirts at ₹500 each" or "5 shirts @ 500" or "shirts qty 5 price 500"
  const itemPattern = /(\d+)\s+([a-zA-Z\s]{2,20}?)\s+(?:at|@|for|rate|each|ke|rupaye|rs\.?|₹)?\s*(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)(?:\s*each|\s*per\s*piece|\s*prat)?/i;
  const itemMatch = text.match(itemPattern);

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

  // Inter-state check
  if (lower.includes('inter-state') || lower.includes('interstate') || lower.includes('igst')) {
    updates.isInterState = true;
  } else if (lower.includes('intra-state') || lower.includes('intrastate') || lower.includes('cgst')) {
    updates.isInterState = false;
  }

  if (updates.items || updates.customer || updates.defaultDiscount !== undefined || updates.defaultGst !== undefined) {
    explanation = 'Processed invoice instructions: ';
    const parts = [];
    if (updates.customer?.name) parts.push(`Customer: ${updates.customer.name}`);
    if (updates.items?.length) parts.push(`${updates.items[0].quantity}x ${updates.items[0].description} @ ₹${updates.items[0].unitPrice}`);
    if (updates.defaultDiscount !== undefined) parts.push(`Discount: ${updates.defaultDiscount}%`);
    if (updates.defaultGst !== undefined) parts.push(`GST: ${updates.defaultGst}%`);
    explanation += parts.join(', ');
  } else {
    explanation = `Understood: "${text}". Please specify items (e.g., "5 shirts at ₹500 each, 10% discount, 5% GST").`;
  }

  return { updates, explanation };
}

// API: AI Invoice Parser
app.post('/api/ai/parse-invoice', async (req, res) => {
  try {
    const { message, currentInvoice, history } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!aiClient) {
      // Use intelligent deterministic offline parser
      const parsed = ruleBasedParse(message, currentInvoice);
      return res.json({
        assistantResponse: parsed.explanation,
        updates: parsed.updates,
        source: 'rule_parser',
        info: 'Running via local rule parser. To enable advanced Gemini AI understanding, configure GEMINI_API_KEY.',
      });
    }

    const systemPrompt = `You are an expert AI billing assistant for Indian businesses creating GST invoices.
The user speaks or types in English, Hindi, or Hinglish.
Your task is to interpret instructions to create or update an invoice.

CRITICAL RULES:
1. Never invent fake customer names, addresses, GSTIN numbers, or UPI IDs. Only extract what the user explicitly mentioned or kept.
2. Prices and amounts are in Indian Rupees (₹).
3. If the user asks to add an item, append it or replace as appropriate based on context ("add", "also", "another" vs "make an invoice for").
4. If the user specifies discounts (e.g., "10% discount" or "₹200 discount"), apply it properly.
5. If the user mentions GST (e.g., "5% GST", "18% GST", "no GST"), update items' gstRate or state taxes.
6. For intra-state (same state), CGST and SGST apply equally (e.g. 5% GST = 2.5% CGST + 2.5% SGST). For inter-state, IGST applies.
7. Return a JSON object with:
   - "assistantResponse": short friendly explanation of what you did in English (or Hinglish if the user spoke Hindi).
   - "followUpQuestion": short question if a critical detail is needed (optional, empty string if none).
   - "updates": an object containing only the fields that need updating:
       - "customer": { "name": string, "address": string, "phone": string, "email": string, "gstin": string, "state": string }
       - "seller": { "name": string, "address": string, "phone": string, "email": string, "gstin": string, "state": string, "upiId": string }
       - "items": array of items [ { "description": string, "hsnSac": string, "quantity": number, "unitPrice": number, "discountPercent": number, "gstRate": number } ]
       - "replaceItems": boolean (true if user asked to "make a new invoice", false if adding/modifying existing)
       - "isInterState": boolean
       - "notes": string
       - "additionalCharges": number
       - "amountPaid": number

CURRENT INVOICE STATE:
${JSON.stringify(currentInvoice || {}, null, 2)}
`;

    const response = await aiClient.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\nUSER INSTRUCTION: "${message}"\n\nReturn ONLY raw JSON with keys assistantResponse, followUpQuestion, and updates.` }],
        },
      ],
      config: {
        responseMimeType: 'application/json',
      },
    });

    const responseText = response.text || '{}';
    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch {
      // Clean possible markdown code fences
      const cleaned = responseText.replace(/```(?:json)?/g, '').trim();
      parsedResult = JSON.parse(cleaned);
    }

    return res.json({
      assistantResponse: parsedResult.assistantResponse || 'Invoice updated.',
      followUpQuestion: parsedResult.followUpQuestion || '',
      updates: parsedResult.updates || {},
      source: 'gemini_api',
    });
  } catch (error: any) {
    console.error('Error in /api/ai/parse-invoice:', error);
    // Graceful fallback to rule parser so user journey never fails
    const fallback = ruleBasedParse(req.body.message || '', req.body.currentInvoice);
    return res.json({
      assistantResponse: fallback.explanation,
      updates: fallback.updates,
      source: 'rule_parser_fallback',
      warning: 'Gemini API call encountered an error; processed with local rule parser.',
    });
  }
});

// API: Health / config check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY' && apiKey.trim().length > 0),
    time: new Date().toISOString(),
  });
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
