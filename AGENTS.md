# AGENTS.md

## Propósito y alcance

Este repositorio automatiza la comparación y futura sincronización entre el
proveedor Arcore y Tiendanube. Estas instrucciones son obligatorias para los
agentes de desarrollo que trabajen en cualquier archivo del repositorio.

La prioridad es preservar las decisiones de negocio y los bloqueos de seguridad
ya aprobados. No inventar reglas ni ampliar el alcance de una tarea sin una
instrucción explícita.

## Fuente de verdad y propiedad de campos

Arcore es la fuente de verdad para:

- disponibilidad;
- precio;
- imagen;
- existencia de productos nuevos.

El sistema puede controlar en Tiendanube:

- publicación o despublicación;
- precio;
- imagen principal;
- creación de productos nuevos.

Preservar por defecto los campos comerciales editados manualmente en
Tiendanube, incluidos:

- título;
- descripción;
- categorías;
- contenido comercial;
- cualquier otro campo no controlado expresamente por la automatización.

No incluir esos campos en payloads de actualización salvo requerimiento
explícito y validado.

## Arquitectura

Mantener la separación entre:

- **Planificador/orquestador (`src/sync`)**: consulta, analiza y decide. Es
  estructuralmente read-only.
- **Executor**: ejecutará planes aprobados, revalidará antes de cada escritura y
  verificará el resultado después de escribir.

No agregar `POST`, `PUT`, `DELETE`, uploads ni helpers de escritura dentro de
`src/sync` sin una decisión arquitectónica explícita.

El orquestador debe usar el cliente de solo lectura y conservar:

- `dryRun: true`;
- `writeOperationsAvailable: false`;
- ausencia de rutas de escritura aunque
  `TIENDANUBE_DRY_RUN=false` esté configurado.

Antes de crear helpers nuevos, buscar y reutilizar los módulos existentes de
extracción, normalización, clasificación, pricing, imágenes, persistencia y
Tiendanube.

## Resolución de SKU y códigos Arcore

`normalizeSku()` normaliza exclusivamente el formato:

- elimina espacios y guiones conforme a la implementación actual;
- normaliza mayúsculas/minúsculas conforme a la implementación actual;
- no agrega ni elimina dígitos;
- no incorpora reglas particulares de Arcore.

La resolución de códigos Arcore admite únicamente:

- `EXACT`: el código normalizado del candidato es idéntico al solicitado;
- `SAFE_TRANSFORM`: el candidato es exactamente el código solicitado más un
  único cero final;
- `AMBIGUOUS`: existen varios candidatos potenciales;
- `NOT_FOUND`: no existe ningún candidato permitido.

La única regla `SAFE_TRANSFORM` aprobada es:

```text
normalizedMatchedCode === normalizedRequestedCode + "0"
rule = APPEND_TRAILING_ZERO
```

Solo `EXACT` y `SAFE_TRANSFORM` permiten planificación automática.
`AMBIGUOUS` y `NOT_FOUND` deben producir `MANUAL_REVIEW`, bloquear todos los
planes automáticos y conservar candidatos seguros para diagnóstico.

Nunca:

- usar `candidate.includes(requested)` como criterio de identidad;
- elegir el primer candidato cuando hay más de uno;
- agregar el cero dentro de `normalizeSku()`;
- aceptar sufijos, prefijos o cantidades de dígitos distintas de la regla
  explícita.

Preferir los datos estructurados de `/api/articulos` frente al matching libre
sobre texto del DOM. Evaluar todos los resultados y toda la paginación; no
asumir que el primer resultado es correcto.

## Clasificación en Tiendanube

Para un SKU normalizado registrado como `LEGACY_GROUP`:

- tratarlo como una excepción histórica, no como una regla general;
- sincronizar únicamente las publicaciones registradas;
- nunca crear integrantes nuevos automáticamente;
- nunca extender la whitelist al encontrar duplicados adicionales;
- validar exactamente `expectedMatches`, `productIds`, `variantIds` y los pares
  actuales `productId:variantId`;
- si cualquier validación difiere, usar `MANUAL_REVIEW` y no escribir.

Para un SKU no legacy:

```text
0 coincidencias -> CREATE_SINGLE
1 coincidencia  -> SINGLE
>1 coincidencia -> MANUAL_REVIEW
```

