// Parser de informes de MetaTrader 5 (Strategy Tester).
// Devuelve { trades, meta }.
//   trades: [{ date: 'YYYY-MM-DD', time: 'YYYY.MM.DD HH:MM:SS', profit, lowestFloating }]
//           date/time son los del CIERRE de la operación; profit es neto (beneficio + comisiones + swap).
//   meta:   { source, initialDeposit, netProfit, reportedNetProfit, warnings[] }

const DATE_RE = /^\d{4}[./-]\d{2}[./-]\d{2}/;

const SECTION_NAMES = {
  deals: ['deals', 'transacciones', 'сделки'],
  positions: ['positions', 'posiciones', 'позиции'],
  orders: ['orders', 'órdenes', 'ordenes', 'ордера'],
};

const sectionOf = (cells) => {
  const nonEmpty = cells.filter((c) => c !== '');
  if (nonEmpty.length !== 1) return null;
  const t = nonEmpty[0].toLowerCase();
  for (const [name, aliases] of Object.entries(SECTION_NAMES)) {
    if (aliases.includes(t)) return name;
  }
  return null;
};

const clean = (s) =>
  String(s ?? '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------- Números: el formato se decide UNA vez por archivo ----------
const makeNumberParser = (samples) => {
  let comma = 0;
  let dot = 0;
  for (const raw of samples) {
    const s = clean(raw).replace(/ /g, '');
    if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) comma++;
    else if (/\.\d{1,2}$/.test(s)) dot++;
  }
  const decimalComma = comma > dot;
  return (val) => {
    if (typeof val === 'number') return val;
    let s = clean(val).replace(/ /g, '').replace(/[−—–]/g, '-');
    if (s === '') return NaN;
    s = decimalComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    return /^[-+]?\d*\.?\d+$/.test(s) || /^[-+]?\d+\.?$/.test(s) ? parseFloat(s) : NaN;
  };
};

// ---------- Extracción de filas ----------
const rowsFromHTML = (content) => {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const rows = [];
  // Todas las <tr> del documento en orden: sirve tanto si hay una tabla con secciones
  // (lo habitual en MT5) como si hay varias.
  doc.querySelectorAll('tr').forEach((tr) => {
    // Ignora filas que contienen tablas anidadas para no duplicar celdas.
    if (tr.querySelector('table')) return;
    const cells = Array.from(tr.children)
      .filter((el) => el.tagName === 'TD' || el.tagName === 'TH')
      .map((el) => clean(el.textContent));
    if (cells.length > 0) rows.push(cells);
  });
  return rows;
};

const splitDelimited = (line, delim) => {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === delim && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(clean); // NO se colapsan celdas vacías: el índice de columna debe conservarse
};

const rowsFromText = (content) => {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const sample = lines.slice(0, 200).join('\n');
  const count = (ch) => (sample.match(new RegExp(ch === '\t' ? '\\t' : '\\' + ch, 'g')) || []).length;
  // Prioridad: tabulador > punto y coma > coma (la coma puede ser decimal)
  const delim = count('\t') > 0 ? '\t' : count(';') > 0 ? ';' : ',';
  return lines.map((l) => splitDelimited(l, delim));
};

// ---------- Cabeceras ----------
const isTimeCell = (c) => /time|tiempo|date|fecha|hora|врем/.test(c);
const PROFIT_NAMES = ['profit', 'beneficio', 'прибыль', 'beneficio/pérdida', 'profit/loss'];

// Con título de sección, la cabecera está justo debajo; sin título (CSV plano) se busca en todo el rango.
const findHeader = (rows, from, to, named) => {
  const last = named ? Math.min(to, from + 4) : to;
  for (let i = from; i < last; i++) {
    const low = rows[i].map((c) => c.toLowerCase());
    if (low.some((c) => PROFIT_NAMES.includes(c)) && low.some(isTimeCell)) return i;
  }
  return -1;
};

