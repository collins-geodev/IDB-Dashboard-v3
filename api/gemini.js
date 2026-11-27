// Vercel serverless function: proxies AI Data Assistant questions to the
// Google Gemini API. The API key lives ONLY in the GEMINI_API_KEY environment
// variable (Vercel > Project Settings > Environment Variables) — it is never
// shipped to the browser. The frontend sends the question plus a compact JSON
// summary of the (already filtered) dataset; Gemini answers from that context
// only. Returns 503 when no key is configured so the frontend can fall back
// to its offline analytics engine.

const SYSTEM_PROMPT = `You are the AI Data Assistant inside "IDB Monitor", an asset-tracking
dashboard for an LT pole tagging project (Ikeja Electric, Shomolu Business Unit, Lagos).
Field officers from three vendor partners (Ikeja Electric, Jesom Technology, ETC Workforce)
tag LT poles, record the pole type and the buildings connected, and link building SLRNs.
Progress is measured against a BOQ (Bill of Quantities) target per feeder, with a velocity
target of 50 poles/day overall.

You receive a DASHBOARD CONTEXT JSON with the real, pre-computed numbers for the user's
current dashboard scope, then a QUESTION. Rules:
- Answer ONLY from the context numbers. Never invent figures, names, dates or trends that
  are not derivable from the context. If the context cannot answer the question, say so
  briefly and suggest what the user could ask instead.
- Be a sharp, practical analyst: lead with the direct answer, then 2-4 short supporting
  points or recommendations when useful. Think operations manager, not essay writer.
- The dataset has NO real pole-condition/defect/quality grading (every record is
  Status=COMPLETE; any issue fields are simulated placeholders). If asked about defects,
  condition or quality, say that condition data is not captured in this dataset and pivot
  to what IS known.
- The context may include "offlineEngineDraft": a plain-text draft computed by the
  dashboard's deterministic analytics engine for this exact question. When present,
  treat its figures as authoritative grounding — improve the wording, structure and
  insight, but keep its numbers.
- Format in simple markdown only: "### " section headers, "- " bullet lists, numbered
  lists, **bold** for key numbers and names. No tables, no code blocks, no links, no HTML.
- Keep it under ~200 words unless the user explicitly asks for a detailed report.`;

// Models tried in order. Measured 2026-11-27 from Vercel with this key:
// the lite models answer in under a second, while gemini-3.6-flash,
// 3.5-flash, 3.8-flash and flash-latest hung past 15s or returned 503
// "high demand", and gemini-2.5-flash is retired (404). GEMINI_MODEL, when
// set in Vercel, is tried first.
const DEFAULT_MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview'];
// Whole request must finish inside the dashboard's 25s client timeout.
const TOTAL_BUDGET_MS = 21000;
const PER_MODEL_MS = 12000;

async function callModel(model, key, payload, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
            encodeURIComponent(model) + ':generateContent', {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: payload,
        });
        if (!upstream.ok) {
            return { error: 'upstream_' + upstream.status, detail: (await upstream.text()).slice(0, 300) };
        }
        const data = await upstream.json();
        const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
        const answer = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
        return answer ? { answer } : { error: 'empty_answer' };
    } catch (e) {
        return { error: e && e.name === 'AbortError' ? 'upstream_timeout' : 'fetch_failed', detail: String(e && e.message || '') };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        res.status(503).json({ error: 'not_configured' });
        return;
    }

    const body = req.body || {};
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > 600) {
        res.status(400).json({ error: 'bad_question' });
        return;
    }
    let contextStr = '{}';
    try { contextStr = JSON.stringify(body.context || {}); } catch (e) { /* keep '{}' */ }
    if (contextStr.length > 80000) {
        res.status(400).json({ error: 'context_too_large' });
        return;
    }

    const payload = JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{
            role: 'user',
            parts: [{ text: 'DASHBOARD CONTEXT (JSON):\n' + contextStr + '\n\nQUESTION: ' + question }],
        }],
        // Roomy cap: newer models spend output tokens on internal reasoning
        // before the visible answer, so 1024 could come back empty.
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    });

    const models = [process.env.GEMINI_MODEL, ...DEFAULT_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
    const started = Date.now();
    let last = { error: 'no_model' };
    let lastModel = null;
    for (const model of models) {
        const left = TOTAL_BUDGET_MS - (Date.now() - started);
        if (left < 3000) break;
        const r = await callModel(model, key, payload, Math.min(PER_MODEL_MS, left));
        if (r.answer) {
            res.status(200).json({ answer: r.answer, model });
            return;
        }
        console.error('[gemini] ' + model + ' failed: ' + r.error, r.detail || '');
        last = r; lastModel = model;
        // A bad request will fail the same way on every model.
        if (r.error === 'upstream_400' || r.error === 'upstream_401' || r.error === 'upstream_403') break;
    }
    res.status(last.error === 'upstream_timeout' ? 504 : 502).json({ error: last.error, detail: last.detail, model: lastModel });
};
