import React, { useState, useRef } from 'react';
import { Play, Upload, TrendingUp, AlertTriangle, CheckCircle, Clock, Calendar, ShieldAlert, Award, FileText, Info } from 'lucide-react';

const App = () => {
  // Configuración del sistema
  const [accountSize, setAccountSize] = useState(50000);
  const [consistency, setConsistency] = useState('OFF');
  const [dailyLossEnabled, setDailyLossEnabled] = useState(true);
  const [drawdownType, setDrawdownType] = useState('EOD'); // 'EOD' o 'INTRADAY'
  const [phase, setPhase] = useState('Examen');
  
  // Datos y estado de la app
  const [trades, setTrades] = useState([]);
  const [fileName, setFileName] = useState('');
  const [results, setResults] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const fileInputRef = useRef(null);

  const consistencyOptions = [
    { label: 'OFF', value: 'OFF' },
    { label: '40%', value: '0.40' },
    { label: '45%', value: '0.45' },
    { label: '50%', value: '0.50' }
  ];

  // Lector Inteligente de archivos de MetaTrader 5 (Soporta TXT, CSV, HTML)
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setFileName(file.name);
    setErrorMsg('');
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target.result;
        let parsedTrades = parseMT5Content(content, file.name);

        if (parsedTrades.length === 0) {
          setErrorMsg('No se pudieron detectar operaciones válidas. Asegúrate de que el archivo contiene el historial de posiciones de MT5.');
        } else {
          setTrades(parsedTrades);
        }
      } catch (err) {
        setErrorMsg('Error al procesar el archivo: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  // Parser unificado de MT5 (HTML, CSV y Graph)
  const parseMT5Content = (content, fileName) => {
    let parsed = [];
    const isHTML = fileName.toLowerCase().endsWith('.html') || fileName.toLowerCase().endsWith('.htm') || content.includes('<html') || content.includes('<table');

    let rows = [];

    // Función auxiliar para parsear números con distintos formatos locales (ej: 1.234,56 o 1,234.56)
    const parseNumber = (val) => {
        if (typeof val !== 'string') return val;
        // Reemplazamos todos los posibles guiones tipográficos por el signo menos estándar
        let str = val.replace(/\s/g, '').replace(/[−—–]/g, '-');
        if (str.match(/^-?\d{1,3}(\.\d{3})*,\d+$/)) {
            // Formato 1.234,56 -> 1234.56
            str = str.replace(/\./g, '').replace(',', '.');
        } else if (str.match(/^-?\d{1,3}(,\d{3})*\.\d+$/)) {
            // Formato 1,234.56 -> 1234.56
            str = str.replace(/,/g, '');
        } else if (str.includes(',') && !str.includes('.')) {
            // Formato 1234,56 -> 1234.56
            str = str.replace(',', '.');
        }
        return parseFloat(str);
    };

    // 1. EXTRACCIÓN DE FILAS (HTML o Texto)
    if (isHTML) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, 'text/html');
        const tables = Array.from(doc.querySelectorAll('table'));
        
        let selectedTable = tables[0];
        let maxWeight = 0;

        // Buscamos la mejor tabla (Priorizamos "Posiciones" sobre "Transacciones")
        tables.forEach(t => {
            const prevText = (t.previousElementSibling?.textContent || '').toLowerCase();
            const firstRow = (t.rows[0]?.textContent || '').toLowerCase();
            let weight = t.rows.length;
            
            if (prevText.includes('position') || prevText.includes('posición') || prevText.includes('posiciones') || firstRow.includes('position')) {
                weight += 100000; // Máxima prioridad
            } else if (prevText.includes('deal') || prevText.includes('transacc') || firstRow.includes('deal')) {
                weight += 50000; // Prioridad media
            }

            if (weight > maxWeight) {
                maxWeight = weight;
                selectedTable = t;
            }
        });

        if (selectedTable) {
            Array.from(selectedTable.rows).forEach(tr => {
                const cells = Array.from(tr.querySelectorAll('td, th')).map(td => td.textContent.trim());
                if (cells.length > 0) rows.push(cells);
            });
        }
    } else {
        const lines = content.split(/\r?\n/);
        for (let line of lines) {
            if (!line.trim()) continue;
            // Separar por tabulaciones, comas o punto y coma
            const cells = line.split(/[\t,;]+/).map(c => c.replace(/["<>]*/g, '').trim());
            const nonEmpty = cells.filter(c => c !== '');
            
            // Detectar cabeceras de sección en CSV para NO duplicar datos
            if (nonEmpty.length === 1 && isNaN(parseFloat(nonEmpty[0]))) {
                const sec = nonEmpty[0].toLowerCase();
                if (sec.includes('order') || sec.includes('órdenes') || sec.includes('deal') || sec.includes('transacc')) {
                    if (rows.length > 5) break; // Si ya leímos "Posiciones", nos detenemos aquí
                }
            }
            rows.push(cells);
        }
    }

    // 2. LECTOR DE GRÁFICO RAW (Deposit Load)
    const isGraphData = rows.some(r => r.some(c => c.toUpperCase().includes('DEPOSIT LOAD')));
    if (isGraphData) {
        let lastFlatBalance = null;
        let lowestEquityDuringTrade = null;
        let isInTrade = false;
        let tradeStartDate = null;

        for (let cols of rows) {
            if (cols.some(c => c.includes('HEADER'))) continue;
            const dateIndex = cols.findIndex(c => /^\d{4}[./-]\d{2}[./-]\d{2}/.test(c));
            
            if (dateIndex !== -1) {
                const dateStr = cols[dateIndex].substring(0, 10).replace(/[./]/g, '-');
                const nums = cols.map(c => parseFloat(c.replace(/\s/g, '').replace(',', '.'))).filter(n => !isNaN(n));
                
                if (nums.length >= 3) {
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
                    } else if (load <= 0.0001) {
                        if (isInTrade) {
                            const profit = balance - lastFlatBalance;
                            const lowestFloating = lowestEquityDuringTrade - lastFlatBalance;
                            if (Math.abs(profit) > 0.001 || Math.abs(lowestFloating) > 0.001) {
                                parsed.push({
                                    date: tradeStartDate || dateStr,
                                    profit: profit,
                                    lowestFloating: Math.min(lowestFloating, profit, 0)
                                });
                            }
                            lastFlatBalance = balance;
                            isInTrade = false;
                            lowestEquityDuringTrade = null;
                        } else {
                            lastFlatBalance = balance;
                        }
                    }
                }
            }
        }
        if (parsed.length > 0) return parsed;
    }

    // 3. LECTOR ESTRUCTURADO (Posiciones o Transacciones HTML/CSV)
    let timeIdx = -1, dirIdx = -1, profitIdx = -1, commIdx = -1, swapIdx = -1;

    // Buscar cabeceras
    for (let r of rows) {
        const rowLower = r.map(c => c.toLowerCase());
        if ((rowLower.includes('profit') || rowLower.includes('beneficio') || rowLower.includes('прибыль') || rowLower.includes('beneficio/pérdida') || rowLower.includes('profit/loss')) &&
            (rowLower.some(c => c.includes('time') || c.includes('tiempo') || c.includes('date') || c.includes('fecha')))) {

            timeIdx = rowLower.findIndex(c => c.includes('time') || c.includes('tiempo') || c.includes('date') || c.includes('fecha'));
            dirIdx = rowLower.findIndex(c => c === 'direction' || c === 'dirección' || c === 'dir' || c === 'type');
            profitIdx = rowLower.findIndex(c => c === 'profit' || c === 'beneficio' || c === 'прибыль' || c === 'beneficio/pérdida' || c === 'profit/loss');
            commIdx = rowLower.findIndex(c => c.includes('commission') || c.includes('comisión'));
            swapIdx = rowLower.findIndex(c => c === 'swap' || c.includes('swap'));
            break;
        }
    }

    // Procesar Datos
    for (let cols of rows) {
        if (cols.length < 5) continue;

        const tIdx = timeIdx > -1 ? timeIdx : 0;
        const dateStr = cols[tIdx];

        // Solo procesamos filas que empiecen con fecha de MT5 (YYYY.MM.DD)
        if (!dateStr || !/^\d{4}[./-]\d{2}[./-]\d{2}/.test(dateStr)) continue;

        // Comprobamos la dirección si existe (para saltar las entradas)
        let isEntry = false;
        if (dirIdx > -1 && cols[dirIdx]) {
            const dir = cols[dirIdx].toLowerCase();
            if (dir === 'in') isEntry = true;
        } else {
            const dirCol = cols.find(c => c.toLowerCase() === 'in' || c.toLowerCase() === 'out' || c.toLowerCase() === 'in/out');
            if (dirCol && dirCol.toLowerCase() === 'in') isEntry = true;
        }

        if (isEntry) continue; // Ignoramos entradas, solo evaluamos el resultado final

        let profitVal = NaN;
        if (profitIdx > -1 && cols[profitIdx]) {
            profitVal = parseNumber(cols[profitIdx]);
        } else {
            // Si no sabemos la columna, el beneficio suele ser el último o penúltimo número
            for (let i = cols.length - 1; i >= 0; i--) {
                const v = parseNumber(cols[i]);
                if (!isNaN(v)) { profitVal = v; break; }
            }
        }

        // Si la fila no tiene un valor numérico de beneficio, es basura (como un subtotal), la saltamos
        if (isNaN(profitVal)) continue;

        let commVal = 0, swapVal = 0;
        if (commIdx > -1 && cols[commIdx]) commVal = parseNumber(cols[commIdx]) || 0;
        if (swapIdx > -1 && cols[swapIdx]) swapVal = parseNumber(cols[swapIdx]) || 0;

        const totalProfit = profitVal + commVal + swapVal;

        parsed.push({
            date: dateStr.substring(0, 10).replace(/[./]/g, '-'),
            profit: totalProfit,
            lowestFloating: totalProfit < 0 ? totalProfit : 0
        });
    }

    return parsed;
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
    let comprados = 1;
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

    let examHistory = [];
    
    // Métricas globales
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfitSum = 0;
    let totalLossSum = 0;
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let durationsPass = [];
    let durationsFail = [];

    trades.forEach((trade) => {
      // Estadísticas Globales
      if (trade.profit > 0) {
        winningTrades++;
        totalProfitSum += trade.profit;
        currentWinStreak++;
        currentLossStreak = 0;
        if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
      } else if (trade.profit < 0) {
        losingTrades++;
        totalLossSum += Math.abs(trade.profit);
        currentLossStreak++;
        currentWinStreak = 0;
        if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
      }

      // Si estamos bloqueados este día por haber suspendido/aprobado antes, saltamos para el examen actual
      if (skipDate === trade.date) {
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
          currentDrawdownLimit = highestEODBalance - maxDrawdownAmount;
        }
      }

      const lowestEquityDuringTrade = currentBalance + (trade.lowestFloating !== undefined ? trade.lowestFloating : (trade.profit < 0 ? trade.profit : 0));
      const dailyLossLimitBalance = startOfDayBalance - dailyLossAmount;

      const failedDaily = dailyLossEnabled && lowestEquityDuringTrade <= dailyLossLimitBalance;
      const failedMax = lowestEquityDuringTrade <= currentDrawdownLimit;

      // Evaluar Suspenso
      if (failedDaily || failedMax) {
        suspendidos++;
        comprados++;
        
        const daysCount = Math.max(1, uniqueExamDays.size);
        durationsFail.push(daysCount);
        examHistory.push({
          status: 'fail',
          duration: daysCount,
          start: currentExamStartDate,
          end: trade.date,
          reason: failedDaily ? 'Límite Diario (DLL)' : 'Pérdida Máxima (EOD)'
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

      // Aplicar beneficio de la operación
      currentDayProfit += trade.profit;
      currentBalance += trade.profit;
      totalExamProfit += trade.profit;
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
          comprados++; // Siguiente fase o cuenta nueva

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

    const totalProcessedTrades = winningTrades + losingTrades;
    setResults({
      comprados,
      aprobados,
      suspendidos,
      winrate: totalProcessedTrades > 0 ? ((winningTrades / totalProcessedTrades) * 100).toFixed(2) : 0,
      avgWin: winningTrades > 0 ? (totalProfitSum / winningTrades).toFixed(2) : 0,
      avgLoss: losingTrades > 0 ? (totalLossSum / losingTrades).toFixed(2) : 0,
      avgWinStreak: maxWinStreak,
      avgLossStreak: maxLossStreak,
      avgDaysPass: durationsPass.length > 0 ? (durationsPass.reduce((a, b) => a + b, 0) / durationsPass.length).toFixed(1) : 0,
      maxDaysPass: durationsPass.length > 0 ? Math.max(...durationsPass) : 0,
      avgDaysFail: durationsFail.length > 0 ? (durationsFail.reduce((a, b) => a + b, 0) / durationsFail.length).toFixed(1) : 0,
      maxDaysFail: durationsFail.length > 0 ? Math.max(...durationsFail) : 0,
      examHistory
    });
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
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Archivo Backtest MT5 (TXT / HTML / CSV)</label>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                accept=".txt,.csv,.html,.htm" 
                className="hidden" 
              />
              <button 
                onClick={() => fileInputRef.current.click()}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs sm:text-sm font-medium text-slate-200 transition-colors"
              >
                <Upload className="w-4 h-4 text-emerald-400" />
                {fileName ? fileName : 'Seleccionar archivo MT5'}
              </button>
              {trades.length > 0 && (
                <p className="text-xs text-emerald-400 mt-2 flex items-center gap-1 font-medium">
                  <CheckCircle className="w-3.5 h-3.5" /> {trades.length} operaciones cargadas correctamente.
                </p>
              )}
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

        {/* Resultados del Backtest */}
        {results ? (
          <div className="space-y-6 animate-fadeIn">
            
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
                <p className="text-3xl font-extrabold text-emerald-400 mt-2">{results.aprobados}</p>
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
                <span className="text-xs text-slate-400 block">Rachas (Max G / P)</span>
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