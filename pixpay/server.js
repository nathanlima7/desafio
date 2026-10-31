import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { read, write, update } from './db.js';

const app = express();
const PORT = process.env.PORT || 3002;

// URLs dos outros sistemas
const LOJA_URL  = process.env.LOJA_URL  || 'http://localhost:3001';
const BANCO_URL = process.env.BANCO_URL || 'http://localhost:3003';

// Segredo compartilhado com a Loja para assinar o webhook.
// Em produção, isso viria de variável de ambiente e seria rotacionado.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'pixpay-dev-secret-123';

app.use(express.json());
app.use(express.static('public'));

// ---------- health check ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pixpay' });
});

// ---------- criar cobrança (chamado pela Loja) ----------
app.post('/api/charges', async (req, res) => {
  const { orderId, amount, returnUrl } = req.body;

  if (!orderId || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'orderId e amount são obrigatórios' });
  }

  const txid = 'TX-' + crypto.randomUUID().slice(0, 8);

  const transaction = {
    txid,
    orderId,
    amount,
    returnUrl: returnUrl || null,
    status: 'pending',
    payerEmail: null,
    createdAt: new Date().toISOString(),
    paidAt: null
  };

  update(db => { db.transactions.push(transaction); });

  // Gera o QR Code como data URL (base64 PNG)
  // O conteúdo do QR é um "Pix copia-e-cola" fictício, só para parecer real
  const pixPayload = `00020126580014br.gov.bcb.pix0136${txid}520400005303986540${amount.toFixed(2)}5802BR5909PIXPAY6008BRASILIA62070503***6304ABCD`;
  const qrDataUrl = await QRCode.toDataURL(pixPayload, { width: 280, margin: 1 });

  res.json({
    ok: true,
    charge: {
      txid,
      amount,
      qrCode: qrDataUrl,
      pixPayload,
      url: `${req.protocol}://${req.get('host')}/pay/${txid}`
    }
  });
});

// ---------- consultar transação ----------
app.get('/api/transactions/:txid', (req, res) => {
  const db = read();
  const tx = db.transactions.find(t => t.txid === req.params.txid);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });
  res.json(tx);
});

// ---------- gerar QR sob demanda ----------
app.get('/api/qr/:txid', async (req, res) => {
  const db = read();
  const tx = db.transactions.find(t => t.txid === req.params.txid);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });

  const pixPayload = `00020126580014br.gov.bcb.pix0136${tx.txid}520400005303986540${tx.amount.toFixed(2)}5802BR5909PIXPAY6008BRASILIA62070503***6304ABCD`;
  const qrCode = await QRCode.toDataURL(pixPayload, { width: 280, margin: 1 });

  res.json({ qrCode, pixPayload });
});

// ---------- página de pagamento ----------
app.get('/pay/:txid', (req, res) => {
  res.sendFile('pay.html', { root: 'public' });
});

// ---------- simular pagamento (chamado pelo cliente na página) ----------
app.post('/api/pay/:txid', async (req, res) => {
  const { txid } = req.params;
  const { payerEmail } = req.body;

  const db = read();
  const tx = db.transactions.find(t => t.txid === txid);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });
  if (tx.status === 'paid') return res.status(400).json({ error: 'Transação já paga' });
  if (!payerEmail) return res.status(400).json({ error: 'payerEmail é obrigatório' });

  // 1) Chama o Banco para debitar
  let bankOk = false;
  try {
    const bankResp = await fetch(`${BANCO_URL}/api/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: payerEmail,
        amount: tx.amount,
        description: `PixPay ${tx.txid} (Pedido ${tx.orderId})`
      })
    });
    if (bankResp.ok) {
      const bankData = await bankResp.json();
      bankOk = bankData.ok === true;
    }
  } catch (err) {
    console.error('[pixpay] erro ao chamar banco:', err.message);
  }

  if (!bankOk) {
    return res.status(402).json({ error: 'Pagamento recusado pelo banco (saldo insuficiente ou erro)' });
  }

  // 2) Marca a transação como paga
  update(db => {
    const t = db.transactions.find(x => x.txid === txid);
    t.status = 'paid';
    t.payerEmail = payerEmail;
    t.paidAt = new Date().toISOString();
  });

  // 3) Notifica a Loja via webhook
  // ═══════════════════════════════════════════════════════════════
  // [PROFESSOR] Aqui a PixPay faz o correto: assina o payload com HMAC.
  // O problema (falha #1) está no LADO DA LOJA, que recebe a assinatura
  // e NÃO VALIDA. O aluno pode forjar um POST direto para
  // /api/webhook/pix da Loja, sem passar pela PixPay, e a Loja aceita.
  //
  // Se quiser tornar a falha ainda mais didática, você pode:
  //   - Deixar a assinatura visível no header (o aluno vê o formato)
  //   - Não assinar (aí a falha fica ainda mais óbvia)
  // Aqui mantemos a assinatura para o cenário ser realista.
  // ═══════════════════════════════════════════════════════════════
  const webhookBody = JSON.stringify({
    txid: tx.txid,
    orderId: tx.orderId,
    status: 'paid',
    amount: tx.amount,
    paidAt: new Date().toISOString()
  });

  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(webhookBody)
    .digest('hex');

  try {
    await fetch(`${LOJA_URL}/api/webhook/pix`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PixPay-Signature': signature
      },
      body: webhookBody
    });
  } catch (err) {
    console.error('[pixpay] erro ao notificar loja:', err.message);
    // Não falha o pagamento por causa disso; a loja pode reconciliar depois
  }

  res.json({ ok: true, txid, status: 'paid' });
});

// ---------- confirmar pagamento (chamado pelo Banco) ----------
app.post('/api/confirm/:txid', async (req, res) => {
  const { txid } = req.params;
  const { payerEmail } = req.body;

  const db = read();
  const tx = db.transactions.find(t => t.txid === txid);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });

  if (tx.status === 'paid') {
    return res.json({ ok: true, alreadyPaid: true });
  }

  update(db => {
    const t = db.transactions.find(x => x.txid === txid);
    t.status = 'paid';
    t.payerEmail = payerEmail || t.payerEmail;
    t.paidAt = new Date().toISOString();
  });

  // Notifica a Loja (webhook com HMAC, que a Loja não valida — falha #1)
  const webhookBody = JSON.stringify({
    txid: tx.txid,
    orderId: tx.orderId,
    status: 'paid',
    amount: tx.amount,
    paidAt: new Date().toISOString()
  });
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(webhookBody)
    .digest('hex');

  try {
    await fetch(`${LOJA_URL}/api/webhook/pix`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PixPay-Signature': signature
      },
      body: webhookBody
    });
  } catch (err) {
    console.error('[pixpay] erro ao notificar loja:', err.message);
  }

  res.json({ ok: true });
});

// ---------- start ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[pixpay] rodando em http://0.0.0.0:${PORT}`);
  console.log(`[pixpay] LOJA_URL  = ${LOJA_URL}`);
  console.log(`[pixpay] BANCO_URL = ${BANCO_URL}`);
});