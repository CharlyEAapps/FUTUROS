# Contexto del proyecto FUTUROS

Documento de contexto que se actualiza en cada cambio de la app. Resume qué hace,
cómo está montada y las reglas del negocio, para retomar el trabajo sin perder nada.

## Qué es
App de un solo archivo (React + Vite + Tailwind) que simula exámenes de prop firm
(Lucid Flex) y la fase financiada (Live) sobre backtests de MetaTrader 5.

- App publicable: `index.html` (autónomo, se abre con doble clic o por GitHub Pages).
- Código: `app/src/App.jsx` (UI + motor) y `app/src/parseMT5.js` (lector de informes).
- Original de Gemini intacto: `app/backup/App.original.jsx`.
- Informes de ejemplo: `reports/`.

## Reglas del negocio confirmadas (Lucid Flex 50K)
- Objetivo examen 50K: 3.000 $. MLL (pérdida máxima): 2.000 $, drawdown EOD, tope en inicial + 100 (50.100).
- DLL: soft breach (bloquea el día, no suspende). Solo el MLL pierde la cuenta.
- Consistencia: OFF / 40% / 50%. No aplica en la fase financiada.
- Objetivo del examen: cuenta al cerrar la operación; con archivo de gráfico, también si el equity lo toca en flotante.
- Sesión Lucid: corte a las 16:45 ET. Servidor MT5 por defecto 7h por delante (Darwinex "New York Close").

### Fase Live / Financiada (Lucid Flex)
- Cada examen APROBADO abre una cuenta financiada. nº de cuentas live = nº de aprobados. Pueden coexistir varias.
- El live usa un SEGUNDO backtest (EA con TP 160 / SL 2000, una operación por día), que se carga aparte.
  Cada cuenta opera ese backtest desde la fecha de aprobación del examen. Si no se carga, usa el backtest
  de examen (resultado pesimista, avisado en pantalla).
- Primera operación del backtest normal (lotaje del EA); el resto del backtest de live, aportando como mucho el objetivo diario (160 $).
- Día válido: beneficio del día ≥ 150 $. Retira tras 5 días válidos (no consecutivos).
- Al retirar: estado RETIRADO (azul). Se retira el beneficio acumulado; el trader se queda el 90% (split 90/10).
- Riesgo máximo: CUALQUIER operación perdedora (o ganadora < mínimo del día) quema la cuenta. Solo retira quien encadene 5 ganadoras >= 150 seguidas.
- Coste de exámenes = precio × exámenes comprados. Neto del live = total retirado − coste.
- Payouts para pasar a Live real: 5 (informativo).

## Funciones de la app
- Carga de varios archivos a la vez (informe HTML + curva de equity del gráfico).
- Parser: Deals/Positions/gráfico, hora de cierre, dirección (largo/corto), volumen, TP/SL de referencia, MFE/MAE del gráfico.
- Escalado de TP: cambia el lotaje y con él SL y P&L. Aviso de límite de contratos de Lucid.
- Pestañas de resultados: General, Detalle temporal (año/trimestre/mes con winrate por dirección),
  Comparativa (correlación de Pearson por periodo entre dos sistemas) y Live / Financiada.
- Registros guardados en el navegador (localStorage): guardar, ver, renombrar, eliminar.
  Exportar/importar a `.json` para llevarlos a otro equipo (la app estática no escribe en GitHub).

## Limitaciones conocidas
- La dirección (largos/cortos) solo sale del informe, no del gráfico.
- Con solo el informe HTML no se ve el recorrido flotante de las ganadoras: drawdown y DLL optimistas.
- El DLL se aplica liquidando exactamente en el límite (sin deslizamiento).
- Backtest de CFD (XAUUSD) aplicado a reglas de futuros: comisiones, spread y tamaño de contrato no son los de GC/MGC; el lotaje escalado no se redondea a contratos enteros.
- Las operaciones del backtest son las mismas en $ para cualquier tamaño de cuenta (aviso si el stop medio se acerca a la pérdida máxima).
- El desfase horario servidor/Nueva York es fijo; falla unas semanas al año si el broker sigue la hora europea.
- Sin backtest de live, el live es pesimista (usa el TP/SL de la estrategia normal).
- Todo verificado en simulación jsdom con informes reales; no abierto en navegador real.

## Desarrollo
```bash
cd app && npm install && npm run dev
npm run build   # regenera app/dist/index.html (y se copia a la raíz como index.html)
```

## Historial de cambios
- Parser reescrito y cuadrado contra el beneficio neto del informe.
- Motor del examen: DLL como bloqueo del día, tope del MLL, rachas promedio, contador de comprados, corte 16:45 ET, objetivo en flotante con gráfico.
- Escalado de TP y aviso de contratos.
- Carga múltiple de archivos y % de aprobados.
- Detalle temporal (año/trimestre/mes) y desglose por dirección.
- Registros guardados (localStorage) + exportar/importar JSON.
- Comparativa con correlación de Pearson entre dos sistemas.
- Fase Live encadenada: cada aprobado abre cuenta financiada; retiradas (azul), quemadas, split 90/10, precio de examen y neto.
- Corrección del live: riesgo máximo real: una operación perdedora quema la cuenta; solo retira quien encadena 5 ganadoras >= 150 seguidas (antes dejaba pasar perdedoras y daba retiradas infladas/negativas).
- Segundo backtest para el live (TP 160/SL 2000): dos zonas de carga (examen y live). El live enlaza por fecha de aprobación con las operaciones del backtest de live. Resuelve que el backtest de examen usa otro TP/SL y no refleja la operativa de live.
- Auditoría: (1) el escalado de TP ahora también escala el máximo flotante; (2) el live sin backtest propio usa el lotaje escalado; (3) con backtest de live, la 1ª operación de cada cuenta sale del backtest normal (lotaje del EA) y las siguientes del de live; (4) el lector del gráfico recupera las operaciones que abren y cierran entre dos puntos de la curva (antes faltaban 2 y 1.461,59 $); (5) los registros antiguos sin live ni detalle temporal ya no rompen la app; (6) aviso cuando el stop medio del EA se acerca a la pérdida máxima de la cuenta.
- Se sube un backtest por tamaño de cuenta. Aviso si el depósito inicial del backtest de examen o de live no coincide con el tamaño de cuenta elegido (se lee de la fila de depósito del informe, de la cabecera "Depósito inicial" o del primer balance del gráfico).
- En live, la primera operación también arriesga 2.000 $: si pierde, la cuenta se quema. Su resultado sale del backtest normal (stop del EA ~1.480 $ en 50K), así que es una aproximación algo pesimista.
