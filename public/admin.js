// ═══════════════════════════════════════════════════════════════════════════════
// LYNK.ID WEBHOOK HUB — Dashboard Frontend Logic
// ═══════════════════════════════════════════════════════════════════════════════

const API_BASE = '/.netlify/functions/api-admin';
let AUTH_TOKEN = '';
let currentFilter = 'ALL';

// ─── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const saved = sessionStorage.getItem('webhookHubToken');
    if (saved) {
        AUTH_TOKEN = saved;
        checkAuth().then(ok => {
            if (ok) showDashboard();
            else sessionStorage.removeItem('webhookHubToken');
        });
    }

    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('rule-form').addEventListener('submit', handleRuleSubmit);
});

// ─── AUTH ──────────────────────────────────────────────────────────────────────
async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const pw = document.getElementById('login-password').value.trim();
    if (!pw) return;

    btn.disabled = true;
    btn.textContent = 'Memverifikasi...';
    AUTH_TOKEN = pw;

    const ok = await checkAuth();
    if (ok) {
        sessionStorage.setItem('webhookHubToken', pw);
        showDashboard();
    } else {
        toast('Password salah', 'error');
        AUTH_TOKEN = '';
    }
    btn.disabled = false;
    btn.textContent = 'Masuk';
}

async function checkAuth() {
    try {
        const res = await apiCall('checkAuth');
        return res?.authenticated === true;
    } catch { return false; }
}

function logout() {
    AUTH_TOKEN = '';
    sessionStorage.removeItem('webhookHubToken');
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('login-password').value = '';
}

function showDashboard() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    loadStats();
    loadRules();
}

// ─── API HELPER ────────────────────────────────────────────────────────────────
async function apiCall(action, options = {}) {
    const { method = 'GET', body = null, params = {} } = options;
    const url = new URL(API_BASE, window.location.origin);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const fetchOpts = {
        method: body ? 'POST' : method,
        headers: {
            'Authorization': `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };
    if (body) fetchOpts.body = JSON.stringify(body);

    const res = await fetch(url.toString(), fetchOpts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ─── STATS ─────────────────────────────────────────────────────────────────────
async function loadStats() {
    try {
        const { stats } = await apiCall('getStats');
        document.getElementById('stat-rules').textContent = stats.activeRules;
        document.getElementById('stat-rules-sub').textContent = `${stats.totalRules} total`;
        document.getElementById('stat-logs').textContent = stats.recentLogs;
        document.getElementById('stat-success').textContent = stats.successCount;
        document.getElementById('stat-fail').textContent = stats.failCount + stats.noRulesCount;

        if (stats.lastWebhookAt) {
            const ago = timeAgo(stats.lastWebhookAt);
            document.getElementById('last-webhook').textContent = `Webhook terakhir: ${ago}`;
        }
    } catch (err) {
        console.error('Stats error:', err);
    }
}

// ─── TABS ──────────────────────────────────────────────────────────────────────
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
    document.getElementById('log-detail').innerHTML = '';
    loadCurrentTab();
}

function loadCurrentTab() {
    const active = document.querySelector('.tab-btn.active');
    if (active?.dataset.tab === 'rules') loadRules();
    else if (active?.dataset.tab === 'logs') loadLogs();
}

// ─── ROUTING RULES ─────────────────────────────────────────────────────────────
async function loadRules() {
    const container = document.getElementById('rules-table-body');
    try {
        const { rules } = await apiCall('getRules');
        if (!rules.length) {
            container.innerHTML = '<div class="empty-state"><div class="icon">📡</div><p>Belum ada routing rule. Klik "Tambah Rule" untuk membuat.</p></div>';
            return;
        }
        container.innerHTML = `
            <table>
                <thead><tr>
                    <th>Nama</th><th>Product ID</th><th>URL Tujuan</th><th>Aktif</th><th>Aksi</th>
                </tr></thead>
                <tbody>${rules.map(ruleRow).join('')}</tbody>
            </table>`;
    } catch (err) {
        container.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">Error: ${err.message}</p></div>`;
    }
}

function ruleRow(rule) {
    const shortUrl = rule.destinationUrl?.length > 45
        ? rule.destinationUrl.substring(0, 45) + '...'
        : rule.destinationUrl;
    const pid = rule.productId || '<span style="color:var(--text-muted)">catch-all</span>';
    return `<tr>
        <td><strong>${esc(rule.name)}</strong>${rule.description ? `<br><span style="color:var(--text-muted);font-size:0.75rem">${esc(rule.description)}</span>` : ''}</td>
        <td style="font-family:monospace;font-size:0.78rem">${pid}</td>
        <td style="font-size:0.78rem" title="${esc(rule.destinationUrl)}">${esc(shortUrl)}</td>
        <td>
            <label class="toggle">
                <input type="checkbox" ${rule.isActive ? 'checked' : ''} onchange="toggleRule('${rule.id}', this.checked)">
                <span class="toggle-slider"></span>
            </label>
        </td>
        <td>
            <button class="btn btn-secondary btn-sm" onclick='editRule(${JSON.stringify(rule)})'>✏️</button>
            <button class="btn btn-danger btn-sm" onclick="deleteRule('${rule.id}','${esc(rule.name)}')">🗑️</button>
        </td>
    </tr>`;
}

function openRuleModal(rule = null) {
    document.getElementById('rule-modal-title').textContent = rule ? 'Edit Rule' : 'Tambah Rule Baru';
    document.getElementById('rule-id').value = rule?.id || '';
    document.getElementById('rule-name').value = rule?.name || '';
    document.getElementById('rule-product-id').value = rule?.productId || '';
    document.getElementById('rule-url').value = rule?.destinationUrl || '';
    document.getElementById('rule-headers').value = rule?.headers && Object.keys(rule.headers).length ? JSON.stringify(rule.headers, null, 2) : '';
    document.getElementById('rule-description').value = rule?.description || '';
    document.getElementById('rule-modal').classList.add('active');
}

function closeRuleModal() {
    document.getElementById('rule-modal').classList.remove('active');
}

function editRule(rule) { openRuleModal(rule); }

async function handleRuleSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('rule-submit-btn');
    btn.disabled = true;

    const id = document.getElementById('rule-id').value;
    let headers = {};
    const headersRaw = document.getElementById('rule-headers').value.trim();
    if (headersRaw) {
        try { headers = JSON.parse(headersRaw); } catch {
            toast('Format Headers JSON tidak valid', 'error');
            btn.disabled = false;
            return;
        }
    }

    const body = {
        name: document.getElementById('rule-name').value.trim(),
        productId: document.getElementById('rule-product-id').value.trim(),
        destinationUrl: document.getElementById('rule-url').value.trim(),
        headers,
        description: document.getElementById('rule-description').value.trim()
    };

    try {
        if (id) {
            body.id = id;
            await apiCall('updateRule', { body });
            toast('Rule berhasil diupdate', 'success');
        } else {
            await apiCall('createRule', { body });
            toast('Rule berhasil dibuat', 'success');
        }
        closeRuleModal();
        loadRules();
        loadStats();
    } catch (err) {
        toast(`Gagal: ${err.message}`, 'error');
    }
    btn.disabled = false;
}

