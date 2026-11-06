// Parser de operaciones de NinjaTrader 8.
// Admite dos formatos de CSV:
//   1) Exportación de la pestaña "Operaciones / Trades" del Strategy Analyzer (clic derecho → Exportar).
//      Cabeceras en inglés o español; separador , ; o tabulador; fechas d/m/a o m/d/a (con o sin AM/PM).
//   2) El CSV del conector BtRunner (cabecera "entrada;salida;largo;cantidad;precio_ent;precio_sal;beneficio;comision;mae;mfe").
//
// Devuelve { trades, meta } con la misma forma que parseMT5Content:
//   trades: [{ date, time, profit, lowestFloating, volume }]  (hora de CIERRE, ya convertida a hora de Nueva York)
//   meta:   { source: 'nt8', timeBase: 'NY', initialDeposit, netProfit, refTP: null, refSL: null, warnings[] }
//
// NT8 guarda las horas en el reloj del PC (no en el del servidor). Se convierten a hora de Nueva York con la
// zona IANA indicada (por defecto Europe/Madrid, que es la del PC del proyecto), respetando los cambios de hora.

const strip = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/^﻿/, '')
    .replace(/\s+/g, ' ')
    .trim();

const norm = (s) => strip(s).toLowerCase();

// ---------- CSV ----------
const splitLine = (line, delim) => {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(strip);
};

const detectDelimiter = (line) => {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
};

// ---------- Números ----------
// El formato decimal se decide una vez por archivo. Admite "$1,234.50", "(120.00)", "−120", "1.234,50 €".
const makeNumberParser = (samples) => {
  let comma = 0;
  let dot = 0;
  for (const raw of samples) {
    const s = strip(raw).replace(/[^\d.,-]/g, '');
    if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) comma++;
    else if (/\.\d{1,2}$/.test(s)) dot++;
  }
  const decimalComma = comma > dot;
  return (val) => {
    if (typeof val === 'number') return val;
    let s = strip(val).replace(/[−—–]/g, '-');
    if (s === '') return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(s.replace(/[^\d.,()-]/g, ''))) neg = true;
    s = s.replace(/[^\d.,-]/g, '');
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    s = decimalComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
    const v = parseFloat(s);
    return neg ? -v : v;
  };
};

// ---------- Zonas horarias ----------
const fmtCache = {};
const partsFormatter = (zone) =>
  (fmtCache[zone] = fmtCache[zone] || new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));

