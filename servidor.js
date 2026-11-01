'use strict';
/*
 * Scriptorium — servidor dos estudos: banco de estudos, latim e violino.
 * Guarda tudo num arquivo JSON dentro do disco do Railway (sem banco externo),
 * cuida do login e avisa os aparelhos abertos quando algo muda.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORTA = process.env.PORT || 3000;
function discoEm(p) { try { return fs.statSync(p).isDirectory() && fs.statSync(p).dev !== fs.statSync(__dirname).dev; } catch (e) { return false; } }
const DADOS = path.resolve(process.env.SCRIPTORIUM_DADOS || process.env.RAILWAY_VOLUME_MOUNT_PATH || (discoEm('/data') ? '/data' : path.join(__dirname, 'dados')));
const ARQ = path.join(DADOS, 'scriptorium.json');
const BACKUPS = path.join(DADOS, 'backups');
const FUSO = process.env.FUSO || 'America/Sao_Paulo';
const COLECOES = new Set(['banco', 'sessoes', 'vocab', 'estado']);
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
const DIAS_SESSAO = 90;
const COPIAS = 30;

/* ---------- Armazenamento ---------- */
fs.mkdirSync(BACKUPS, { recursive: true });
let db = { usuarios: [], sessoes: {}, docs: {}, apagados: {}, seq: 0 };
if (fs.existsSync(ARQ)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(ARQ, 'utf8'))); }
  catch (e) { console.error('Não consegui ler ' + ARQ + '. Corrija ou restaure uma cópia da pasta backups/. Nada foi apagado.', e.message); process.exit(1); }
}
let timerGravar = null, ultimoErroGravar = '', ultimaGravacao = 0;
function gravar() { clearTimeout(timerGravar); timerGravar = setTimeout(gravarAgora, 250); }
function gravarAgora() {
  timerGravar = null;
  if (!db.criadoEm) db.criadoEm = new Date().toISOString();
  try {
    const tmp = ARQ + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, ARQ);
    ultimaGravacao = Date.now(); ultimoErroGravar = '';
  } catch (e) { ultimoErroGravar = e.message; console.error('[dados] NÃO consegui gravar em ' + ARQ + ': ' + e.message); }
}
const NO_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
function discoSeparado() { try { return fs.statSync(DADOS).dev !== fs.statSync(__dirname).dev; } catch (e) { return false; } }
function dadosPersistentes() {
  if (!NO_RAILWAY) return true;
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH || (DADOS === '/data' ? '/data' : '');
  return !!vol && (DADOS === path.resolve(vol) || DADOS.startsWith(path.resolve(vol) + path.sep)) && discoSeparado();
}
const INICIADO = new Date();
function encerrar() { if (timerGravar) gravarAgora(); process.exit(0); }
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

