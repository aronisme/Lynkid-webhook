// netlify/functions/lynk-webhook.js
// ═══════════════════════════════════════════════════════════════════════════════
// Webhook Hub: Menerima webhook dari Lynk.id, menyimpan log,
// dan meneruskan (forward) ke proyek lain berdasarkan routing rules di Firestore.
// ═══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
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

// ─── VALIDASI SIGNATURE LYNK.ID ──────────────────────────────────────────────
// Signature Lynk.id (hasil reverse engineering):
// SHA256(amount + refId + messageId + merchantKey)
function validateLynkSignature(payload, signature, merchantKey) {
    try {
        const refId = payload?.data?.message_data?.refId || '';
        const messageId = payload?.data?.message_id || '';
        const amountTypes = [
            payload?.data?.message_data?.totals?.totalPrice,
            payload?.data?.message_data?.totals?.grandTotal,
            payload?.data?.message_data?.totals?.customerPay
        ];

        for (const amt of amountTypes) {
            if (amt !== undefined) {
                const dataToSign = `${amt}${refId}${messageId}${merchantKey}`;
                const computed = crypto.createHash('sha256').update(dataToSign).digest('hex');
                if (computed === signature) return true;
            }
        }
        return false;
    } catch (e) {
        console.error('[Webhook Hub] Signature validation error:', e);
        return false;
    }
}