const columnsFromHeader = (header) => {
  const low = header.map((c) => c.toLowerCase());
  const lastIndex = (pred) => {
    for (let i = low.length - 1; i >= 0; i--) if (pred(low[i])) return i;
    return -1;
  };
  return {
    // Positions tiene dos columnas de hora (apertura, cierre). Deals tiene una. Siempre la ÚLTIMA.
    time: lastIndex(isTimeCell),
    type: low.findIndex((c) => c === 'type' || c === 'tipo' || c === 'тип'),
    dir: low.findIndex((c) => ['direction', 'dirección', 'direccion', 'dir', 'направление'].includes(c)),
    symbol: low.findIndex((c) => ['symbol', 'símbolo', 'simbolo', 'символ'].includes(c)),
    profit: low.findIndex((c) => PROFIT_NAMES.includes(c)),
    comm: low.findIndex((c) => c.includes('commission') || c.includes('comisión') || c.includes('comision') || c.includes('комисс')),
    swap: low.findIndex((c) => c.includes('swap') || c.includes('своп')),
    balance: low.findIndex((c) => c === 'balance' || c === 'баланс'),
    volume: low.findIndex((c) => c === 'volume' || c === 'volumen' || c === 'объем'),
    comment: low.findIndex((c) => c === 'comment' || c === 'comentario' || c === 'комментарий'),
  };
};

// ---------- Lector de gráfico crudo (Deposit Load) ----------
const parseGraph = (rows) => {
  const parsed = [];
  let lastFlatBalance = null;
  let lowestEquityDuringTrade = null;
  let isInTrade = false;
  let tradeStartDate = null;

  for (const cols of rows) {
    if (cols.some((c) => c.includes('HEADER'))) continue;
    const dateIndex = cols.findIndex((c) => DATE_RE.test(c));
    if (dateIndex === -1) continue;
    const dateStr = cols[dateIndex].substring(0, 10).replace(/[./]/g, '-');
    const nums = cols.map((c) => parseFloat(c.replace(/\s/g, '').replace(',', '.'))).filter((n) => !isNaN(n));
    if (nums.length < 3) continue;

    const load = nums[nums.length - 1];
    const equity = nums[nums.length - 2];
    const balance = nums[nums.length - 3];
    if (lastFlatBalance === null) lastFlatBalance = balance;

    if (load > 0.0001) {
      if (!isInTrade) {
        isInTrade = true;
        tradeStartDate = dateStr;
        lowestEquityDuringTrade = equity;
      } else if (equity < lowestEquityDuringTrade) {
        lowestEquityDuringTrade = equity;
      }
    } else if (isInTrade) {
      const profit = balance - lastFlatBalance;
      const lowestFloating = lowestEquityDuringTrade - lastFlatBalance;
      if (Math.abs(profit) > 0.001 || Math.abs(lowestFloating) > 0.001) {
        parsed.push({
          date: tradeStartDate || dateStr,
          time: cols[dateIndex],
          profit,
          lowestFloating: Math.min(lowestFloating, profit, 0),
        });
      }
      lastFlatBalance = balance;
      isInTrade = false;
      lowestEquityDuringTrade = null;
    } else {
      lastFlatBalance = balance;
    }
  }
  return parsed;
};

