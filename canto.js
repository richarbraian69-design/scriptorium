'use strict';
/*
 * Canto dos versos da Eneida: uma voz sintética (eSpeak, pelo pacote mespeak, licença GPL) canta cada
 * sílaba na nota e na duração pedidas pela escansão. Cada sílaba é sintetizada em tom fixo e depois
 * esticada ou encurtada repetindo ou tirando períodos inteiros da vogal, para cair no tempo certo.
 */
const SR = 22050, BREVE = 0.23, NOTAS = { A: 110, C: 130.81, D: 146.83 };
let ms = null;
const vozes = {};

function lerWav(buf) {
  if (!buf) return new Float32Array(0);
  buf = Buffer.from(buf);
  let o = 12;
  while (o + 8 <= buf.length && buf.toString('ascii', o, o + 4) !== 'data') o += 8 + buf.readUInt32LE(o + 4);
  const n = Math.floor((buf.length - o - 8) / 2), x = new Float32Array(Math.max(0, n));
  for (let i = 0; i < x.length; i++) x[i] = buf.readInt16LE(o + 8 + i * 2) / 32768;
  return x;
}
function aparar(x) {
  let a = 0, b = x.length - 1;
  while (a < b && Math.abs(x[a]) < 0.02) a++;
  while (b > a && Math.abs(x[b]) < 0.02) b--;
  return x.subarray(a, b + 1);
}
function sintetizar(texto, voz, velocidade) {
  return aparar(lerWav(ms.speak(texto, { voice: voz, speed: Math.round(velocidade), rawdata: 'buffer' })));
}
function frequencia(x) {
  const N = Math.min(2048, x.length >> 1), s = (x.length >> 1) - (N >> 1);
  let melhor = 0, atraso = Math.round(SR / 110);
  for (let lag = Math.floor(SR / 260); lag < Math.floor(SR / 60); lag++) {
    let c = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < N; i++) { const a = x[s + i], b = x[s + i + lag] || 0; c += a * b; e1 += a * a; e2 += b * b; }
    const r = c / Math.sqrt(e1 * e2 + 1e-9);
    if (r > melhor) { melhor = r; atraso = lag; }
  }
  return SR / atraso;
}
function carregar() {
  if (ms) return;
  const m = require('mespeak');
  m.loadConfig(require('mespeak/src/mespeak_config.json'));
  const la = require('mespeak/voices/la.json'), base = Buffer.from(la.voice, 'base64').toString('latin1');
  const por = (id, tom) => m.loadVoice(Object.assign({}, la, { voice_id: id, voice: Buffer.from(base + '\npitch ' + tom + ' ' + tom + '\n', 'latin1').toString('base64') }));
  ms = m;
  for (const n in NOTAS) {
    // O tom pedido ao sintetizador sai um pouco mais grave; mede e corrige uma vez.
    let tom = Math.round(NOTAS[n] + 9), id = 'canto-' + n + '-a';
    por(id, tom);
    const medido = frequencia(sintetizar('a', id, 110));
    tom = Math.round(tom + (NOTAS[n] - medido)); id = 'canto-' + n + '-b';
    por(id, tom);
    vozes[n] = { id, f: frequencia(sintetizar('a', id, 110)) };
  }
}
function centro(x) {
  const w = Math.floor(SR * 0.02);
  let soma = 0, melhor = -1, onde = x.length >> 1;
  for (let i = 0; i < x.length; i++) {
    soma += x[i] * x[i]; if (i >= w) soma -= x[i - w] * x[i - w];
    const c = i - (w >> 1);
    if (c > x.length * 0.25 && c < x.length * 0.65 && soma > melhor) { melhor = soma; onde = c; }
  }
  return onde;
}
function trechoPeriodico(x, c, P) {
  const alvo = Math.round(3 * P), W = Math.round(P), folga = Math.round(P / 3);
  let melhor = -2, L = alvo;
  for (let l = alvo - folga; l <= alvo + folga; l++) {
    if (c + l + W >= x.length) break;
    let s = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < W; i++) { const a = x[c + i], b = x[c + l + i]; s += a * b; e1 += a * a; e2 += b * b; }
    const r = s / Math.sqrt(e1 * e2 + 1e-9);
    if (r > melhor) { melhor = r; L = l; }
  }
  return L;
}
function ajustar(x, N, P) {
  let y = x;
  if (x.length > 5 * P) {
    const c = Math.max(0, Math.min(centro(x), x.length - Math.round(4.5 * P))), L = trechoPeriodico(x, c, P), dif = N - x.length;
    if (dif > L / 2) {
      const r = Math.round(dif / L);
      y = new Float32Array(x.length + r * L);
      y.set(x.subarray(0, c + L));
      for (let k = 0; k < r; k++) y.set(x.subarray(c, c + L), c + L + k * L);
      y.set(x.subarray(c + L), c + L + r * L);
    } else if (dif < -L / 2) {
      const r = Math.min(Math.round(-dif / L), Math.floor((x.length * 0.8 - c) / L));
      if (r > 0) { y = new Float32Array(x.length - r * L); y.set(x.subarray(0, c)); y.set(x.subarray(c + r * L), c); }
    }
  }
  const z = new Float32Array(N); z.set(y.subarray(0, Math.min(N, y.length)));
  const fim = Math.min(N, y.length), sobe = Math.min(Math.floor(SR * 0.004), fim), desce = Math.min(Math.floor(SR * 0.014), fim);
  for (let i = 0; i < sobe; i++) z[i] *= i / sobe;
  for (let i = 0; i < desce; i++) z[fim - 1 - i] *= i / desce;
  return z;
}
function textoDaSilaba(t) { return String(t || '').replace(/\([^)]*\)/g, '').normalize('NFC').replace(/[^\p{L}]/gu, '').toLowerCase(); }

