import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { read, write } from './db.js';

const app = express();
const PORT = process.env.PORT || 3003;

// URL da PixPay (para validação e para avisar sobre o pagamento)
const PIXPAY_URL = process.env.PIXPAY_URL || 'http://localhost:3002';

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ---------- helpers ----------
function getUser(req) {
  const email = req.cookies?.bank_user;
  if (!email) return null;
  return read().users.find(u => u.email === email) || null;
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  req.user = user;
  next();
}

// ---------- health check ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'banco' });
});

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const db = read();
  const user = db.users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

  res.cookie('bank_user', user.email, { httpOnly: false, sameSite: 'lax' });
  res.json({ ok: true, name: user.name });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('bank_user');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email });
});

// ---------- saldo e extrato ----------
app.get('/api/balance', requireAuth, (req, res) => {
  res.json({ balance: req.user.balance });
});

app.get('/api/transactions', requireAuth, (req, res) => {
  const db = read();
  const txs = db.transactions
    .filter(t => t.email === req.user.email)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(txs);
});

// ---------- pagar QR (chamado pelo app do banco quando escaneia) ----------
app.post('/api/pay-qr', requireAuth, async (req, res) => {
  const { qrPayload } = req.body;
  if (!qrPayload) return res.status(400).json({ error: 'qrPayload é obrigatório' });

  // Extrai txid e amount do payload EMV fictício
  // Formato: ...0136TX-xxxxxxxx...54XX<amount>...
  const txidMatch = qrPayload.match(/0136(TX-[a-f0-9]{8})/);
  const amountMatch = qrPayload.match(/54(\d{2})([\d.]+)/);

  if (!txidMatch || !amountMatch) {
    return res.status(400).json({ error: 'QR Code inválido ou não reconhecido' });
  }

  const txid = txidMatch[1];
  const amount = parseFloat(amountMatch[2]);

  // ═══════════════════════════════════════════════════════════════
  // [PROFESSOR] FALHA PLANTADA #4 — Não valida o amount do QR contra a PixPay
  // O correto seria consultar a PixPay: GET /api/transactions/:txid
  // e garantir que tx.amount === amount (o valor do QR).
  // Aqui confiamos no valor que veio no QR, que o aluno pode gerar
  // sozinho com amount = 0.01 e escanear no app.
  // ═══════════════════════════════════════════════════════════════
  try {
    const resp = await fetch(`${PIXPAY_URL}/api/transactions/${txid}`);
    if (!resp.ok) {
      return res.status(404).json({ error: 'Cobrança não encontrada na PixPay' });
    }
    // (A validação do amount deveria estar aqui — mas não está)
  } catch (err) {
    return res.status(502).json({ error: 'Falha ao consultar a PixPay' });
  }

  // ═══════════════════════════════════════════════════════════════
  // [PROFESSOR] FALHA PLANTADA #3 — Race condition no débito
  // O padrão correto é uma transação atômica:
  //   UPDATE users SET balance = balance - ? WHERE email = ? AND balance >= ?
  // e verificar se a linha foi afetada.
  // Aqui fazemos SELECT + write separados, o que permite
  // duas requisições simultâneas passarem pelo `if` de saldo antes do write.
  // ═══════════════════════════════════════════════════════════════
  const db = read();
  const user = db.users.find(u => u.email === req.user.email);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.balance < amount) {
    return res.status(402).json({ error: 'Saldo insuficiente' });
  }
  user.balance -= amount;
  db.transactions.push({
    id: 't' + crypto.randomUUID().slice(0, 8),
    email: user.email,
    amount,
    txid,
    type: 'debit',
    description: `Pix via app — ${txid}`,
    createdAt: new Date().toISOString()
  });
  write(db);

  // Avisa a PixPay que o pagamento foi feito
  try {
    await fetch(`${PIXPAY_URL}/api/confirm/${txid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payerEmail: user.email })
    });
  } catch (err) {
    console.error('[banco] erro ao confirmar na PixPay:', err.message);
  }

  res.json({ ok: true, newBalance: user.balance, amount, txid });
});

// ---------- transferência direta (chamada pela PixPay no fluxo server-to-server) ----------
app.post('/api/transfer', async (req, res) => {
  const { email, amount, description } = req.body;
  if (!email || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'email e amount são obrigatórios' });
  }

  const db = read();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'Conta não encontrada' });
  if (user.balance < amount) return res.status(402).json({ error: 'Saldo insuficiente' });

  user.balance -= amount;
  db.transactions.push({
    id: 't' + crypto.randomUUID().slice(0, 8),
    email: user.email,
    amount,
    txid: null,
    type: 'debit',
    description: description || 'Pix',
    createdAt: new Date().toISOString()
  });
  write(db);

  res.json({ ok: true, newBalance: user.balance });
});

// ---------- start ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[banco] rodando em http://0.0.0.0:${PORT}`);
  console.log(`[banco] PIXPAY_URL = ${PIXPAY_URL}`);
});