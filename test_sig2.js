const fs = require('fs');
const crypto = require('crypto');

const payloadStr = '{"event": "payment.received", "data": {"message_action": "SUCCESS", "message_code": "0", "message_data": {"createdAt": "2026-03-22T05:09:37", "customer": {"email": "sr7aron@gmail.com", "name": "", "phone": ""}, "items": [{"addons": [], "appointment_data": {}, "pafId": "", "price": 100, "public_affiliate_content": {}, "qty": 1, "questions": "{}", "stock": "unlimited", "title": "testing webhook", "uuid": "69bf16671a403958e494ea03-9571-9574821441-1774130791318"}], "refId": "412039de859c18ba7c825fef4be478f1", "shippingAddress": "", "shippingInfo": "", "totals": {"affiliate": 0, "convenienceFee": 0, "customerPay": 101, "discount": 0, "grandTotal": 100, "totalAddon": 0, "totalItem": 1, "totalPrice": 100, "totalShipping": 0}, "voucherCode": "", "voucherQuantity": ""}, "message_desc": "", "message_id": "API_CALL_177413102951029_582304", "message_title": ""}}';
const payload = JSON.parse(payloadStr);

const merchantKey = 'Z8l40qLVha0yauhTMZpCOTgFWtjtkRrK';
const expectedSig = '14f0011a9e989776a14379d27ce91baff9be6dbe51ff1ae1b7b8743cdfe4924c';

const refId = payload.data.message_data.refId;
const messageId = payload.data.message_id;

const amounts = [100, 101, '100', '101'];

let found = false;

amounts.forEach(amount => {
    // Try different concatenations
    const patterns = [
        `${refId}${amount}${messageId}`,
        `${refId}${messageId}${amount}`,
        `${messageId}${amount}${refId}`,
        `${amount}${refId}${messageId}`
    ];

    patterns.forEach(dataToSign => {
        // SHA256
        const s1 = crypto.createHash('sha256').update(merchantKey + dataToSign).digest('hex');
        const s2 = crypto.createHash('sha256').update(dataToSign + merchantKey).digest('hex');
        if (s1 === expectedSig) {
             fs.writeFileSync('result.txt', `MATCH: merchantKey + ${dataToSign} (amount used: ${amount})`);
             found = true;
        }
        if (s2 === expectedSig) {
             fs.writeFileSync('result.txt', `MATCH: ${dataToSign} + merchantKey (amount used: ${amount})`);
             found = true;
        }
    });
});
