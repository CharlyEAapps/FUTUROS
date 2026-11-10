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
    timeOpen: low.findIndex(isTimeCell), // Positions: hora de apertura (primera columna de hora)
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
// Marca de tiempo "YYYY.MM.DD HH:MM[:SS]" -> milisegundos (UTC ficticio; solo sirve para comparar horas del servidor).
const toMs = (str) => {
  const m = /^(\d{4})[./-](\d{2})[./-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(str || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN;
};

// Filas del gráfico: { time, ms, balance, equity, load }. El BALANCE del gráfico de MT5 llega ya con el resultado de la
// operación en la fila de apertura (es posterior al cierre) y la carga puede ser 0 con la posición aún abierta.
const graphPoints = (rows) => {
  const pts = [];
  for (const cols of rows) {
    if (cols.some((c) => c.includes('HEADER'))) continue;
    const dateIndex = cols.findIndex((c) => DATE_RE.test(c));
    if (dateIndex === -1) continue;
    // Decimal con punto; los miles pueden venir con espacio como separador (p. ej. "109 812.69").
    const nums = cols.map((c) => parseFloat(c.replace(/\s/g, '').replace(',', '.'))).filter((n) => !isNaN(n));
    if (nums.length < 3) continue;
    pts.push({ time: cols[dateIndex], ms: toMs(cols[dateIndex]), balance: nums[nums.length - 3], equity: nums[nums.length - 2], load: nums[nums.length - 1] });
  }
  return pts;
};

// Lector solo-gráfico (sin informe). Una operación = un tramo CONTINUO de filas con posición abierta, entre dos filas
// "planas" (sin carga y equity = balance). Así las filas con carga 0 pero posición todavía abierta no parten la operación
// en dos, y el flotante de cada operación se mide contra el saldo anterior a abrirla.
const parseGraph = (rows) => {
  const pts = graphPoints(rows);
  const parsed = [];
  const isFlat = (p) => p.load <= 0.0001 && Math.abs(p.equity - p.balance) < 0.005;
  let lastFlatBalance = null;
  let seg = null; // { dateStr, time, low, high }

  for (const p of pts) {
    const dateStr = p.time.substring(0, 10).replace(/[./]/g, '-');
    if (lastFlatBalance === null) lastFlatBalance = p.balance;
    if (!isFlat(p)) {
      if (!seg) seg = { dateStr, time: p.time, low: p.equity, high: p.equity };
      else {
        if (p.equity < seg.low) seg.low = p.equity;
        if (p.equity > seg.high) seg.high = p.equity;
      }
      continue;
    }
    // Fila plana: cierra el tramo abierto (si lo hay) y fija el nuevo saldo de referencia.
    const profit = p.balance - lastFlatBalance;
    if (seg) {
      const lowestFloating = seg.low - lastFlatBalance;
      const highestFloating = seg.high - lastFlatBalance;
      parsed.push({
        date: seg.dateStr,
        time: seg.time,
        profit,
        // Peor / mejor equity del tramo frente al saldo de inicio (MFE para la regla del objetivo)
        lowestFloating: Math.min(lowestFloating, profit, 0),
        highestFloating: Math.max(highestFloating, profit, 0),
      });
    } else if (Math.abs(profit) > 0.001) {
      // Operación que abrió y cerró entre dos puntos de la curva: el balance cambia sin filas intermedias.
      parsed.push({ date: dateStr, time: p.time, profit, lowestFloating: Math.min(profit, 0), highestFloating: Math.max(profit, 0) });
    }
    lastFlatBalance = p.balance;
    seg = null;
  }
  // Tramo abierto al final de la curva: no se cuenta como operación.
  // Primer balance de la curva = depósito inicial del backtest
  if (pts.length) parsed.firstBalance = pts[0].balance;
  parsed.points = pts;
  return parsed;
};

// ---------- Informe + gráfico: cada operación real una sola vez ----------
// El informe (Deals/Positions) es la fuente de verdad de las operaciones (hora de apertura y de cierre, resultado, lotes,
// dirección). El gráfico solo aporta el equity intradía: para cada operación se toman las filas del gráfico entre su
// apertura y su cierre y se mide el flotante contra el saldo ANTERIOR a abrirla (depósito + suma de resultados previos),
// no contra el balance de la fila, que ya incluye el resultado de esa operación.
// Devuelve { trades, warnings, withFloat } o null si el informe no trae la hora de apertura de las operaciones.
export const mergeReportAndGraph = (reportTrades, points, initialDeposit) => {
  if (!reportTrades || reportTrades.length === 0 || !points || points.length === 0) return null;
  if (reportTrades.some((t) => !t.openTime || isNaN(toMs(t.openTime)))) return null;

  const deposit = initialDeposit ?? points[0].balance;
  const base = reportTrades.map((t) => ({ ...t }));
  base.sort((a, b) => toMs(a.time) - toMs(b.time));
  let bal = deposit;
  base.forEach((t) => { t.balBefore = bal; bal += t.profit; t.balAfter = bal; t.o = Math.floor(toMs(t.openTime) / 60000) * 60000; t.c = Math.ceil(toMs(t.time) / 60000) * 60000; t.cf = Math.floor(toMs(t.time) / 60000) * 60000; });

  // Las filas del gráfico se asignan a la operación abierta más reciente cuya ventana contiene la hora de la fila.
  const byOpen = base.map((_, i) => i).sort((i, j) => base[i].o - base[j].o);
  const opens = byOpen.map((i) => base[i].o);
  const stats = base.map(() => ({ low: Infinity, high: -Infinity, n: 0 }));
  for (const p of points) {
    if (isNaN(p.ms)) continue;
    let lo = 0, hi = opens.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (opens[mid] <= p.ms) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    for (let q = idx, tries = 0; q >= 0 && tries < 4; q--, tries++) {
      const k = byOpen[q];
      if (p.ms <= base[k].c) {
        const st = stats[k];
        if (p.equity < st.low) st.low = p.equity;
        if (p.equity > st.high) st.high = p.equity;
        st.n++;
        break;
      }
    }
  }

  let withFloat = 0;
  const trades = base.map((t, k) => {
    const st = stats[k];
    let low = Math.min(t.profit, 0);
    let high = Math.max(t.profit, 0);
    if (st.n > 0) {
      low = Math.min(st.low - t.balBefore, t.profit, 0);
      high = Math.max(st.high - t.balBefore, t.profit, 0);
      withFloat++;
    }
    const { balBefore, balAfter, o, c, cf, ...rest } = t;
    return { ...rest, lowestFloating: low, highestFloating: high };
  });

  // Comprobación: en las filas planas del gráfico el balance debe coincidir con el saldo acumulado del informe.
  const warnings = [];
  let flat = 0, bad = 0;
  for (const p of points) {
    if (!(p.load <= 0.0001 && Math.abs(p.equity - p.balance) < 0.005) || isNaN(p.ms)) continue;
    let lo = 0, hi = base.length - 1, last = -1; // última operación cerrada (a su minuto) a la hora de la fila
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (base[mid].cf <= p.ms) { last = mid; lo = mid + 1; } else hi = mid - 1; }
    const expected = last < 0 ? deposit : base[last].balAfter;
    flat++;
    if (Math.abs(expected - p.balance) > 1) bad++;
  }
  if (flat > 0 && bad / flat > 0.02) {
    warnings.push(`El gráfico no cuadra con el informe en ${bad} de ${flat} puntos planos: puede que no sean del mismo backtest. Revisa que sean los dos archivos de la misma prueba.`);
  }
  if (withFloat < trades.length * 0.8) {
    warnings.push(`Solo ${withFloat} de ${trades.length} operaciones tienen filas del gráfico entre su apertura y su cierre; el resto usa su resultado cerrado como único flotante.`);
  }
  return { trades, warnings, withFloat };
};

// Depósito inicial declarado en la cabecera del informe ("Depósito inicial:" / "Initial Deposit:")
const depositFromHeader = (rows) => {
  for (const r of rows) {
    const i = r.findIndex((c) => /^(dep[oó]sito inicial|initial deposit|начальный депозит)\s*:?$/i.test(c));
    if (i > -1 && r[i + 1]) {
      const v = parseFloat(r[i + 1].replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
      if (!isNaN(v)) return v;
    }
  }
  return null;
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
      warnings.push('Archivo de gráfico con equity intradía: el objetivo se aprueba si el equity lo alcanza con la posición abierta, y el drawdown y el límite diario miran el equity, no solo el cierre. La curva no indica la dirección (largo/corto) de cada operación.');
      return {
        trades,
        meta: { source: 'graph', graphPoints: trades.points, initialDeposit: trades.firstBalance ?? null, netProfit: trades.reduce((a, t) => a + t.profit, 0), reportedNetProfit: null, refTP: null, refSL: null, warnings },
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
  const openTrades = {}; // símbolo -> cola FIFO de { cost, dir } de las entradas aún abiertas

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
        // En Deals, la entrada "buy" abre un largo; "sell" abre un corto.
        (openTrades[sym] = openTrades[sym] || []).push({ cost, direction: type === 'buy' ? 'long' : 'short', openTime: r[col.time] });
        continue;
      }
      const entry = (openTrades[sym] && openTrades[sym].shift()) || { cost: 0, direction: null, openTime: null };
      const gross = val(r, col.profit);
      const net = gross + cost + entry.cost; // salida: beneficio + su comisión/swap + comisión/swap de la entrada
      // MT5 anota en el comentario de la salida si cerró por "tp 1234.5" o "sl 1234.5"
      const cm = col.comment > -1 ? (r[col.comment] || '').toLowerCase() : '';
      const exit = /^tp\b/.test(cm) ? 'tp' : /^sl\b/.test(cm) ? 'sl' : 'other';
      trades.push({ date: r[col.time].substring(0, 10).replace(/[./]/g, '-'), time: r[col.time], openTime: entry.openTime, profit: net, gross, exit, direction: entry.direction, volume: val(r, col.volume), lowestFloating: net < 0 ? net : 0 });
    } else {
      // En Positions, el tipo de la fila ya es la dirección de la posición cerrada.
      const net = val(r, col.profit) + cost; // la comisión ya es el total de la posición
      trades.push({ date: r[col.time].substring(0, 10).replace(/[./]/g, '-'), time: r[col.time], openTime: col.timeOpen > -1 && col.timeOpen !== col.time ? (r[col.timeOpen] || null) : null, profit: net, direction: type === 'buy' ? 'long' : 'short', volume: val(r, col.volume), lowestFloating: net < 0 ? net : 0 });
    }
  }

  // Orden por hora de CIERRE (los Deals ya vienen ordenados; Positions vienen por apertura).
  trades.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const netProfit = trades.reduce((a, t) => a + t.profit, 0);

  // 3. Verificación cruzada contra el propio informe.
  const dangling = Object.values(openTrades).reduce((a, q) => a + q.length, 0);
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

  return { trades, meta: { source, initialDeposit: initialDeposit ?? depositFromHeader(rows), netProfit, reportedNetProfit, refTP, refSL, warnings } };
};