Antes de cualquier futura creación, volver a consultar Tiendanube y confirmar
que no apareció un SKU equivalente. Nunca crear duplicados nuevos.

## Disponibilidad

Consultar el stock Arcore mediante `/api/stocks` usando metadata estructurada de
`/api/articulos`:

- código interno;
- `marcaId` interno;
- `supermedida`.

No asumir que los valores visibles del DOM son parámetros internos válidos.

El mapping vigente es:

```text
AVAILABLE   -> published = true
PARTIAL     -> published = true
UNAVAILABLE -> published = false
UNKNOWN     -> no modificar publicación
```

`UNKNOWN` es un fail-safe obligatorio. No convertir textos o colores nuevos en
estados conocidos mediante heurísticas dudosas. Todo mapping nuevo debe basarse
en evidencia inequívoca, quedar explícito y tener pruebas.

Los diagnósticos pueden incluir URL segura, parámetros no secretos, status HTTP
y respuesta funcional. Nunca deben incluir cookies, tokens ni datos de sesión.

## Precio

La selección del precio proveedor tiene este orden estricto:

1. `Su precio` (`SU_PRECIO`);
2. `Precio Mostrador` (`PRECIO_MOSTRADOR`) solo si falta `Su precio`;
3. `null` si faltan ambos.

Nunca usar `Precio de lista` ni cualquier otro número de la tarjeta como
fallback genérico.

Aplicar las reglas comerciales vigentes en este orden:

```text
0 <= precio <= 75000        -> categoría 1, multiplicador 1.50
75000 < precio < 250000     -> categoría 2, multiplicador 1.30
250000 <= precio <= 712000  -> categoría 3, multiplicador 1.25
precio > 712000             -> categoría 4, multiplicador 1.20
```

El flujo debe permanecer separado:

```text
precio proveedor
-> seleccionar categoría
-> aplicar multiplicador
-> obtener baseCalculatedPrice
-> applyPriceRounding()
-> obtener calculatedPrice entero
```

`applyPriceRounding()` usa `Math.round`. No mezclar redondeo, selección de
categoría y coeficientes. No agregar tratamiento de IVA sin una regla comercial
explícita.

Un precio proveedor igual a cero puede calcularse para diagnóstico, pero debe
bloquear cualquier escritura real y requerir revisión manual.

## Imágenes

Si Arcore no tiene imagen, devolver `NO_SOURCE_IMAGE`. Nunca eliminar una imagen
de Tiendanube por ausencia de imagen en Arcore.

Comparar imágenes en dos etapas:

1. SHA-256 exacto;
2. si el hash exacto difiere, dHash perceptual de 256 bits con threshold `20`.

Una misma imagen recomprimida o redimensionada debe producir
`IMAGE_NO_CHANGE`. Una imagen realmente distinta debe producir
`IMAGE_REPLACE`. No usar URL, nombre de archivo o dimensiones como único
criterio.

Trabajar únicamente sobre la imagen principal salvo cambio explícito. No borrar
automáticamente imágenes secundarias.

En un reemplazo futuro:

1. subir la imagen nueva;
2. comprobar que la respuesta contiene su ID;
3. verificar el resultado cuando corresponda;
4. eliminar la imagen anterior recién después.

Si la subida falla, preservar la imagen anterior. Si falla la eliminación de la
imagen anterior después de una subida exitosa, conservar ambas imágenes,
registrar `IMAGE_OLD_DELETE_FAILED`, `updated: true` y `partial: true`, y no
intentar un rollback destructivo.

Al descargar imágenes autenticadas de Arcore, enviar cookies únicamente a la
whitelist existente. No seguir redirects autenticados a terceros y validar que
el `Content-Type` sea `image/*` antes de calcular hashes.

## Seguridad y secretos

Nunca:

- imprimir tokens, contraseñas, cookies o valores de sesión;
- incluir secretos en errores, fixtures o snapshots;
- commitear `.env`, `storageState.json`, claves o archivos de secretos;
- inventar, modificar o revocar credenciales;
- mostrar cuerpos descargados cuando no son imágenes válidas.

Mantener las exclusiones de `.gitignore`. Usar `.env.example` solo para nombres
y valores seguros de ejemplo.