// ─── FORWARD WEBHOOK KE URL TUJUAN ──────────────────────────────────────────
async function forwardWebhook(rule, payload) {
    const startTime = Date.now();
    try {
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'LynkidWebhookHub/1.0',
            'X-Webhook-Source': 'lynkid-hub',
            ...(rule.headers || {})
        };

        const response = await fetch(rule.destinationUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000) // 15 detik timeout
        });

        const responseText = await response.text().catch(() => '');

        return {
            ruleName: rule.name,
            ruleId: rule.id,
            destinationUrl: rule.destinationUrl,
            httpStatus: response.status,
            responseBody: responseText.substring(0, 500), // Batasi 500 char
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

// ─── BUILT-IN HANDLER: UPDATE isPremium (LOGIKA ASLI) ────────────────────────
async function handlePremiumUpgrade(db, payload) {
    const customerEmail = payload?.data?.message_data?.customer?.email;
    if (!customerEmail) {
        console.log('[Webhook Hub] Tidak ada email customer, skip premium upgrade.');
        return { action: 'premium_upgrade', skipped: true, reason: 'no_email' };
    }

    const normalizedEmail = customerEmail.toLowerCase().trim();
    console.log(`[Webhook Hub] Upgrade premium untuk: ${normalizedEmail}`);

    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('email', '==', normalizedEmail).get();

    if (snapshot.empty) {
        console.warn(`[Webhook Hub] User '${normalizedEmail}' tidak ditemukan.`);
        return { action: 'premium_upgrade', skipped: true, reason: 'user_not_found', email: normalizedEmail };
    }

    const batch = db.batch();
    snapshot.forEach((doc) => {
        batch.update(doc.ref, {
            isPremium: true,
            upgradedAt: new Date().toISOString(),
            lynkRefId: payload?.data?.message_data?.refId || null
        });
    });
    await batch.commit();

    console.log(`[Webhook Hub] ✅ User '${normalizedEmail}' upgraded to Premium!`);
    return { action: 'premium_upgrade', success: true, email: normalizedEmail };
}

// ─── HANDLER UTAMA ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(), body: '' };
    }

    // Hanya terima POST
    if (event.httpMethod !== 'POST') {
        return respond(405, { error: 'Method Not Allowed' });
    }

    const MERCHANT_KEY = process.env.LYNK_MERCHANT_KEY;
    if (!MERCHANT_KEY) {
        console.error('[Webhook Hub] LYNK_MERCHANT_KEY tidak dikonfigurasi!');
        return respond(500, { error: 'Server misconfiguration' });
    }

    // Parse payload
    let payload;
    try {
        payload = JSON.parse(event.body);
    } catch (e) {
        return respond(400, { error: 'Invalid JSON body' });
    }

    console.log('[Webhook Hub] Payload diterima:', JSON.stringify(payload).substring(0, 500));

    // Validasi signature
    const signature = event.headers['x-lynk-signature'] || event.headers['X-Lynk-Signature'];
    if (!signature) {
        console.warn('[Webhook Hub] Tidak ada X-Lynk-Signature header.');
        return respond(401, { error: 'Missing signature' });
    }

    if (!validateLynkSignature(payload, signature, MERCHANT_KEY)) {
        console.warn(`[Webhook Hub] Signature mismatch. Received: ${signature}`);
        return respond(403, { error: 'Invalid signature' });
    }

    console.log('[Webhook Hub] ✅ Signature valid.');

    // Cek status transaksi
    const status = payload?.data?.message_action;
    const eventName = payload?.event;
    if (status !== 'SUCCESS' || eventName !== 'payment.received') {
        console.log(`[Webhook Hub] Event bukan sukses pembayaran (${eventName} / ${status}). Diabaikan.`);
        return respond(200, { message: 'Non-success event ignored.' });
    }

    // ── Mulai proses forwarding ──────────────────────────────────────────────
    const db = getFirestoreDb();

    // Ambil semua product UUID dari payload
    const items = payload?.data?.message_data?.items || [];
    const productIds = items.map(item => item.uuid).filter(Boolean);
    const customerEmail = payload?.data?.message_data?.customer?.email || '';
    const refId = payload?.data?.message_data?.refId || '';

    // Buat log entry awal
    const logRef = db.collection('webhook_logs').doc();
    const logEntry = {
        rawPayload: payload,
        lynkRefId: refId,
        customerEmail: customerEmail.toLowerCase().trim(),
        productIds,
        productNames: items.map(item => item.title).filter(Boolean),
        status: 'PROCESSING',
        forwards: [],
        builtInResults: [],
        createdAt: FieldValue.serverTimestamp(),
        createdAtISO: new Date().toISOString()
    };
    await logRef.set(logEntry);

    // ── 1. Built-in handler: Premium upgrade (logika asli) ───────────────────
    let premiumResult;
    try {
        premiumResult = await handlePremiumUpgrade(db, payload);
    } catch (error) {
        premiumResult = { action: 'premium_upgrade', success: false, error: error.message };
        console.error('[Webhook Hub] Premium upgrade error:', error);
    }

    // ── 2. Cari routing rules yang cocok ─────────────────────────────────────
    let matchedRules = [];
    try {
        const rulesSnapshot = await db.collection('routing_rules')
            .where('isActive', '==', true)
            .get();

        rulesSnapshot.forEach(doc => {
            const rule = { id: doc.id, ...doc.data() };
            // Cocokkan: rule tanpa productId = match semua (catch-all)
            // rule dengan productId = match jika productId ada di payload
            if (!rule.productId || rule.productId === '' || productIds.includes(rule.productId)) {
                matchedRules.push(rule);
            }
        });
    } catch (error) {
        console.error('[Webhook Hub] Error fetching routing rules:', error);
    }

    console.log(`[Webhook Hub] ${matchedRules.length} rules cocok untuk ${productIds.length} produk.`);

    // ── 3. Forward webhook ke semua URL tujuan secara paralel ─────────────────
    let forwardResults = [];
    if (matchedRules.length > 0) {
        const forwardPromises = matchedRules.map(rule => forwardWebhook(rule, payload));
        forwardResults = await Promise.allSettled(forwardPromises);
        forwardResults = forwardResults.map(r => r.status === 'fulfilled' ? r.value : {
            success: false,
            errorMessage: r.reason?.message || 'Promise rejected'
        });
    }

    // ── 4. Update log dengan hasil akhir ─────────────────────────────────────
    const allSuccess = forwardResults.every(r => r.success);
    const anyForward = forwardResults.length > 0;
    const finalStatus = !anyForward ? 'NO_RULES' : allSuccess ? 'SUCCESS' : 'PARTIAL_FAIL';

    await logRef.update({
        forwards: forwardResults,
        builtInResults: [premiumResult],
        status: finalStatus,
        completedAt: FieldValue.serverTimestamp(),
        completedAtISO: new Date().toISOString()
    });

    console.log(`[Webhook Hub] Selesai. Status: ${finalStatus}, Forward: ${forwardResults.length} destinations.`);

    return respond(200, {
        success: true,
        status: finalStatus,
        forwardsCount: forwardResults.length,
        logId: logRef.id
    });
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Lynk-Signature',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };
}

function respond(statusCode, body) {
    return {
        statusCode,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}
