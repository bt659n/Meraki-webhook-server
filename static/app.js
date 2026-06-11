// State Management
let appState = {
    token: localStorage.getItem('meraki_dashboard_token') || '',
    events: [],
    selectedEventId: null,
    searchQuery: '',
    sseSource: null
};

// Inject Custom JSON Syntax Highlighting Styles
const style = document.createElement('style');
style.textContent = `
  .json-key { color: #f472b6; font-weight: 500; }
  .json-string { color: #34d399; }
  .json-number { color: #60a5fa; }
  .json-boolean { color: #c084fc; }
  .json-null { color: #9ca3af; }
`;
document.head.appendChild(style);

// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const connectionStatus = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const endpointUrl = document.getElementById('endpoint-url');
const copyEndpointBtn = document.getElementById('copy-endpoint-btn');

const countTotal = document.getElementById('count-total');
const countNetworks = document.getElementById('count-networks');
const countDevices = document.getElementById('count-devices');
const countLastTime = document.getElementById('count-last-time');

const searchInput = document.getElementById('search-input');
const clearFiltersBtn = document.getElementById('clear-filters-btn');
const clearDbBtn = document.getElementById('clear-db-btn');

const feedCount = document.getElementById('feed-count');
const webhookFeed = document.getElementById('webhook-feed');
const feedEmpty = document.getElementById('feed-empty');

const detailPanel = document.getElementById('detail-panel');
const detailEmpty = document.getElementById('detail-empty');
const detailContent = document.getElementById('detail-content');
const detailAlertBadge = document.getElementById('detail-alert-badge');
const detailAlertTitle = document.getElementById('detail-alert-title');
const detailTime = document.getElementById('detail-time');
const detailNetwork = document.getElementById('detail-network');
const detailDeviceName = document.getElementById('detail-device-name');
const detailDeviceSerial = document.getElementById('detail-device-serial');
const detailJsonBlock = document.getElementById('detail-json-block');
const copyJsonBtn = document.getElementById('copy-json-btn');
const toastContainer = document.getElementById('toast-container');

// Initialize Endpoint URL
endpointUrl.textContent = `${window.location.origin}/webhook`;

// App Startup
document.addEventListener('DOMContentLoaded', async () => {
    await checkAuthStatus();
    setupEventListeners();
});

// Event Listeners Setup
function setupEventListeners() {
    // Copy webhook endpoint URL
    copyEndpointBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(endpointUrl.textContent);
        showToast('Webhook endpoint URL copied!', 'success');
    });

    // Copy selected webhook JSON payload
    copyJsonBtn.addEventListener('click', () => {
        if (appState.selectedEventId) {
            const event = appState.events.find(e => e.id === appState.selectedEventId);
            if (event) {
                navigator.clipboard.writeText(JSON.stringify(JSON.parse(event.raw_payload), null, 2));
                showToast('JSON Payload copied!', 'success');
            }
        }
    });

    // Search input typing
    searchInput.addEventListener('input', (e) => {
        appState.searchQuery = e.target.value.toLowerCase().trim();
        renderFeed();
        
        if (appState.searchQuery) {
            clearFiltersBtn.classList.remove('hide');
        } else {
            clearFiltersBtn.classList.add('hide');
        }
    });

    // Clear filters button
    clearFiltersBtn.addEventListener('click', () => {
        searchInput.value = '';
        appState.searchQuery = '';
        clearFiltersBtn.classList.add('hide');
        renderFeed();
    });

    // Clear dashboard display
    clearDbBtn.addEventListener('click', () => {
        appState.events = [];
        appState.selectedEventId = null;
        renderFeed();
        updateStats();
        showDetailPanel(null);
        showToast('Dashboard logs cleared.', 'info');
    });

    // Login Form Submission
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = passwordInput.value;
        try {
            const response = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            if (response.ok) {
                const data = await response.json();
                appState.token = data.token;
                localStorage.setItem('meraki_dashboard_token', data.token);
                loginOverlay.classList.add('hide');
                loginError.classList.add('hide');
                passwordInput.value = '';
                
                showToast('Dashboard unlocked!', 'success');
                initializeDashboard();
            } else {
                loginError.classList.remove('hide');
                passwordInput.value = '';
            }
        } catch (error) {
            console.error('Login error:', error);
            showToast('Authentication server connection error', 'error');
        }
    });

    // Logout
    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('meraki_dashboard_token');
        appState.token = '';
        if (appState.sseSource) {
            appState.sseSource.close();
        }
        location.reload();
    });
}

// Authentication Status Checker
async function checkAuthStatus() {
    try {
        const response = await fetch('/api/auth/status', {
            headers: getAuthHeaders()
        });
        const data = await response.json();
        
        if (data.required) {
            logoutBtn.classList.remove('hide');
        }

        if (data.required && !data.valid) {
            loginOverlay.classList.remove('hide');
        } else {
            loginOverlay.classList.add('hide');
            initializeDashboard();
        }
    } catch (e) {
        console.error('Failed to verify auth status:', e);
        showToast('Failed to contact auth backend', 'error');
    }
}

