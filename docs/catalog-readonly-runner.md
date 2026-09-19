# Catalogo completo read-only

## Comandos seguros

El recorrido predeterminado procesa como maximo cinco paginas:

```bash
npm run catalog:scan
npm run catalog:scan -- --max-pages 5
```

Para reanudar desde un checkpoint:

```bash
npm run catalog:scan -- --resume output/catalog-checkpoints/<runId>.checkpoint.json
```

Un recorrido sin limite exige el flag explicito `--full`:

```bash
npm run catalog:scan -- --full
```

`PLAN_BATCH` procesa solo una cantidad acotada de los SKU descubiertos. El
limite predeterminado es 100 y puede reducirse con `--max-items`:

```bash
npm run catalog:plan -- --max-pages 5 --max-items 25
```

Todos los modos son read-only. El catalogo no acepta gates mutables y el batch
subyacente fuerza dry-run aunque `.env` contenga valores inseguros.

## Sesion y paginacion

El runner reutiliza un unico browser, contexto y pagina autenticada para todas
las lecturas de `/api/articulos` y, en `PLAN_BATCH`, para la extraccion Arcore
secuencial. La concurrencia de paginas y de planificacion es 1.

Se ejecuta un health check al inicio, al final y cada 100 paginas. Un HTTP 401
o redirect a login permite una unica reautenticacion. Timeouts, HTTP 429 y 5xx
usan hasta tres intentos totales con esperas de 1 y 2 segundos. Una pagina que
continua fallando pausa el run y conserva `nextPage` para reanudarla; nunca se
salta silenciosamente.

## Checkpoint incremental

Despues de cada pagina se actualizan:

- `output/catalog-checkpoints/<runId>.checkpoint.json`;
- `output/catalog-checkpoints/<runId>.pages.ndjson`.

El JSON contiene progreso y compatibilidad. El NDJSON agrega un registro
compacto por pagina con `id` y `codComercial`. Al reanudar, solo se reconstruye
estado hasta `lastCompletedPage`; lineas posteriores a un checkpoint incompleto
se ignoran.

Un cambio de `pageSize` invalida la reanudacion. Los cambios de `totalPages` se
registran como `CATALOG_PAGINATION_EXPANDED` o
`CATALOG_PAGINATION_REDUCED`.

## Salidas

El resultado se guarda en `output/catalog-runs/<runId>.json` e incluye metadata,
paginacion, resumen, warnings, errores, duplicados, items invalidos, checkpoint
y la lista estable de SKU. No persiste respuestas crudas de Arcore.

El source SKU es siempre `codComercial`. Los faltantes quedan como items
invalidos y la deduplicacion usa exclusivamente `normalizeSku()`.
