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
- Format in simple markdown only: "### " section headers, "- " bullet lists, numbered
  lists, **bold** for key numbers and names. No tables, no code blocks, no links, no HTML.
- Keep it under ~200 words unless the user explicitly asks for a detailed report.`;

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

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent';

    try {
        const upstream = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: [{
                    role: 'user',
                    parts: [{ text: 'DASHBOARD CONTEXT (JSON):\n' + contextStr + '\n\nQUESTION: ' + question }],
                }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
            }),
        });
        if (!upstream.ok) {
            const detail = (await upstream.text()).slice(0, 300);
            res.status(502).json({ error: 'upstream_' + upstream.status, detail });
            return;
        }
        const data = await upstream.json();
        const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
        const answer = parts.map(p => p.text || '').join('').trim();
        if (!answer) {
            res.status(502).json({ error: 'empty_answer' });
            return;
        }
        res.status(200).json({ answer, model });
    } catch (e) {
        res.status(502).json({ error: 'fetch_failed' });
    }
};