// ---------- Principal ----------
export const parseMT5Content = (content, fileName = '') => {
  const name = fileName.toLowerCase();
  const isHTML = name.endsWith('.html') || name.endsWith('.htm') || /<html|<table/i.test(content.slice(0, 5000));
  const rows = isHTML ? rowsFromHTML(content) : rowsFromText(content);
  const warnings = [];

  if (rows.some((r) => r.some((c) => c.toUpperCase().includes('DEPOSIT LOAD')))) {
    const trades = parseGraph(rows);
    if (trades.length > 0) {
      return {
        trades,
        meta: { source: 'graph', initialDeposit: null, netProfit: trades.reduce((a, t) => a + t.profit, 0), reportedNetProfit: null, warnings },
      };
    }
  }

  // 1. Trocear en secciones (Orders / Deals / Positions) según las filas-título.
  const sections = [];
  let current = { name: 'unnamed', start: 0 };
  rows.forEach((r, i) => {
    const s = sectionOf(r);
    if (s) {
      current.end = i;
      sections.push(current);
      current = { name: s, start: i + 1 };
    }
  });
  current.end = rows.length;
  sections.push(current);

  // 2. Elegir sección: Deals (permite cuadrar con la columna Balance) > Positions > sin título.
  const headerOf = (s) => findHeader(rows, s.start, s.end, s.name !== 'unnamed');
  const pick = ['deals', 'positions', 'unnamed'].map((n) => sections.find((s) => s.name === n && headerOf(s) !== -1)).find(Boolean);
  if (!pick) return { trades: [], meta: { source: null, initialDeposit: null, netProfit: 0, reportedNetProfit: null, warnings: ['No se encontró una tabla de Transacciones/Posiciones con cabecera.'] } };

  const headerIdx = headerOf(pick);
  const col = columnsFromHeader(rows[headerIdx]);
  if (col.time < 0 || col.profit < 0 || col.type < 0) {
    return { trades: [], meta: { source: null, initialDeposit: null, netProfit: 0, reportedNetProfit: null, warnings: ['La cabecera no tiene las columnas Hora, Tipo y Beneficio.'] } };
  }
  const data = rows.slice(headerIdx + 1, pick.end).filter((r) => DATE_RE.test(r[col.time] || ''));
  const num = makeNumberParser(data.map((r) => r[col.profit]).concat(data.map((r) => r[col.comm])));
  const val = (r, i) => (i > -1 ? (num(r[i]) || 0) : 0);
  const hasDirection = col.dir > -1;
  const source = hasDirection ? 'deals' : 'positions';

  const trades = [];
  let initialDeposit = null;
  let lastBalance = null;
  const openCosts = {}; // símbolo -> cola FIFO de comisión+swap de las entradas aún abiertas

  for (const r of data) {
    const type = (r[col.type] || '').toLowerCase();
    if (col.balance > -1) {
      const b = num(r[col.balance]);
      if (!isNaN(b)) lastBalance = b;
    }
    // Solo operaciones reales. Se descartan balance (depósito inicial), credit, charge, correction...
    if (type !== 'buy' && type !== 'sell') {
      if (type === 'balance' && initialDeposit === null) initialDeposit = val(r, col.profit);
      continue;
    }

    const sym = col.symbol > -1 ? r[col.symbol] : '';
    const cost = val(r, col.comm) + val(r, col.swap);

    if (hasDirection) {
      const dir = (r[col.dir] || '').toLowerCase().replace(/\s/g, '');
      if (dir === 'in') {
        (openCosts[sym] = openCosts[sym] || []).push(cost); // guardar coste de entrada, no es una operación cerrada
        continue;
      }
      const entry = (openCosts[sym] && openCosts[sym].shift()) || 0;
      const gross = val(r, col.profit);
      const net = gross + cost + entry; // salida: beneficio + su comisión/swap + comisión/swap de la entrada
      // MT5 anota en el comentario de la salida si cerró por "tp 1234.5" o "sl 1234.5"
      const cm = col.comment > -1 ? (r[col.comment] || '').toLowerCase() : '';
      const exit = /^tp\b/.test(cm) ? 'tp' : /^sl\b/.test(cm) ? 'sl' : 'other';
      trades.push({ date: r[col.time].substring(0, 10).replace(/[./]/g, '-'), time: r[col.time], profit: net, gross, exit, volume: val(r, col.volume), lowestFloating: net < 0 ? net : 0 });
    } else {
      const net = val(r, col.profit) + cost; // en Positions la comisión ya es el total de la posición
      trades.push({ date: r[col.time].substring(0, 10).replace(/[./]/g, '-'), time: r[col.time], profit: net, volume: val(r, col.volume), lowestFloating: net < 0 ? net : 0 });
    }
  }

  // Orden por hora de CIERRE (los Deals ya vienen ordenados; Positions vienen por apertura).
  trades.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const netProfit = trades.reduce((a, t) => a + t.profit, 0);

  // 3. Verificación cruzada contra el propio informe.
  const dangling = Object.values(openCosts).reduce((a, q) => a + q.length, 0);
  if (dangling > 0) warnings.push(`${dangling} posición(es) abierta(s) al final del backtest: no se cuentan como operaciones.`);
  let reportedNetProfit = null;
  if (initialDeposit !== null && lastBalance !== null && dangling === 0) {
    reportedNetProfit = lastBalance - initialDeposit;
    if (Math.abs(reportedNetProfit - netProfit) > 1) {
      warnings.push(`La suma de operaciones (${netProfit.toFixed(2)}) no coincide con el beneficio neto del informe (${reportedNetProfit.toFixed(2)}).`);
    }
  }
  // Referencia de TP/SL en $: mediana del beneficio bruto de las salidas por TP / SL (necesita ≥ 5 muestras)
  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  };
  const tpSamples = trades.filter((x) => x.exit === 'tp').map((x) => x.gross);
  const slSamples = trades.filter((x) => x.exit === 'sl').map((x) => Math.abs(x.gross));
  const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
  const refTP = tpSamples.length >= 5 ? round2(median(tpSamples)) : null;
  const refSL = slSamples.length >= 5 ? round2(median(slSamples)) : null;

  warnings.push('El informe no incluye el equity intradía: el drawdown medido es optimista (solo cuenta el resultado cerrado de cada operación).');

  return { trades, meta: { source, initialDeposit, netProfit, reportedNetProfit, refTP, refSL, warnings } };
};
