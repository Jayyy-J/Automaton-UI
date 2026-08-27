# Automaton — panel de simulación

Panel web que simula la actividad de un agente autónomo: tareas completadas,
créditos/débitos a su wallet, y una regla de negocio semanal (ver abajo). Los
eventos se generan y persisten en SQLite (`automaton.db`), así que el
historial sobrevive a reinicios y redeploys (mientras `automaton.db` viva en
un Volume persistente).

⚠️ **Es un entorno de demo.** Los montos y tareas son generados
automáticamente, no representan cobros o ingresos reales.

## Regla semanal

Cada semana (sábado 00:00 → viernes 23:59:59, hora Colombia) se planifica por
adelantado:

1. Se sortea un objetivo de ganancia neta entre **$35 y $195**.
2. Se generan los tiempos de los eventos de esa semana, separados entre
   **15 minutos y 3 horas** entre sí.
3. Los débitos (costos de infraestructura) son montos naturales al azar
   ($0.10–$5).
4. Los créditos (tareas pagadas) se calculan matemáticamente para que:
   `total créditos − total débitos = objetivo semanal`, cada uno dentro de
   $0.50–$25.

Esto garantiza que, sin importar cuántos eventos ocurran, la semana siempre
cierra el viernes con una ganancia neta dentro del rango pedido — no es pura
casualidad, está calculado desde el inicio de la semana.

Un proceso interno revisa cada minuto si hay eventos "vencidos" (su hora ya
llegó) y los aplica al saldo. Si el servidor estuvo apagado un rato, al volver
a encender aplica de una vez los que se acumularon (no se pierden, solo se
entregan en bloque).

## Reiniciar el saldo a un valor específico

Si necesitas forzar el saldo a un número exacto (por ejemplo, para empezar
una demo desde $1922.30):

1. En Railway → Variables, agrega `RESET_BALANCE_TO=1922.30`.
2. Redeploy. Esto borra el historial y los planes anteriores, y deja el saldo
   exactamente en ese valor.
3. **Importante:** borra esa variable de entorno después de un deploy exitoso.
   Si la dejas puesta, cada vez que el contenedor se reinicie volverá a
   resetear el saldo.

## Pausar / reanudar la simulación

Por defecto la simulación está **activa**. Para congelarla (que el saldo y el
historial queden fijos tal como están):

