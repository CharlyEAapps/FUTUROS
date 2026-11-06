// Motor de simulación de exámenes (Lucid Flex). Función pura: la usan la interfaz y los scripts de línea de comandos.
// trades: [{ date, time, profit, lowestFloating }] ordenados por hora de cierre (hora del servidor MT5 o de Nueva York).
// cfg: { accountSize, consistency ('OFF' | '0.40'...), dailyLossEnabled, drawdownType ('EOD'|'INTRADAY'), serverOffsetHours, lotScale }
export const simularExamenes = (trades, cfg) => {
  const { accountSize, consistency, dailyLossEnabled, drawdownType, serverOffsetHours } = cfg;
    if (!trades || trades.length === 0) return null;

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
    const lotScale = cfg.lotScale || 1;
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

      const hitDaily = dailyLossEnabled && lowestEquityDuringTrade <= dailyLossLimitBalance;
      const failedMax = lowestEquityDuringTrade <= currentDrawdownLimit;

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
    return ({
      comprados,
      aprobados,
      suspendidos,
      winrate: totalProcessedTrades > 0 ? ((winningTrades / totalProcessedTrades) * 100).toFixed(2) : 0,
      avgWin: winningTrades > 0 ? (totalProfitSum / winningTrades).toFixed(2) : 0,
      avgLoss: losingTrades > 0 ? (totalLossSum / losingTrades).toFixed(2) : 0,
      avgWinStreak: avgOf(winStreaks),
      avgLossStreak: avgOf(lossStreaks),
      avgDaysPass: durationsPass.length > 0 ? (durationsPass.reduce((a, b) => a + b, 0) / durationsPass.length).toFixed(1) : 0,
      maxDaysPass: durationsPass.length > 0 ? Math.max(...durationsPass) : 0,
      avgDaysFail: durationsFail.length > 0 ? (durationsFail.reduce((a, b) => a + b, 0) / durationsFail.length).toFixed(1) : 0,
      maxDaysFail: durationsFail.length > 0 ? Math.max(...durationsFail) : 0,
      examHistory
    });
};
