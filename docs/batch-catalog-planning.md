# Planificacion batch de catalogo

## Alcance actual

`npm run sync:batch` procesa una lista explicita de SKUs. Cada SKU reutiliza
`executeSyncPlan()`, que a su vez reutiliza `syncProduct()`, la clasificacion,
la revalidacion y los planes existentes. La capa batch no contiene reglas de
precio, disponibilidad, imagen, identidad o LEGACY_GROUP.

El comando fuerza `READ_ONLY`: ignora gates mutables del entorno, usa el
cliente Tiendanube de solo lectura, no persiste ejecuciones individuales y no
expone adapters de escritura. El unico archivo generado es el reporte local en
`output/batches/`.

## Entrada

Archivos TXT, un SKU por linea:

```bash
npm run sync:batch -- --file input/skus.txt
```

Archivos JSON con un array de strings:

```bash
npm run sync:batch -- --file input/skus.json
```

Para pruebas breves tambien se admite una lista separada por comas:

```bash
npm run sync:batch -- "415054910,415071510"
```

La concurrencia predeterminada es `1`. Puede configurarse entre `1` y `3` con
`--concurrency`, pero el modo secuencial es el recomendado porque cada SKU abre
su propio contexto de navegador Arcore.

## Futuro proveedor de catalogo completo

La fuente estructurada disponible es `GET /api/articulos`, con `query` y
`page`. La paginacion actual es base cero y la respuesta expone `pages` y
`data`. El identificador comercial apropiado para alimentar al batch es
`codComercial`; `codigo` y `marcaId` son identificadores internos necesarios
para stock, no reemplazos del SKU comercial.

Una consulta read-only de la pagina cero realizada el 2026-09-18 devolvio
`total: 25771`, `pages: 2148` y `pageSize: 12`. Son valores observados, no
constantes de negocio: el proveedor de catalogo futuro debe leerlos en cada
ejecucion y no asumir que permanecen estables.

Antes de recorrer el catalogo completo se necesita un proveedor separado que:

1. recorra todas las paginas y guarde checkpoints por pagina;
2. extraiga `codComercial` sin aplicar transformaciones de identidad;
3. deduplique con `normalizeSku()` solo para coordinar unidades de trabajo;
4. persista cursor, paginas completadas y errores recuperables;
5. reanude desde el ultimo checkpoint sin repetir items completados;
6. limite concurrencia y aplique backoff a errores transitorios de Arcore.

Riesgos principales: codigos comerciales duplicados, articulos sin
`codComercial`, cambios de paginacion durante una corrida y expiracion de la
sesion. Ninguno debe convertirse automaticamente en una regla nueva de SKU o
en una ampliacion de la whitelist legacy.
