// netlify/functions/api-admin.js
// ═══════════════════════════════════════════════════════════════════════════════
// Admin API: CRUD untuk routing rules, membaca webhook logs, dan resend webhook.
// Dilindungi oleh ADMIN_PASSWORD dari environment variable.
// ═══════════════════════════════════════════════════════════════════════════════

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ─── INISIALISASI FIREBASE ADMIN (Singleton) ─────────────────────────────────
function getFirestoreDb() {
    if (getApps().length === 0) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(serviceAccount) });
    }
    return getFirestore();
}

// ─── AUTENTIKASI ──────────────────────────────────────────────────────────────
function authenticate(event) {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
        console.error('[API Admin] ADMIN_PASSWORD not configured!');
        return false;
    }
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    return token === adminPassword;
}

// ─── HANDLER UTAMA ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(), body: '' };
    }

    // Autentikasi
    if (!authenticate(event)) {
        return respond(401, { error: 'Unauthorized. Invalid or missing admin password.' });
    }

    const params = event.queryStringParameters || {};
    const action = params.action;
    const method = event.httpMethod;

    try {
        const db = getFirestoreDb();

        switch (action) {
            // ═══ ROUTING RULES ═══════════════════════════════════════════════
            case 'getRules':
                return await getRules(db);

            case 'createRule':
                if (method !== 'POST') return respond(405, { error: 'POST required' });
                return await createRule(db, JSON.parse(event.body));

            case 'updateRule':
                if (method !== 'PUT' && method !== 'POST') return respond(405, { error: 'PUT/POST required' });
                return await updateRule(db, JSON.parse(event.body));

            case 'deleteRule':
                if (method !== 'DELETE' && method !== 'POST') return respond(405, { error: 'DELETE/POST required' });
                return await deleteRule(db, JSON.parse(event.body));

            case 'toggleRule':
                if (method !== 'POST') return respond(405, { error: 'POST required' });
                return await toggleRule(db, JSON.parse(event.body));

            // ═══ WEBHOOK LOGS ════════════════════════════════════════════════
            case 'getLogs':
                return await getLogs(db, params);

            case 'getLog':
                return await getLog(db, params);

            case 'resend':
                if (method !== 'POST') return respond(405, { error: 'POST required' });
                return await resendWebhook(db, JSON.parse(event.body));

            // ═══ DASHBOARD STATS ═════════════════════════════════════════════
            case 'getStats':
                return await getStats(db);

            // ═══ AUTH CHECK ══════════════════════════════════════════════════
            case 'checkAuth':
                return respond(200, { authenticated: true });

            default:
                return respond(400, { error: `Unknown action: ${action}` });
        }
    } catch (error) {
        console.error(`[API Admin] Error in action '${action}':`, error);
        return respond(500, { error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING RULES HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getRules(db) {
    const snapshot = await db.collection('routing_rules')
        .orderBy('createdAt', 'desc')
        .get();

    const rules = [];
    snapshot.forEach(doc => rules.push({ id: doc.id, ...doc.data() }));
    return respond(200, { rules });
}

async function createRule(db, body) {
    const { name, productId, destinationUrl, headers, description } = body;

    if (!name || !destinationUrl) {
        return respond(400, { error: 'name and destinationUrl are required' });
    }

    // Validasi URL
    try { new URL(destinationUrl); } catch {
        return respond(400, { error: 'Invalid destinationUrl' });
    }

    const rule = {
        name: name.trim(),
        productId: (productId || '').trim(),
        destinationUrl: destinationUrl.trim(),
        headers: headers || {},
        description: (description || '').trim(),
        isActive: true,
        createdAt: FieldValue.serverTimestamp(),
        createdAtISO: new Date().toISOString(),
        updatedAt: FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('routing_rules').add(rule);
    return respond(201, { id: docRef.id, ...rule });
}

async function updateRule(db, body) {
    const { id, name, productId, destinationUrl, headers, description } = body;

    if (!id) return respond(400, { error: 'id is required' });

    const updateData = { updatedAt: FieldValue.serverTimestamp() };
    if (name !== undefined) updateData.name = name.trim();
    if (productId !== undefined) updateData.productId = productId.trim();
    if (destinationUrl !== undefined) {
        try { new URL(destinationUrl); } catch {
            return respond(400, { error: 'Invalid destinationUrl' });
        }
        updateData.destinationUrl = destinationUrl.trim();
    }
    if (headers !== undefined) updateData.headers = headers;
    if (description !== undefined) updateData.description = description.trim();

    await db.collection('routing_rules').doc(id).update(updateData);
    return respond(200, { id, ...updateData });
}

async function deleteRule(db, body) {
    const { id } = body;
    if (!id) return respond(400, { error: 'id is required' });

    await db.collection('routing_rules').doc(id).delete();
    return respond(200, { deleted: true, id });
}

async function toggleRule(db, body) {
    const { id, isActive } = body;
    if (!id || isActive === undefined) {
        return respond(400, { error: 'id and isActive are required' });
    }

    await db.collection('routing_rules').doc(id).update({
        isActive: Boolean(isActive),
        updatedAt: FieldValue.serverTimestamp()
    });

    return respond(200, { id, isActive: Boolean(isActive) });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK LOGS HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getLogs(db, params) {
    const limit = Math.min(parseInt(params.limit) || 50, 100);
    const statusFilter = params.status || 'ALL';

    let query = db.collection('webhook_logs')
        .orderBy('createdAt', 'desc')
        .limit(limit);

    if (statusFilter !== 'ALL') {
        query = db.collection('webhook_logs')
            .where('status', '==', statusFilter)
            .orderBy('createdAt', 'desc')
            .limit(limit);
    }

    const snapshot = await query.get();
    const logs = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        // Ringkasan saja, tanpa rawPayload untuk performa
        logs.push({
            id: doc.id,
            lynkRefId: data.lynkRefId,
            customerEmail: data.customerEmail,
            productNames: data.productNames || [],
            productIds: data.productIds || [],
            status: data.status,
            forwardsCount: (data.forwards || []).length,
            forwardsSuccess: (data.forwards || []).filter(f => f.success).length,
            createdAtISO: data.createdAtISO,
            completedAtISO: data.completedAtISO
        });
    });

    return respond(200, { logs, count: logs.length });
}

async function getLog(db, params) {
    const { id } = params;
    if (!id) return respond(400, { error: 'id parameter required' });

    const doc = await db.collection('webhook_logs').doc(id).get();
    if (!doc.exists) return respond(404, { error: 'Log not found' });

    return respond(200, { log: { id: doc.id, ...doc.data() } });
}

async function resendWebhook(db, body) {
    const { logId, ruleId } = body;
    if (!logId) return respond(400, { error: 'logId is required' });

    // Ambil log asli
    const logDoc = await db.collection('webhook_logs').doc(logId).get();
    if (!logDoc.exists) return respond(404, { error: 'Log not found' });

    const logData = logDoc.data();
    const payload = logData.rawPayload;

    // Tentukan ke mana harus dikirim
    let rules = [];
    if (ruleId) {
        // Resend ke satu rule spesifik
        const ruleDoc = await db.collection('routing_rules').doc(ruleId).get();
        if (ruleDoc.exists) {
            rules.push({ id: ruleDoc.id, ...ruleDoc.data() });
        }
    } else {
        // Resend ke semua rule yang cocok
        const productIds = logData.productIds || [];
        const rulesSnapshot = await db.collection('routing_rules')
            .where('isActive', '==', true)
            .get();

        rulesSnapshot.forEach(doc => {
            const rule = { id: doc.id, ...doc.data() };
            if (!rule.productId || rule.productId === '' || productIds.includes(rule.productId)) {
                rules.push(rule);
            }
        });
    }

    if (rules.length === 0) {
        return respond(404, { error: 'No matching rules found for resend' });
    }

    // Forward
    const results = await Promise.allSettled(
        rules.map(rule => forwardWebhookFromAdmin(rule, payload))
    );

    const forwardResults = results.map(r =>
        r.status === 'fulfilled' ? r.value : { success: false, errorMessage: r.reason?.message }
    );

    // Update log
    const existingForwards = logData.forwards || [];
    const updatedForwards = [...existingForwards, ...forwardResults.map(f => ({ ...f, isResend: true }))];
    const allSuccess = updatedForwards.filter(f => !f.isResend || f.isResend).every(f => f.success);

    await logDoc.ref.update({
        forwards: updatedForwards,
        status: allSuccess ? 'SUCCESS' : 'PARTIAL_FAIL',
        lastResendAt: FieldValue.serverTimestamp(),
        lastResendAtISO: new Date().toISOString()
    });

    return respond(200, {
        success: true,
        resendResults: forwardResults,
        logId
    });
}

// ─── Forward helper (sama dengan di lynk-webhook.js) ─────────────────────────
async function forwardWebhookFromAdmin(rule, payload) {
    const startTime = Date.now();
    try {
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'LynkidWebhookHub/1.0',
            'X-Webhook-Source': 'lynkid-hub',
            'X-Webhook-Resend': 'true',
            ...(rule.headers || {})
        };

        const response = await fetch(rule.destinationUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000)
        });

        const responseText = await response.text().catch(() => '');

        return {
            ruleName: rule.name,
            ruleId: rule.id,
            destinationUrl: rule.destinationUrl,
            httpStatus: response.status,
            responseBody: responseText.substring(0, 500),
            success: response.ok,
            durationMs: Date.now() - startTime,
            sentAt: new Date().toISOString()
        };
    } catch (error) {
        return {
            ruleName: rule.name,
            ruleId: rule.id,
            destinationUrl: rule.destinationUrl,
            httpStatus: 0,
            responseBody: '',
            errorMessage: error.message || 'Unknown error',
            success: false,
            durationMs: Date.now() - startTime,
            sentAt: new Date().toISOString()
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════════════════════════════════

async function getStats(db) {
    // Jumlah rules
    const rulesSnapshot = await db.collection('routing_rules').get();
    const totalRules = rulesSnapshot.size;
    const activeRules = rulesSnapshot.docs.filter(d => d.data().isActive).length;

    // 50 log terakhir untuk statistik
    const logsSnapshot = await db.collection('webhook_logs')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();

    let totalLogs = logsSnapshot.size;
    let successCount = 0;
    let failCount = 0;
    let noRulesCount = 0;
    let lastWebhookAt = null;

    logsSnapshot.forEach((doc, idx) => {
        const data = doc.data();
        if (data.status === 'SUCCESS') successCount++;
        else if (data.status === 'PARTIAL_FAIL' || data.status === 'FAILED') failCount++;
        else if (data.status === 'NO_RULES') noRulesCount++;

        if (idx === 0) lastWebhookAt = data.createdAtISO;
    });

    return respond(200, {
        stats: {
            totalRules,
            activeRules,
            recentLogs: totalLogs,
            successCount,
            failCount,
            noRulesCount,
            lastWebhookAt
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    };
}

function respond(statusCode, body) {
    return {
        statusCode,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}