function hojeNoFuso() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}
function copiaDeSeguranca(nome) {
  if (timerGravar) gravarAgora();
  if (!fs.existsSync(ARQ)) return;
  fs.copyFileSync(ARQ, path.join(BACKUPS, nome));
  const antigos = fs.readdirSync(BACKUPS).filter(f => /^scriptorium-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  antigos.slice(0, Math.max(0, antigos.length - COPIAS)).forEach(f => { try { fs.unlinkSync(path.join(BACKUPS, f)); } catch (e) {} });
}
function backupDiario() {
  const alvo = 'scriptorium-' + hojeNoFuso() + '.json';
  if (db.usuarios.length && !fs.existsSync(path.join(BACKUPS, alvo))) copiaDeSeguranca(alvo);
}
setInterval(backupDiario, 30 * 60 * 1000);
setTimeout(backupDiario, 5000);

/* ---------- Utilidades ---------- */
class Erro extends Error { constructor(m, status) { super(m); this.status = status || 400; } }
function novoId(prefixo) { return prefixo + crypto.randomBytes(9).toString('base64url'); }
function normNome(n) { return String(n || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function hashSenha(senha) { const sal = crypto.randomBytes(16).toString('hex'); return sal + ':' + crypto.scryptSync(String(senha), sal, 64).toString('hex'); }
function senhaConfere(senha, guardado) {
  const [sal, h] = String(guardado || '').split(':'); if (!sal || !h) return false;
  const x = crypto.scryptSync(String(senha), sal, 64), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function validarNome(n) { n = String(n || '').trim(); if (n.length < 1 || n.length > 40) throw new Erro('O nome precisa ter entre 1 e 40 letras.'); return n; }
function validarSenha(s) { s = String(s || ''); if (s.length < 6 || s.length > 100) throw new Erro('A senha precisa ter pelo menos 6 caracteres.'); return s; }
function cookies(req) {
  const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return o;
}
function perfil(u) { return { id: u.id, nome: u.nome, admin: !!u.admin }; }
function caminho(col, id) {
  if (!COLECOES.has(col)) throw new Erro('Coleção desconhecida: ' + col);
  if (!SEG.test(String(id || ''))) throw new Erro('Identificador inválido.');
  return col + '/' + id;
}
function objeto(d) { if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Erro('Os dados precisam ser um objeto.'); return d; }
function mesclar(alvo, novo) {
  for (const k of Object.keys(novo)) {
    const v = novo[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && alvo[k] && typeof alvo[k] === 'object' && !Array.isArray(alvo[k])) mesclar(alvo[k], v);
    else alvo[k] = v;
  }
  return alvo;
}

/* ---------- Sessões ---------- */
function abrirSessao(req, res, u) {
  const t = crypto.randomBytes(32).toString('hex');
  db.sessoes[t] = { uid: u.id, criada: Date.now() }; gravar();
  res.set('Set-Cookie', 'scriptorium_sessao=' + t + '; HttpOnly; Path=/; Max-Age=' + (DIAS_SESSAO * 86400) + '; SameSite=Lax' + (req.secure ? '; Secure' : ''));
}
function usuarioDe(req) {
  const t = cookies(req).scriptorium_sessao, s = t && db.sessoes[t];
  if (!s) return null;
  if (Date.now() - s.criada > DIAS_SESSAO * 864e5) { delete db.sessoes[t]; gravar(); return null; }
  return db.usuarios.find(u => u.id === s.uid) || null;
}
const tentativas = new Map();
function limitarLogin(req) {
  const ip = req.ip || 'x', t = tentativas.get(ip);
  if (t && t.ate > Date.now() && t.n >= 8) throw new Erro('Muitas tentativas. Espere 15 minutos e tente de novo.', 429);
}
function falhouLogin(req) {
  const ip = req.ip || 'x', t = tentativas.get(ip);
  if (!t || t.ate < Date.now()) tentativas.set(ip, { n: 1, ate: Date.now() + 15 * 60 * 1000 }); else t.n++;
}

/* ---------- Avisos ao vivo (cada aparelho aberto recebe o número da última mudança) ---------- */
const ouvintes = new Set();
function avisar() { const msg = 'data: ' + db.seq + '\n\n'; for (const r of ouvintes) { try { r.write(msg); } catch (e) {} } }
setInterval(() => { for (const r of ouvintes) { try { r.write(': ping\n\n'); } catch (e) {} } }, 25000);
function escrever(p, dados, uid) {
  db.seq++;
  if (dados === null) { delete db.docs[p]; db.apagados[p] = db.seq; }
  else { db.docs[p] = { d: dados, s: db.seq, em: new Date().toISOString(), por: uid }; delete db.apagados[p]; }
  gravar(); avisar();
  return db.seq;
}

/* ---------- Ponto de partida: latim no capítulo VI e os exercícios de violino ---------- */
function semear(uid) {
  if (Object.keys(db.docs).length) return;
  const tudo = { l1: true, l2: true, l3: true, gram: true, pa: true, pb: true, pc: true }, feitos = {};
  for (let c = 1; c <= 5; c++) feitos[c] = Object.assign({}, tudo);
  const ex = (id, nome) => ({ id, nome, foco: '', bpmMeta: null, ativo: true });
  escrever('estado/latim', { atual: 6, feitos }, uid);
  escrever('estado/violino', { exercicios: [ex('afinacao', 'Afinação em melodia'), ex('vibrato', 'Vibrato'), ex('cordas', 'Mudança de cordas'), ex('maoesq', 'Posição da mão esquerda')] }, uid);
  escrever('estado/geral', { metaLatim: 5, metaViolino: 5 }, uid);
}

/* ---------- Aplicação ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); res.set('X-Frame-Options', 'DENY'); next(); });

const RESET = '<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>';
const CABECA = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' + RESET + '<script>window.SCRIPTORIUM_SERVIDOR=1</script>' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0f0f0e" media="(prefers-color-scheme: dark)">' +
  '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Scriptorium">' +
  '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icone-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
  '<meta name="robots" content="noindex"></head><body>';
function pagina() { return CABECA + fs.readFileSync(path.join(__dirname, 'publico', 'index.html'), 'utf8') + '</body></html>'; }
const PAGINA = pagina();
app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(PAGINA); });
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').send(JSON.stringify({
  name: 'Scriptorium', short_name: 'Scriptorium', start_url: '/', display: 'standalone', background_color: '#f7f7f5', theme_color: '#f7f7f5', lang: 'pt-BR',
  icons: [{ src: '/icone-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icone-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
})));
app.use(express.static(path.join(__dirname, 'publico'), { index: false, maxAge: '7d' }));
app.get('/saude', (req, res) => res.type('text').send('ok'));
app.get('/diagnostico', (req, res) => {
  let arq = 'ainda não existe';
  try { const st = fs.statSync(ARQ); arq = (st.size / 1024).toFixed(1) + ' KB, gravado em ' + st.mtime.toISOString(); } catch (e) {}
  let teste = 'ok';
  try { const t = path.join(DADOS, '.teste-escrita'); fs.writeFileSync(t, String(Date.now())); fs.unlinkSync(t); } catch (e) { teste = 'FALHOU: ' + e.message; }
  let backups = [];
  try { backups = fs.readdirSync(BACKUPS).filter(f => f.endsWith('.json')).sort(); } catch (e) {}
  const ok = dadosPersistentes() && teste === 'ok' && !ultimoErroGravar;
  res.set('Cache-Control', 'no-store').type('text').send([
    'Scriptorium · diagnóstico dos dados', '',
    ok ? 'RESULTADO: OK. Os dados ficam no disco e sobrevivem às atualizações.' : 'RESULTADO: PROBLEMA. Veja as linhas abaixo.', '',
    'Pasta dos dados ........ ' + DADOS,
    'Volume do Railway ...... ' + (process.env.RAILWAY_VOLUME_MOUNT_PATH || (NO_RAILWAY ? 'NENHUM ligado a este serviço' : 'não está no Railway')),
    'Disco separado do app .. ' + (discoSeparado() ? 'sim' : 'NÃO'),
    'Teste de escrita ....... ' + teste,
    'Última gravação ........ ' + (ultimoErroGravar ? 'ERRO: ' + ultimoErroGravar : ultimaGravacao ? new Date(ultimaGravacao).toISOString() : 'nenhuma desde que o servidor ligou'),
    'Arquivo scriptorium.json ' + arq,
    'Dados criados em ....... ' + (db.criadoEm || '—'),
    'Contas ................. ' + db.usuarios.length,
    'Registros guardados .... ' + Object.keys(db.docs).length,
    'Cópias de segurança .... ' + (backups.length ? backups.length + ' (última: ' + backups[backups.length - 1] + ')' : 'nenhuma ainda'),
    'Servidor ligado em ..... ' + INICIADO.toISOString()
  ].join('\n'));
});

/* Toda chamada que altera algo precisa do cabeçalho X-Scriptorium (bloqueia formulários de outros sites). */
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); if (req.method !== 'GET' && req.get('X-Scriptorium') !== '1') return res.status(403).json({ erro: 'Requisição recusada.' }); next(); });
function exigir(req, res, next) { const u = usuarioDe(req); if (!u) return res.status(401).json({ erro: 'Sua sessão terminou. Entre de novo.' }); req.u = u; next(); }
function exigirAdmin(req, res, next) { if (!req.u.admin) return res.status(403).json({ erro: 'Só o administrador pode fazer isso.' }); next(); }
const rota = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => { if (!(e instanceof Erro)) console.error(e); res.status(e.status || 500).json({ erro: e instanceof Erro ? e.message : 'Erro no servidor.' }); });

