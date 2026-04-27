/**
 * Matter-Homematic Bridge — Dashboard App
 * Vanilla JS, no build step
 */

// --- API helper ---
async function fetchApi(method, options = {}) {
  const url = `/api/?method=${method}`;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`API ${method}: ${res.status}`);
  return res.json();
}

// --- Tab switching ---
function switchTab(tabId, el) {
  // Hide all panes
  document.querySelectorAll('.tab-content-pane').forEach(p => p.style.display = 'none');
  // Deactivate all nav links
  document.querySelectorAll('.sidebar-nav .nav-link').forEach(a => a.classList.remove('active'));
  // Show selected
  const pane = document.getElementById('tab-' + tabId);
  if (pane) pane.style.display = '';
  if (el) el.classList.add('active');
  // Load data for tab
  if (tabId === 'dashboard') loadDashboard();
  if (tabId === 'devices') loadDevices();
  if (tabId === 'filters') loadFilters();
}

// --- Dashboard ---
let dashboardTimer = null;

async function loadDashboard() {
  clearInterval(dashboardTimer);
  await refreshDashboard();
  dashboardTimer = setInterval(refreshDashboard, 5000);
}

async function refreshDashboard() {
  try {
    const data = await fetchApi('getBridgeStatus');
    // CCU status
    const dot = document.querySelector('#ccu-status .status-dot');
    const txt = document.getElementById('ccu-status-text');
    if (data.ccuConnected) {
      dot.className = 'status-dot online';
      txt.textContent = 'Connected';
    } else {
      dot.className = 'status-dot offline';
      txt.textContent = 'Disconnected';
    }
    document.getElementById('ccu-host').textContent = data.ccuHost || '--';

    // Counts
    document.getElementById('device-count').textContent = data.deviceCount ?? '--';
    document.getElementById('endpoint-count').textContent = data.endpointCount ?? '--';
    document.getElementById('matter-port').textContent = data.matterPort ?? '--';

    // Uptime
    document.getElementById('uptime').textContent = formatUptime(data.uptime || 0);
    document.getElementById('bridge-name').textContent = data.bridgeName || '--';

    // Pairing
    document.getElementById('passcode').textContent = data.passcode ?? '--';
    document.getElementById('discriminator').textContent = data.discriminator ?? '--';

    // Sidebar version
    document.getElementById('sidebar-version').textContent = 'v1.0.0';

    // Timestamp
    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Dashboard refresh failed:', err);
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// --- Devices ---
let allDevices = [];
let allChannels = [];
let unmappedLoaded = false;

async function loadDevices() {
  try {
    const data = await fetchApi('getDevices');
    allDevices = data.devices || [];
    document.getElementById('devices-total').textContent = `${allDevices.length} devices`;
    const defToggle = document.getElementById('default-exposed');
    if (defToggle) defToggle.checked = data.defaultExposed !== false;
    filterDeviceTable();
  } catch (err) {
    console.error('Failed to load devices:', err);
    document.getElementById('device-tbody').innerHTML =
      '<tr><td colspan="7" class="text-center text-body-secondary py-4">Failed to load devices</td></tr>';
  }
}

function renderDeviceTable(devices) {
  const tbody = document.getElementById('device-tbody');
  if (!devices.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-body-secondary py-4">No devices found</td></tr>';
    return;
  }
  tbody.innerHTML = devices.map(d => {
    const addr = esc(d.address);
    const checked = d.exposed ? 'checked' : '';
    return `
    <tr>
      <td>
        <div class="form-check form-switch expose-switch">
          <input class="form-check-input" type="checkbox" ${checked}
                 data-address="${addr}"
                 onchange="toggleExposed('${addr}', this.checked)">
        </div>
      </td>
      <td class="fw-medium">${esc(d.name || d.address)}</td>
      <td class="mono">${addr}</td>
      <td><span class="badge badge-hm">${esc(d.hmChannelType || d.hmDeviceType || '--')}</span></td>
      <td><span class="badge badge-matter">${esc(d.matterDeviceType || '--')}</span></td>
      <td>${renderTiltControl(d)}</td>
      <td>${esc(d.room || '')}</td>
      <td>${renderState(d.currentState)}</td>
    </tr>
  `;
  }).join('');
}

/**
 * Tri-state tilt override for WindowCovering devices. HmIP-FBL always reports
 * LEVEL_2 numeric even when physically wired to a roller, so auto-detect alone
 * will wrongly add tilt to rollers on FBL hardware. Users pick the mode here.
 * For non-blind devices the cell is blank.
 */
function renderTiltControl(d) {
  if (d.matterDeviceType !== 'WindowCovering') return '';
  const addr = esc(d.address);
  const cur = d.tiltOverride; // null | true | false
  const sel = (v) => cur === v ? 'selected' : '';
  const autoLabel = `Auto (${d.hasTilt ? 'tilt' : 'lift-only'})`;
  return `
    <select class="form-select form-select-sm tilt-select"
            data-address="${addr}"
            onchange="setTiltOverride('${addr}', this.value)">
      <option value="auto" ${sel(null)}>${esc(autoLabel)}</option>
      <option value="true" ${sel(true)}>Tilt</option>
      <option value="false" ${sel(false)}>Lift only</option>
    </select>
  `;
}

async function setTiltOverride(address, value) {
  const tilt = value === 'auto' ? null : value === 'true';
  try {
    await fetchApi('setDeviceTilt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, tilt }),
    });
    const dev = allDevices.find(d => d.address === address);
    if (dev) dev.tiltOverride = tilt;
    document.getElementById('expose-alert').style.display = '';
  } catch (err) {
    console.error('Failed to set tilt override:', err);
    alert('Failed to save. Check bridge logs.');
  }
}

async function toggleExposed(address, exposed) {
  try {
    await fetchApi('setDeviceExposed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, exposed }),
    });
    const dev = allDevices.find(d => d.address === address);
    if (dev) dev.exposed = exposed;
    document.getElementById('expose-alert').style.display = '';
  } catch (err) {
    console.error('Failed to toggle exposure:', err);
    alert('Failed to save. Check bridge logs.');
  }
}