/* Melodia de recitação: o primeiro tempo de cada pé sobe; o terceiro pé é o ponto alto; o verso repousa no Lá. */
function plano(silabas) {
  const out = []; let pe = 0, pos = 0;
  silabas.forEach((s, i) => {
    const ultima = i === silabas.length - 1;
    let nota = 'A';
    if (pe === 2) nota = pos === 0 ? 'D' : 'C';
    else if (pe === 4) nota = pos === 0 ? 'D' : pos === 1 ? 'C' : 'A';
    else if (pe === 5) nota = pos === 0 ? 'C' : 'A';
    else nota = pos === 0 ? 'C' : 'A';
    out.push({ texto: textoDaSilaba(s.texto), nota, dur: ultima ? BREVE * 3.5 : (s.longa ? 2 : 1) * BREVE });
    if (s.fim_do_pe) { pe++; pos = 0; } else pos++;
  });
  return out;
}
function tempos(silabas) { return plano(silabas).map(p => Math.round(p.dur * 1000) / 1000); }
function cantar(silabas) {
  carregar();
  const pl = plano(silabas), total = pl.reduce((t, p) => t + Math.round(p.dur * SR), 0) + Math.round(SR * 0.12), saida = new Float32Array(total);
  let pos = 0;
  for (const p of pl) {
    const N = Math.round(p.dur * SR), v = vozes[p.nota];
    if (p.texto) {
      let x = sintetizar(p.texto, v.id, 150);
      if (x.length > 200) {
        const vel = Math.max(80, Math.min(380, 150 * x.length / N));
        if (Math.abs(vel - 150) > 8) { const x2 = sintetizar(p.texto, v.id, vel); if (x2.length > 200) x = x2; }
        saida.set(ajustar(x, N, SR / v.f), pos);
      }
    }
    pos += N;
  }
  let pico = 0; for (let i = 0; i < saida.length; i++) pico = Math.max(pico, Math.abs(saida[i]));
  const g = pico > 0 ? 0.9 / pico : 1, wav = Buffer.alloc(44 + saida.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + saida.length * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(saida.length * 2, 40);
  for (let i = 0; i < saida.length; i++) wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(saida[i] * g * 32767))), 44 + i * 2);
  return wav;
}
module.exports = { cantar, tempos, VERSAO: 1, _interno: { frequencia, lerWav, vozes, SR } };
