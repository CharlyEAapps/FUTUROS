import React, { useState, useRef } from 'react';
import { Play, Upload, TrendingUp, AlertTriangle, CheckCircle, Clock, Calendar, ShieldAlert, Award, FileText, Info } from 'lucide-react';
import { parseMT5Content } from './parseMT5';

const App = () => {
  // Configuración del sistema
  const [accountSize, setAccountSize] = useState(50000);
  const [consistency, setConsistency] = useState('OFF');
  const [dailyLossEnabled, setDailyLossEnabled] = useState(true);
  const [drawdownType, setDrawdownType] = useState('EOD'); // 'EOD' o 'INTRADAY'
  const [phase, setPhase] = useState('Examen');
  // Horas que el reloj del servidor MT5 va por delante de Nueva York. 7 = servidores "New York Close" (p. ej. Darwinex: GMT+2/+3 con DST de EE.UU.)
  const [serverOffsetHours, setServerOffsetHours] = useState(7);
  
  // Datos y estado de la app
  const [trades, setTrades] = useState([]);
  const [fileName, setFileName] = useState('');
  const [results, setResults] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [parseWarnings, setParseWarnings] = useState([]);
  // TP/SL de referencia del backtest (en $) y TP objetivo elegido. Cambiar el TP escala el lotaje, y con él el SL y todo el P&L.
  const [refTP, setRefTP] = useState(null);
  const [refSL, setRefSL] = useState(null);
  const [tpTarget, setTpTarget] = useState('');

  // Volumen por operación del informe (para el aviso de contratos cuando el motor usa el gráfico)
  const [reportVolumes, setReportVolumes] = useState([]);
  // Registros guardados en el navegador (localStorage)
  const STORAGE_KEY = 'evaluadorPropFirms.registros';
  const [savedRecords, setSavedRecords] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  });
  const persistRecords = (records) => {
    setSavedRecords(records);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch { /* cuota del navegador llena */ }
  };
  // Pestaña de resultados: 'general' o 'detalle'
  const [activeTab, setActiveTab] = useState('general');
  // Nivel de agrupación del detalle temporal: 'year' | 'quarter' | 'month'
  const [periodLevel, setPeriodLevel] = useState('quarter');

  const fileInputRef = useRef(null);

  // Factor de lotaje que implica el TP elegido respecto al TP del backtest
  const getLotScale = () => {
    const tp = parseFloat(tpTarget);
    return refTP && tp > 0 ? tp / refTP : 1;
  };

  // Límite de contratos de Lucid por cuenta, en minis. Equivalencia asumida: 1 lote XAUUSD = 100 oz = 1 mini GC; 0,1 lote = 1 micro MGC.
  const MAX_MINIS = { 25000: 2, 50000: 4, 100000: 6 };
  const contractCheck = (() => {
    // El volumen puede venir del propio juego de operaciones (informe) o del informe aparte si el motor usa el gráfico
    const vols = trades.some((tr) => tr.volume > 0) ? trades.filter((tr) => tr.volume > 0).map((tr) => tr.volume) : reportVolumes;
    if (vols.length === 0) return null;
    const withVolume = vols.map((v) => ({ volume: v }));
    const scale = getLotScale();
    const limit = MAX_MINIS[accountSize];
    const over = withVolume.filter((tr) => tr.volume * scale > limit + 1e-9).length;
    const peak = Math.max(...withVolume.map((tr) => tr.volume)) * scale;
    return { limit, over, peak, total: withVolume.length };
  })();
  const contractWarning = contractCheck && contractCheck.over > 0 ? (
    <p className="text-xs text-amber-400 mt-2 flex items-start gap-1">
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>
        Lotaje máximo {contractCheck.peak.toFixed(2)} lotes, por encima del límite de Lucid para esta cuenta ({contractCheck.limit} minis o {contractCheck.limit * 10} micros).{' '}
        {contractCheck.over} de {contractCheck.total} operaciones lo superan. Equivalencia asumida: 1 lote de XAUUSD = 1 mini de oro (GC).
      </span>
    </p>
  ) : null;

  const consistencyOptions = [
    { label: 'OFF', value: 'OFF' },
    { label: '40%', value: '0.40' },
    { label: '45%', value: '0.45' },
    { label: '50%', value: '0.50' }
  ];

  // Lector de archivos de MT5. Acepta varios a la vez: informe (HTML/CSV) y curva de equity (gráfico).
  // Si hay un gráfico, el motor usa el gráfico (equity flotante); el informe aporta TP/SL y volumen.
  const handleFileUpload = (e) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    if (files.length === 0) return;

    setErrorMsg('');
    setParseWarnings([]);
    setRefTP(null);
    setRefSL(null);
    setTpTarget('');
    setTrades([]);
    setReportVolumes([]);
    setResults(null);

    const readFile = (file) =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            resolve({ name: file.name, ...parseMT5Content(ev.target.result, file.name) });
          } catch (err) {
            resolve({ name: file.name, trades: [], meta: { warnings: ['Error al procesar ' + file.name + ': ' + err.message] } });
          }
        };
        reader.readAsText(file);
      });

    Promise.all(files.map(readFile)).then((parsed) => {
      setFileName(files.map((f) => f.name).join(' + '));

      const graph = parsed.find((p) => p.meta.source === 'graph' && p.trades.length > 0);
      const report = parsed.find((p) => p.meta.source !== 'graph' && p.trades.length > 0);
      const chosen = graph || report; // el gráfico manda para el motor

      if (!chosen) {
        const firstWarn = parsed.map((p) => p.meta.warnings && p.meta.warnings[0]).find(Boolean);
        setErrorMsg(firstWarn || 'No se pudieron detectar operaciones válidas en los archivos. Sube el informe de MT5 o la curva de equity del gráfico.');
        return;
      }

      setTrades(chosen.trades);
      setResults(null);

      // TP/SL y volumen: del informe si existe (más fiable); si no, del propio elegido
      const refSource = report || chosen;
      setRefTP(refSource.meta.refTP || null);
      setRefSL(refSource.meta.refSL || null);
      setTpTarget(refSource.meta.refTP ? String(refSource.meta.refTP) : '');
      if (graph && report) setReportVolumes(report.trades.filter((t) => t.volume > 0).map((t) => t.volume));

      const warns = [...(chosen.meta.warnings || [])];
      if (graph && report) warns.unshift('Dos archivos combinados: el motor usa la curva de equity del gráfico; el informe aporta TP/SL y volumen. Las medias y el winrate son los del archivo del motor.');
      else if (report && !graph) warns.unshift('Solo informe cargado: el objetivo y el drawdown se miden con el cierre de cada operación. Para usar el equity intradía, sube también la curva del gráfico.');
      setParseWarnings(warns);
    });

    input.value = ''; // permite volver a elegir los mismos archivos
  };

  // Motor Principal de Simulación
  const runBacktest = () => {
    if (trades.length === 0) return;

    let targetProfitAmount = 0;
    let dailyLossAmount = 0;
    let maxDrawdownAmount = 0;

    if (accountSize === 25000) {
      targetProfitAmount = 1250;
      dailyLossAmount = 600;
      maxDrawdownAmount = 1000;
    } else if (accountSize === 50000) {
      targetProfitAmount = 3000;
      dailyLossAmount = 1200;
      maxDrawdownAmount = 2000;
    } else if (accountSize === 100000) {
      targetProfitAmount = 6000;
      dailyLossAmount = 1800;
      maxDrawdownAmount = 3000;
    }

    const targetBalance = accountSize + targetProfitAmount;
    const consistencyRuleValue = consistency === 'OFF' ? 1.0 : parseFloat(consistency);

    // Variables de control de exámenes
    let aprobados = 0;
    let suspendidos = 0;
    
    let currentBalance = accountSize;
    let highestEODBalance = accountSize;
    let highestIntradayBalance = accountSize;
    let currentDrawdownLimit = accountSize - maxDrawdownAmount;
    let startOfDayBalance = accountSize;
    let currentDay = null;
    let maxDailyProfit = 0;
    let currentDayProfit = 0;
    let totalExamProfit = 0;
    let currentExamTrades = 0;
    let currentExamStartDate = null;
    let uniqueExamDays = new Set(); // Conjunto para contar días de trading únicos reales
    let skipDate = null;
    let dllBlockedDate = null; // día en el que el DLL bloqueó la operativa (la cuenta sigue viva)

    let examHistory = [];
    
    // Métricas globales
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfitSum = 0;
    let totalLossSum = 0;
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let winStreaks = []; // longitud de cada racha de ganadoras
    let lossStreaks = []; // longitud de cada racha de perdedoras
    let durationsPass = [];
    let durationsFail = [];

    // La sesión de Lucid termina a las 16:45 ET. Las operaciones se agrupan por sesión, no por día natural del servidor.
    // hora ET = hora servidor - offset; sesión = fecha de (hora ET + 7h15m), de modo que 16:45 ET abre la sesión siguiente.
    const sessionShiftMs = (7 * 60 + 15 - serverOffsetHours * 60) * 60000;
    const sessionDay = (trade) => {
      const m = /^(\d{4})[./-](\d{2})[./-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(trade.time || '');
      if (!m) return trade.date; // sin hora (p. ej. modo gráfico): se mantiene la fecha
      const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + sessionShiftMs;
      return new Date(ms).toISOString().slice(0, 10);
    };
    // Los puntos de TP y SL no cambian: solo la cantidad. Cambiar el lotaje multiplica por igual
    // beneficio, comisión, swap y pérdida flotante de cada operación (el SL en $ sube o baja en la misma proporción).
    const lotScale = getLotScale();
    const sessionTrades = trades.map((tr) => ({
      ...tr,
      date: sessionDay(tr),
      profit: tr.profit * lotScale,
      lowestFloating: tr.lowestFloating !== undefined ? tr.lowestFloating * lotScale : undefined,
    }));

    sessionTrades.forEach((trade) => {
      // Estadísticas Globales
      if (trade.profit > 0) {
        winningTrades++;
        totalProfitSum += trade.profit;
        if (currentLossStreak > 0) lossStreaks.push(currentLossStreak);
        currentWinStreak++;
        currentLossStreak = 0;
      } else if (trade.profit < 0) {
        losingTrades++;
        totalLossSum += Math.abs(trade.profit);
        if (currentWinStreak > 0) winStreaks.push(currentWinStreak);
        currentLossStreak++;
        currentWinStreak = 0;
      }

      // Si estamos bloqueados este día por haber suspendido/aprobado antes, saltamos para el examen actual
      if (skipDate === trade.date) {
        return;
      }

      // DLL alcanzado antes en este día: no se opera más hasta la siguiente sesión
      if (dllBlockedDate === trade.date) {
        return;
      }

      if (!currentExamStartDate) {
        currentExamStartDate = trade.date;
        uniqueExamDays.clear();
      }

      uniqueExamDays.add(trade.date);

      // Gestión de cambio de día para EOD Trailing, DLL y Consistencia
      if (currentDay !== trade.date) {
        // Almacenar el mejor día para la regla de consistencia
        if (currentDay !== null) {
          maxDailyProfit = Math.max(maxDailyProfit, currentDayProfit);
        }
        
        currentDay = trade.date;
        startOfDayBalance = currentBalance;
        currentDayProfit = 0; // Reseteamos el beneficio acumulado para el nuevo día
        
        if (startOfDayBalance > highestEODBalance) {
          highestEODBalance = startOfDayBalance;
        }
        
        // Si el drawdown es EOD, se actualiza solo al cambiar de día
        if (drawdownType === 'EOD') {
          // El límite sube con el cierre más alto pero se bloquea en saldo inicial + 100 $
          currentDrawdownLimit = Math.min(highestEODBalance - maxDrawdownAmount, accountSize + 100);
        }
      }

      const lowestEquityDuringTrade = currentBalance + (trade.lowestFloating !== undefined ? trade.lowestFloating : (trade.profit < 0 ? trade.profit : 0));
      const dailyLossLimitBalance = startOfDayBalance - dailyLossAmount;

      // Equity máximo alcanzado durante la operación (MFE). Solo existe con archivo de gráfico (equity intradía).
      // Si el equity tocó el objetivo con la posición abierta, se cierra ahí y el examen se aprueba,
      // aunque la operación acabara cerrando peor. Requiere consistencia OK.
      const highestEquityDuringTrade = trade.highestFloating !== undefined ? currentBalance + trade.highestFloating : null;

      const hitDaily = dailyLossEnabled && lowestEquityDuringTrade <= dailyLossLimitBalance;
      const failedMax = lowestEquityDuringTrade <= currentDrawdownLimit;

      // Objetivo alcanzado en flotante (solo con equity intradía del gráfico)
      if (highestEquityDuringTrade !== null && !failedMax && highestEquityDuringTrade >= targetBalance) {
        const totalIfClosed = totalExamProfit + (targetBalance - currentBalance);
        let consistencyPassed = true;
        if (consistency !== 'OFF' && totalIfClosed > 0) {
          const tempMaxDaily = Math.max(maxDailyProfit, currentDayProfit + (targetBalance - currentBalance));
          if (tempMaxDaily > totalIfClosed * consistencyRuleValue) consistencyPassed = false;
        }
        if (consistencyPassed) {
          aprobados++;
          const daysCount = Math.max(1, uniqueExamDays.size);
          durationsPass.push(daysCount);
          examHistory.push({ status: 'pass', duration: daysCount, start: currentExamStartDate, end: trade.date, reason: 'Objetivo en flotante' });
          currentBalance = accountSize;
          highestEODBalance = accountSize;
          highestIntradayBalance = accountSize;
          currentDrawdownLimit = accountSize - maxDrawdownAmount;
          startOfDayBalance = accountSize;
          currentDay = null;
          maxDailyProfit = 0;
          currentDayProfit = 0;
          totalExamProfit = 0;
          currentExamTrades = 0;
          currentExamStartDate = null;
          uniqueExamDays.clear();
          skipDate = trade.date;
          return;
        }
      }

      // Evaluar Suspenso: solo el MLL pierde la cuenta
      if (failedMax) {
        suspendidos++;
        
        const daysCount = Math.max(1, uniqueExamDays.size);
        durationsFail.push(daysCount);
        examHistory.push({
          status: 'fail',
          duration: daysCount,
          start: currentExamStartDate,
          end: trade.date,
          reason: 'Pérdida Máxima (EOD)'
        });

        // Resetear cuenta para el examen del día siguiente
        currentBalance = accountSize;
        highestEODBalance = accountSize;
        highestIntradayBalance = accountSize;
        currentDrawdownLimit = accountSize - maxDrawdownAmount;
        startOfDayBalance = accountSize;
        currentDay = null;
        maxDailyProfit = 0;
        currentDayProfit = 0;
        totalExamProfit = 0;
        currentExamTrades = 0;
        currentExamStartDate = null;
        uniqueExamDays.clear();
        skipDate = trade.date;
        return;
      }

      // DLL alcanzado (soft breach): la operación se liquida en el límite diario,
      // se bloquea el resto del día y la cuenta sigue viva.
      let appliedProfit = trade.profit;
      if (hitDaily) {
        appliedProfit = dailyLossLimitBalance - currentBalance;
        dllBlockedDate = trade.date;
      }

      // Aplicar beneficio de la operación
      currentDayProfit += appliedProfit;
      currentBalance += appliedProfit;
      totalExamProfit += appliedProfit;
      currentExamTrades++;

      // Actualizar High-Water Mark si el drawdown es Intradía
      if (currentBalance > highestIntradayBalance) {
        highestIntradayBalance = currentBalance;
      }
      if (drawdownType === 'INTRADAY') {
        currentDrawdownLimit = highestIntradayBalance - maxDrawdownAmount;
      }

      // Evaluar Aprobación (Profit Target alcanzado)
      if (currentBalance >= targetBalance) {
        // Comprobar regla de consistencia si está activa (sobre beneficio DIARIO, no individual)
        let consistencyPassed = true;
        if (consistency !== 'OFF' && totalExamProfit > 0) {
          const tempMaxDaily = Math.max(maxDailyProfit, currentDayProfit);
          const maxAllowedProfitFromSingleDay = totalExamProfit * consistencyRuleValue;
          if (tempMaxDaily > maxAllowedProfitFromSingleDay) {
            consistencyPassed = false; // Requiere seguir operando para diluir el día grande
          }
        }

        if (consistencyPassed) {
          aprobados++;

          const daysCount = Math.max(1, uniqueExamDays.size);
          durationsPass.push(daysCount);
          examHistory.push({
            status: 'pass',
            duration: daysCount,
            start: currentExamStartDate,
            end: trade.date
          });

          // Resetear cuenta
          currentBalance = accountSize;
          highestEODBalance = accountSize;
          highestIntradayBalance = accountSize;
          currentDrawdownLimit = accountSize - maxDrawdownAmount;
          maxDailyProfit = 0;
          currentDayProfit = 0;
          totalExamProfit = 0;
          currentExamTrades = 0;
          currentExamStartDate = null;
          uniqueExamDays.clear();
          skipDate = trade.date;
        }
      }
    });

    // Cerrar la racha que quede abierta al terminar el backtest
    if (currentWinStreak > 0) winStreaks.push(currentWinStreak);
    if (currentLossStreak > 0) lossStreaks.push(currentLossStreak);
    const avgOf = (arr) => (arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 0);

    // Exámenes comprados = resueltos + el que esté en curso al acabar el backtest
    const comprados = aprobados + suspendidos + (currentExamStartDate ? 1 : 0);

    const totalProcessedTrades = winningTrades + losingTrades;

    // --- Estadísticas por dirección (largo / corto). Requiere informe; el gráfico no trae dirección. ---
    const dirStats = (dir) => {
      const subset = sessionTrades.filter((t) => t.direction === dir && t.profit !== 0);
      const wins = subset.filter((t) => t.profit > 0);
      const losses = subset.filter((t) => t.profit < 0);
      const sumWin = wins.reduce((a, t) => a + t.profit, 0);
      const sumLoss = losses.reduce((a, t) => a + Math.abs(t.profit), 0);
      return {
        total: subset.length,
        wins: wins.length,
        losses: losses.length,
        winrate: subset.length > 0 ? ((wins.length / subset.length) * 100).toFixed(1) : '0.0',
        net: subset.reduce((a, t) => a + t.profit, 0),
        avgWin: wins.length > 0 ? sumWin / wins.length : 0,
        avgLoss: losses.length > 0 ? sumLoss / losses.length : 0,
      };
    };
    const hasDirection = sessionTrades.some((t) => t.direction);
    const directionStats = hasDirection ? { long: dirStats('long'), short: dirStats('short') } : null;

    // --- Estadísticas por periodo (año, trimestre o mes) según la fecha de cierre en sesión de Lucid ---
    const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    // Cada función devuelve [etiqueta visible, clave de orden]
    const keyFns = {
      year: (d) => { const y = d.slice(0, 4); return [y, y]; },
      quarter: (d) => { const [y, m] = d.split('-').map(Number); const q = Math.floor((m - 1) / 3) + 1; return [`${y}-T${q}`, `${y}-${q}`]; },
      month: (d) => { const [y, m] = d.split('-').map(Number); return [`${y}-${MESES[m - 1]}`, `${y}-${String(m).padStart(2, '0')}`]; },
    };
    const periodStatsFor = (keyFn) => {
      const map = new Map();
      for (const t of sessionTrades) {
        const [label, sortKey] = keyFn(t.date);
        if (!map.has(sortKey)) map.set(sortKey, { label, list: [] });
        map.get(sortKey).list.push(t);
      }
      const wr = (arr) => {
        const nz = arr.filter((t) => t.profit !== 0);
        return nz.length > 0 ? ((nz.filter((t) => t.profit > 0).length / nz.length) * 100).toFixed(1) : '0.0';
      };
      return [...map.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([, { label: key, list }]) => {
          const nonZero = list.filter((t) => t.profit !== 0);
          const longs = list.filter((t) => t.direction === 'long');
          const shorts = list.filter((t) => t.direction === 'short');
          return {
            key,
            trades: nonZero.length,
            net: list.reduce((a, t) => a + t.profit, 0),
            winrate: wr(nonZero),
            longs: longs.length,
            shorts: shorts.length,
            longWinrate: wr(longs),
            shortWinrate: wr(shorts),
          };
        });
    };
    const periodStats = {
      year: periodStatsFor(keyFns.year),
      quarter: periodStatsFor(keyFns.quarter),
      month: periodStatsFor(keyFns.month),
    };

    setResults({
      comprados,
      aprobados,
      suspendidos,
      // % de exámenes resueltos (aprobados + suspendidos) que se aprobaron; el examen en curso no cuenta
      passRate: aprobados + suspendidos > 0 ? ((aprobados / (aprobados + suspendidos)) * 100).toFixed(1) : 0,
      winrate: totalProcessedTrades > 0 ? ((winningTrades / totalProcessedTrades) * 100).toFixed(2) : 0,
      avgWin: winningTrades > 0 ? (totalProfitSum / winningTrades).toFixed(2) : 0,
      avgLoss: losingTrades > 0 ? (totalLossSum / losingTrades).toFixed(2) : 0,
      avgWinStreak: avgOf(winStreaks),
      avgLossStreak: avgOf(lossStreaks),
      avgDaysPass: durationsPass.length > 0 ? (durationsPass.reduce((a, b) => a + b, 0) / durationsPass.length).toFixed(1) : 0,
      maxDaysPass: durationsPass.length > 0 ? Math.max(...durationsPass) : 0,
      avgDaysFail: durationsFail.length > 0 ? (durationsFail.reduce((a, b) => a + b, 0) / durationsFail.length).toFixed(1) : 0,
      maxDaysFail: durationsFail.length > 0 ? Math.max(...durationsFail) : 0,
      directionStats,
      periodStats,
      examHistory
    });
  };

  // Guardar el análisis actual en el navegador
  const saveCurrentRecord = () => {
    if (!results) return;
    const defaultName = `${fileName || 'Backtest'} · ${accountSize / 1000}K · ${consistency === 'OFF' ? 'sin consist.' : consistency}`;
    const name = window.prompt('Nombre para este registro:', defaultName);
    if (name === null) return; // cancelado
    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.trim() || defaultName,
      savedAt: new Date().toISOString(),
      config: { accountSize, consistency, dailyLossEnabled, drawdownType, serverOffsetHours, tpTarget, fileName },
      results,
    };
    persistRecords([record, ...savedRecords]);
  };

  // Cargar un registro guardado y mostrarlo
  const loadRecord = (record) => {
    const c = record.config || {};
    if (c.accountSize) setAccountSize(c.accountSize);
    if (c.consistency) setConsistency(c.consistency);
    if (typeof c.dailyLossEnabled === 'boolean') setDailyLossEnabled(c.dailyLossEnabled);
    if (c.drawdownType) setDrawdownType(c.drawdownType);
    if (typeof c.serverOffsetHours === 'number') setServerOffsetHours(c.serverOffsetHours);
    setFileName(c.fileName || record.name);
    setResults(record.results);
    setActiveTab('general');
    setErrorMsg('');
    setParseWarnings([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renameRecord = (id) => {
    const rec = savedRecords.find((r) => r.id === id);
    if (!rec) return;
    const name = window.prompt('Nuevo nombre:', rec.name);
    if (name === null) return;
    persistRecords(savedRecords.map((r) => (r.id === id ? { ...r, name: name.trim() || r.name } : r)));
  };

  const deleteRecord = (id) => {
    const rec = savedRecords.find((r) => r.id === id);
    if (rec && window.confirm(`¿Eliminar el registro "${rec.name}"? No se puede deshacer.`)) {
      persistRecords(savedRecords.filter((r) => r.id !== id));
    }
  };

  const calculateDays = (startStr, endStr) => {
    if (!startStr || !endStr) return 1;
    const start = new Date(startStr);
    const end = new Date(endStr);
    const diffTime = Math.abs(end - start);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays === 0 ? 1 : diffDays;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="border-b border-slate-800 pb-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              Evaluador de Estrategias & Prop Firms
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Mide la validez de tu sistema de futuros con datos reales de MetaTrader 5
            </p>
          </div>
          <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-4 py-2 rounded-lg">
            <ShieldAlert className="w-5 h-5 text-emerald-400" />
            <span className="text-xs text-slate-300 font-medium">Modo Simulación Activo</span>
          </div>
        </header>

        {/* Panel de Configuración Inicial */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-md">
          
          {/* Config Col 1 */}
          <div className="space-y-5">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Tamaño de Cuenta</label>
              <div className="grid grid-cols-3 gap-2">
                {[25000, 50000, 100000].map((size) => (
                  <button
                    key={size}
                    onClick={() => setAccountSize(size)}
                    className={`py-2.5 px-2 text-xs sm:text-sm font-semibold rounded-lg transition-all border ${
                      accountSize === size 
                        ? 'bg-emerald-600 border-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.3)]' 
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    ${size.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Fase</label>
              <div className="grid grid-cols-2 gap-2">
                {['Examen', 'Live'].map((p) => (
                  <button
                    key={p}
                    onClick={() => setPhase(p)}
                    disabled={p === 'Live'}
                    className={`py-2 px-3 text-xs sm:text-sm rounded-lg transition-all border ${
                      phase === p 
                        ? 'bg-cyan-600 border-cyan-500 text-white font-semibold' 
                        : p === 'Live' 
                          ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                          : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {p} {p === 'Live' ? '(Próx)' : ''}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">TP por operación ($)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={10}
                  value={tpTarget}
                  disabled={!refTP}
                  onChange={(e) => setTpTarget(e.target.value)}
                  className="w-28 py-2 px-2 text-sm rounded-lg bg-slate-800 border border-slate-700 text-slate-200 disabled:opacity-40"
                />
                <span className="text-xs text-slate-400">
                  {refTP
                    ? `Backtest: ${refTP.toLocaleString()} $ de TP${refSL ? ` y ${refSL.toLocaleString()} $ de SL` : ''}. Lotaje ×${(parseFloat(tpTarget) > 0 ? parseFloat(tpTarget) / refTP : 1).toFixed(2)}${refSL && parseFloat(tpTarget) > 0 ? ` (SL ≈ ${Math.round((refSL * parseFloat(tpTarget)) / refTP).toLocaleString()} $)` : ''}`
                    : 'Carga un backtest con salidas por TP para poder cambiarlo.'}
                </span>
              </div>
              {contractWarning}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Hora del servidor MT5</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={-12}
                  max={14}
                  step={1}
                  value={serverOffsetHours}
                  onChange={(e) => setServerOffsetHours(Number.isFinite(parseInt(e.target.value, 10)) ? parseInt(e.target.value, 10) : 7)}
                  className="w-16 py-2 px-2 text-sm rounded-lg bg-slate-800 border border-slate-700 text-slate-200"
                />
                <span className="text-xs text-slate-400">h por delante de Nueva York (7 = New York Close, p. ej. Darwinex). La sesión se corta a las 16:45 ET.</span>
              </div>
            </div>
          </div>

          {/* Config Col 2 */}
          <div className="space-y-5">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Regla de Consistencia</label>
              <div className="grid grid-cols-4 gap-2">
                {consistencyOptions.map(opt => (
                  <button
                    key={opt.label}
                    onClick={() => setConsistency(opt.value)}
                    className={`py-2 px-1 text-xs font-medium rounded-lg transition-all border ${
                      consistency === opt.value 
                        ? 'bg-emerald-600 border-emerald-500 text-white shadow-[0_0_10px_rgba(16,185,129,0.3)]' 
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Límite Pérdida Diaria (DLL)</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setDailyLossEnabled(true)}
                  className={`py-2 px-2 text-xs font-medium rounded-lg transition-all border ${
                    dailyLossEnabled 
                      ? 'bg-rose-600 border-rose-500 text-white shadow-[0_0_10px_rgba(225,29,72,0.3)]' 
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  Activada
                </button>
                <button
                  onClick={() => setDailyLossEnabled(false)}
                  className={`py-2 px-2 text-xs font-medium rounded-lg transition-all border ${
                    !dailyLossEnabled 
                      ? 'bg-slate-700 border-slate-500 text-white font-medium' 
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  Desactivada
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Tipo Drawdown Máx.</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setDrawdownType('EOD')}
                  className={`py-2 px-2 text-xs font-medium rounded-lg transition-all border ${
                    drawdownType === 'EOD'
                      ? 'bg-purple-600 border-purple-500 text-white shadow-[0_0_10px_rgba(147,51,234,0.3)]' 
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  EOD (Fin de Día)
                </button>
                <button
                  onClick={() => setDrawdownType('INTRADAY')}
                  className={`py-2 px-2 text-xs font-medium rounded-lg transition-all border ${
                    drawdownType === 'INTRADAY'
                      ? 'bg-orange-600 border-orange-500 text-white shadow-[0_0_10px_rgba(234,88,12,0.3)]' 
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  Intradía (En Vivo)
                </button>
              </div>
            </div>
          </div>

          {/* Config Col 3: Carga de Archivo y Botón */}
          <div className="flex flex-col justify-between space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Archivos Backtest MT5 (informe y/o gráfico)</label>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                accept=".txt,.csv,.html,.htm" 
                multiple
                className="hidden" 
              />
              <button 
                onClick={() => fileInputRef.current.click()}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs sm:text-sm font-medium text-slate-200 transition-colors"
              >
                <Upload className="w-4 h-4 text-emerald-400" />
                {fileName ? fileName : 'Seleccionar archivo(s) MT5'}
              </button>
              <p className="text-[11px] text-slate-500 mt-1">Puedes seleccionar los dos a la vez: el informe y la curva de equity del gráfico.</p>
              {trades.length > 0 && (
                <p className="text-xs text-emerald-400 mt-2 flex items-center gap-1 font-medium">
                  <CheckCircle className="w-3.5 h-3.5" /> {trades.length} operaciones cargadas correctamente.
                </p>
              )}
              {parseWarnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-400 mt-2 flex items-start gap-1">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {w}
                </p>
              ))}
              {errorMsg && (
                <p className="text-xs text-rose-400 mt-2 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> {errorMsg}
                </p>
              )}
            </div>

            <button
              onClick={runBacktest}
              disabled={trades.length === 0}
              className={`w-full py-3.5 px-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg ${
                trades.length > 0 
                  ? 'bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 shadow-emerald-500/20 cursor-pointer' 
                  : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50'
              }`}
            >
              <Play className="w-4 h-4 fill-current" />
              INICIAR ANÁLISIS
            </button>
          </div>

        </div>

        {/* Registros guardados */}
        {savedRecords.length > 0 && (
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="w-5 h-5 text-cyan-400" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300">Registros Guardados ({savedRecords.length})</h3>
            </div>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {savedRecords.map((rec) => (
                <div key={rec.id} className="flex items-center justify-between gap-3 bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-200 truncate">{rec.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {new Date(rec.savedAt).toLocaleString()} · {rec.results.aprobados}/{rec.results.aprobados + rec.results.suspendidos} aprobados ({rec.results.passRate}%)
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => loadRecord(rec)} className="px-2.5 py-1 text-xs font-semibold rounded-md bg-emerald-600/80 hover:bg-emerald-500 text-white transition-colors">Ver</button>
                    <button onClick={() => renameRecord(rec.id)} className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors">Renombrar</button>
                    <button onClick={() => deleteRecord(rec.id)} className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-800 hover:bg-rose-600/80 text-rose-300 hover:text-white transition-colors">Eliminar</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Resultados del Backtest */}
        {results ? (
          <div className="space-y-6 animate-fadeIn">

            {/* Pestañas + guardar */}
            <div className="flex items-center justify-between border-b border-slate-800 flex-wrap gap-2">
              <div className="flex gap-2">
                {[
                  { id: 'general', label: 'General' },
                  { id: 'detalle', label: 'Detalle temporal' },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 -mb-px ${
                      activeTab === t.id
                        ? 'border-emerald-500 text-emerald-400'
                        : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                onClick={saveCurrentRecord}
                className="mb-1 flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-emerald-400 transition-colors"
              >
                <FileText className="w-3.5 h-3.5" /> Guardar registro
              </button>
            </div>

            {activeTab === 'general' && (
            <div className="space-y-6">
            {/* Tarjetas Superiores: Contadores de Exámenes */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-md">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Exámenes Comprados</span>
                  <FileText className="w-5 h-5 text-cyan-400" />
                </div>
                <p className="text-3xl font-extrabold text-white mt-2">{results.comprados}</p>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-md">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">Exámenes Aprobados</span>
                  <Award className="w-5 h-5 text-emerald-400" />
                </div>
                <p className="text-3xl font-extrabold text-emerald-400 mt-2">
                  {results.aprobados}
                  <span className="text-lg font-bold text-emerald-400/70 ml-2">({results.passRate}%)</span>
                </p>
                <span className="text-xs text-slate-500 mt-1 block">{results.passRate}% de los exámenes resueltos</span>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-md">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-rose-400">Exámenes Suspendidos</span>
                  <AlertTriangle className="w-5 h-5 text-rose-400" />
                </div>
                <p className="text-3xl font-extrabold text-rose-400 mt-2">{results.suspendidos}</p>
              </div>
            </div>

            {/* Métricas Principales de Operativa */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
                <span className="text-xs text-slate-400 block">Winrate Global</span>
                <span className="text-xl font-bold text-white mt-1 block">{results.winrate}%</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
                <span className="text-xs text-slate-400 block">Ganancia Media</span>
                <span className="text-xl font-bold text-emerald-400 mt-1 block">${results.avgWin}</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
                <span className="text-xs text-slate-400 block">Pérdida Media</span>
                <span className="text-xl font-bold text-rose-400 mt-1 block">-${results.avgLoss}</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
                <span className="text-xs text-slate-400 block">Rachas (Prom. G / P)</span>
                <span className="text-xl font-bold text-cyan-400 mt-1 block">{results.avgWinStreak}G / {results.avgLossStreak}P</span>
              </div>
            </div>

            {/* Métricas de Tiempos */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-sm font-bold uppercase tracking-wider text-emerald-400">Tiempos para Aprobar Examen</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                    <span className="text-xs text-slate-400 block">Promedio Días</span>
                    <span className="text-lg font-bold text-white">{results.avgDaysPass} días</span>
                  </div>
                  <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                    <span className="text-xs text-slate-400 block">Tiempo Máximo</span>
                    <span className="text-lg font-bold text-white">{results.maxDaysPass} días</span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="w-5 h-5 text-rose-400" />
                  <h3 className="text-sm font-bold uppercase tracking-wider text-rose-400">Tiempos para Suspender Examen</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                    <span className="text-xs text-slate-400 block">Promedio Días</span>
                    <span className="text-lg font-bold text-white">{results.avgDaysFail} días</span>
                  </div>
                  <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                    <span className="text-xs text-slate-400 block">Tiempo Máximo</span>
                    <span className="text-lg font-bold text-white">{results.maxDaysFail} días</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Historial Cronológico Visual (Cuadrículas tipo GitHub) */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Calendar className="w-5 h-5 text-cyan-400" />
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300">Distribución Cronológica de Exámenes</h3>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <span className="flex items-center gap-1"><span className="w-3 h-3 bg-emerald-500 rounded-sm inline-block"></span> Aprobado</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 bg-rose-500 rounded-sm inline-block"></span> Suspendido</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 p-4 bg-slate-950/60 rounded-xl border border-slate-800/80 max-h-64 overflow-y-auto">
                {results.examHistory.length === 0 ? (
                  <p className="text-xs text-slate-500">No hay suficientes exámenes completados en este backtest.</p>
                ) : (
                  results.examHistory.map((exam, index) => (
                    <div
                      key={index}
                      title={`Intento #${index + 1}\nEstado: ${exam.status === 'pass' ? 'Aprobado' : 'Suspendido (' + exam.reason + ')'}\nDuración: ${exam.duration} días\nDel ${exam.start} al ${exam.end}`}
                      className={`w-7 h-7 rounded-md flex items-center justify-center text-[10px] font-bold cursor-pointer transition-transform hover:scale-110 ${
                        exam.status === 'pass' 
                          ? 'bg-emerald-600/80 border border-emerald-400 text-white shadow-[0_0_8px_rgba(16,185,129,0.4)]' 
                          : 'bg-rose-600/80 border border-rose-400 text-white shadow-[0_0_8px_rgba(244,63,94,0.4)]'
                      }`}
                    >
                      {index + 1}
                    </div>
                  ))
                )}
              </div>
            </div>
            </div>
            )}

            {activeTab === 'detalle' && (
            <div className="space-y-6">
              {/* Dirección: largos vs cortos */}
              {results.directionStats ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    { key: 'long', label: 'Operaciones Largas', cls: 'text-emerald-400', d: results.directionStats.long },
                    { key: 'short', label: 'Operaciones Cortas', cls: 'text-cyan-400', d: results.directionStats.short },
                  ].map(({ key, label, cls, d }) => (
                    <div key={key} className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                      <div className="flex items-center gap-2 mb-4">
                        <TrendingUp className={`w-5 h-5 ${cls} ${key === 'short' ? 'rotate-180' : ''}`} />
                        <h3 className={`text-sm font-bold uppercase tracking-wider ${cls}`}>{label}</h3>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                          <span className="text-xs text-slate-400 block">Operaciones</span>
                          <span className="text-xl font-bold text-white">{d.total}</span>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                          <span className="text-xs text-slate-400 block">Winrate</span>
                          <span className="text-xl font-bold text-white">{d.winrate}%</span>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                          <span className="text-xs text-slate-400 block">Ganadoras / Perdedoras</span>
                          <span className="text-base font-bold text-white">{d.wins} / {d.losses}</span>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                          <span className="text-xs text-slate-400 block">Resultado neto</span>
                          <span className={`text-base font-bold ${d.net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {d.net >= 0 ? '+' : ''}{d.net.toLocaleString(undefined, { maximumFractionDigits: 0 })} $
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-amber-950/30 border border-amber-900/50 rounded-xl p-4 text-sm text-amber-200 flex gap-2">
                  <Info className="w-5 h-5 flex-shrink-0 text-amber-400" />
                  <span>El desglose por dirección (largos / cortos) necesita el informe de MT5. La curva del gráfico agrupa operaciones y no distingue la dirección.</span>
                </div>
              )}

              {/* Tabla por periodo con selector año / trimestre / mes */}
              {(() => {
                const rows = results.periodStats[periodLevel] || [];
                const best = rows.length > 1 ? Math.max(...rows.map((x) => x.net)) : null;
                const worst = rows.length > 1 ? Math.min(...rows.map((x) => x.net)) : null;
                const colLabel = { year: 'Año', quarter: 'Trimestre', month: 'Mes' }[periodLevel];
                return (
                  <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-5 h-5 text-cyan-400" />
                        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300">Rendimiento por {colLabel}</h3>
                      </div>
                      <div className="flex gap-1 bg-slate-800 p-1 rounded-lg">
                        {[
                          { id: 'year', label: 'Año' },
                          { id: 'quarter', label: 'Trimestre' },
                          { id: 'month', label: 'Mes' },
                        ].map((o) => (
                          <button
                            key={o.id}
                            onClick={() => setPeriodLevel(o.id)}
                            className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                              periodLevel === o.id ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:text-white'
                            }`}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="overflow-x-auto max-h-96 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-slate-400 border-b border-slate-800">
                            <th className="text-left py-2 px-2 font-semibold sticky top-0 bg-slate-900">{colLabel}</th>
                            <th className="text-right py-2 px-2 font-semibold sticky top-0 bg-slate-900">Operaciones</th>
                            <th className="text-right py-2 px-2 font-semibold sticky top-0 bg-slate-900">Winrate</th>
                            <th className="text-right py-2 px-2 font-semibold sticky top-0 bg-slate-900">Resultado neto</th>
                            <th className="text-right py-2 px-2 font-semibold sticky top-0 bg-slate-900">Largos (WR)</th>
                            <th className="text-right py-2 px-2 font-semibold sticky top-0 bg-slate-900">Cortos (WR)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((q) => (
                            <tr key={q.key} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                              <td className="py-2 px-2 font-medium text-slate-200">
                                {q.key}
                                {best !== null && q.net === best && <span className="ml-2 text-[10px] text-emerald-400">▲ mejor</span>}
                                {worst !== null && q.net === worst && <span className="ml-2 text-[10px] text-rose-400">▼ peor</span>}
                              </td>
                              <td className="text-right py-2 px-2 text-slate-300">{q.trades}</td>
                              <td className="text-right py-2 px-2 text-slate-300">{q.winrate}%</td>
                              <td className={`text-right py-2 px-2 font-semibold ${q.net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {q.net >= 0 ? '+' : ''}{q.net.toLocaleString(undefined, { maximumFractionDigits: 0 })} $
                              </td>
                              <td className="text-right py-2 px-2 text-slate-400">{q.longs > 0 ? `${q.longs} (${q.longWinrate}%)` : '—'}</td>
                              <td className="text-right py-2 px-2 text-slate-400">{q.shorts > 0 ? `${q.shorts} (${q.shortWinrate}%)` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-3">Agrupado por {colLabel.toLowerCase()} según la fecha de cierre. El resultado neto incluye comisiones y swap.</p>
                  </div>
                );
              })()}
            </div>
            )}

            {contractCheck && contractCheck.over > 0 && (
              <div className="bg-amber-950/30 border border-amber-900/50 rounded-xl p-4 text-sm text-amber-200">
                {contractWarning}
              </div>
            )}

            {/* Nota Informativa de Reglas */}
            {(() => {
              const currentRules = {
                25000: { target: 1250, daily: 600, drawdown: 1000 },
                50000: { target: 3000, daily: 1200, drawdown: 2000 },
                100000: { target: 6000, daily: 1800, drawdown: 3000 }
              }[accountSize];
              
              return (
                <div className="bg-blue-950/30 border border-blue-900/50 rounded-xl p-4 flex gap-3 text-sm text-blue-200">
                  <Info className="w-5 h-5 flex-shrink-0 text-blue-400" />
                  <p>
                    <strong>Reglas aplicadas:</strong> Objetivo = ${currentRules.target.toLocaleString()}, 
                    {dailyLossEnabled ? ` Pérdida Diaria = $${currentRules.daily.toLocaleString()},` : ' Sin Pérdida Diaria,'} 
                    {' '}Pérdida máxima = ${currentRules.drawdown.toLocaleString()} 
                    <b> ({drawdownType === 'EOD' ? 'EOD Trailing' : 'Intraday Trailing'})</b>: 
                    {drawdownType === 'EOD' ? ' el límite de pérdida máxima NO se mueve durante el día, solo se actualiza arrastrándose a tu balance más alto al finalizar el día.' : ' el límite persigue a tu balance máximo en vivo tras cada operación dentro del mismo día.'}
                    {' '}El análisis asume que cada vez que superas o suspendes un examen, compras uno nuevo inmediatamente para el día siguiente.
                  </p>
                </div>
              );
            })()}

          </div>
        ) : null}

      </div>
    </div>
  );
};

export default App;