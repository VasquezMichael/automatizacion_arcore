# Despliegue productivo v1

## Inicio

La aplicacion productiva se inicia con:

```bash
npm run start:production
```

El proceso levanta el dashboard, `GET /health`, `GET /ready` y el scheduler
interno. El scheduler esta deshabilitado por defecto y su modo seguro es
`PLAN`.

## Persistencia

`DATA_DIR` define la raiz de reportes, planes, checkpoints, locks y metadata
del scheduler. Su valor local por defecto es `./output`.

En produccion, `DATA_DIR` debe apuntar a un volumen o disco persistente. Si se
usa un filesystem efimero se perderan checkpoints, historial y metadata tras
un reinicio. La imagen Docker declara `/app/data` como volumen y usa ese path
por defecto.

Al iniciar, el proceso valida que `DATA_DIR` exista o pueda crearse y que sea
escribible. El path efectivo se registra sin incluir secretos.

## Seguridad

La autenticacion HTTP Basic se habilita con:

```text
DASHBOARD_AUTH_ENABLED=true
DASHBOARD_USERNAME=...
DASHBOARD_PASSWORD=...
```

Si falta usuario o password, el proceso no inicia. `/health` y `/ready` quedan
sin autenticacion para permitir probes de infraestructura; el dashboard y las
APIs operativas quedan protegidos.

Una ejecucion programada en modo `EXECUTE` requiere, ademas de todos los gates
existentes, `PRODUCTION_SYNC_EXECUTION_CONFIRMED=true`. Si falta cualquier
proteccion, el servidor puede iniciar pero el scheduler queda `BLOCKED`. El
proceso nunca abre gates automaticamente.

## Scheduler

```text
PRODUCTION_SYNC_SCHEDULE_ENABLED=false
PRODUCTION_SYNC_INTERVAL_MINUTES=60
PRODUCTION_SYNC_MODE=PLAN
```

Los jobs no se solapan. Los errores se registran y persisten sin detener el
servidor. La metadata vive en `DATA_DIR/scheduler/metadata.json`.

## Cierre ordenado

`SIGTERM` y `SIGINT` detienen nuevos jobs, cierran el servidor HTTP y esperan
la ejecucion activa hasta `PRODUCTION_SHUTDOWN_TIMEOUT_MS`. Si vence el timeout,
el proceso no elimina por la fuerza el lock de una ejecucion cuyo estado sea
incierto.

## Docker

```bash
docker build -t arcore-sync:v1 .
docker run --rm -p 3000:3000 -v arcore-data:/app/data \
  --env-file .env arcore-sync:v1
```

No incluir `.env` ni `storageState.json` dentro de la imagen. Proveer secretos
mediante el mecanismo seguro de la plataforma de despliegue.