async function toggleRule(id, isActive) {
    try {
        await apiCall('toggleRule', { body: { id, isActive } });
        toast(isActive ? 'Rule diaktifkan' : 'Rule dinonaktifkan', 'success');
        loadStats();
    } catch (err) {
        toast(`Gagal toggle: ${err.message}`, 'error');
        loadRules();
    }
}

async function deleteRule(id, name) {
    if (!confirm(`Hapus rule "${name}"?`)) return;
    try {
        await apiCall('deleteRule', { body: { id } });
        toast('Rule dihapus', 'success');
        loadRules();
        loadStats();
    } catch (err) {
        toast(`Gagal hapus: ${err.message}`, 'error');
    }
}

// ─── WEBHOOK LOGS ──────────────────────────────────────────────────────────────
async function loadLogs() {
    const container = document.getElementById('logs-table-body');
    try {
        const { logs } = await apiCall('getLogs', { params: { status: currentFilter, limit: '50' } });
        if (!logs.length) {
            container.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>Belum ada webhook log.</p></div>';
            return;
        }
        container.innerHTML = `
            <table>
                <thead><tr>
                    <th>Waktu</th><th>Email</th><th>Produk</th><th>Forward</th><th>Status</th><th>Aksi</th>
                </tr></thead>
                <tbody>${logs.map(logRow).join('')}</tbody>
            </table>`;
    } catch (err) {
        container.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">Error: ${err.message}</p></div>`;
    }
}

