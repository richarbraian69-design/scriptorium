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
const { pipeline } = require('stream');
const Anthropic = require('@anthropic-ai/sdk').default;

const PORTA = process.env.PORT || 3000;
function discoEm(p) { try { return fs.statSync(p).isDirectory() && fs.statSync(p).dev !== fs.statSync(__dirname).dev; } catch (e) { return false; } }
const DADOS = path.resolve(process.env.SCRIPTORIUM_DADOS || process.env.RAILWAY_VOLUME_MOUNT_PATH || (discoEm('/data') ? '/data' : path.join(__dirname, 'dados')));
const ARQ = path.join(DADOS, 'scriptorium.json');
const BACKUPS = path.join(DADOS, 'backups');
const ARQUIVOS = path.join(DADOS, 'arquivos');
const FUSO = process.env.FUSO || 'America/Sao_Paulo';
const COLECOES = new Set(['banco', 'sessoes', 'vocab', 'estado', 'arquivos']);
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
const DIAS_SESSAO = 90;
const COPIAS = 30;

/* ---------- Armazenamento ---------- */
fs.mkdirSync(BACKUPS, { recursive: true });
fs.mkdirSync(ARQUIVOS, { recursive: true });
let db = { usuarios: [], sessoes: {}, docs: {}, apagados: {}, seq: 0, dicionario: {} };
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
  '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" sizes="32x32" href="/icones/icone-32.png"><link rel="icon" type="image/png" sizes="64x64" href="/icones/icone-64.png"><link rel="apple-touch-icon" href="/icones/apple-touch-icon.png">' +
  '<meta name="robots" content="noindex"></head><body>';
function pagina() { return CABECA + fs.readFileSync(path.join(__dirname, 'publico', 'index.html'), 'utf8') + '</body></html>'; }
const PAGINA = pagina();
app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(PAGINA); });
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').send(JSON.stringify({
  name: 'Scriptorium', short_name: 'Scriptorium', start_url: '/', display: 'standalone', background_color: '#0f0f0e', theme_color: '#0f0f0e', lang: 'pt-BR',
  icons: [{ src: '/icones/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icones/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icones/icone-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' }, { src: '/icones/icone-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
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
    'Arquivos de estudo ..... ' + (() => { const e = espacoArquivos(); return e.qtd + ' (' + (e.usado / 1048576).toFixed(1) + ' MB)' + (e.total ? ', ' + (e.livre / 1048576).toFixed(0) + ' MB livres de ' + (e.total / 1048576).toFixed(0) + ' MB' : ''); })(),
    'Dicionário ............. ' + (claude ? 'ligado (' + MODELO_DIC + '), ' + Object.keys(db.dicionario || {}).length + ' palavras guardadas' : 'desligado: falta ANTHROPIC_API_KEY'),
    'Cópias de segurança .... ' + (backups.length ? backups.length + ' (última: ' + backups[backups.length - 1] + ')' : 'nenhuma ainda'),
    'Servidor ligado em ..... ' + INICIADO.toISOString()
  ].join('\n'));
});

/* Toda chamada que altera algo precisa do cabeçalho X-Scriptorium (bloqueia formulários de outros sites). */
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); if (req.method !== 'GET' && req.get('X-Scriptorium') !== '1') return res.status(403).json({ erro: 'Requisição recusada.' }); next(); });
function exigir(req, res, next) { const u = usuarioDe(req); if (!u) return res.status(401).json({ erro: 'Sua sessão terminou. Entre de novo.' }); req.u = u; next(); }
function exigirAdmin(req, res, next) { if (!req.u.admin) return res.status(403).json({ erro: 'Só o administrador pode fazer isso.' }); next(); }
const rota = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => { if (!(e instanceof Erro)) console.error(e); res.status(e.status || 500).json({ erro: e instanceof Erro ? e.message : 'Erro no servidor.' }); });

/* Arquivos de estudo: ficam em /data/arquivos, e a ficha de cada um em docs (coleção arquivos).
 * Só abrem na tela os formatos que o navegador mostra sem risco; o resto é baixado. */
