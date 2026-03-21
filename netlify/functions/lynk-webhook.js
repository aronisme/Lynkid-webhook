// netlify/functions/lynk-webhook.js
// Backend serverless untuk menerima webhook dari Lynk.id
// dan mengupdate status premium user di Firestore.

const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ─── INISIALISASI FIREBASE ADMIN (Singleton) ─────────────────────────────────
function getFirestoreDb() {
    if (getApps().length === 0) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(serviceAccount) });
    }
    return getFirestore();
}

// ─── VALIDASI SIGNATURE LYNK.ID ──────────────────────────────────────────────
// Lynk.id menggunakan HMAC-SHA256 dengan format:
// signature = HMAC_SHA256(merchantKey, refId + amount + message_id)
function validateLynkSignature(payload, signature, merchantKey) {
    try {
        const { ref_id, amount, message_id } = payload;
        const dataToSign = `${ref_id}${amount}${message_id}`;
        const computedSig = crypto
            .createHmac('sha256', merchantKey)
            .update(dataToSign)
            .digest('hex');
        return computedSig === signature;
    } catch (e) {
        console.error('[Lynk Webhook] Signature validation error:', e);
        return false;
    }
}

// ─── HANDLER UTAMA ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
    // Hanya terima metode POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    const MERCHANT_KEY = process.env.LYNK_MERCHANT_KEY;

    if (!MERCHANT_KEY) {
        console.error('[Lynk Webhook] LYNK_MERCHANT_KEY tidak dikonfigurasi!');
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server misconfiguration' })
        };
    }

    let payload;
    try {
        payload = JSON.parse(event.body);
    } catch (e) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Invalid JSON body' })
        };
    }

    console.log('[Lynk Webhook] Payload diterima:', JSON.stringify(payload, null, 2));

    // 1. Ambil Signature dari header
    const signature = event.headers['x-lynk-signature'] || event.headers['X-Lynk-Signature'];

    if (!signature) {
        console.warn('[Lynk Webhook] Tidak ada X-Lynk-Signature header.');
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Missing signature' })
        };
    }

    // 2. Validasi Signature (Mencoba beberapa kombinasi algoritma Lynk.id yang sebenarnya)
    const rawBody = event.body;
    let isValid = false;
    let stringSignatures = [];

    // Kombinasi Lynk.id yang sebenarnya (dari hasil reverse engineering):
    // SHA256(amount + refId + messageId + merchantKey)
    const refId = payload?.data?.message_data?.refId || '';
    const messageId = payload?.data?.message_id || '';
    const amountTypes = [
        payload?.data?.message_data?.totals?.totalPrice,
        payload?.data?.message_data?.totals?.grandTotal,
        payload?.data?.message_data?.totals?.customerPay
    ];

    for (let amt of amountTypes) {
        if (amt !== undefined) {
            // Urutan spesifik Lynk.id: amount + refId + messageId + merchantKey
            const dataToSign = `${amt}${refId}${messageId}${MERCHANT_KEY}`;
            const hs = crypto.createHash('sha256').update(dataToSign).digest('hex');
            stringSignatures.push(hs);
            if (hs === signature) isValid = true;
        }
    }

    if (!isValid) {
        // Jika tetap gagal, kita tolak tapi sediakan debug info
        console.warn(`[Lynk Webhook] Signature mismatch. Received: ${signature}`);
        
        return {
            statusCode: 403,
            body: JSON.stringify({ 
                error: 'Invalid signature', 
                debug: {
                    received_signature: signature,
                    computed_signatures: stringSignatures,
                    payload_keys: Object.keys(payload?.data || {})
                }
            })
        };
    }

    console.log('[Lynk Webhook] Signature VALID. Melanjutkan proses...');

    // 3. Pastikan status transaksi adalah SUKSES
    const status = payload?.data?.message_action;
    const eventName = payload?.event;
    if (status !== 'SUCCESS' || eventName !== 'payment.received') {
        console.log(`[Lynk Webhook] Event bukan sukses pembayaran (${eventName} / ${status}). Diabaikan.`);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: `Transaction status ignored.` })
        };
    }

    // 4. Ambil email pembeli dari payload Lynk.id
    const customerEmail = payload?.data?.message_data?.customer?.email;

    if (!customerEmail) {
        console.error('[Lynk Webhook] Tidak ada email customer dalam payload:', JSON.stringify(payload));
        return {
            statusCode: 422,
            body: JSON.stringify({ error: 'Customer email not found in payload' })
        };
    }

    const normalizedEmail = customerEmail.toLowerCase().trim();
    console.log(`[Lynk Webhook] Upgrade premium untuk email: ${normalizedEmail}`);

    // 5. Cari user di Firestore berdasarkan email & update isPremium
    try {
        const db = getFirestoreDb();
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', normalizedEmail).get();

        if (snapshot.empty) {
            console.warn(`[Lynk Webhook] User dengan email '${normalizedEmail}' tidak ditemukan di Firestore.`);
            // Kita tetap return 200 agar Lynk.id tidak retry terus-menerus
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'User not found, but acknowledged.' })
            };
        }

        // Update semua dokumen yang match (seharusnya hanya 1)
        const batch = db.batch();
        snapshot.forEach((doc) => {
            batch.update(doc.ref, {
                isPremium: true,
                upgradedAt: new Date().toISOString(),
                lynkRefId: payload.ref_id || null
            });
        });

        await batch.commit();

        console.log(`[Lynk Webhook] ✅ User '${normalizedEmail}' berhasil di-upgrade ke Premium!`);
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'User upgraded to premium.' })
        };

    } catch (error) {
        console.error('[Lynk Webhook] Error Firestore:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Firestore update failed', detail: error.message })
        };
    }
};
