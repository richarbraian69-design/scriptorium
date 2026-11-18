'use strict';
/* Baixa os textos das obras do mapa de educação clássica e guarda uma cópia
   de leitura: PDFs ficam como estão; páginas viram um HTML limpo, só com
   parágrafos, títulos e ênfases, sem scripts nem links, para ler no Scriptorium. */
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');

/* Só estes sites podem ser baixados (são os das listas de leitura). */
const SITES = [
  'vatican.va', 'newadvent.org', 'classics.mit.edu', 'penelope.uchicago.edu', 'cts.perseids.org',
  'wikisource.org', 'earlychurchtexts.com', 'attalus.org', 'corpusthomisticum.org', 'newmanreader.org',
  'sourcebooks.web.fordham.edu', 'history.hanover.edu', 'ewtn.com', 'clerus.org', 'lms.org.uk',
  'archive.wf-f.org', 'kolbefoundation.org', 'projetos.uel.br', 'teses.usp.br', 'revistas.usp.br',
  'estudogeral.uc.pt', 'archive.org', 'media.lasallianresources.org', 'revistas.comillas.edu',
  'agustinosrecoletos.com', 'puc-campinas.edu.br', 'bkv.unifr.ch', 'repositorio.ucp.pt'
];
const MAX_BYTES = 40 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; Scriptorium/1.0; app pessoal de estudos)';

function permitido(u) {
  let h;
  try { const x = new URL(u); if (x.protocol !== 'https:' && x.protocol !== 'http:') return false; h = x.hostname.toLowerCase(); } catch (e) { return false; }
  return SITES.some(s => h === s || h.endsWith('.' + s));
}

/* Segue os redirecionamentos um a um, conferindo o site de cada salto. */
async function buscar(url) {
  let atual = url, cookies = '';
  for (let i = 0; i < 8; i++) {
    if (!permitido(atual)) throw new Error('Site fora da lista de leitura: ' + new URL(atual).hostname);
    const r = await fetch(atual, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept': 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5', ...(cookies ? { Cookie: cookies } : {}) }, signal: AbortSignal.timeout(90000) });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookies = [cookies, ...sc.map(c => c.split(';')[0])].filter(Boolean).join('; ');
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { atual = new URL(r.headers.get('location'), atual).href; continue; }
    if (!r.ok) throw new Error('O site respondeu ' + r.status + '.');
    const tam = Number(r.headers.get('content-length')) || 0;
    if (tam > MAX_BYTES) throw new Error('Arquivo grande demais (' + Math.round(tam / 1048576) + ' MB).');
    const partes = []; let total = 0;
    for await (const p of r.body) { total += p.length; if (total > MAX_BYTES) throw new Error('Arquivo grande demais.'); partes.push(p); }
    return { buf: Buffer.concat(partes), tipo: String(r.headers.get('content-type') || '').toLowerCase(), final: atual };
  }
  throw new Error('Redirecionamentos demais.');
}

function decodificar(buf, tipo) {
  let cs = (tipo.match(/charset=([\w-]+)/) || [])[1];
  if (!cs) { const ini = buf.slice(0, 4096).toString('latin1'); cs = (ini.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1]; }
  cs = (cs || 'utf-8').toLowerCase();
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'us-ascii') cs = 'windows-1252';
  let t;
  try { t = new TextDecoder(cs).decode(buf); } catch (e) { t = new TextDecoder('utf-8').decode(buf); }
  if (cs === 'utf-8' && (t.match(/�/g) || []).length > 20) t = new TextDecoder('windows-1252').decode(buf);
  return t;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BLOCO = { P: 'p', H1: 'h2', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4', BLOCKQUOTE: 'blockquote', UL: 'ul', OL: 'ol', LI: 'li', PRE: 'pre', TABLE: 'table', TBODY: 'tbody', THEAD: 'thead', TR: 'tr', TD: 'td', TH: 'th', DL: 'dl', DT: 'dt', DD: 'dd', CENTER: 'p' };
const LINHA = { EM: 'em', I: 'em', CITE: 'em', B: 'strong', STRONG: 'strong', SUP: 'sup', SUB: 'sub', SMALL: 'small' };
const FORA = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'IMG', 'PICTURE', 'MAP', 'HEAD', 'TITLE', 'META', 'LINK', 'TEMPLATE']);

/* Reescreve a árvore só com as tags permitidas e sem nenhum atributo. */
function limpar(no) {
  let out = '';
  for (const n of Array.from(no.childNodes || [])) {
    if (n.nodeType === 3) { out += esc(n.textContent); continue; }
    if (n.nodeType !== 1) continue;
    const t = n.tagName.toUpperCase();
    if (FORA.has(t)) continue;
    if (t === 'BR') { out += '<br>'; continue; }
    if (t === 'HR') { out += '<hr>'; continue; }
    const dentro = limpar(n);
    if (BLOCO[t]) { if (dentro.replace(/<br>|\s|&nbsp;/g, '') || t === 'TD' || t === 'TH') out += '<' + BLOCO[t] + '>' + dentro + '</' + BLOCO[t] + '>'; }
    else if (LINHA[t]) { if (dentro.trim()) out += '<' + LINHA[t] + '>' + dentro + '</' + LINHA[t] + '>'; }
    else if (t === 'DIV' || t === 'SECTION' || t === 'ARTICLE' || t === 'MAIN') out += dentro.trim() ? (/<(p|h\d|blockquote|ul|ol|table|pre|dl)>/.test(dentro) ? dentro : '<p>' + dentro + '</p>') : '';
    else out += dentro;
  }
  return out;
}
/* Avisos dos sites que não fazem parte do texto. */
const AVISOS = [/Please help support the mission of New Advent/i, /^Contact information\. The editor of New Advent/i, /Relevant books available at Amazon/i, /One of the most extensive resources on the internet for the study of early Christianity/i];
function semAvisos(html) { return html.replace(/<(p|li|h\d)>([\s\S]*?)<\/\1>/g, (m, t, d) => AVISOS.some(r => r.test(textoDe(d))) ? '' : m); }
function textoDe(html) { return html.replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim(); }

