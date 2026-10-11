# 🌐 Valle Verde Online — Cómo ponerlo en Render

Este paquete contiene tu juego con **multijugador**: un servidor Node.js (Express + WebSocket) que además sirve el juego.
Tus amigos solo abren la dirección que te da Render y juegan juntos.

## ¿Qué trae?

- **Jugar → Crear mundo → 🌐 Ver servidores creados**: lista de servidores con *oleada*, *día*, jugadores conectados y quién está dentro.
  Ordena por **🏆 Más avanzados**, **📅 Más días** o **👥 Más jugadores**, y tiene buscador.
- **Crear servidor** (nombre, semilla, dificultad) o botón **🌐 Online** en cualquiera de tus mundos locales para publicarlo.
- **Jugadores sincronizados**: se ven caminar, su ropa/apariencia, su apodo y salen en el minimapa (punto celeste).
- **Zombis sincronizados**: cada zombi lo controla el jugador más cercano y todos lo ven; si le disparas a un zombi de otro, el daño cuenta. Las oleadas empiezan a la vez para todos.
- **Modelo 3D compartido**: si importas tu `.glb/.gltf/.obj` en *Apariencia*, al entrar a un servidor se sube y **todos los demás lo ven** sobre tu personaje.
- **Chat**: tecla **T** o **Enter** (botón 💬 en celular). Avisos de entrada/salida, muertes y oleadas.
- Botín (cofres) y barricadas compartidos. Tu inventario es tuyo y se guarda en tu navegador por servidor.
- En línea el juego **no se pausa** (ni con inventario ni con pausa) y no hay "modo Extremo" de una sola vida: si mueres, reapareces.

## 1. Probarlo en tu PC (opcional)

```bash
npm install
npm start
# abre http://localhost:3000  (en otra pestaña/ventana puedes entrar como segundo jugador)
```

## 2. Subirlo a GitHub

1. Crea una cuenta en https://github.com y un repositorio nuevo (por ejemplo `valle-verde-online`).
2. Sube **todo el contenido de esta carpeta** (`server.js`, `package.json`, carpeta `public/`, etc.).
   - Fácil: en la página del repositorio → **Add file → Upload files** → arrastra los archivos → **Commit**.
   - No subas `node_modules` (ya está en `.gitignore`).

## 3. Crear el servicio en Render

1. Entra a https://render.com y crea cuenta (puedes usar tu GitHub).
2. **New + → Web Service** → conecta tu repositorio.
3. Rellena:
   | Campo | Valor |
   |---|---|
   | Language / Runtime | **Node** |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** (para probar) |
4. (Opcional) En **Advanced** pon *Health Check Path* = `/health`.
5. Pulsa **Create Web Service** y espera a que diga **Live**.
6. Render te da una dirección tipo `https://valle-verde-online.onrender.com`. **Esa es la dirección que compartes.**

> También puedes usar el archivo `render.yaml` incluido: *New + → Blueprint* y elige el repositorio.

## 4. Jugar

1. Abre tu dirección de Render → **▶ Jugar → 🌐 Ver servidores creados**.
2. Pon tu **apodo**, crea un servidor (o únete a uno) y pásale la dirección a tus amigos.
3. Para usar tu modelo 3D: *Menú → 🎨 Apariencia → Importar modelo → Usar modelo*, y luego entra al servidor. Verás en el chat "Tu modelo 3D ya lo ven todos".

## Variables de entorno (Render → Environment)

| Variable | Por defecto | Qué hace |
|---|---|---|
| `MAX_PLAYERS` | 8 | Jugadores por servidor |
| `MAX_SERVERS` | 300 | Servidores en total |
| `MAX_MODEL_MB` | 20 | Peso máximo del modelo 3D compartido por jugador |
| `MAX_TOTAL_MODEL_MB` | 200 | Memoria total para modelos (el plan gratis tiene 512 MB de RAM) |
| `PRUNE_DAYS` | 30 | Borra servidores vacíos sin actividad tras N días |
| `CREATE_PER_HOUR` | 8 | Servidores que puede crear una misma IP por hora |
| `DATA_DIR` | `./data` | Dónde se guarda la lista de servidores |

## ⚠️ Limitaciones del plan gratis de Render (importante)

- **Se duerme tras 15 minutos sin tráfico** y tarda cerca de **1 minuto** en despertar. Mientras haya jugadores conectados no se duerme.
- **El disco es temporal**: cuando el servicio se reinicia, redespliega o se duerme, **la lista de servidores se borra**.
  - El juego lo compensa: tu navegador guarda tu progreso y datos de cada servidor. En la lista aparecerá **"Tus servidores guardados"** con el botón **↻ Restaurar y entrar**, que recrea el servidor con la misma semilla, oleada y antigüedad (días).
  - Para que la lista sea **permanente**: pasa a un plan de pago y añade un **Persistent Disk** montado en `/data`, y define `DATA_DIR=/data`.
- 750 horas gratis al mes por cuenta (suficiente para un servicio 24/7 durante un mes).
- Render puede reiniciar servicios gratis en cualquier momento: el juego reintenta reconectar solo.

## Consejos y solución de problemas

- **"No se pudo contactar con el servidor"**: espera ~1 minuto (despertando) y pulsa ↻.
- **Abriste el `index.html` como archivo**: el modo online solo funciona desde la dirección `https://…onrender.com` (o `localhost:3000`).
- **Mi modelo no se ve para otros**: pesa más que `MAX_MODEL_MB` (el chat te avisa). Usa un `.glb` ligero (idealmente < 10 MB). Hasta 5 modelos remotos se cargan a la vez por jugador que mira.
- **Lag con muchos jugadores**: baja `MAX_PLAYERS` a 4–6 en el plan gratis (0,1 CPU).
- Si quieres que **no se duerma** sin pagar, puedes usar un monitor externo (p. ej. UptimeRobot) que visite `https://tu-app.onrender.com/health` cada 5 minutos.

## Cómo funciona (resumen técnico)

- `server.js`: HTTP (lista/creación de servidores, subida/descarga de modelos) + WebSocket `/ws` que reenvía mensajes por sala.
- `public/index.html`: el juego. El terreno, casas y cofres salen de la **misma semilla** en todos los clientes, así que no se envían.
- Los zombis los simula el cliente **más cercano** y se traspasan automáticamente al acercarse otro jugador; si alguien se desconecta o minimiza la pestaña, sus zombis pasan a otro.
