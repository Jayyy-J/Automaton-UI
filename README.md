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

Columnas nuevas que se agreguen en el futuro (como `bot_id` o
`counts_toward_targets` en `events`) se añaden con `ALTER TABLE ADD COLUMN`
a cualquier base de datos existente — nunca se recrea ni se borra una
tabla con datos.

## Regla semanal

Cada semana (sábado 00:00 → viernes 23:59:59, hora Colombia), **para cada
usuario por separado**, se planifica por adelantado:

1. Se sortea un objetivo de ganancia neta entre **$750 y $975**.
2. Se generan los tiempos de los eventos de esa semana, separados entre
   **15 minutos y 3 horas** entre sí.
3. Los débitos (costos de infraestructura) son montos naturales al azar
   ($0.10–$5).
4. Los créditos (tareas pagadas) se calculan matemáticamente para que:
   `total créditos − total débitos = objetivo semanal`, cada uno dentro de
   $0.50–$25.

Esto garantiza que, sin importar cuántos eventos ocurran, la semana siempre
cierra el viernes con una ganancia neta dentro del rango pedido — no es pura
casualidad, está calculado desde el inicio de la semana. Con el hito de bot
a $150 (ver abajo), este rango da entre 5 y 6 bots nuevos por semana en
promedio, sin necesitar un mecanismo de "mínimo garantizado" aparte.

Para que el objetivo siga siendo matemáticamente alcanzable con el tope de
$25 por crédito incluso en el caso límite de muy pocas semanas/horas
restantes (ej. una cuenta creada a pocas horas de que cierre la semana, con
muy pocos eventos generados al azar), el generador agrega slots de crédito
extra — sin el espaciado normal de 15min-3h — hasta que haya capacidad
suficiente para cubrir el objetivo. Esto es poco frecuente y solo aplica a
ese caso límite; una semana completa normal no lo necesita.

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

## Atribución de eventos a bots + historial por bot

Cada evento de tarea (crédito o débito) de la planificación semanal se
atribuye, en el momento en que se **entrega** (no cuando se genera el plan
por adelantado), a un bot elegido al azar entre los que ese usuario tiene
EN ESE MOMENTO — nunca a un bot que se vaya a crear después. El feed de
actividad muestra qué bot generó cada evento (`BOT-014 — Web scraping —
catálogo de precios`).

En "FLOTA DE BOTS", cada fila tiene una flechita para desplegar el
historial completo de ese bot específico. Varios bots pueden estar
desplegados a la vez (no es acordeón de "solo uno"); cada panel desplegado
tiene su propia altura máxima con scroll independiente, y la lista de bots
en sí crece con la página en vez de quedar encerrada en una caja chica.

Los eventos que ya existían antes de que se guardara a qué bot pertenecen
(de antes de este cambio) recibieron, una sola vez, un bot asignado al azar
entre los bots de ese usuario que ya existían en la fecha de cada evento
(nunca uno creado después de esa fecha); si ningún bot calificaba para un
evento muy viejo, se usó cualquier bot de ese usuario. Los retiros nunca
tienen bot asignado — no los genera un bot.

## Cobertura diaria garantizada por bot

Un barrido corre cada hora (y una vez al iniciar el servidor, por si estuvo
apagado) y revisa, para cada bot de cada usuario, si ya tuvo al menos un
evento hoy (día calendario, hora Colombia). Al que no haya tenido ninguno
le genera un evento de cobertura mínimo ($0.01–$0.05), usando las mismas
listas de nombres de tarea / razones de débito que los eventos normales.

Estos eventos son **intencionalmente indistinguibles** de la actividad
real: mismo formato, mismo feed, mismo historial por bot — no hay ninguna
etiqueta ni marca visible, ni en el frontend ni en las respuestas de la
API, que delate cuáles son de cobertura. Lo único que los distingue es una
columna interna (`counts_toward_targets = 0`) que ningún endpoint expone:
por eso NO cuentan para la regla de ganancia semanal ni para el progreso
hacia el próximo bot (si contaran, la semana ya no cerraría exacto en el
rango calculado de antemano). Sí se incluyen en las estadísticas de "hoy"
del dashboard (ingresos/egresos/tareas de hoy), para que esos números
coincidan con lo que el feed en vivo muestra — excluirlos ahí sería, en sí
mismo, la clase de inconsistencia que delataría que no son reales.

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
