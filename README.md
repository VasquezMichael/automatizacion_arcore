# Arcore POC

Proyecto de prueba de concepto para automatización de login y consulta autenticada en un portal privado.

## Qué hace

- Inicia sesión automáticamente con Playwright en modo visible.
- Guarda la sesión autenticada en `storageState.json`.
- Reutiliza esa sesión para consultar un endpoint interno protegido: `/api/stocks`.
- Prueba la accesibilidad y validez de imágenes del portal.
- Muestra el resultado en consola y guarda reportes en `results/`.

## Estructura

- `package.json` - scripts y dependencias
- `.gitignore` - archivos excluidos
- `.env.example` - plantilla de variables de entorno
- `src/config.js` - carga configuración desde `.env`
- `src/login.js` - login con Playwright y guardado de sesión
- `src/session.js` - gestión de `storageState.json`
- `src/stockClient.js` - cliente Axios para `/api/stocks`
- `src/productImage.js` - búsqueda y extracción de imagen de producto
- `src/index.js` - script principal de consulta de stock + imagen
- `src/imageProbe.js` - módulo de extracción y prueba de imágenes
- `src/probeImages.js` - script de prueba técnica de imágenes
- `results/` - reportes JSON y CSV de pruebas de imágenes

## Instalación

```powershell
npm install
```

## Configuración

1. Copia el archivo de ejemplo:

```powershell
copy .env.example .env
```

2. Completa las variables en `.env`:

- `ARCORE_BASE_URL`
- `ARCORE_USER`
- `ARCORE_PASSWORD`
- `TEST_CODIGO`
- `TEST_MARCA_ID`
- `TEST_SUPERMEDIDA`

## Uso

1. Inicia sesión y guarda la sesión autenticada:

```powershell
npm run login
```

2. Consulta el stock autenticado e imagen del producto:

```powershell
npm run test:stock
```

- Consulta el endpoint `/api/stocks` con los parámetros de `.env`.
- Busca visualmente el producto en la página de artículos.
- Extrae la imagen principal del producto detectado.
- Filtra logos, iconos e imágenes decorativas automáticamente.
- Muestra en consola:
  - Código, marcaId, descripción, color del stock
  - URL de la imagen, dimensiones, fuente de detección
  - Observaciones sobre la extracción

3. Prueba la accesibilidad de imágenes:

```powershell
npm run test:images
```

- Detecta automáticamente las cards/contenedores de productos.
- Para cada producto extrae: código, nombre, imagen principal.
- Dentro de cada card busca la imagen más grande y relevante.
- Filtra automáticamente logos, iconos, imágenes muy pequeñas y assets del sitio.
- Prueba cada imagen con y sin autenticación.
- Verifica si la imagen requiere sesión autenticada.
- Guarda resultados en `results/image-probe-<timestamp>.json` y `results/image-probe-<timestamp>.csv`.

4. Alias para correr la consulta de stock:

```powershell
npm start
```

## Notas

- El navegador se abre en modo visible durante el login para facilitar debugging.
- Si los selectores de login no son correctos, actualiza las constantes en `src/login.js`.
- Si la respuesta del endpoint no coincide con el esquema esperado, el script imprimirá la respuesta completa.
- La consulta de stock busca la imagen del producto dentro de su contexto visual (no busca globalmente en la página).
- Si no se encuentra una imagen confiable, la salida lo indica explícitamente.
- Los reportes de imágenes se guardan con timestamp para mantener histórico.
- Si una imagen requiere autenticación, aparecerá marcada en el CSV con `requires_session_auth = yes`.