// Helper: HTTP Authorization Header
function getAuthHeaders() {
    const headers = {};
    if (appState.token) {
        headers['Authorization'] = `Bearer ${appState.token}`;
    }
    return headers;
}

// Initialize Dashboard Data streams
async function initializeDashboard() {
    await fetchInitialEvents();
    connectSSE();
}

// Fetch Previous Webhooks (Initial Load)
async function fetchInitialEvents() {
    try {
        const response = await fetch('/api/events?limit=100', {
            headers: getAuthHeaders()
        });
        if (response.status === 401) {
            checkAuthStatus();
            return;
        }
        if (response.ok) {
            const data = await response.json();
            appState.events = data;
            renderFeed();
            updateStats();
        }
    } catch (e) {
        console.error('Error fetching initial events:', e);
        showToast('Could not load history from server', 'error');
    }
}

// Connect to Server-Sent Events stream for real-time notifications
function connectSSE() {
    if (appState.sseSource) {
        appState.sseSource.close();
    }

    const sseUrl = `/api/events/sse${appState.token ? `?token=${appState.token}` : ''}`;
    const source = new EventSource(sseUrl);
    appState.sseSource = source;

    setConnectionState('connecting', 'Connecting...');

    source.onopen = () => {
        setConnectionState('connected', 'Connected');
    };

    source.onerror = (e) => {
        setConnectionState('disconnected', 'Disconnected');
        console.error('SSE connection failed. Retrying in 5 seconds...', e);
        source.close();
        setTimeout(connectSSE, 5000);
    };

    source.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            
            // Handle standard handshake event
            if (payload.type === 'connected') {
                return;
            }

            // Create temporary unique ID
            payload.id = Date.now() + Math.random().toString(36).substr(2, 9);
            
            // Add new payload to the top of list
            appState.events.unshift(payload);
            
            // Cap history
            if (appState.events.length > 1000) {
                appState.events.pop();
            }

            // Play pulse sound or flash feed card
            renderFeed(payload.id);
            updateStats();
            showToast(`New alert: ${payload.alert_type}`, 'info');
        } catch (err) {
            console.error('Error parsing SSE payload:', err);
        }
    };
}

// Connection State Modifier
function setConnectionState(state, text) {
    connectionStatus.className = 'status-badge';
    if (state === 'connected') {
        connectionStatus.classList.add('connected');
        statusText.textContent = text;
    } else if (state === 'disconnected') {
        connectionStatus.classList.add('disconnected');
        statusText.textContent = text;
    } else {
        connectionStatus.classList.add('disconnected');
        statusText.textContent = text;
    }
}

// Compute and Update Dashboard Statistics
function updateStats() {
    countTotal.textContent = appState.events.length;

    const networks = new Set();
    const devices = new Set();
    let lastTime = null;

    appState.events.forEach(e => {
        if (e.network_name && e.network_name !== 'N/A') networks.add(e.network_name);
        if (e.device_serial && e.device_serial !== 'N/A') devices.add(e.device_serial);
    });

    countNetworks.textContent = networks.size;
    countDevices.textContent = devices.size;

    if (appState.events.length > 0) {
        const latest = appState.events[0];
        // Parse occurred_at (which is usually ISO format)
        const dateStr = latest.occurred_at || latest.timestamp;
        try {
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
                countLastTime.textContent = formatRelativeTime(date);
            } else {
                countLastTime.textContent = 'Recent';
            }
        } catch {
            countLastTime.textContent = 'Recent';
        }
    } else {
        countLastTime.textContent = 'Never';
    }
}

// Helper: Relative time formatter (e.g. "Just now", "2m ago")
function formatRelativeTime(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
}

