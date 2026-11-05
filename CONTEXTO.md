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
- Cada examen APROBADO abre una cuenta financiada que opera en paralelo las operaciones siguientes.
  Por tanto nº de cuentas live = nº de aprobados. Pueden coexistir varias.
- Una operación por día. Primera con lotaje del EA; el resto con TP al objetivo diario (160 $).
- Día válido: beneficio del día ≥ 150 $. Retira tras 5 días válidos (no consecutivos).
- Al retirar: estado RETIRADO (azul). Se retira el beneficio acumulado; el trader se queda el 90% (split 90/10).
- Perdedora: mantiene su pérdida real; la cuenta se quema solo si el equity toca el MLL.
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
- El archivo de gráfico agrupa operaciones del mismo día; winrate y medias por tramo, no por operación.
- La dirección (largos/cortos) solo sale del informe, no del gráfico.
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
