# Automaton — panel de simulación (multi-usuario)

Panel web que simula la actividad de un agente autónomo: tareas completadas,
créditos/débitos a su wallet, una flota de bots y retiros. Cada cuenta tiene
su propio wallet, historial y flota de bots, completamente aislados de las
demás (multi-tenant). Todo se persiste en SQLite (`automaton.db`), así que el
historial sobrevive a reinicios y redeploys (mientras `automaton.db` viva en
un Volume persistente, como el que ya está montado en Railway en `/data`).

⚠️ **Es un entorno de demo.** Los montos y tareas son generados
automáticamente, no representan cobros o ingresos reales.

## Login y cuentas

No hay registro público — nadie puede crear su propia cuenta desde la
interfaz. Hay dos tipos de cuenta:

- **`admin`**: no tiene wallet ni simulación propia. Solo puede iniciar
  sesión en `/admin`, ver la lista de cuentas existentes (email, saldo,
  cantidad de bots) y crear cuentas nuevas (siempre con role `user`).
- **`user`**: tiene su propio Automaton — wallet, historial de eventos,
  flota de bots, retiros y planificación semanal, todo aislado del resto de
  usuarios. Inicia sesión en `/` y ve únicamente su propia información.

Las contraseñas se guardan siempre con hash bcrypt, nunca en texto plano.
Las sesiones usan una cookie httpOnly (`automaton_sid`) de sesión de
navegador (se cierra al cerrar el navegador por completo).

**Crear cuentas nuevas:** inicia sesión como admin (`jota71663@gmail.com`) y
usa el formulario en `/admin`. Es la única forma de dar de alta un usuario
nuevo — no existe una ruta de registro público ni se necesita tocar Railway
ni la base de datos a mano.

### Variables de entorno obligatorias en el primer deploy

Las contraseñas de las dos cuentas iniciales (admin y Jorge) **no están en el
código** — el server las lee una sola vez, en el momento de crear cada
cuenta, desde estas variables de entorno en Railway:

- `SEED_ADMIN_PASSWORD` → contraseña de `jota71663@gmail.com`
- `SEED_JORGE_PASSWORD` → contraseña de `jryesid@gmail.com`

Si falta alguna y esa cuenta todavía no existe, el server **no arranca** (se
detiene con un mensaje claro en los logs indicando cuál falta) en vez de
crear la cuenta con una contraseña por defecto o dejarla a medias. Una vez
creadas ambas cuentas (ya quedó guardado el hash bcrypt en la base de
datos), estas variables ya no se vuelven a leer — puedes borrarlas de
Railway después del primer deploy exitoso si quieres, aunque dejarlas no
tiene ningún costo de seguridad adicional (ya no se usan para nada).

## Migración de datos existentes

La primera vez que este código corre contra una base de datos que todavía
tiene el esquema anterior (una sola wallet global, sin usuarios), lo detecta
automáticamente: renombra las tablas viejas a `*_legacy` (nunca se borran,
quedan de respaldo) y copia todo ese estado — saldo, historial de eventos,
retiros, flota de bots y planificación pendiente — a la cuenta
`jryesid@gmail.com`. Esto ocurre una sola vez (queda una bandera guardada en
la tabla `system_meta`) y nunca se repite en reinicios posteriores.

Todo este proceso (detectar, renombrar, crear las cuentas y copiar los
datos) corre dentro de una sola transacción: si `SEED_ADMIN_PASSWORD` o
`SEED_JORGE_PASSWORD` faltan, o el proceso se interrumpe a la mitad por
cualquier motivo, no se guarda nada — ni el renombrado de tablas, ni cuentas
a medias — y se reintenta desde cero, de forma segura, en el próximo
arranque.

## Regla semanal

Cada semana (sábado 00:00 → viernes 23:59:59, hora Colombia), **para cada
usuario por separado**, se planifica por adelantado:

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

Un proceso interno revisa cada minuto, para cada usuario registrado, si hay
eventos "vencidos" (su hora ya llegó) y los aplica al saldo. Si el servidor
estuvo apagado un rato, al volver a encender aplica de una vez los que se
acumularon (no se pierden, solo se entregan en bloque).

## Flota de bots y retiro automático

Cada vez que la ganancia neta acumulada de **tareas** (créditos − débitos;
los retiros no cuentan) de un usuario avanza $150, se crea un bot nuevo para
ese usuario. Cada bot nuevo dispara automáticamente un retiro de $50 a
`9b37eChVGn3rSQRRMCLGj76GxGZx2d4tTBc9tcDBnWSP`, visible en el historial de
retiros con la etiqueta "Retiro automático — bot duplicado". Si el saldo en
ese momento es menor a $50, se retira lo que haya disponible (retiro
parcial) en vez de bloquear la creación del bot o dejar el saldo negativo.
Igual que los retiros manuales, estos retiros automáticos no cuentan para la
regla de ganancia semanal ni para el progreso hacia el siguiente bot.

## Retiros manuales

Cualquier usuario puede retirar desde su propio dashboard a una dirección de
Solana. La dirección se valida de verdad (decodificación base58 + 32 bytes
exactos, no solo un patrón de caracteres). Los retiros no cuentan para la
regla de ganancia semanal ni para el progreso de bots.

## Pausar / reanudar la simulación

Por defecto la simulación está **activa** para todos los usuarios. Para
congelarla (que el saldo y el historial de todos queden fijos tal como
están), pon `SIMULATION_ENABLED=false` en las variables de entorno y
redeploy.
