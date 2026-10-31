// ---------- utils ----------
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

function money(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

async function renderHeader() {
  const userArea = document.getElementById('user-area');
  if (!userArea) return;

  const me = await fetch('/api/me').then(r => r.ok ? r.json() : null);
  if (!me) {
    userArea.innerHTML = '<a href="login.html">Entrar</a>';
    return;
  }
  userArea.innerHTML = `Olá, <strong>${me.name}</strong> | <a href="#" id="logout">Sair</a>`;
  document.getElementById('logout')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = 'login.html';
  });
}

// ---------- catálogo ----------
async function renderCatalog() {
  await renderHeader();

  const grid = document.getElementById('grid');
  if (!grid) return;

  const products = await fetch('/api/products').then(r => r.json());
  grid.innerHTML = products.map(p => `
    <div class="card">
      <div class="thumb">${p.image}</div>
      <div class="body">
        <h3>${p.name}</h3>
        <div class="desc">${p.description}</div>
        <div class="price">${money(p.price)}</div>
        <button data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>
          ${p.stock <= 0 ? 'Esgotado' : 'COMPRAR'}
        </button>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('button[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const resp = await fetch('/api/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: btn.dataset.id, qty: 1 })
      });
      if (resp.status === 401) {
        window.location.href = 'login.html';
        return;
      }
      if (!resp.ok) { toast('Erro ao adicionar'); return; }
      toast('Produto adicionado ao carrinho');
    });
  });
}

// ---------- carrinho ----------
async function renderCart() {
  await renderHeader();

  const empty = document.getElementById('empty');
  const content = document.getElementById('cart-content');
  if (!content) return;

  const data = await fetch('/api/cart').then(r => r.ok ? r.json() : { items: [], total: 0 });

  if (!data.items || data.items.length === 0) {
    empty.style.display = 'block';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = 'block';

  document.getElementById('cart-body').innerHTML = data.items.map(i => `
    <tr>
      <td>${i.image || ''} ${i.name}</td>
      <td>${money(i.price)}</td>
      <td>${i.qty}</td>
      <td>${money(i.price * i.qty)}</td>
      <td><button class="btn-danger" data-remove="${i.productId}">Remover</button></td>
    </tr>
  `).join('');

  document.getElementById('total').textContent = money(data.total);

  document.querySelectorAll('button[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch('/api/cart/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: btn.dataset.remove })
      });
      renderCart();
    });
  });

  document.getElementById('btn-checkout').addEventListener('click', async () => {
    // ⚠️ Este é o payload que o aluno pode interceptar e alterar
    // A falha #2 será explorada aqui: ele muda o `price` dos itens
    const resp = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: data.items.map(i => ({
          productId: i.productId,
          name: i.name,
          price: i.price,
          qty: i.qty
        }))
      })
    });

    if (!resp.ok) {
      const d = await resp.json();
      toast('Erro: ' + (d.error || 'desconhecido'));
      return;
    }

    const result = await resp.json();
    // Redireciona para a PixPay (o aluno vê o QR Code)
    if (result.charge?.url) {
      window.location.href = result.charge.url;
    } else {
      toast('Pedido criado, mas sem URL de pagamento');
    }
  });
}