# Automaton — panel de simulación

Panel web que simula la actividad de un agente autónomo: tareas completadas,
créditos/débitos a su wallet, y un cálculo de "autonomía restante" según su
costo de mantenimiento mensual. Los eventos se generan solos cada 4–14
segundos (aleatorio) y se guardan en SQLite (`automaton.db`), así que el
historial persiste aunque reinicies el servidor o la máquina.

⚠️ **Es un entorno de demo.** Los montos y tareas son generados
automáticamente, no representan cobros o ingresos reales. El badge en la UI
ya lo indica, pero acláraselo también de palabra al cliente.

## Correr en tu VM de Ubuntu (WSL o nativo)

```bash
cd automaton-demo
npm install
npm start
```

Abre `http://localhost:4000`. El servidor sigue generando eventos mientras
esté corriendo. La próxima vez que lo arranques (`npm start`), lee el mismo
`automaton.db` y continúa desde el saldo y el historial donde quedaron — no
reinicia desde cero.

Para dejarlo corriendo en segundo plano en la VM:

```bash
nohup npm start > automaton.log 2>&1 &
```

O, mejor, usa `pm2` para que sobreviva a reinicios de la VM:

```bash
npm install -g pm2
pm2 start server.js --name automaton
pm2 save
pm2 startup   # sigue las instrucciones que imprime
```

## Publicar con un dominio (Railway)

1. Sube esta carpeta a un repo de GitHub.
2. En Railway: **New Project → Deploy from GitHub repo**.
3. Railway detecta Node.js automáticamente y corre `npm install && npm start`.
4. **Importante para la persistencia:** el sistema de archivos de Railway es
   efímero en cada deploy nuevo. Para que `automaton.db` sobreviva entre
   deploys, agrega un **Volume** en el servicio (Settings → Volumes) montado
   en, por ejemplo, `/data`, y define la variable de entorno:
   ```
   DB_PATH=/data/automaton.db
   ```
5. Genera el dominio público desde Settings → Networking → Generate Domain
   (o conecta tu propio dominio ahí mismo).

Con el volumen montado, el historial sigue creciendo de forma continua sin
importar cuántas veces redeploys el servicio.

## Configuración

Todo lo ajustable está al inicio de `server.js`:

- `STARTING_BALANCE` — saldo inicial (solo aplica la primera vez, antes de
  que exista `automaton.db`).
- `MONTHLY_MAINTENANCE` — costo mensual usado para calcular "días de
  autonomía restante".
- `MIN_EVENT_MS` / `MAX_EVENT_MS` — qué tan seguido se generan eventos.
- `CREDIT_PROBABILITY` — proporción de eventos que son ingresos vs. gastos.
- Débitos: aleatorios entre $0.10 y $5.00 (máximo pedido).
- Créditos: aleatorios entre $0.50 y $25.00 (rango pedido).

## Endpoints

- `GET /api/status` — saldo actual, autonomía restante, totales del día.
- `GET /api/events?limit=50` — últimos eventos del ledger.

## Reiniciar desde cero

Si en algún momento quieres que el cliente vea un arranque limpio, simplemente
borra `automaton.db`, `automaton.db-shm` y `automaton.db-wal` y vuelve a
iniciar el servidor.