async function restartBridge() {
  const btn = document.getElementById('restart-btn');
  if (!confirm('Restart the bridge now? Matter controllers may briefly lose connection.')) return;
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Restarting...';
  try {
    await fetchApi('restartBridge', { method: 'POST' });
    // Poll until the bridge is back up
    const startedAt = Date.now();
    const waitForUp = async () => {
      while (Date.now() - startedAt < 60000) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const status = await fetchApi('getBridgeStatus');
          // A freshly restarted bridge has uptime < a few seconds
          if (status && status.uptime < (Date.now() - startedAt) / 1000) {
            return true;
          }
        } catch { /* web UI briefly unreachable — keep trying */ }
      }
      return false;
    };
    const ok = await waitForUp();
    if (ok) {
      refreshDashboard();
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    } else {
      btn.innerHTML = 'Timed out';
      setTimeout(() => { btn.innerHTML = originalHtml; btn.disabled = false; }, 3000);
    }
  } catch (err) {
    console.error('Restart failed:', err);
    alert('Failed to trigger restart. Check bridge logs.');
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

async function toggleDefaultExposed() {
  const checked = document.getElementById('default-exposed').checked;
  try {
    await fetchApi('setDefaultExposed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultExposed: checked }),
    });
    document.getElementById('expose-alert').style.display = '';
  } catch (err) {
    console.error('Failed to save default exposure:', err);
    alert('Failed to save. Check bridge logs.');
  }
}

function renderState(state) {
  if (!state || typeof state !== 'object') return '<span class="text-body-secondary">--</span>';
  const parts = [];
  for (const [key, val] of Object.entries(state)) {
    if (val === undefined || val === null) continue;
    let display = val;
    if (typeof val === 'boolean') display = val ? 'ON' : 'OFF';
    if (typeof val === 'number') display = Math.round(val * 100) / 100;
    parts.push(`<span class="state-item">${esc(key)}: <strong>${esc(String(display))}</strong></span>`);
  }
  return parts.join(' ') || '<span class="text-body-secondary">--</span>';
}