function documento(titulo, corpo, origem, lingua) {
  const hoje = new Date().toISOString().slice(0, 10);
  return '<!doctype html><html lang="' + esc(lingua || 'pt') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(titulo) + '</title><style>' +
    ':root{color-scheme:light dark;--fd:#fbf8f1;--tx:#2b2620;--tx2:#7a6f60;--li:#e4dccb}@media (prefers-color-scheme:dark){:root{--fd:#1d1a16;--tx:#e9e2d4;--tx2:#a39886;--li:#3a342b}}' +
    'html{background:var(--fd)}body{margin:0 auto;max-width:44rem;padding:28px 22px 80px;font:18px/1.7 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;color:var(--tx);background:var(--fd);overflow-wrap:break-word}' +
    'header{border-bottom:1px solid var(--li);margin-bottom:24px;padding-bottom:12px}header h1{font-size:1.5rem;line-height:1.25;margin:0 0 6px;font-weight:600}header p{margin:0;font:13px/1.5 -apple-system,system-ui,sans-serif;color:var(--tx2)}' +
    'h2{font-size:1.25rem;margin:1.8em 0 .6em}h3{font-size:1.1rem;margin:1.5em 0 .5em}h4{font-size:1rem;margin:1.3em 0 .4em}p{margin:0 0 1em}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid var(--li)}' +
    'table{border-collapse:collapse;width:100%;margin:1em 0}td,th{vertical-align:top;padding:4px 8px;border-bottom:1px solid var(--li)}pre{white-space:pre-wrap;font:inherit}sup{font-size:.7em;color:var(--tx2)}hr{border:0;border-top:1px solid var(--li);margin:2em 0}' +
    '</style></head><body><header><h1>' + esc(titulo) + '</h1><p>Cópia de leitura guardada no Scriptorium em ' + hoje + '. Original: ' + esc(origem) + '</p></header><main>' + corpo + '</main></body></html>';
}

/* Texto puro (como os do MIT Classics): parágrafos separados por linha em branco. */
function deTexto(t) {
  return t.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => /^-{5,}$/.test(p) ? '<hr>' : (p.length < 80 && /^(book|chapter|part|section|liber|caput|[ivxlc]+\.?)\b/i.test(p) ? '<h3>' + esc(p) + '</h3>' : '<p>' + esc(p.replace(/\s*\n\s*/g, ' ')) + '</p>')).join('');
}

function deHtml(html, url) {
  const { document } = parseHTML(html);
  let titulo = (document.querySelector('title') || {}).textContent || '';
  document.querySelectorAll('script,style,noscript,iframe,form,nav,header,footer,aside').forEach(e => e.remove());
  const corpoTodo = limpar(document.body || document.documentElement);
  let corpo = corpoTodo;
  try {
    const { document: d2 } = parseHTML(html);
    const art = new Readability(d2, { charThreshold: 300, keepClasses: false }).parse();
    if (art && art.content) {
      const { document: d3 } = parseHTML('<html><body>' + art.content + '</body></html>');
      const c = limpar(d3.body);
      /* O modo leitura às vezes corta demais (páginas bilíngues, tabelas); nesse caso fica a página inteira, limpa. */
      if (textoDe(c).length >= 0.45 * textoDe(corpoTodo).length) corpo = c;
      if (art.title) titulo = art.title;
    }
  } catch (e) { /* fica a página inteira */ }
  return { titulo: titulo.replace(/\s+/g, ' ').trim(), corpo: semAvisos(corpo) };
}

/* Devolve { tipo: 'application/pdf', buf } ou { tipo: 'text/html', buf, letras }. */
async function baixarFonte(url, titulo, lingua) {
  const r = await buscar(url);
  const ehPdf = /application\/pdf/.test(r.tipo) || r.buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (ehPdf) {
    if (r.buf.length < 20000) throw new Error('O PDF veio vazio. Use a versão em página.');
    return { tipo: 'application/pdf', buf: r.buf };
  }
  const bruto = decodificar(r.buf, r.tipo);
  const pagina = /text\/plain/.test(r.tipo) ? { titulo: '', corpo: deTexto(bruto) } : deHtml(bruto, r.final);
  const letras = textoDe(pagina.corpo).length;
  if (letras < 600) throw new Error('A página veio quase vazia (' + letras + ' letras).');
  return { tipo: 'text/html', buf: Buffer.from(documento(titulo || pagina.titulo || 'Texto', pagina.corpo, url, lingua), 'utf-8'), letras };
}

module.exports = { baixarFonte, permitido };
