const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');
const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SERVER_API_KEY = process.env.MODELVERSE_API_KEY || 'PCB0tVVbpBTVCYhf6f7eB3A9-dAeE-4c84-9BeE-D58f7dC9';

// ── Extract embedded images from xlsx buffer ─────────────────────────────────
// Returns: { [rowIndex]: base64DataUrl }  (rowIndex is 0-based, matching sheet_to_json rows)
function extractEmbeddedImages(buffer) {
  const rowImageMap = {};
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().map(e => e.entryName);

    // Find drawing xml files (typically xl/drawings/drawing1.xml)
    const drawingFiles = entries.filter(e => e.match(/xl\/drawings\/drawing\d+\.xml$/));
    if (!drawingFiles.length) return rowImageMap;

    for (const drawingPath of drawingFiles) {
      // Get the corresponding rels file
      const parts = drawingPath.split('/');
      const fname = parts[parts.length - 1];
      const relsPath = parts.slice(0, -1).join('/') + '/_rels/' + fname + '.rels';

      const drawingXml = zip.readAsText(drawingPath);
      const relsXml = zip.readAsText(relsPath);
      if (!drawingXml || !relsXml) continue;

      // Parse rels: rId → image path
      const relsDoc = new DOMParser().parseFromString(relsXml, 'text/xml');
      const relNodes = relsDoc.getElementsByTagName('Relationship');
      const ridToPath = {};
      for (let i = 0; i < relNodes.length; i++) {
        const n = relNodes[i];
        const id = n.getAttribute('Id');
        const target = n.getAttribute('Target'); // e.g. ../media/image1.png
        if (id && target) {
          // Resolve relative to xl/drawings/ → xl/media/imageN.png
          const resolvedPath = path.posix.normalize('xl/drawings/' + target).replace(/^\//,'');
          ridToPath[id] = resolvedPath;
        }
      }

      // Parse drawing: each anchor (oneCellAnchor or twoCellAnchor) → from.row + rId
      const drawDoc = new DOMParser().parseFromString(drawingXml, 'text/xml');
      // Support both twoCellAnchor and oneCellAnchor, with or without namespace prefix
      function getElsByLocalName(doc, localName) {
        const results = [];
        const all = doc.getElementsByTagName('*');
        for (let k = 0; k < all.length; k++) {
          const tag = all[k].tagName || '';
          if (tag === localName || tag.endsWith(':' + localName)) results.push(all[k]);
        }
        return results;
      }
      const anchors = [
        ...getElsByLocalName(drawDoc, 'twoCellAnchor'),
        ...getElsByLocalName(drawDoc, 'oneCellAnchor'),
      ];
      console.log(`[extractImages] drawing=${drawingPath} anchors=${anchors.length} ridMap=${JSON.stringify(ridToPath)}`);
      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const fromEls = getElsByLocalName(anchor, 'from');
        if (!fromEls.length) { console.log('[extractImages] anchor has no from'); continue; }
        const rowEl = getElsByLocalName(fromEls[0], 'row');
        if (!rowEl.length) { console.log('[extractImages] from has no row'); continue; }
        const rowNum = parseInt(rowEl[0].textContent, 10); // 0-based row in sheet (0 = header row)

        const blipEls = getElsByLocalName(anchor, 'blip');
        if (!blipEls.length) { console.log('[extractImages] anchor has no blip'); continue; }
        // try both r:embed and embed attributes
        const rId = blipEls[0].getAttribute('r:embed') || blipEls[0].getAttribute('embed') || blipEls[0].getAttribute('r:link');
        console.log(`[extractImages] rowNum=${rowNum} rId=${rId} resolved=${ridToPath[rId]}`);
        if (!rId || !ridToPath[rId]) continue;

        const imgPath = ridToPath[rId];
        const imgEntry = zip.getEntry(imgPath);
        if (!imgEntry) continue;

        const imgBuf = imgEntry.getData();
        const ext = imgPath.split('.').pop().toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/png';
        const b64 = imgBuf.toString('base64');
        const dataUrl = `data:${mime};base64,${b64}`;

        // rowNum in drawing is 0-based sheet row; row 0 = header, row 1 = first data row (index 0)
        const dataRowIndex = rowNum - 1; // convert to 0-based data row
        if (dataRowIndex >= 0) {
          if (!rowImageMap[dataRowIndex]) {
            rowImageMap[dataRowIndex] = { ref: dataUrl };
          } else if (!rowImageMap[dataRowIndex].pattern) {
            // Second image in same row = pattern/design image
            rowImageMap[dataRowIndex].pattern = dataUrl;
          }
        }
      }
    }
  } catch (e) {
    console.error('extractEmbeddedImages error:', e.message);
  }

  // ── Fallback: if XML parsing yielded nothing, map media files by sort order ──
  if (Object.keys(rowImageMap).length === 0) {
    console.log('[extractImages] XML parse yielded 0 images - trying media fallback');
    try {
      const zip2 = new AdmZip(buffer);
      const mediaEntries = zip2.getEntries()
        .filter(e => e.entryName.match(/xl\/media\//i) && e.entryName.match(/\.(png|jpe?g|gif|webp)$/i))
        .sort((a, b) => a.entryName.localeCompare(b.entryName));
      console.log('[extractImages] media files found:', mediaEntries.map(e => e.entryName));
      mediaEntries.forEach((entry, idx) => {
        const imgBuf = entry.getData();
        const ext = entry.entryName.split('.').pop().toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/webp';
        const dataUrl = `data:${mime};base64,${imgBuf.toString('base64')}`;
        rowImageMap[idx] = { ref: dataUrl };
        console.log(`[extractImages] fallback: media[${idx}] => ${entry.entryName} (${imgBuf.length} bytes)`);
      });
    } catch (e2) {
      console.error('extractEmbeddedImages fallback error:', e2.message);
    }
  }

  console.log('[extractImages] final rowImageMap keys:', Object.keys(rowImageMap));
  return rowImageMap;
}

// ── Parse Excel ──────────────────────────────────────────────────────────────
app.post('/api/parse-excel', upload.single('file'), (req, res) => {
  try {
    const buf = req.file.buffer;
    const workbook = XLSX.read(buf, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    // Extract embedded images and attach to rows
    const rowImageMap = extractEmbeddedImages(buf);
    data.forEach((row, i) => {
      const entry = rowImageMap[i];
      if (entry) {
        // entry is { ref: dataUrl, pattern?: dataUrl }
        row['__embeddedImage__'] = entry.ref || null;       // primary reference image
        row['__patternImage__'] = entry.pattern || null;   // secondary pattern/design image
      }
    });

    res.json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ── Proxy external image as base64 (for reference images & inserted images) ──
app.post('/api/fetch-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'No URL' });
  try {
    const b64 = await fetchImageAsBase64(url);
    res.json({ success: true, data: b64 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Generate image (with optional reference image) ───────────────────────────
app.post('/api/generate-image', async (req, res) => {
  const { prompt, apiKey, referenceImageB64, insertedImageB64 } = req.body;
  const effectiveKey = (apiKey && apiKey.trim()) ? apiKey.trim() : SERVER_API_KEY;
  try {
    const result = await callModelverse(effectiveKey, prompt, referenceImageB64, insertedImageB64);
    res.json({ success: true, imageUrl: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Edit generated image (Qwen Image Edit) ──────────────────────────────────
app.post('/api/edit-image', async (req, res) => {
  const { imageB64, instruction, apiKey } = req.body;
  const effectiveKey = (apiKey && apiKey.trim()) ? apiKey.trim() : SERVER_API_KEY;
  if (!imageB64 || !instruction) return res.status(400).json({ success: false, error: 'Missing imageB64 or instruction' });
  try {
    const result = await callImageEdit(effectiveKey, imageB64, instruction);
    res.json({ success: true, imageUrl: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Generate variant (similar or creative) ────────────────────────────────────
app.post('/api/generate-variant', async (req, res) => {
  const { copywriting, theme, hasReferenceImg, referenceImageB64, insertedImageB64, customPrompt, variantType, variantIndex, apiKey } = req.body;
  const effectiveKey = (apiKey && apiKey.trim()) ? apiKey.trim() : SERVER_API_KEY;

  try {
    // Build prompt - pass reference/inserted image for style hints
    const styleHintImg = insertedImageB64 || referenceImageB64;
    const prompt = buildVariantPrompt(copywriting, theme, hasReferenceImg, styleHintImg, variantType, variantIndex);

    // If custom prompt set and creative type, use custom prompt
    const finalPrompt = (variantType === 'creative' && customPrompt) ? customPrompt : prompt;

    // Pass referenceImageB64 as primary reference; insertedImageB64 as secondary overlay hint
    const result = await callModelverse(effectiveKey, finalPrompt, referenceImageB64, insertedImageB64);
    res.json({ success: true, imageUrl: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Swap element by click position ────────────────────────────────────────────
app.post('/api/swap-element', async (req, res) => {
  const { imageB64, clickX, clickY, apiKey } = req.body;
  const effectiveKey = (apiKey && apiKey.trim()) ? apiKey.trim() : SERVER_API_KEY;
  if (!imageB64 || clickX == null || clickY == null) {
    return res.status(400).json({ success: false, error: 'Missing imageB64 or click coordinates' });
  }
  try {
    const prompt = `This is a sticker image. The user clicked at approximately (${Math.round(clickX * 100)}%, ${Math.round(clickY * 100)}%) of the image (measured from top-left corner).

Please:
1. Identify what visual element is located at that click position (e.g. "rose", "lemon", "branch")
2. Replace ALL instances of that same element with a different variety or species of the same category — for example: rose -> daisy or sunflower, lemon -> lime or orange slice, cherry -> strawberry. The new element must have a clearly different silhouette and shape so the swap is obvious at a glance.
3. IMPORTANT: Keep the exact same color palette — do not change any colors. Only the shape/illustration of the element changes.
4. Keep everything else completely unchanged: layout, text, other decorative elements, background, composition, illustration style.

Return the modified image.`;

    const result = await callImageEdit(effectiveKey, imageB64, prompt);
    res.json({ success: true, imageUrl: result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Identify fonts in sticker image ────────────────────────────────────────────────────
app.post('/api/identify-font', async (req, res) => {
  const { imageB64, apiKey } = req.body;
  const effectiveKey = (apiKey && apiKey.trim()) ? apiKey.trim() : SERVER_API_KEY;
  try {
    const result = await callVisionText(effectiveKey, imageB64,
      'Look at the text in this sticker image. Identify the font(s) used. Reply ONLY in this format: "Font: [font name(s)]". If multiple fonts, separate with commas. If unsure, suggest the closest known font family.');
    // Extract the font name from the reply
    const match = result.match(/Font:\s*(.+)/i);
    const fonts = match ? match[1].trim() : result.trim();
    res.json({ success: true, fonts });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Build prompt (now reference image drives style description) ───────────────
app.post('/api/generate-prompt', (req, res) => {
  const { copywriting, theme, hasReferenceImg, insertedImageDesc } = req.body;
  const prompt = buildPrompt(copywriting, theme, hasReferenceImg, insertedImageDesc);
  res.json({ success: true, prompt });
});

// ── Refine prompt via LLM ────────────────────────────────────────────────────
app.post('/api/refine-prompt', async (req, res) => {
  const { currentPrompt, userInstruction, apiKey } = req.body;
  const effectiveKey = (apiKey && apiKey.trim()) ? apiKey.trim() : SERVER_API_KEY;
  const systemMsg = `You are an expert image generation prompt engineer for sticker design.
Rewrite the given prompt incorporating the user's modification requirements.
Keep core structure: circular sticker, 5x5cm, party celebration, illustration fills 100% of the circle edge-to-edge with zero white margins, theme-appropriate background color and accents, cute flat cartoon illustration style.
Never include hands, fingers, people, or body parts. Never include outer ribbon rosette or badge frame.
Return ONLY the revised prompt, no explanations.`;
  const userMsg = `Current prompt:\n${currentPrompt}\n\nUser request:\n${userInstruction}\n\nRevised prompt:`;
  try {
    const result = await callTextLLM(effectiveKey, systemMsg, userMsg);
    res.json({ success: true, refinedPrompt: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Search images via Unsplash ────────────────────────────────────────────────
// Using public source.unsplash.com (no key needed for basic search)
app.get('/api/search-images', async (req, res) => {
  const q = req.query.q || 'flower';
  try {
    // Use Unsplash source API - returns list of images
    const results = await searchUnsplash(q);
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, results: [] });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrompt(copywriting, theme, hasReferenceImg, insertedImageDesc) {
  return buildVariantPrompt(copywriting, theme, hasReferenceImg, insertedImageDesc, 'similar', 0);
}

function buildVariantPrompt(copywriting, theme, hasReferenceImg, insertedImageB64, variantType, variantIndex) {
  const textLine = copywriting
    ? `Text on the sticker: "${copywriting}". Do NOT change, add, or remove any words.`
    : 'No text on this sticker.';

  const themeLine = theme ? `Theme/motif: ${theme}.` : '';

  const printQuality = 'This is a COMMERCIAL PRODUCT sticker for mass printing and retail sale. It must look clean, professional, and visually appealing like something you would see on a premium product in a store. Not cluttered, not messy.';

  const circleRule = 'The circular sticker must fill the ENTIRE square canvas from edge to edge, the circle diameter equals the canvas width. The four corners show transparent background. No padding, no margin.';

  // 第5张随机抽风格
  const creativeStyles = [
    'Japanese kawaii style: soft rounded shapes, cute proportions, pastel-friendly, charming and sweet aesthetic',
    'Pop art style: bold black outlines, flat graphic color blocks, strong contrast, graphic and punchy',
    'Watercolor hand-painted style: soft edges, painterly brushstrokes, gentle color bleeds, organic and artistic feel',
    'Cartoon style: clean expressive linework, bold shapes, slightly exaggerated proportions, fun and lively'
  ];
  const pickedStyle = creativeStyles[Math.floor(Math.random() * creativeStyles.length)];

  const variantStrategies = [
    {
      label: 'Faithful Similar A',
      hint: 'Stay very close to the reference style. Reproduce the same illustration technique, color palette, and composition feel. Only minor variation in element arrangement.'
    },
    {
      label: 'Faithful Similar B',
      hint: 'Stay very close to the reference style. Keep the same color palette and illustration approach. Slightly vary the sizes or positions of decorative motifs compared to variant A.'
    },
    {
      label: 'Subtle Variation',
      hint: 'Keep the same illustration style but apply subtle variation: shift the color tones slightly warmer or cooler, adjust element details and textures. Should feel like a fresh alternative from the same design family.'
    },
    {
      label: 'New Color & Pattern Scheme',
      hint: 'Use a completely different color palette (e.g. if original is warm yellow/green, switch to cool blue/purple or bold red/orange). Redesign the decorative pattern arrangement to match the new palette. The theme and text stay the same but the visual mood should feel distinctly different.'
    },
    {
      label: 'Creative Style Exploration',
      hint: `Reimagine the sticker in this specific style: ${pickedStyle}. Keep the same theme and text, but fully commit to this new visual style. The result should feel like a genuinely different design direction, not just a color swap.`
    }
  ];

  const strategy = variantStrategies[variantIndex] || variantStrategies[0];

  if (hasReferenceImg || (insertedImageB64 && insertedImageB64.length > 100)) {
    return `Look at the reference image. Create a circular sticker based on it.\n\n${themeLine}\n${textLine}\n\nVariant direction: ${strategy.hint}\n\n${printQuality}\n${circleRule}\nDo not add any text other than what is specified above. Do not include human hands or body parts.\n\n[Variant ${variantIndex + 1} of 5 -- ${strategy.label}]`;
  }

  return `Create a circular sticker design (5x5cm).\n\n${themeLine}\n${textLine}\n\nVariant direction: ${strategy.hint}\n\n${printQuality}\n${circleRule}\n- Do not add any text other than specified above\n- Do not include human hands or body parts\n\n[Variant ${variantIndex + 1} of 5 -- ${strategy.label}]`;
}
}
async function callImageEdit(apiKey, imageB64, instruction) {
  // Use Gemini 3 Pro via chat/completions (same as callModelverse)
  return callModelverse(apiKey, instruction, imageB64, null);
}

async function callModelverse(apiKey, prompt, referenceImageB64, insertedImageB64) {
  return new Promise((resolve, reject) => {
    // Build content array - include images if provided
    let content;

    // Check if any image is provided
    const hasRefImage = referenceImageB64 && referenceImageB64.length > 100;
    const hasInsImage = insertedImageB64 && insertedImageB64.length > 100;

    if (hasRefImage || hasInsImage) {
      content = [];
      content.push({ type: 'text', text: prompt });
      if (hasRefImage) {
        const mime = referenceImageB64.startsWith('data:')
          ? referenceImageB64.split(';')[0].split(':')[1]
          : 'image/jpeg';
        const b64data = referenceImageB64.startsWith('data:')
          ? referenceImageB64.split(',')[1]
          : referenceImageB64;
        content.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${b64data}` }
        });
      }
      if (hasInsImage) {
        const mime2 = insertedImageB64.startsWith('data:')
          ? insertedImageB64.split(';')[0].split(':')[1]
          : 'image/jpeg';
        const b64data2 = insertedImageB64.startsWith('data:')
          ? insertedImageB64.split(',')[1]
          : insertedImageB64;
        content.push({
          type: 'image_url',
          image_url: { url: `data:${mime2};base64,${b64data2}` }
        });
      }
    } else {
      content = prompt;
    }

    const body = JSON.stringify({
      model: 'gemini-3-pro-image-preview',
      messages: [{ role: 'user', content }],
      response_modalities: ['TEXT', 'IMAGE']
    });

    const options = {
      hostname: 'api.modelverse.cn',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    let data = '';
    const req = https.request(options, (response) => {
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (typeof content === 'string') {
            const mdMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^)]+)\)/);
            if (mdMatch) { resolve(mdMatch[1]); return; }
            const dataUriMatch = content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
            if (dataUriMatch) { resolve(dataUriMatch[1]); return; }
            if (/^[A-Za-z0-9+/=]{100,}$/.test(content.trim())) {
              resolve('data:image/jpeg;base64,' + content.trim()); return;
            }
          }
          if (Array.isArray(content)) {
            const imgPart = content.find(p => p.type === 'image_url' || p.type === 'image');
            if (imgPart) { resolve(imgPart.image_url?.url || imgPart.url || imgPart.data); return; }
          }
          reject(new Error('No image in response: ' + JSON.stringify(json).slice(0, 300)));
        } catch (e) {
          reject(new Error('Parse error: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Vision model returning TEXT (not image) — used for font identification etc.
async function callVisionText(apiKey, imageB64, prompt) {
  return new Promise((resolve, reject) => {
    const mime = imageB64.startsWith('data:') ? imageB64.split(';')[0].split(':')[1] : 'image/jpeg';
    const b64data = imageB64.startsWith('data:') ? imageB64.split(',')[1] : imageB64;
    const body = JSON.stringify({
      model: 'gemini-3.1-flash-lite-preview',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64data}` } }
      ]}]
    });
    const options = {
      hostname: 'api.modelverse.cn', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) }
    };
    let data = '';
    const req = https.request(options, (response) => {
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (content) { resolve(typeof content === 'string' ? content.trim() : JSON.stringify(content)); return; }
          reject(new Error('No text: ' + data.slice(0, 200)));
        } catch (e) { reject(new Error('Parse: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callTextLLM(apiKey, systemMsg, userMsg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gemini-3.1-flash-lite-preview',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg }
      ]
    });
    const options = {
      hostname: 'api.modelverse.cn', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) }
    };
    let data = '';
    const req = https.request(options, (response) => {
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (content) { resolve(content.trim()); return; }
          reject(new Error('No text: ' + data.slice(0, 200)));
        } catch (e) { reject(new Error('Parse: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function fetchImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const options = { headers: { 'User-Agent': 'Mozilla/5.0' } };
    protocol.get(url, options, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchImageAsBase64(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const mime = res.headers['content-type'] || 'image/jpeg';
        resolve(`data:${mime};base64,${buf.toString('base64')}`);
      });
    }).on('error', reject);
  });
}

async function searchUnsplash(query) {
  // Use Unsplash public search - returns curated results
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(query);
    const url = `https://unsplash.com/napi/search/photos?query=${q}&per_page=12&orientation=squarish`;
    const options = {
      hostname: 'unsplash.com',
      path: `/napi/search/photos?query=${q}&per_page=12&orientation=squarish`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://unsplash.com/'
      }
    };
    let data = '';
    const req = https.request(options, (res) => {
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.results || []).map(p => ({
            id: p.id,
            thumb: p.urls?.thumb || p.urls?.small,
            small: p.urls?.small,
            full: p.urls?.regular,
            alt: p.alt_description || p.description || query,
            author: p.user?.name
          })).filter(r => r.thumb);
          resolve(results);
        } catch (e) {
          // Fallback: empty
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

const PORT = process.env.PORT || 7788;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sticker Generator running on http://0.0.0.0:${PORT}`);
});