// A channel is "unnamed" if the CCU never had a user-assigned label —
// in that case ReGa returns a template like "HmIPW-DRS8 3014F711…:11"
// which always contains the channel's own address.
function hasCustomName(d) {
  if (!d.name || !d.address) return false;
  return !d.name.includes(d.address);
}

function filterDeviceTable() {
  const query = document.getElementById('device-search').value.toLowerCase().trim();
  const hideUnnamed = document.getElementById('hide-unnamed')?.checked;
  let list = allDevices;
  if (hideUnnamed) list = list.filter(hasCustomName);
  if (query) {
    list = list.filter(d =>
      (d.name || '').toLowerCase().includes(query) ||
      (d.address || '').toLowerCase().includes(query) ||
      (d.hmChannelType || '').toLowerCase().includes(query) ||
      (d.matterDeviceType || '').toLowerCase().includes(query) ||
      (d.room || '').toLowerCase().includes(query)
    );
  }
  renderDeviceTable(list);
  // Reflect filtered count so the header badge matches the visible rows
  const total = allDevices.length;
  const badge = document.getElementById('devices-total');
  if (badge) {
    badge.textContent = list.length === total
      ? `${total} devices`
      : `${list.length} of ${total} devices`;
  }
}

async function toggleUnmapped() {
  const show = document.getElementById('show-unmapped').checked;
  const section = document.getElementById('unmapped-section');
  if (!show) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  if (!unmappedLoaded) {
    try {
      const data = await fetchApi('getChannels');
      allChannels = data.channels || [];
      unmappedLoaded = true;
    } catch (err) {
      console.error('Failed to load channels:', err);
    }
  }
  renderUnmappedChannels();
}

function renderUnmappedChannels() {
  const mappedAddresses = new Set(allDevices.map(d => d.address));
  const unmapped = allChannels.filter(c => !mappedAddresses.has(c.address));
  const tbody = document.getElementById('unmapped-tbody');
  if (!unmapped.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-body-secondary py-4">No unmapped channels</td></tr>';
    return;
  }
  tbody.innerHTML = unmapped.map(c => {
    const valKeys = Object.keys(c.values || {}).join(', ');
    return `
      <tr>
        <td class="mono">${esc(c.address)}</td>
        <td><span class="badge badge-hm">${esc(c.type || '--')}</span></td>
        <td>${esc(c.name || '')}</td>
        <td class="text-body-secondary">${esc(valKeys || '--')}</td>
      </tr>
    `;
  }).join('');
}

// --- Filter Config ---
async function loadFilters() {
  try {
    const data = await fetchApi('getConfig');
    const f = data.filter || {};
    document.getElementById('filter-rooms').value = (f.rooms || []).join('\n');
    document.getElementById('filter-functions').value = (f.functions || []).join('\n');
    document.getElementById('filter-include').value = (f.include || []).join('\n');
    document.getElementById('filter-exclude').value = (f.exclude || []).join('\n');
  } catch (err) {
    console.error('Failed to load filter config:', err);
  }
}

async function saveFilter(event) {
  event.preventDefault();
  const toArray = id => document.getElementById(id).value.split('\n').map(s => s.trim()).filter(Boolean);
  const filter = {
    rooms: toArray('filter-rooms'),
    functions: toArray('filter-functions'),
    include: toArray('filter-include'),
    exclude: toArray('filter-exclude'),
  };
  try {
    await fetchApi('saveDeviceFilter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filter),
    });
    document.getElementById('filter-alert').style.display = '';
  } catch (err) {
    console.error('Failed to save filter:', err);
    alert('Failed to save filter configuration.');
  }
}

// --- Utility ---
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
});
