// ---------- utils ----------
function money(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

function getTxidFromUrl() {
  const parts = window.location.pathname.split('/');
  return parts[parts.length - 1];
}

// ---------- carregar transação ----------
async function loadTransaction() {
  const txid = getTxidFromUrl();
  document.getElementById('txid').textContent = txid;

  const resp = await fetch(`/api/transactions/${txid}`);
  if (!resp.ok) {
    showStatus('Transação não encontrada', 'error');
    return null;
  }

  const tx = await resp.json();

  document.getElementById('amount').textContent = money(tx.amount);

  if (tx.status === 'paid') {
    document.getElementById('qr').style.display = 'none';
    document.getElementById('pix-code').style.display = 'none';
    document.getElementById('btn-pay').style.display = 'none';
    showStatus('✅ Pagamento confirmado!', 'paid');

    if (tx.returnUrl) {
      const back = document.createElement('button');
      back.className = 'btn-secondary';
      back.textContent = 'Voltar para a loja';
      back.onclick = () => { window.location.href = tx.returnUrl; };
      document.getElementById('card').appendChild(back);
    }
    return tx;
  }

  // Pendente: precisa do QR e do código Pix
  // A rota /api/transactions/:txid não devolve QR (só o /api/charges devolve).
  // Para simplificar, geramos o QR no cliente usando o txid + amount.
  // Em produção, a PixPay armazenaria o QR junto da transação.
  await loadQrCode(tx);

  return tx;
}

// ---------- gerar QR no cliente (fallback didático) ----------
// A PixPay já gera QR no /api/charges e o devolve para a Loja.
// Mas se o aluno abrir /pay/:txid direto, precisamos de um QR.
// Solução simples: pedir um QR sob demanda ao backend.
async function loadQrCode(tx) {
  // Pede ao backend um QR Code específico desta transação.
  // Adicionamos uma rota /api/qr/:txid no server.js (abaixo).
  const resp = await fetch(`/api/qr/${tx.txid}`);
  if (resp.ok) {
    const { qrCode, pixPayload } = await resp.json();
    document.getElementById('qr').src = qrCode;
    document.getElementById('pix-code').textContent = pixPayload;
  }
}

// ---------- status ----------
function showStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
  el.style.display = 'block';
}

// ---------- pagar ----------
async function pay(txid) {
  const payerEmail = prompt(
    'E-mail da conta do CyberBank que vai pagar:',
    'aluno@techparts.local'
  );
  if (!payerEmail) return;

  const btn = document.getElementById('btn-pay');
  btn.disabled = true;
  btn.textContent = 'Processando...';

  const resp = await fetch(`/api/pay/${txid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payerEmail })
  });

  const data = await resp.json();

  if (!resp.ok) {
    showStatus('❌ ' + (data.error || 'Falha no pagamento'), 'error');
    btn.disabled = false;
    btn.textContent = 'Simular pagamento no app do banco';
    return;
  }

  showStatus('✅ Pagamento confirmado!', 'paid');

  const tx = await fetch(`/api/transactions/${txid}`).then(r => r.json());
  if (tx.returnUrl) {
    setTimeout(() => { window.location.href = tx.returnUrl; }, 1500);
  }
}

// ---------- copiar código ----------
document.getElementById('pix-code').addEventListener('click', () => {
  const code = document.getElementById('pix-code').textContent;
  navigator.clipboard.writeText(code);
  showStatus('Código Pix copiado!', 'pending');
});

// ---------- init ----------
(async () => {
  const txid = getTxidFromUrl();
  await loadTransaction();

  document.getElementById('btn-pay').addEventListener('click', () => pay(txid));

  // Polling: se a transação mudar de status enquanto a página está aberta
  setInterval(async () => {
    const tx = await fetch(`/api/transactions/${txid}`).then(r => r.json()).catch(() => null);
    if (tx && tx.status === 'paid' && document.getElementById('btn-pay').style.display !== 'none') {
      window.location.reload();
    }
  }, 3000);
})();