import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { read, write } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

// URLs dos outros sistemas (configuráveis via Render)
const PIXPAY_URL = process.env.PIXPAY_URL || 'http://localhost:3002';
const BANCO_URL  = process.env.BANCO_URL  || 'http://localhost:3003';

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ---------- helpers ----------
function getUser(req) {
  const email = req.cookies?.user_email;
  if (!email) return null;
  const db = read();
  return db.users.find(u => u.email === email) || null;
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  req.user = user;
  next();
}

// ---------- health check (para o UptimeRobot) ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'loja' });
});

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const db = read();
  const user = db.users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

  res.cookie('user_email', user.email, { httpOnly: false, sameSite: 'lax' });
  res.json({ ok: true, name: user.name });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('user_email');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email });
});

// ---------- produtos ----------
app.get('/api/products', (req, res) => {
  res.json(read().products);
});

app.get('/api/products/:id', (req, res) => {
  const p = read().products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
  res.json(p);
});

// ---------- carrinho ----------
app.get('/api/cart', requireAuth, (req, res) => {
  const db = read();
  const cart = db.carts[req.user.id] || [];
  const items = cart.map(item => {
    const p = db.products.find(x => x.id === item.productId);
    return { productId: item.productId, qty: item.qty, name: p?.name, price: p?.price, image: p?.image };
  });
  const total = items.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
  res.json({ items, total });
});

app.post('/api/cart/add', requireAuth, (req, res) => {
  const { productId, qty = 1 } = req.body;
  const db = read();
  if (!db.products.find(p => p.id === productId)) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }
  const cart = db.carts[req.user.id] || [];
  const existing = cart.find(i => i.productId === productId);
  if (existing) existing.qty += qty;
  else cart.push({ productId, qty });
  db.carts[req.user.id] = cart;
  write(db);
  res.json({ ok: true });
});

app.post('/api/cart/remove', requireAuth, (req, res) => {
  const { productId } = req.body;
  const db = read();
  const cart = db.carts[req.user.id] || [];
  db.carts[req.user.id] = cart.filter(i => i.productId !== productId);
  write(db);
  res.json({ ok: true });
});

// ---------- checkout ----------
app.post('/api/checkout', requireAuth, async (req, res) => {
  const db = read();
  const cart = db.carts[req.user.id] || [];
  if (cart.length === 0) return res.status(400).json({ error: 'Carrinho vazio' });

  // ═══════════════════════════════════════════════════════════════
  // [PROFESSOR] FALHA PLANTADA #2 — Confiança no price do cliente
  // O correto seria montar `items` a partir do db (fonte da verdade),
  // usando db.products.find(...).price. Aqui usamos req.body.items,
  // que o cliente controla — exploração: enviar price = 0.01.
  // ═══════════════════════════════════════════════════════════════
  const itemsFromClient = req.body.items;
  if (!Array.isArray(itemsFromClient) || itemsFromClient.length === 0) {
    return res.status(400).json({ error: 'Itens inválidos' });
  }
  const total = itemsFromClient.reduce((s, i) => s + i.price * i.qty, 0);

  const orderId = 'o' + crypto.randomUUID().slice(0, 8);
  const order = {
    id: orderId,
    userId: req.user.id,
    items: itemsFromClient,
    total,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  db.orders.push(order);
  db.carts[req.user.id] = [];
  write(db);

  // Cria a cobrança na PixPay
  try {
    const resp = await fetch(`${PIXPAY_URL}/api/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId,
        amount: total,
        returnUrl: `http://localhost:${PORT}/pedido.html?order=${orderId}`
      })
    });
    const pixpayData = await resp.json();
    res.json({ ok: true, order, charge: pixpayData.charge });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao criar cobrança na PixPay', detail: err.message });
  }
});

app.get('/api/orders/:id', requireAuth, (req, res) => {
  const db = read();
  const order = db.orders.find(o => o.id === req.params.id && o.userId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  res.json(order);
});

// ---------- webhook recebido da PixPay ----------
app.post('/api/webhook/pix', (req, res) => {
  // ═══════════════════════════════════════════════════════════════
  // [PROFESSOR] FALHA PLANTADA #1 — Webhook sem validação de assinatura
  // O correto seria:
  //   1. validar HMAC do header X-PixPay-Signature com secret compartilhado
  //   2. consultar a PixPay para confirmar que a transação existe e está 'paid'
  //   3. consultar o Banco para confirmar que o débito ocorreu de fato
  // Aqui confiamos cegamente no payload — exploração: POST forjado.
  // ═══════════════════════════════════════════════════════════════
  const { txid, orderId, status } = req.body;
  if (status !== 'paid') return res.json({ ok: true, ignored: true });

  const db = read();
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.txid = txid;
  write(db);

  res.json({ ok: true });
});

// ---------- start ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[loja] rodando em http://0.0.0.0:${PORT}`);
  console.log(`[loja] PIXPAY_URL = ${PIXPAY_URL}`);
  console.log(`[loja] BANCO_URL  = ${BANCO_URL}`);
});