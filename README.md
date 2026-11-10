# FUTUROS — Evaluador de Estrategias & Prop Firms

Simula exámenes LucidFlex sobre backtests de MetaTrader 5 (informe HTML del Strategy Tester) o de NinjaTrader 8 (CSV de operaciones).

## Abrir la app

- **Más fácil (en línea):** se publica con GitHub Pages en
  https://CharlyEAapps.github.io/FUTUROS/ — se abre en el navegador, sin instalar nada.
- **En tu PC:** descarga este repositorio (botón verde **Code → Download ZIP**),
  descomprímelo y abre `index.html` con doble clic. Es un único archivo autónomo.

## Cómo se usa

1. Elige tamaño de cuenta (25K / 50K / 100K), consistencia y el TP por operación.
2. Elige la plataforma del backtest con el selector **MetaTrader 5 / NinjaTrader** y carga el archivo. En MetaTrader 5: el informe HTML (y, si quieres, también la curva del gráfico). En NinjaTrader: el CSV de operaciones (ver abajo).
3. Pulsa "Iniciar análisis".

### Backtests de NinjaTrader

- Exporta las operaciones desde el Strategy Analyzer: vista de operaciones → clic derecho → **Exportar** (CSV). Comprobado con una exportación real en español (separador `;`, decimales con coma, importes con ` $`, fechas día/mes/año); también se admiten cabeceras en inglés y fechas mes/día con AM/PM. Suma comisión y tarifas y detecta con el beneficio acumulado si el beneficio ya las descuenta. También lee el CSV del conector BtRunner.
- **Importante:** exporta un backtest SIN los límites del examen (pérdida máxima, objetivo y consistencia desactivados, contratos fijos). Si el EA se detiene al llegar a ellos, la serie queda cortada y el simulador no tiene operaciones que evaluar.
- NinjaTrader guarda las horas con el reloj del PC: indica su zona horaria (por defecto `Europe/Madrid`) y se convierten a hora de Nueva York respetando los cambios de hora. El desfase del servidor MT5 no se usa con NinjaTrader.
- Si el CSV no trae comisión, el resultado es bruto: escribe la comisión extra por contrato (ida y vuelta) en el campo correspondiente.
- El drawdown intradía se calcula con el MAE de cada operación. NinjaTrader no trae TP de referencia: el campo "Multiplicador de contratos" escala beneficio, comisión y pérdida flotante. Los micros (MNQ, MES, MGC...) cuentan 0,1 mini para el límite de contratos.
- Cambiar de plataforma descarta los archivos cargados. El backtest de live y los registros guardados funcionan igual con las dos plataformas.

Verás cuántos exámenes se aprobarían y suspenderían (con su %), el winrate, las
ganancias y pérdidas medias, las rachas medias y los días por examen.

Pestañas de resultados:
- **General:** contadores de exámenes, métricas y cronología.
- **Detalle temporal:** rendimiento por año, trimestre o mes, con winrate de largos y cortos.
- **Comparativa:** enfrenta el análisis actual con un registro guardado y calcula la
  correlación (Pearson) del resultado neto por periodo entre los dos sistemas.

## Registros guardados y cómo llevarlos a otro equipo

Los registros que guardas viven en el navegador (localStorage), así que **no viajan solos**
a otro equipo ni se guardan en este repositorio por su cuenta.

Para llevarlos a otro sitio o conservarlos en el repo:
1. **Exportar .json** descarga todos tus registros en un archivo.
2. Guarda ese archivo donde quieras: puedes subirlo a este repositorio (p. ej. en una
   carpeta `registros/`), a Drive, o llevarlo en un USB.
3. En el otro equipo, pulsa **Importar .json** y elige el archivo. Los registros se
   fusionan con los que ya tengas, sin duplicar.

> Nota: la app es un archivo estático y no puede escribir en GitHub por sí sola (haría falta
> autenticación, que no puede ir dentro de un HTML público). Por eso el puente entre equipos
> es el archivo `.json` que tú exportas e importas.

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
- `app/src/parseNT8.js` — lector de CSV de NinjaTrader 8 (Analizador y BtRunner), con paso de hora del PC a Nueva York.
- `app/src/App.jsx` — interfaz y motor de exámenes.
- `app/backup/App.original.jsx` — el código original, sin modificar.
- `reports/` — informes de MT5 de ejemplo y dos CSV de NinjaTrader (Analizador y BtRunner, las mismas 63 operaciones).

### Desarrollo

```bash
cd app
npm install
npm run dev     # servidor de desarrollo
npm run build   # regenera el index.html autónomo en app/dist/
```
