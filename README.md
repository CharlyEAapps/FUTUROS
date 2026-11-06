# FUTUROS — Evaluador de Estrategias & Prop Firms

Simula exámenes LucidFlex sobre backtests de MetaTrader 5 (informe HTML del Strategy Tester) o de NinjaTrader 8 (CSV de operaciones).

## Abrir la app

- **Más fácil (en línea):** se publica con GitHub Pages en
  https://CharlyEAapps.github.io/FUTUROS/ — se abre en el navegador, sin instalar nada.
- **En tu PC:** descarga este repositorio (botón verde **Code → Download ZIP**),
  descomprímelo y abre `index.html` con doble clic. Es un único archivo autónomo.

## Cómo se usa

1. Elige tamaño de cuenta (25K / 50K / 100K), consistencia y el TP por operación.
2. Elige la plataforma del backtest con el selector **MetaTrader 5 / NinjaTrader** y carga el archivo con el botón.
3. Pulsa "Iniciar análisis".

### Backtests de NinjaTrader

- Exporta las operaciones desde el Strategy Analyzer: vista de operaciones → clic derecho → **Exportar** (CSV, p. ej. `NinjaTrader Grid ….csv`). Comprobado con una exportación real en español (separador `;`, decimales con coma, importes con ` $`, fechas día/mes/año). Se admiten también cabeceras en inglés y fechas mes/día con AM/PM. Suma comisión y tarifas y detecta con la columna de beneficio acumulado si el beneficio ya las descuenta. También lee el CSV del conector BtRunner.
- **Importante:** exporta un backtest SIN los límites del examen (pérdida máxima, objetivo y consistencia desactivados, contratos fijos). Si el EA se detiene al llegar a ellos, la serie queda cortada y el simulador no tiene operaciones que evaluar.
- NinjaTrader guarda las horas con el reloj del PC: indica su zona horaria (por defecto `Europe/Madrid`) y se convierten a hora de Nueva York respetando los cambios de hora.
- Si el CSV no trae comisión, el resultado es bruto: escribe la comisión por contrato (ida y vuelta) en el campo correspondiente.
- El drawdown intradía se calcula con el MAE de cada operación. Sin TP de referencia, el campo "Multiplicador de contratos" escala beneficio, comisión y pérdida flotante.

Verás cuántos exámenes se aprobarían y suspenderían, el winrate, las ganancias y
pérdidas medias, las rachas medias y los días por examen.

## Qué hace el motor

- Cada examen empieza al día siguiente de aprobar o suspender el anterior.
- Drawdown de fin de día (EOD), bloqueado en saldo inicial + 100 $.
- El límite de pérdida diaria bloquea la operativa el resto del día; no suspende la cuenta.
- La sesión se corta a las 16:45 hora de Nueva York.
- El objetivo solo cuenta con la posición cerrada.
- Cambiar el TP en $ reescala el lotaje, y con él el SL y todo el P&L.
- Avisa cuando el lotaje supera el límite de contratos de Lucid.

## Estructura del proyecto

- `index.html` — la app ya compilada en un único archivo (lo que publica GitHub Pages).
- `app/src/parseMT5.js` — lector de informes de MT5.
- `app/src/parseNT8.js` — lector de CSV de NinjaTrader 8.
- `app/src/motorExamen.js` — motor de exámenes (función pura, usable desde Node).
- `app/src/App.jsx` — interfaz.
- `app/backup/App.original.jsx` — el código original, sin modificar.
- `reports/` — dos informes de MT5 de ejemplo.

### Desarrollo

```bash
cd app
npm install
npm run dev     # servidor de desarrollo
npm run build   # regenera el index.html autónomo en app/dist/
```
