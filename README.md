# FUTUROS — Evaluador de Estrategias & Prop Firms

Simula exámenes LucidFlex sobre backtests de MetaTrader 5 (informe HTML del Strategy Tester).

## Abrir la app

- **Más fácil (en línea):** se publica con GitHub Pages en
  https://CharlyEAapps.github.io/FUTUROS/ — se abre en el navegador, sin instalar nada.
- **En tu PC:** descarga este repositorio (botón verde **Code → Download ZIP**),
  descomprímelo y abre `index.html` con doble clic. Es un único archivo autónomo.

## Cómo se usa

1. Elige tamaño de cuenta (25K / 50K / 100K), consistencia y el TP por operación.
2. Carga tu informe HTML de MetaTrader 5 con el botón.
3. Pulsa "Iniciar análisis".

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
- `app/src/App.jsx` — interfaz y motor de exámenes.
- `app/backup/App.original.jsx` — el código original, sin modificar.
- `reports/` — dos informes de MT5 de ejemplo.

### Desarrollo

```bash
cd app
npm install
npm run dev     # servidor de desarrollo
npm run build   # regenera el index.html autónomo en app/dist/
```
