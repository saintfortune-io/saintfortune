// ══════════════════════════════════════════════════════════════════════
// SAINT FORTUNE · NinjaTrader Realtime Module
// Pega este bloque ANTES del </script> final en tu index.html
//
// Escucha la tabla nt8_trades en Supabase y convierte cada trade
// al formato de entradas del dashboard automáticamente.
// ══════════════════════════════════════════════════════════════════════

(function () {

  // ── Config ─────────────────────────────────────────────────────────
  const NT_SB_URL = 'https://qkuimdilzxhhxpnvlnjb.supabase.co';
  const NT_SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrdWltZGlsenhoaHhwbnZsbmpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NTQzNjQsImV4cCI6MjA5NzUzMDM2NH0.9kkAuNYuuU6G5EIgXk3ZO7nKxs6IVwjlzAAGggcn0Dk';

  // ── Convierte un trade de NT8 al formato de entry del dashboard ────
  function nt8TradeToEntry(t) {
    const entryDate = t.entry_time ? t.entry_time.split('T')[0] : new Date().toISOString().split('T')[0];
    const entryTime = t.entry_time ? t.entry_time.split('T')[1]?.substring(0, 5) : '09:30';

    return {
      id:         t.id,
      date:       entryDate,
      time:       entryTime,
      account:    t.account || 'NinjaTrader',
      symbol:     t.instrument || '?',
      direction:  t.direction === 'Long' ? 'buy' : 'sell',
      contracts:  t.contracts || 1,
      entryPrice: t.entry_price || 0,
      exitPrice:  t.exit_price  || 0,
      pnl:        t.net_pnl     || 0,
      commission: t.commission  || 0,
      duration:   t.duration_secs ? formatDuration(t.duration_secs) : '—',
      source:     'ninja',
      synced:     true
    };
  }

  function formatDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // ── Agrega o actualiza una entrada en el array global entries[] ────
  function upsertEntry(entry) {
    if (typeof entries === 'undefined') return;
    const idx = entries.findIndex(e => e.id === entry.id);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], ...entry };
    } else {
      entries.unshift(entry); // más reciente primero
    }
    // Guardar y refrescar UI
    try { save(); } catch (e) {}
    if (typeof renderOverview === 'function') renderOverview();
    if (typeof renderEntries  === 'function') renderEntries();
    showNinjaToast(entry);
  }

  // ── Toast de notificación cuando llega un trade ───────────────────
  function showNinjaToast(entry) {
    const existing = document.getElementById('sf-ninja-toast');
    if (existing) existing.remove();

    const color  = entry.pnl >= 0 ? '#27d97a' : '#ff4f4f';
    const sign   = entry.pnl >= 0 ? '+' : '';
    const pnlFmt = `${sign}$${Math.abs(entry.pnl).toFixed(2)}`;

    const toast = document.createElement('div');
    toast.id = 'sf-ninja-toast';
    toast.style.cssText = `
      position:fixed; bottom:24px; right:24px; z-index:99999;
      background:#18181f; border:1px solid ${color};
      border-radius:12px; padding:12px 16px;
      box-shadow: 0 0 20px ${color}33;
      display:flex; align-items:center; gap:10px;
      animation: sfToastIn 0.3s ease;
      font-family: inherit;
    `;

    toast.innerHTML = `
      <style>
        @keyframes sfToastIn { from { transform:translateY(20px);opacity:0 } to { transform:translateY(0);opacity:1 } }
      </style>
      <div style="font-size:20px">⚡</div>
      <div>
        <div style="font-size:11px;color:#888899;margin-bottom:2px">NinjaTrader · ${entry.symbol}</div>
        <div style="font-size:13px;font-weight:700;color:${color}">${pnlFmt}</div>
        <div style="font-size:10px;color:#55556a">${entry.direction === 'buy' ? '▲ Long' : '▼ Short'} · ${entry.contracts} contratos</div>
      </div>
      <div style="cursor:pointer;color:#55556a;font-size:16px;margin-left:8px" onclick="this.parentElement.remove()">×</div>
    `;

    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 5000);
  }

  // ── Cargar historial inicial de trades de NT8 ─────────────────────
  async function loadNT8History() {
    try {
      const res = await fetch(
        NT_SB_URL + '/rest/v1/nt8_trades?select=*&order=entry_time.desc&limit=200',
        {
          headers: {
            'apikey':        NT_SB_KEY,
            'Authorization': 'Bearer ' + NT_SB_KEY
          }
        }
      );
      if (!res.ok) return;
      const trades = await res.json();
      if (!Array.isArray(trades)) return;

      trades.forEach(t => {
        const entry = nt8TradeToEntry(t);
        if (typeof entries !== 'undefined') {
          const exists = entries.findIndex(e => e.id === entry.id) >= 0;
          if (!exists) entries.push(entry);
        }
      });

      try { save(); } catch (e) {}
      if (typeof renderOverview === 'function') renderOverview();
      if (typeof renderEntries  === 'function') renderEntries();

      console.log(`SF NinjaTrader: ${trades.length} trades cargados`);
    } catch (err) {
      console.warn('SF NinjaTrader: error cargando historial', err);
    }
  }

  // ── Realtime via Supabase Postgres Changes (WebSocket) ───────────
  function startRealtimeListener() {
    // Supabase Realtime endpoint
    const realtimeUrl = NT_SB_URL.replace('https://', 'wss://') + '/realtime/v1/websocket?apikey=' + NT_SB_KEY + '&vsn=1.0.0';

    let ws;
    let heartbeatInterval;
    let reconnectTimeout;

    function connect() {
      ws = new WebSocket(realtimeUrl);

      ws.onopen = () => {
        console.log('SF NinjaTrader Realtime: conectado');
        updateNinjaStatus('conectado');

        // Suscribirse a INSERT en nt8_trades
        ws.send(JSON.stringify({
          topic:   'realtime:public:nt8_trades',
          event:   'phx_join',
          payload: {
            config: {
              broadcast:  { self: false },
              presence:   { key: '' },
              postgres_changes: [{
                event:  'INSERT',
                schema: 'public',
                table:  'nt8_trades'
              }]
            }
          },
          ref: '1'
        }));

        // Heartbeat cada 30s para mantener conexión
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.event === 'postgres_changes' && msg.payload?.data) {
            const record = msg.payload.data.record;
            if (record) {
              const entry = nt8TradeToEntry(record);
              upsertEntry(entry);
              console.log('SF NinjaTrader: trade recibido en tiempo real', entry);
            }
          }
        } catch (err) {
          console.warn('SF NinjaTrader: error parsing message', err);
        }
      };

      ws.onclose = () => {
        console.warn('SF NinjaTrader Realtime: desconectado, reconectando en 5s...');
        updateNinjaStatus('desconectado');
        clearInterval(heartbeatInterval);
        reconnectTimeout = setTimeout(connect, 5000);
      };

      ws.onerror = (err) => {
        console.warn('SF NinjaTrader Realtime: error', err);
        updateNinjaStatus('error');
      };
    }

    connect();
  }

  // ── Indicador de estado en el sidebar del dashboard ──────────────
  function injectNinjaStatusBadge() {
    // Espera a que el sidebar esté listo
    const sidebar = document.querySelector('.sidebar') || document.querySelector('#sidebar');
    if (!sidebar) {
      setTimeout(injectNinjaStatusBadge, 800);
      return;
    }

    const badge = document.createElement('div');
    badge.id = 'sf-ninja-badge';
    badge.style.cssText = `
      display:flex; align-items:center; gap:6px;
      padding:6px 10px; margin:8px 10px 0;
      border-radius:8px; border:1px solid #252530;
      background:#111118; font-size:10px;
      color:#55556a; cursor:default;
    `;
    badge.innerHTML = `
      <span id="sf-ninja-dot" style="width:7px;height:7px;border-radius:50%;background:#ffae30;flex-shrink:0"></span>
      <span id="sf-ninja-label">NinjaTrader · conectando</span>
    `;
    sidebar.prepend(badge);
  }

  function updateNinjaStatus(state) {
    const dot   = document.getElementById('sf-ninja-dot');
    const label = document.getElementById('sf-ninja-label');
    if (!dot || !label) return;

    const states = {
      conectado:    { color: '#27d97a', text: 'NinjaTrader · activo' },
      desconectado: { color: '#ff4f4f', text: 'NinjaTrader · sin conexión' },
      error:        { color: '#ff4f4f', text: 'NinjaTrader · error' },
      conectando:   { color: '#ffae30', text: 'NinjaTrader · conectando' }
    };

    const s = states[state] || states.conectando;
    dot.style.background = s.color;
    label.textContent    = s.text;
  }

  // ── Arranque ──────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(async () => {
      injectNinjaStatusBadge();
      await loadNT8History();
      startRealtimeListener();
    }, 1000);
  });

})();
