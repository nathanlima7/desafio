// ---------- utils ----------
function money(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

// ---------- dashboard ----------
async function loadDashboard() {
  const me = await fetch('/api/me').then(r => r.ok ? r.json() : null);
  if (!me) {
    window.location.href = '/index.html';
    return;
  }
  
  // Preenche nome e inicial
  document.getElementById('user-name').textContent = me.name;
  document.getElementById('user-initial').textContent = me.name.charAt(0).toUpperCase();

  // Saldo
  const { balance } = await fetch('/api/balance').then(r => r.json());
  document.getElementById('balance').textContent = money(balance);

  // Extrato
  const txs = await fetch('/api/transactions').then(r => r.json());
  const list = document.getElementById('tx-list');

  if (!txs.length) {
    list.innerHTML = '<li style="text-align:center;color:#999;padding:20px;background:#fff;border-radius:12px;">Nenhuma transação ainda</li>';
  } else {
    list.innerHTML = txs.map(t => {
      const isDebit = t.type === 'debit';
      return `
      <li class="tx-item">
        <div class="tx-icon ${isDebit ? '' : 'credit'}">
          ${isDebit ? '↗' : '↙'}
        </div>
        <div class="tx-info">
          <div class="tx-desc">${t.description}</div>
          <div class="tx-date">${new Date(t.createdAt).toLocaleString('pt-BR')}</div>
        </div>
        <div class="tx-amount ${isDebit ? '' : 'credit'}">
          ${isDebit ? '-' : '+'} ${money(t.amount)}
        </div>
      </li>
      `;
    }).join('');
  }

  // Botões
  document.getElementById('btn-pay').addEventListener('click', () => {
    window.location.href = '/scanner.html';
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/index.html';
  });
}

// ---------- scanner (mantido igual) ----------
function startScanner() {
  const msg = document.getElementById('message');

  const scanner = new Html5Qrcode('reader');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: 250 },
    async (decodedText) => {
      msg.className = 'scanner-message';
      msg.textContent = 'QR lido! Processando pagamento...';
      await scanner.stop();

      try {
        const resp = await fetch('/api/pay-qr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qrPayload: decodedText })
        });
        const data = await resp.json();

        if (!resp.ok) {
          msg.className = 'scanner-message error';
          msg.textContent = '❌ ' + (data.error || 'Falha no pagamento');
          setTimeout(() => window.location.href = '/dashboard.html', 3000);
          return;
        }

        msg.className = 'scanner-message success';
        msg.textContent = `✅ Pago: ${money(data.amount)}. Novo saldo: ${money(data.newBalance)}`;
        setTimeout(() => window.location.href = '/dashboard.html', 2000);
      } catch (err) {
        msg.className = 'scanner-message error';
        msg.textContent = '❌ Erro de rede';
      }
    },
    (error) => { /* ignora frames sem QR */ }
  ).catch(err => {
    msg.className = 'scanner-message error';
    msg.textContent = '❌ Erro na câmera: ' + err.message;
  });

  document.getElementById('btn-cancel').addEventListener('click', async () => {
    await scanner.stop();
    window.location.href = '/dashboard.html';
  });
}