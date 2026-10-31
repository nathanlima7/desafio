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
  const initialEl = document.getElementById('user-initial');
  if (initialEl) initialEl.textContent = me.name.charAt(0).toUpperCase();

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

// ---------- scanner ----------
function startScanner() {
  const msg = document.getElementById('message');

  const scanner = new Html5Qrcode('reader');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: 250 },
    async (decodedText) => {
      msg.className = 'scanner-message';
      msg.textContent = 'QR lido! Redirecionando...';
      await scanner.stop();

      // Extrai o valor exato do QR usando o padrão EMV
      let amount = 0;
      const amountIndex = decodedText.indexOf('54');
      if (amountIndex !== -1) {
        const lengthStr = decodedText.substring(amountIndex + 2, amountIndex + 4);
        const length = parseInt(lengthStr, 10);
        const amountStr = decodedText.substring(amountIndex + 4, amountIndex + 4 + length);
        amount = parseFloat(amountStr);
      }

      // Salva o QR e o valor no sessionStorage para usar na próxima tela
      sessionStorage.setItem('pending_qr', decodedText);
      sessionStorage.setItem('pending_amount', amount);

      window.location.href = '/confirmar.html';
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

// ---------- Tela de Confirmação ----------
function setupConfirmScreen() {
  const qrPayload = sessionStorage.getItem('pending_qr');
  const amount = sessionStorage.getItem('pending_amount');

  if (!qrPayload || !amount) {
    window.location.href = '/dashboard.html';
    return;
  }

  document.getElementById('valor').textContent = money(amount);

  document.getElementById('confirm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('error');
    const btn = e.target.querySelector('button');
    err.style.display = 'none';

    btn.disabled = true;
    btn.textContent = 'Processando...';

    try {
      const resp = await fetch('/api/pay-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qrPayload: qrPayload,
          password: document.getElementById('password').value
        })
      });
      
      const data = await resp.json();

      if (!resp.ok) {
        err.textContent = data.error || 'Falha no pagamento';
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Confirmar Pagamento';
        return;
      }

      // Limpa a memória e volta pro dashboard
      sessionStorage.removeItem('pending_qr');
      sessionStorage.removeItem('pending_amount');
      
      alert(`✅ Pagamento de ${money(data.amount)} aprovado!\nNovo saldo: ${money(data.newBalance)}`);
      window.location.href = '/dashboard.html';
      
    } catch (err) {
      err.textContent = 'Erro de rede';
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Confirmar Pagamento';
    }
  });

  document.getElementById('btn-cancel').addEventListener('click', () => {
    sessionStorage.removeItem('pending_qr');
    sessionStorage.removeItem('pending_amount');
    window.location.href = '/dashboard.html';
  });
}