// Dynamically Render Feed Items list
function renderFeed(highlightId = null) {
    // Filter events based on search
    const filteredEvents = appState.events.filter(e => {
        if (!appState.searchQuery) return true;
        const q = appState.searchQuery;
        return (
            (e.alert_type && e.alert_type.toLowerCase().includes(q)) ||
            (e.network_name && e.network_name.toLowerCase().includes(q)) ||
            (e.device_name && e.device_name.toLowerCase().includes(q)) ||
            (e.device_serial && e.device_serial.toLowerCase().includes(q))
        );
    });

    feedCount.textContent = `Showing ${filteredEvents.length} events`;

    if (filteredEvents.length === 0) {
        webhookFeed.innerHTML = '';
        webhookFeed.appendChild(feedEmpty);
        feedEmpty.querySelector('p').textContent = appState.searchQuery ? 'No matching events found.' : 'No webhooks received yet.';
        return;
    }

    if (feedEmpty.parentNode) {
        feedEmpty.remove();
    }

    // Build feed list HTML
    let listHtml = '';
    filteredEvents.forEach(event => {
        const isActive = appState.selectedEventId === event.id ? 'active' : '';
        const isPulse = highlightId === event.id ? 'pulse-new' : '';
        const badgeClass = getBadgeClass(event.alert_type);
        
        let occurredDate = 'Unknown Time';
        if (event.occurred_at) {
            try {
                const date = new Date(event.occurred_at);
                occurredDate = isNaN(date.getTime()) ? event.occurred_at : date.toLocaleString();
            } catch {
                occurredDate = event.occurred_at;
            }
        }

        listHtml += `
            <div class="webhook-card ${isActive} ${isPulse}" data-id="${event.id}">
                <div class="webhook-card-header">
                    <span class="alert-badge ${badgeClass}">${event.alert_type}</span>
                    <span class="card-time">${occurredDate}</span>
                </div>
                <div class="webhook-card-body">
                    <span class="card-network"><i class="fa-solid fa-network-wired"></i> ${event.network_name || 'N/A'}</span>
                    <span class="card-device"><i class="fa-solid fa-microchip"></i> Device: ${event.device_name || 'N/A'} (${event.device_serial || 'N/A'})</span>
                </div>
            </div>
        `;
    });

    webhookFeed.innerHTML = listHtml;

    // Attach click listeners to cards
    const cards = webhookFeed.querySelectorAll('.webhook-card');
    cards.forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-id');
            // Check if string or integer ID
            const numericId = parseInt(id);
            const eventId = isNaN(numericId) ? id : numericId;
            
            // Toggle selection
            cards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            
            appState.selectedEventId = eventId;
            const event = appState.events.find(e => e.id === eventId);
            showDetailPanel(event);
        });
    });

    // Remove animation classes after 2s
    if (highlightId) {
        setTimeout(() => {
            const pulseEl = webhookFeed.querySelector('.pulse-new');
            if (pulseEl) pulseEl.classList.remove('pulse-new');
        }, 2000);
    }
}

// Helper: Determine CSS class for alert types
function getBadgeClass(alertType) {
    if (!alertType) return 'badge-test';
    const type = alertType.toLowerCase();
    
    if (type.includes('test')) return 'badge-test';
    if (type.includes('settings') || type.includes('config')) return 'badge-settings';
    if (type.includes('down') || type.includes('disconnect') || type.includes('fail')) return 'badge-down';
    if (type.includes('up') || type.includes('connect')) return 'badge-up';
    if (type.includes('vpn')) return 'badge-vpn';
    return 'badge-info';
}

// Side Panel Detail Display logic
function showDetailPanel(event) {
    if (!event) {
        detailEmpty.classList.remove('hide');
        detailContent.classList.add('hide');
        appState.selectedEventId = null;
        return;
    }

    detailEmpty.classList.add('hide');
    detailContent.classList.remove('hide');

    detailAlertBadge.className = `alert-badge ${getBadgeClass(event.alert_type)}`;
    detailAlertBadge.textContent = event.alert_type;
    detailAlertTitle.textContent = event.alert_type;

    let occurredDate = 'N/A';
    if (event.occurred_at) {
        try {
            const date = new Date(event.occurred_at);
            occurredDate = isNaN(date.getTime()) ? event.occurred_at : date.toLocaleString();
        } catch {
            occurredDate = event.occurred_at;
        }
    }
    
    detailTime.textContent = occurredDate;
    detailNetwork.textContent = event.network_name || 'N/A';
    detailDeviceName.textContent = event.device_name || 'N/A';
    detailDeviceSerial.textContent = event.device_serial || 'N/A';

    // Format JSON with syntax highlighting
    try {
        const parsed = JSON.parse(event.raw_payload);
        detailJsonBlock.innerHTML = syntaxHighlight(parsed);
    } catch {
        detailJsonBlock.textContent = event.raw_payload;
    }
}

// Custom JSON syntax highlighting parser
function syntaxHighlight(jsonObj) {
    let json = JSON.stringify(jsonObj, undefined, 2);
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, function (match) {
        let cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
            } else {
                cls = 'string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'boolean';
        } else if (/null/.test(match)) {
            cls = 'null';
        }
        return `<span class="json-${cls}">${match}</span>`;
    });
}

// Toast Alert System
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'info-circle';
    if (type === 'success') icon = 'circle-check';
    if (type === 'error') icon = 'circle-exclamation';
    if (type === 'warning') icon = 'triangle-exclamation';

    toast.innerHTML = `
        <i class="fa-solid fa-${icon}"></i>
        <span>${message}</span>
    `;

    toastContainer.appendChild(toast);

    // Remove toast after 3 seconds
    setTimeout(() => {
        toast.style.animation = 'toast-in 0.2s reverse ease';
        setTimeout(() => {
            toast.remove();
        }, 200);
    }, 3000);
}