app.use('/api', express.json({ limit: '8mb' }));

/* Conta */
app.get('/api/estado', (req, res) => {
  const u = usuarioDe(req);
  res.json({ primeiroAcesso: db.usuarios.length === 0, logado: !!u, usuario: u ? perfil(u) : null, semDisco: !dadosPersistentes() });
});
app.post('/api/primeiro-acesso', rota((req, res) => {
  if (db.usuarios.length) throw new Erro('O administrador já foi criado. Entre com seu nome e senha.', 403);
  const u = { id: novoId('u'), nome: validarNome(req.body.nome), senha: hashSenha(validarSenha(req.body.senha)), admin: true, criado: new Date().toISOString() };
  db.usuarios.push(u); semear(u.id); abrirSessao(req, res, u); gravar();
  res.json({ usuario: perfil(u) });
}));
app.post('/api/entrar', rota((req, res) => {
  limitarLogin(req);
  const u = db.usuarios.find(x => normNome(x.nome) === normNome(req.body.nome));
  if (!u || !senhaConfere(req.body.senha, u.senha)) { falhouLogin(req); throw new Erro('Nome ou senha incorretos.', 401); }
  tentativas.delete(req.ip || 'x');
  abrirSessao(req, res, u);
  res.json({ usuario: perfil(u) });
}));
app.post('/api/sair', (req, res) => {
  const t = cookies(req).scriptorium_sessao; if (t && db.sessoes[t]) { delete db.sessoes[t]; gravar(); }
  res.set('Set-Cookie', 'scriptorium_sessao=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});
app.post('/api/senha', exigir, rota((req, res) => {
  if (!senhaConfere(req.body.atual, req.u.senha)) throw new Erro('A senha atual não confere.', 403);
  req.u.senha = hashSenha(validarSenha(req.body.nova));
  const atual = cookies(req).scriptorium_sessao;
  for (const t in db.sessoes) if (db.sessoes[t].uid === req.u.id && t !== atual) delete db.sessoes[t];
  gravar(); res.json({ ok: true });
}));
app.get('/api/contas', exigir, (req, res) => res.json({ contas: db.usuarios.map(perfil) }));
app.post('/api/contas', exigir, exigirAdmin, rota((req, res) => {
  const nome = validarNome(req.body.nome);
  if (db.usuarios.some(u => normNome(u.nome) === normNome(nome))) throw new Erro('Já existe uma conta com esse nome.');
  db.usuarios.push({ id: novoId('u'), nome, senha: hashSenha(validarSenha(req.body.senha)), admin: !!req.body.admin, criado: new Date().toISOString() });
  gravar(); res.json({ contas: db.usuarios.map(perfil) });
}));
app.post('/api/contas/:id/senha', exigir, exigirAdmin, rota((req, res) => {
  const u = db.usuarios.find(x => x.id === req.params.id); if (!u) throw new Erro('Conta não encontrada.', 404);
  u.senha = hashSenha(validarSenha(req.body.senha));
  for (const t in db.sessoes) if (db.sessoes[t].uid === u.id) delete db.sessoes[t];
  gravar(); res.json({ ok: true });
}));
app.delete('/api/contas/:id', exigir, exigirAdmin, rota((req, res) => {
  if (req.params.id === req.u.id) throw new Erro('Você não pode apagar a sua própria conta.');
  db.usuarios = db.usuarios.filter(u => u.id !== req.params.id);
  for (const t in db.sessoes) if (db.sessoes[t].uid === req.params.id) delete db.sessoes[t];
  gravar(); res.json({ contas: db.usuarios.map(perfil) });
}));

/* Dados */
app.get('/api/dados', exigir, (req, res) => {
  const desde = Math.max(0, parseInt(req.query.desde, 10) || 0);
  const docs = {}, apagados = [];
  for (const p in db.docs) if (!desde || db.docs[p].s > desde) docs[p] = db.docs[p].d;
  if (desde) for (const p in db.apagados) if (db.apagados[p] > desde) apagados.push(p);
  res.json({ seq: db.seq, completo: !desde, docs, apagados });
});
app.get('/api/eventos', exigir, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 4000\n\ndata: ' + db.seq + '\n\n');
  ouvintes.add(res);
  req.on('close', () => ouvintes.delete(res));
});
app.put('/api/doc/:col/:id', exigir, rota((req, res) => {
  const p = caminho(req.params.col, req.params.id);
  res.json({ seq: escrever(p, objeto(req.body.data), req.u.id) });
}));
app.patch('/api/doc/:col/:id', exigir, rota((req, res) => {
  const p = caminho(req.params.col, req.params.id);
  if (!db.docs[p]) throw new Erro('Esse registro não existe mais.', 404);
  const novo = mesclar(JSON.parse(JSON.stringify(db.docs[p].d)), objeto(req.body.data));
  res.json({ seq: escrever(p, novo, req.u.id) });
}));
app.delete('/api/doc/:col/:id', exigir, rota((req, res) => {
  const p = caminho(req.params.col, req.params.id);
  res.json({ seq: db.docs[p] ? escrever(p, null, req.u.id) : db.seq });
}));

/* Cópia dos dados */
app.get('/api/exportar', exigir, (req, res) => {
  const docs = {}; for (const p in db.docs) docs[p] = db.docs[p].d;
  res.set('Content-Disposition', 'attachment; filename="scriptorium-dados-' + hojeNoFuso() + '.json"');
  res.type('application/json').send(JSON.stringify({ formato: 'scriptorium-exportacao', versao: 1, exportadoEm: new Date().toISOString(), docs }, null, 1));
});
app.post('/api/importar', exigir, exigirAdmin, rota((req, res) => {
  const b = req.body || {};
  if (b.formato !== 'scriptorium-exportacao' || !b.docs || typeof b.docs !== 'object') throw new Erro('Esse arquivo não é uma cópia do Scriptorium.');
  if (Object.keys(db.docs).length && !b.substituir) throw new Erro('Já existem dados aqui. Confirme que quer substituir tudo.', 409);
  const novos = {};
  for (const p of Object.keys(b.docs)) { const [c, i, extra] = p.split('/'); if (extra !== undefined) throw new Erro('Registro inválido: ' + p); novos[caminho(c, i)] = objeto(b.docs[p]); }
  if (Object.keys(db.docs).length) copiaDeSeguranca('antes-da-importacao-' + Date.now() + '.json');
  db.seq++;
  for (const p in db.docs) if (!novos[p]) db.apagados[p] = db.seq;
  db.docs = {};
  const em = new Date().toISOString();
  for (const p in novos) db.docs[p] = { d: novos[p], s: db.seq, em, por: req.u.id };
  gravar(); avisar();
  res.json({ ok: true, registros: Object.keys(novos).length });
}));

app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));

app.listen(PORTA, () => {
  console.log('Scriptorium rodando na porta ' + PORTA + ' · dados em ' + DADOS + (dadosPersistentes() ? '' : ' (ATENÇÃO: sem disco; os dados somem a cada atualização)'));
});