Los scripts existentes bajo `src/tiendanube/test*.js` incluyen POCs capaces de
escribir. No asumir que el prefijo `test` implica solo lectura. No ejecutar esos
flujos con `TIENDANUBE_DRY_RUN=false` sin autorización explícita del usuario para
la operación concreta.

## Dry-run y escrituras futuras

Los componentes de análisis deben fallar de manera segura. Para cualquier futuro
executor:

- `TIENDANUBE_DRY_RUN` debe ser `true` por defecto;
- solo `false` explícito puede habilitar una escritura;
- una escritura requiere además autorización y validaciones funcionales;
- dry-run no debe emitir `POST`, `PUT`, `DELETE` ni uploads.

Antes de cada escritura real:

- revalidar SKU normalizado;
- revalidar `productId` y `variantId`;
- volver a consultar el estado actual;
- confirmar la clasificación;
- bloquear `MANUAL_REVIEW`;
- bloquear `UNKNOWN` cuando afecte publicación;
- comprobar que el recurso sigue en el estado esperado;
- revalidar el registro completo si es `LEGACY_GROUP`.

Después de cada escritura:

- ejecutar un GET de verificación;
- distinguir `writeAttempted`, `writeSucceeded`, `verified` y `updated`;
- no interpretar HTTP 2xx como estado final verificado;
- registrar el resultado individual de cada publicación;
- continuar ante fallos individuales solo cuando la política aprobada lo
  permita;
- no improvisar rollbacks destructivos.

## Workflow de trabajo

Antes de editar:

1. ejecutar `git status`;
2. verificar la rama activa;
3. leer los módulos relacionados y sus pruebas;
4. identificar cambios locales previos y preservarlos;
5. confirmar que no se está desarrollando directamente sobre `main`.

Usar ramas `feature/*` para desarrollo. `main` es la rama estable.

Mantener los cambios acotados al pedido. Si aparece una mejora no solicitada,
registrarla como deuda técnica y no implementarla si cambia reglas de negocio o
arquitectura. Si una regla de negocio es ambigua, bloquear esa parte y reportar
la ambigüedad; no inventar una decisión.

Antes de un commit:

1. ejecutar `node --check` sobre los archivos JavaScript afectados;
2. ejecutar las pruebas relevantes;
3. ejecutar `git diff --check`;
4. revisar `git diff` y `git status`;
5. verificar que no se agregaron secretos ni salidas generadas.

Usar mensajes de commit en español y commits pequeños por milestone lógico. No
hacer commit o push salvo autorización del usuario o coordinador. Puede hacerse
commit y push en `feature/*` cuando se autorice expresamente.

Nunca:

- hacer merge automático a `main`;
- hacer push automático a `main`;
- borrar ramas sin instrucción explícita;
- revertir cambios locales ajenos al alcance.

El merge a `main` siempre requiere aprobación explícita.

## Verificación

Ejecutar las pruebas aplicables al área modificada:

```bash
npm run availability:test
npm run arcore:test-code-resolution
npm run pricing:test-rules
npm run pricing:test-supplier-price
npm run images:test-fingerprint
npm run tiendanube:test-price-aggregate
```

Para cambios del orquestador, probar como mínimo y siempre en modo read-only:

```bash
npm run sync:test -- "415 0549 10"
npm run sync:test -- "415 0715 10"
```

Referencias de validación conocidas, no reglas para hardcodear en producción:

```text
415 0549 10 -> SAFE_TRANSFORM -> 4150549100 -> SINGLE -> AVAILABLE
415 0715 10 -> SAFE_TRANSFORM -> 4150715100 -> LEGACY_GROUP (12) -> PARTIAL
```

No asumir que otros planes, como precio o imagen, permanecerán sin cambios: esos
resultados dependen del estado actual de Arcore y Tiendanube.

## Cierre de tareas

Después de cada tarea relevante, informar:

1. archivos creados o modificados;
2. implementación realizada;
3. pruebas y comandos ejecutados;
4. resultados observados;
5. warnings, ambigüedades o deuda técnica;
6. si hubo escrituras externas;
7. si hubo commit o push.

No ocultar pruebas omitidas, fallos parciales ni estados externos inciertos.