function logRow(log) {
    const statusMap = {
        'SUCCESS': '<span class="badge badge-success">✅ Success</span>',
        'PARTIAL_FAIL': '<span class="badge badge-danger">⚠️ Partial Fail</span>',
        'FAILED': '<span class="badge badge-danger">❌ Failed</span>',
        'NO_RULES': '<span class="badge badge-warning">📭 No Rules</span>',
        'PROCESSING': '<span class="badge badge-info">⏳ Processing</span>'
    };
    const products = (log.productNames || []).join(', ') || '—';
    const fwdText = log.forwardsCount > 0 ? `${log.forwardsSuccess}/${log.forwardsCount}` : '—';
    return `<tr>
        <td style="font-size:0.78rem;white-space:nowrap">${formatDate(log.createdAtISO)}</td>
        <td style="font-size:0.82rem">${esc(log.customerEmail || '—')}</td>
        <td style="font-size:0.78rem;max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${esc(products)}">${esc(products)}</td>
        <td>${fwdText}</td>
        <td>${statusMap[log.status] || log.status}</td>
        <td>
            <button class="btn btn-secondary btn-sm" onclick="viewLog('${log.id}')">👁️</button>
            <button class="btn btn-success btn-sm" onclick="resendLog('${log.id}')" title="Resend">🔄</button>
        </td>
    </tr>`;
}

function filterLogs(status) {
    currentFilter = status;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === status));
    loadLogs();
}

async function viewLog(id) {
    const detailEl = document.getElementById('log-detail');
    detailEl.innerHTML = '<div class="detail-panel"><div class="spinner"></div> Memuat detail...</div>';

    try {
        const { log } = await apiCall('getLog', { params: { id } });
        const forwards = (log.forwards || []).map(f => `
            <tr>
                <td>${esc(f.ruleName || '—')}</td>
                <td style="font-size:0.78rem">${esc(f.destinationUrl || '—')}</td>
                <td>${f.success ? '<span class="badge badge-success">OK</span>' : '<span class="badge badge-danger">FAIL</span>'}</td>
                <td>${f.httpStatus || '—'}</td>
                <td style="font-size:0.75rem">${f.durationMs ? f.durationMs + 'ms' : '—'}</td>
                <td>${f.isResend ? '<span class="badge badge-info">Resend</span>' : ''}</td>
            </tr>`).join('');

        detailEl.innerHTML = `
            <div class="detail-panel">
                <h3>Detail Log: ${esc(log.lynkRefId || id)}</h3>
                <div class="detail-section">
                    <h4>Informasi</h4>
                    <p><strong>Email:</strong> ${esc(log.customerEmail || '—')}</p>
                    <p><strong>Produk:</strong> ${esc((log.productNames || []).join(', ') || '—')}</p>
                    <p><strong>Status:</strong> ${log.status}</p>
                    <p><strong>Waktu:</strong> ${formatDate(log.createdAtISO)}</p>
                </div>
                ${forwards ? `<div class="detail-section">
                    <h4>Forwarding Results</h4>
                    <div class="table-container">
                        <table><thead><tr><th>Rule</th><th>URL</th><th>Status</th><th>HTTP</th><th>Durasi</th><th></th></tr></thead>
                        <tbody>${forwards}</tbody></table>
                    </div>
                </div>` : ''}
                <div class="detail-section">
                    <h4>Raw Payload</h4>
                    <div class="payload-box">${esc(JSON.stringify(log.rawPayload, null, 2))}</div>
                </div>
                <div style="margin-top:16px">
                    <button class="btn btn-success btn-sm" onclick="resendLog('${id}')">🔄 Resend Webhook</button>
                    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('log-detail').innerHTML=''">Tutup</button>
                </div>
            </div>`;
    } catch (err) {
        detailEl.innerHTML = `<div class="detail-panel"><p style="color:var(--danger)">Error: ${err.message}</p></div>`;
    }
}

async function resendLog(logId) {
    if (!confirm('Kirim ulang webhook ini ke semua rule yang cocok?')) return;
    try {
        const result = await apiCall('resend', { body: { logId } });
        const successCount = (result.resendResults || []).filter(r => r.success).length;
        const total = (result.resendResults || []).length;
        toast(`Resend selesai: ${successCount}/${total} berhasil`, successCount === total ? 'success' : 'error');
        loadLogs();
        loadStats();
    } catch (err) {
        toast(`Resend gagal: ${err.message}`, 'error');
    }
}

// ─── UTILS ─────────────────────────────────────────────────────────────────────
function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    el.innerHTML = `<span>${icons[type] || ''}</span><span>${esc(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
}

function formatDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) +
            ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
}

function timeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'baru saja';
    if (mins < 60) return `${mins} menit lalu`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} jam lalu`;
    const days = Math.floor(hours / 24);
    return `${days} hari lalu`;
}
