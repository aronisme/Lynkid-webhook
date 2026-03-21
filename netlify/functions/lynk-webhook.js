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

    // 2. Validasi Signature
    const { ref_id, amount, message_id } = payload;
    const dataToSign = `${ref_id}${amount}${message_id}`;
    const computedSig = crypto.createHmac('sha256', MERCHANT_KEY).update(dataToSign).digest('hex');

    if (computedSig !== signature) {
        console.warn(`[Lynk Webhook] Signature invalid. Expected: ${computedSig}, Got: ${signature}`);
        return {
            statusCode: 403,
            body: JSON.stringify({ 
                error: 'Invalid signature', 
                debug: {
                    received_signature: signature,
                    computed_signature: computedSig,
                    data_to_sign: dataToSign,
                    payload_keys: Object.keys(payload)
                }
            })
        };
    }

    console.log('[Lynk Webhook] Signature VALID. Melanjutkan proses...');

    // 3. Pastikan status transaksi adalah SUKSES
    const status = payload.status || payload.payment_status;
    if (status !== 'success' && status !== 'paid' && status !== 'completed') {
        console.log(`[Lynk Webhook] Status transaksi bukan sukses (${status}). Diabaikan.`);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: `Transaction status '${status}' ignored.` })
        };
    }

    // 4. Ambil email pembeli dari payload Lynk.id
    const customerEmail = payload.message_data?.customer?.email || payload.customer_email;

    if (!customerEmail) {
        console.error('[Lynk Webhook] Tidak ada email customer dalam payload.');
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