const wallInZone = (utcMs, zone) => {
  const p = {};
  for (const x of partsFormatter(zone).formatToParts(new Date(utcMs))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
};

// Instante UTC (ms) cuya hora de pared en `zone` es la indicada.
const wallToUtc = (y, mo, d, h, mi, s, zone) => {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const w = wallInZone(guess, zone);
    const diff = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - asUtc;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
};

const pad = (n) => String(n).padStart(2, '0');
const toNYString = (utcMs) => {
  const w = wallInZone(utcMs, 'America/New_York');
  return `${w.y}.${pad(w.mo)}.${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
};

// ---------- Fechas ----------
// Devuelve {y,mo,d,h,mi,s} a partir de texto; `order` = 'ymd' | 'dmy' | 'mdy'.
const parseStamp = (text, order) => {
  const m = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp]\.?[Mm]\.?)?/.exec(strip(text));
  if (!m) return null;
  let [a, b, c] = [+m[1], +m[2], +m[3]];
  let y, mo, d;
  if (order === 'ymd') { y = a; mo = b; d = c; }
  else if (order === 'dmy') { d = a; mo = b; y = c; }
  else { mo = a; d = b; y = c; }
  if (y < 100) y += 2000;
  let h = +m[4];
  const ap = (m[7] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { y, mo, d, h, mi: +m[5], s: +(m[6] || 0) };
};

const detectOrder = (samples) => {
  let ymd = 0, firstBig = 0, secondBig = 0, n = 0;
  for (const t of samples) {
    const m = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/.exec(strip(t));
    if (!m) continue;
    n++;
    if (m[1].length === 4) { ymd++; continue; }
    if (+m[1] > 12) firstBig++;
    if (+m[2] > 12) secondBig++;
  }
  if (n && ymd === n) return { order: 'ymd', ambiguous: false };
  if (firstBig > 0 && secondBig === 0) return { order: 'dmy', ambiguous: false };
  if (secondBig > 0 && firstBig === 0) return { order: 'mdy', ambiguous: false };
  return { order: 'dmy', ambiguous: true };
};

// ---------- Cabeceras ----------
const findCol = (header, tests) => {
  const h = header.map(norm);
  for (const t of tests) {
    const i = h.findIndex((x) => t.test(x));
    if (i > -1) return i;
  }
  return -1;
};

const isMicroSymbol = (s) => /^m(nq|es|gc|cl|ym|6e|6b)\b|^m(nq|es|gc|cl|ym|6e)[ -_]/i.test(strip(s)) || /^mini[- ]?micro/i.test(s);

export const looksLikeNT8 = (content) => {
  const first = String(content).replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
  const h = norm(first);
  if (/entrada;salida;largo;cantidad/.test(h)) return true;
  const hasEntryTime = /(entry|entrada).*(time|hora|tiempo)|(time|hora|tiempo).*(entry|entrada)/.test(h);
  const hasProfit = /(profit|beneficio|ganancia)/.test(h);
  return hasEntryTime && hasProfit && /(exit|salida)/.test(h) && !/<html|<table/i.test(first);
};

/**
 * @param {string} content  texto del CSV
 * @param {string} fileName nombre del archivo (sirve para deducir si el contrato es micro)
 * @param {{zone?: string, extraCommissionRT?: number}} opts
 *   zone: zona IANA del reloj del PC donde se hizo el backtest (por defecto Europe/Madrid).
 *   extraCommissionRT: comisión por contrato (ida y vuelta, $) a restar si el fichero no la trae.
 */
export const parseNT8Content = (content, fileName = '', opts = {}) => {
  const zone = opts.zone || 'Europe/Madrid';
  const extraRT = Number(opts.extraCommissionRT) || 0;
  const warnings = [];
  const fail = (msg) => ({ trades: [], meta: { source: null, timeBase: 'NY', initialDeposit: null, netProfit: 0, reportedNetProfit: null, refTP: null, refSL: null, warnings: [msg] } });

  try { partsFormatter(zone).format(0); } catch { return fail(`Zona horaria no válida: ${zone}`); }

  const lines = String(content).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return fail('El archivo de NinjaTrader está vacío.');
  const delim = detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delim);
  const rows = lines.slice(1).map((l) => splitLine(l, delim));
  const hn = header.map(norm);

  const isBt = hn[0] === 'entrada' && hn.includes('beneficio') && hn.includes('cantidad');
  const col = isBt
    ? {
        entryTime: hn.indexOf('entrada'), exitTime: hn.indexOf('salida'), dir: hn.indexOf('largo'), qty: hn.indexOf('cantidad'),
        profit: hn.indexOf('beneficio'), cum: -1, fees: [], comm: hn.indexOf('comision'), mae: hn.indexOf('mae'), mfe: hn.indexOf('mfe'), instrument: -1,
      }
    : {
        entryTime: findCol(header, [/(hora|time|tiempo).*(entrada|entry)|(entrada|entry).*(hora|time|tiempo)/]),
        exitTime: findCol(header, [/(hora|time|tiempo).*(salida|exit)|(salida|exit).*(hora|time|tiempo)/]),
        dir: findCol(header, [/market pos|mercado pos|pos.* mercado|posicion/]),
        qty: findCol(header, [/^(qty|cant|cantidad|quantity)/]),
        profit: findCol(header, [/^(profit|beneficio|ganancias?)( \(.*\))?$/, /^(profit|beneficio)\b(?!.*(acum|cum))/]),
        cum: findCol(header, [/cum\.? (net )?profit|con ganancia neto|(ganancia|beneficio).*(acum|neto)/]),
        comm: findCol(header, [/^(commission|comision)/]),
        fees: header.map((h, i) => (/^(fee|tarifa)|\bfee\b/.test(norm(h)) ? i : -1)).filter((i) => i > -1),
        mae: findCol(header, [/^mae/]),
        mfe: findCol(header, [/^mfe/]),
        instrument: findCol(header, [/instrument|instrumento|simbolo/]),
      };
  if (col.exitTime < 0 || col.profit < 0) return fail('No encuentro las columnas de hora de salida y beneficio en el CSV de NinjaTrader.');

  const exitTimes = rows.map((r) => r[col.exitTime]).filter(Boolean);
  const { order, ambiguous } = detectOrder(exitTimes.concat(rows.map((r) => r[col.entryTime]).filter(Boolean)));
  if (ambiguous) warnings.push('No puedo distinguir día/mes en las fechas: asumo día/mes/año. Si las fechas salen mal, exporta con otro formato.');
  const num = makeNumberParser(rows.flatMap((r) => [r[col.profit], col.comm > -1 ? r[col.comm] : '', col.mae > -1 ? r[col.mae] : '', col.cum > -1 ? r[col.cum] : '']));
  const val = (r, i) => (i > -1 ? (num(r[i]) || 0) : 0);

  const symbolFromName = (/(^|[\\/])\s*([A-Za-z0-9]+)[ _-]/.exec(fileName) || [])[2] || '';
  let commissionSeen = false;
  let microCount = 0;
  // Si el CSV trae el beneficio acumulado, se usa para saber si la columna de beneficio ya descuenta la comisión.
  let profitIsNet = false;
  if (col.cum > -1) {
    let prev = 0, netHits = 0, grossHits = 0;
    for (const r of rows) {
      const cumV = num(r[col.cum]);
      if (isNaN(cumV)) continue;
      const diff = cumV - prev; prev = cumV;
      const cost = Math.abs(val(r, col.comm)) + col.fees.reduce((a, i) => a + Math.abs(val(r, i)), 0);
      if (cost <= 0) continue;
      const g = val(r, col.profit);
      if (Math.abs(diff - g) < 0.011) netHits++; else if (Math.abs(diff - (g - cost)) < 0.011) grossHits++;
    }
    profitIsNet = netHits > grossHits;
  }

  const trades = [];
  for (const r of rows) {
    const st = parseStamp(r[col.exitTime], order);
    if (!st) continue;
    const utc = wallToUtc(st.y, st.mo, st.d, st.h, st.mi, st.s, zone);
    const nyTime = toNYString(utc);
    const qty = Math.abs(val(r, col.qty)) || 1;
    const gross = val(r, col.profit);
    const comm = Math.abs(val(r, col.comm)) + col.fees.reduce((a, i) => a + Math.abs(val(r, i)), 0);
    if (comm > 0) commissionSeen = true;
    const net = gross - (profitIsNet ? 0 : comm) - extraRT * qty;
    const mae = Math.abs(val(r, col.mae));
    const sym = col.instrument > -1 ? r[col.instrument] : symbolFromName;
    const micro = isMicroSymbol(sym);
    if (micro) microCount++;
    trades.push({
      date: nyTime.substring(0, 10).replace(/\./g, '-'),
      time: nyTime,
      profit: net,
      gross,
      volume: micro ? qty / 10 : qty, // en "minis equivalentes", como espera el aviso de contratos
      lowestFloating: Math.min(net, -mae - (profitIsNet ? 0 : comm) - extraRT * qty),
    });
  }
  if (trades.length === 0) return fail('No pude leer ninguna operación del CSV de NinjaTrader.');

  trades.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const netProfit = trades.reduce((a, t) => a + t.profit, 0);

  warnings.push(`NinjaTrader: horas convertidas de ${zone} a Nueva York (la hora del servidor MT5 no se usa).`);
  if (!commissionSeen && extraRT === 0) warnings.push('El archivo no trae comisión (o es 0): el resultado es BRUTO. Indica la comisión por contrato (ida y vuelta) para netearlo.');
  if (col.mae < 0) warnings.push('El archivo no trae MAE: el drawdown intradía es optimista (solo cuenta el resultado cerrado).');
  else warnings.push('Drawdown intradía calculado con el MAE de cada operación (pérdida flotante máxima).');
  if (microCount === 0 && col.instrument < 0) warnings.push('No sé si el contrato es micro o mini (el nombre del archivo no lo indica): lo trato como mini para el límite de contratos.');

  return { trades, meta: { source: 'nt8', timeBase: 'NY', initialDeposit: null, netProfit, reportedNetProfit: null, refTP: null, refSL: null, warnings } };
};