const TIPO_NA_TELA = /^(application\/pdf|image\/(png|jpeg|gif|webp)|audio\/[\w.+-]+|video\/[\w.+-]+)$/;
const MAX_ARQUIVO = 2 * 1024 * 1024 * 1024;
function espacoArquivos() {
  let usado = 0, qtd = 0;
  for (const p in db.docs) if (p.startsWith('arquivos/')) { usado += Number(db.docs[p].d.tam) || 0; qtd++; }
  let total = 0, livre = 0;
  try { const st = fs.statfsSync(DADOS); total = st.blocks * st.bsize; livre = st.bavail * st.bsize; } catch (e) {}
  return { usado, qtd, total, livre };
}
function apagarArquivoDoDisco(id) { try { fs.unlinkSync(path.join(ARQUIVOS, id)); } catch (e) {} }
app.get('/api/arquivos/espaco', exigir, (req, res) => res.json(espacoArquivos()));
app.post('/api/arquivos', exigir, (req, res) => {
  const tam = parseInt(req.get('Content-Length'), 10);
  if (!(tam > 0)) return res.status(411).json({ erro: 'Arquivo vazio.' });
  if (tam > MAX_ARQUIVO) return res.status(413).json({ erro: 'Esse arquivo passa de 2 GB.' });
  const esp = espacoArquivos();
  if (esp.total && tam + 10485760 > esp.livre) return res.status(507).json({ erro: 'Não há espaço no disco para esse arquivo.' });
  let nome = 'arquivo', meta = {};
  try { nome = decodeURIComponent(req.get('X-Nome') || 'arquivo'); } catch (e) {}
  try { meta = JSON.parse(decodeURIComponent(req.get('X-Meta') || '%7B%7D')) || {}; } catch (e) {}
  nome = nome.replace(/[\u0000-\u001f\\/]/g, ' ').trim().slice(0, 200) || 'arquivo';
  const id = novoId('a'), tmp = path.join(ARQUIVOS, id + '.parte'), saida = fs.createWriteStream(tmp);
  pipeline(req, saida, err => {
    if (err || saida.bytesWritten !== tam) {
      fs.unlink(tmp, () => {});
      const semEspaco = err && err.code === 'ENOSPC';
      if (!res.headersSent) res.status(semEspaco ? 507 : 400).json({ erro: semEspaco ? 'Não há espaço no disco para esse arquivo.' : 'O envio foi interrompido. Tente de novo.' });
      return;
    }
    fs.renameSync(tmp, path.join(ARQUIVOS, id));
    const doc = { nome, tipo: String(req.get('Content-Type') || '').split(';')[0].trim().slice(0, 100), tam, criado: hojeNoFuso(), area: String(meta.area || '').slice(0, 60), item: String(meta.item || '').slice(0, 120), notas: '' };
    escrever(caminho('arquivos', id), doc, req.u.id);
    res.json({ id, doc });
  });
});
app.get('/api/arquivos/:id', exigir, (req, res) => {
  if (!SEG.test(req.params.id)) return res.status(404).type('text').send('Arquivo não encontrado.');
  const reg = db.docs['arquivos/' + req.params.id], arq = path.join(ARQUIVOS, req.params.id);
  if (!reg || !fs.existsSync(arq)) return res.status(404).type('text').send('Arquivo não encontrado.');
  const tipo = String(reg.d.tipo || ''), texto = /^text\//.test(tipo) || /\.(txt|md)$/i.test(reg.d.nome || ''), naTela = !req.query.baixar && (TIPO_NA_TELA.test(tipo) || texto);
  res.set({ 'Cache-Control': 'private, max-age=86400', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Disposition': (naTela ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(reg.d.nome || 'arquivo') });
  res.set('Content-Type', !naTela ? 'application/octet-stream' : texto ? 'text/plain; charset=utf-8' : tipo);
  res.sendFile(req.params.id, { root: ARQUIVOS, cacheControl: false }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});
app.delete('/api/arquivos/:id', exigir, rota((req, res) => {
  const p = caminho('arquivos', req.params.id);
  apagarArquivoDoDisco(req.params.id);
  res.json({ seq: db.docs[p] ? escrever(p, null, req.u.id) : db.seq });
}));

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
/* Dicionário: o Claude explica a palavra; o que já foi consultado fica guardado e não gasta de novo. */
const MODELO_DIC = process.env.ANTHROPIC_MODELO || 'claude-opus-5-5';
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 30000, maxRetries: 1 }) : null;
const FORMATO_DIC = { type: 'object', additionalProperties: false, required: ['encontrado', 'tipo', 'idioma', 'traducao', 'termo', 'significado', 'analise', 'exemplo'], properties: {
  encontrado: { type: 'boolean' }, tipo: { type: 'string', enum: ['palavra', 'frase'] }, idioma: { type: 'string' }, traducao: { type: 'string' }, termo: { type: 'string' }, significado: { type: 'string' }, analise: { type: 'string' }, exemplo: { type: 'string' } } };
const PEDIDO_DIC = 'Você é o dicionário e tradutor de um estudante brasileiro que aprende latim pelo Familia Romana, de Hans Ørberg, e também estuda outros assuntos. Ele digita ou seleciona uma palavra, uma expressão ou uma frase inteira, às vezes sem mácrons, com palavras divididas por hífen no fim da linha ou com erro de leitura do PDF. Responda em português do Brasil, de forma curta.\n' +
  'Campos comuns: encontrado (false se o texto não for reconhecível; nesse caso deixe os outros campos de texto vazios). tipo ("palavra" para uma palavra ou expressão curta de dicionário; "frase" para uma oração ou trecho). idioma (o idioma do texto, em português, como "Latim").\n' +
  'Se tipo for "palavra": termo (forma de dicionário; em latim, com enunciado, gênero e mácrons, como "via, viae f." ou "amō, amāre, amāvī, amātum"). significado (os sentidos principais, em poucas palavras). analise (em latim, o que é a forma digitada, como "ablativo singular"; vazio se ela já for a forma de dicionário ou não for latim). exemplo (uma frase latina curta com tradução, se for latim; senão, vazio). traducao vazio.\n' +
  'Se tipo for "frase": traducao (a tradução completa e natural para o português; se o texto já estiver em português, traduza para o latim). analise (se for latim, até três observações curtas sobre as construções ou palavras mais difíceis; senão, vazio). termo, significado e exemplo vazios.\n' +
  'Se não tiver certeza de um sentido, diga isso em vez de inventar.';
function chaveDic(t) { return normNome(t).replace(/\s+/g, ' '); }
const usoDic = { hora: 0, n: 0 };
async function consultarClaude(termo) {
  const r = await claude.beta.messages.create({ model: MODELO_DIC, max_tokens: 2000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    system: PEDIDO_DIC, output_config: { effort: 'low', format: { type: 'json_schema', schema: FORMATO_DIC } }, messages: [{ role: 'user', content: termo }] });
  if (r.stop_reason === 'refusal') throw new Erro('O Claude não respondeu sobre esse termo.', 422);
  if (r.stop_reason === 'max_tokens') throw new Erro('A resposta ficou longa demais. Tente um trecho menor.', 422);
  const bloco = r.content.find(b => b.type === 'text');
  try { return JSON.parse(bloco.text); } catch (e) { throw new Erro('O Claude respondeu num formato inesperado. Tente de novo.', 502); }
}
app.post('/api/significado', exigir, rota(async (req, res) => {
  const termo = String((req.body || {}).termo || '').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (!termo) throw new Erro('Digite uma palavra.');
  if (termo.length > 800) throw new Erro('Esse trecho é longo demais. Consulte até 800 letras por vez.');
  db.dicionario = db.dicionario || {};
  const k = chaveDic(termo);
  if (db.dicionario[k]) return res.json(Object.assign({ guardado: true }, db.dicionario[k]));
  if (!claude) throw new Erro('O dicionário ainda não foi ligado: falta a chave ANTHROPIC_API_KEY no Railway.', 503);
  const hora = Math.floor(Date.now() / 3600000);
  if (usoDic.hora !== hora) { usoDic.hora = hora; usoDic.n = 0; }
  if (++usoDic.n > 200) throw new Erro('Muitas consultas nesta hora. Espere um pouco.', 429);
  let d;
  try { d = await consultarClaude(termo); }
  catch (e) {
    if (e instanceof Erro) throw e;
    console.error('[dicionario] ' + (e.status || '') + ' ' + (e.request_id || '') + ' ' + e.message);
    if (e.status === 401 || e.status === 403) throw new Erro('A chave ANTHROPIC_API_KEY do Railway foi recusada.', 502);
    if (e.status === 429) throw new Erro('Muitas consultas seguidas. Tente de novo em instantes.', 429);
    if (e.status === 404) throw new Erro('O modelo ' + MODELO_DIC + ' não está disponível nessa chave.', 502);
    if (e.status === 400 && /credit|billing/i.test(e.message || '')) throw new Erro('A conta da API da Anthropic está sem crédito.', 502);
    throw new Erro('Não consegui falar com o Claude agora. Tente de novo.', 502);
  }
  if (d.encontrado) { db.dicionario[k] = d; gravar(); }
  res.json(d);
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
  if (req.params.col === 'arquivos') apagarArquivoDoDisco(req.params.id);
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

/* ---------- Porta do JARVIS: o assistente do Mac acompanha os estudos e anota sem abrir a tela ----------
 * Liga com a variável JARVIS_TOKEN_SHA256 no Railway: a impressão digital (SHA-256, em hex) da chave que
 * fica só no Mac do JARVIS. Sem ela, nada disto existe. Os números repetem os "Cálculos" da tela.
 * De propósito, não apaga nem altera nada: só lê, anota estudo feito e põe item novo no banco. */
const JARVIS_SHA = String(process.env.JARVIS_TOKEN_SHA256 || '').trim().toLowerCase();
const JARVIS_HASH = /^[0-9a-f]{64}$/.test(JARVIS_SHA) ? Buffer.from(JARVIS_SHA, 'hex') : null;
function exigirJarvis(req, res, next) {
  if (!JARVIS_HASH) return res.status(404).type('text').send('Página não encontrada.');
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m || !crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), JARVIS_HASH)) {
    try { limitarLogin(req); } catch (e) { return res.status(429).json({ erro: e.message }); }
    falhouLogin(req);
    return res.status(401).json({ erro: 'Chave do JARVIS inválida.' });
  }
  next();
}
const CAPS = ['Imperium Romanum', 'Familia Romana', 'Puer improbus', 'Dominus et servi', 'Villa et hortus', 'Via Latina', 'Puella et rosa', 'Taberna Romana', 'Pastor et oves', 'Bestiae et homines', 'Corpus humanum', 'Miles Romanus', 'Annus et menses', 'Novus dies', 'Magister et discipuli', 'Tempestas', 'Numeri difficiles', 'Litterae Latinae', 'Maritus et uxor', 'Parentes', 'Pugna discipulorum', 'Cave canem', 'Epistula magistri', 'Puer aegrotus', 'Theseus et Minotaurus', 'Daedalus et Icarus', 'Res rusticae', 'Pericula maris', 'Navigare necesse est', 'Convivium', 'Inter pocula', 'Classis Romana', 'Exercitus Romanus', 'De arte poetica', 'Ars grammatica'];
const PARTES = [['l1', 'Lectio I'], ['l2', 'Lectio II'], ['l3', 'Lectio III'], ['gram', 'Grammatica Latina'], ['pa', 'Pensum A'], ['pb', 'Pensum B'], ['pc', 'Pensum C']];
const AREAS = ['trabalho', 'intelectual', 'religioso', 'outros'];
function areasValidas() { const a = (docDe('estado/geral') || {}).areas; return Array.isArray(a) && a.length ? a.map(x => x.id) : AREAS; }
function areaPadrao() { const l = areasValidas(); return l.includes('intelectual') ? 'intelectual' : l[0]; }
const TIPOS = ['video', 'livro', 'artigo', 'curso', 'tema', 'outro'];
function somaDias(iso, n) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function segundaDe(iso) { const [y, m, d] = iso.split('-').map(Number); return somaDias(iso, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7)); }
function colecao(col) { const l = []; for (const p in db.docs) if (p.startsWith(col + '/')) l.push(Object.assign({}, db.docs[p].d, { id: p.slice(col.length + 1) })); return l; }
const docDe = p => (db.docs[p] || {}).d || null;
const somaMin = l => l.reduce((t, s) => t + s.minutos, 0);
function estudos() {
  return { sess: colecao('sessoes').map(s => Object.assign(s, { minutos: Number(s.minutos) || 0 })), banco: colecao('banco'), vocab: colecao('vocab'),
    lat: docDe('estado/latim') || { atual: 1, feitos: {} }, vio: docDe('estado/violino') || { exercicios: [] }, ger: docDe('estado/geral') || { metaLatim: 5, metaViolino: 5 } };
}
const jarvis = express.Router();
jarvis.use(exigirJarvis);
jarvis.get('/resumo', (req, res) => {
  const e = estudos(), hoje = hojeNoFuso(), seg = segundaDe(hoje), dias = {};
  e.sess.forEach(s => { dias[s.data] = 1; });
  let d = dias[hoje] ? hoje : somaDias(hoje, -1), seq = 0; while (dias[d]) { seq++; d = somaDias(d, -1); }
  const de = (p, f) => e.sess.filter(s => s.pratica === p && f(s));
  const cap = Math.max(1, Math.min(35, Number(e.lat.atual) || 1)), feitos = (e.lat.feitos || {})[String(cap)] || {}, prox = PARTES.find(p => !feitos[p[0]]);
  const hist = id => e.sess.flatMap(s => (s.itens || []).filter(i => i.ex === id).map(i => ({ data: s.data, bpm: i.bpm }))).sort((a, b) => a.data.localeCompare(b.data));
  const fila = e.banco.filter(b => b.status === 'fila' || b.status === 'estudando'), ultRev = e.ger.ultimaRevisao;
  res.json({ hoje, sequenciaDias: seq,
    latim: { minutosHoje: somaMin(de('latim', s => s.data === hoje)), metaDia: Number(e.ger.metaLatim) || 5, minutosSemana: somaMin(de('latim', s => s.data >= seg)),
      capitulo: cap, nome: CAPS[cap - 1], partesFeitas: PARTES.filter(p => feitos[p[0]]).length, partesTotal: PARTES.length, proximaParte: prox ? prox[1] : null,
      vocabParaRevisar: e.vocab.filter(v => (v.proxima || hoje) <= hoje).length, vocabTotal: e.vocab.length },
    violino: { minutosHoje: somaMin(de('violino', s => s.data === hoje)), metaDia: Number(e.ger.metaViolino) || 5, minutosSemana: somaMin(de('violino', s => s.data >= seg)),
      exercicios: (e.vio.exercicios || []).filter(x => x.ativo !== false).map(x => { const h = hist(x.id), b = h.filter(i => i.bpm); return { nome: x.nome, foco: x.foco || '', bpmMeta: x.bpmMeta || null, ultimoBpm: b.length ? b[b.length - 1].bpm : null, ultimoTreino: h.length ? h[h.length - 1].data : null }; }) },
    banco: { naFila: e.banco.filter(b => b.status === 'fila').length, estudando: e.banco.filter(b => b.status === 'estudando').length,
      daSemana: e.banco.filter(b => b.semana && b.status !== 'concluido' && b.status !== 'arquivado').map(b => b.titulo || b.link),
      revisaoPendente: fila.length > 0 && (!ultRev || somaDias(ultRev, 7) <= hoje) },
    ultimasSessoes: e.sess.sort((a, b) => (b.data + (b.criado || '')).localeCompare(a.data + (a.criado || ''))).slice(0, 6).map(s => ({ data: s.data, pratica: s.pratica, minutos: s.minutos, notas: s.notas || '' })) });
});
jarvis.get('/banco', (req, res) => {
  const q = req.query, st = ['fila', 'estudando', 'concluido', 'arquivado'].includes(q.status) ? q.status : null, busca = normNome(q.busca || '');
  const l = estudos().banco.filter(b => (st ? b.status === st : b.status !== 'arquivado') && (!q.area || b.area === q.area) && (!busca || normNome((b.titulo || '') + ' ' + (b.link || '')).includes(busca)))
    .sort((a, b) => String(b.criado || '').localeCompare(String(a.criado || '')));
  res.json({ total: l.length, itens: l.slice(0, 80).map(b => ({ titulo: b.titulo, link: b.link || '', area: b.area, tipo: b.tipo, prioridade: b.prioridade, status: b.status, semana: !!b.semana })) });
});
jarvis.post('/sessoes', rota((req, res) => {
  const b = req.body || {}, pratica = b.pratica, minutos = parseInt(b.minutos, 10), data = b.data ? String(b.data) : hojeNoFuso();
  if (!['latim', 'violino'].includes(pratica)) throw new Erro('Prática: latim ou violino.');
  if (!(minutos > 0 && minutos <= 600)) throw new Erro('Minutos entre 1 e 600.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Erro('Data no formato AAAA-MM-DD.');
  const s = { pratica, data, minutos, notas: String(b.notas || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500), criado: new Date().toISOString(), via: 'jarvis' };
  if (pratica === 'latim') { s.cap = Math.max(1, Math.min(35, parseInt(b.cap, 10) || Number((docDe('estado/latim') || {}).atual) || 1)); s.partes = []; }
  else s.itens = [];
  escrever(caminho('sessoes', novoId('j')), s, 'jarvis');
  res.json({ ok: true, sessao: s });
}));
jarvis.post('/banco', rota((req, res) => {
  const b = req.body || {}, link = String(b.link || '').trim().slice(0, 500), titulo = String(b.titulo || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  if (!titulo && !link) throw new Erro('Diga o título ou o link do estudo.');
  if (link && !/^https?:\/\//.test(link)) throw new Erro('O link precisa começar com http.');
  const tipo = TIPOS.includes(b.tipo) ? b.tipo : /youtu\.?be|vimeo|instagram|tiktok/.test(link) ? 'video' : link ? 'artigo' : 'tema';
  const item = { titulo, link, area: areasValidas().includes(b.area) ? b.area : areaPadrao(), tipo, prioridade: ['alta', 'media', 'baixa'].includes(b.prioridade) ? b.prioridade : 'media',
    status: 'fila', notas: '', semana: false, criado: hojeNoFuso(), via: 'jarvis' };
  escrever(caminho('banco', novoId('j')), item, 'jarvis');
  res.json({ ok: true, item });
}));
app.use('/api/jarvis', jarvis);

/* Confere a tradução com o Claude uma única vez: a frase fica guardada e não é consultada de novo. */
const FRASE_TESTE = 'Via Appia longa est.';
if (claude && !(db.dicionario || {})[chaveDic(FRASE_TESTE)]) {
  consultarClaude(FRASE_TESTE).then(d => { db.dicionario = db.dicionario || {}; if (d.encontrado) { db.dicionario[chaveDic(FRASE_TESTE)] = d; gravar(); } console.log('[dicionario] teste ok: ' + d.tipo + ' = ' + d.traducao); })
    .catch(e => console.error('[dicionario] teste falhou: ' + (e.status || '') + ' ' + e.message));
}

app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));

app.listen(PORTA, () => {
  console.log('Scriptorium rodando na porta ' + PORTA + ' · dados em ' + DADOS + (dadosPersistentes() ? '' : ' (ATENÇÃO: sem disco; os dados somem a cada atualização)'));
});
