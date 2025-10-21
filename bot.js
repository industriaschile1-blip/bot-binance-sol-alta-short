// Importar las librerías necesarias
const crypto = require('crypto');
const axios = require('axios');

// --- CONFIGURACIÓN DINÁMICA (Leída desde Variables de GitHub) ---
// El bot leerá estos valores desde los "Secrets and Variables" de GitHub.
const SYMBOL = process.env.SYMBOL || 'SOLUSDT';             // El par a operar (ej. SOLUSDT, BTCUSDT)
const timeframeMinutes = parseInt(process.env.TIMEFRAME_MINUTES) || 5; // El intervalo en minutos (ej. 5, 15)
const TIMEFRAME = `${timeframeMinutes}m`;                  // Formato para Binance (ej. '5m')

const TAKE_PROFIT_PERCENT = parseFloat(process.env.TAKE_PROFIT_PERCENT) || 0.5; // Meta de ganancia (0.5 = 0.5%)
const STOP_LOSS_PERCENT = parseFloat(process.env.STOP_LOSS_PERCENT) || 0.2;     // Límite de pérdida (0.2 = 0.2%)
const QUANTITY_USDT = parseFloat(process.env.QUANTITY_USDT) || 10;         // Cantidad de dinero a usar
// --- FIN DE LA CONFIGURACIÓN ---

// Claves de API (leídas de forma segura desde los Secrets de GitHub)
const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const BASE_URL = process.env.BINANCE_ENDPOINT;

// --- LÓGICA DEL BOT (No necesitas cambiar esto) ---

// Función para crear la firma de la petición
function createSignature(queryString) {
    return crypto
        .createHmac('sha256', SECRET_KEY)
        .update(queryString)
        .digest('hex');
}

// Función para hacer peticiones a la API de Binance
async function binanceRequest(endpoint, params = {}) {
    if (!API_KEY || !SECRET_KEY || !BASE_URL) {
        throw new Error("Faltan las claves de API o el endpoint. Revisa los Secrets de GitHub.");
    }

    params.timestamp = Date.now();
    const queryString = new URLSearchParams(params).toString();
    params.signature = createSignature(queryString);

    try {
        const response = await axios.get(`${BASE_URL}${endpoint}?${queryString}`, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        return response.data;
    } catch (error) {
        console.error("Error en la petición a Binance:", error.response ? error.response.data : error.message);
        throw error;
    }
}

// Función para verificar la conexión y los permisos de la API
async function checkApiPermissions() {
    console.log("Verificando conexión y permisos de la API...");
    try {
        const accountInfo = await binanceRequest('/fapi/v2/account');
        const canTrade = accountInfo.canTrade;
        if (!canTrade) {
            throw new Error("La API Key no tiene permisos para operar (canTrade: false). Actívalos en la configuración de Binance.");
        }
        console.log("✅ API Key verificada y con permisos para operar.");
        return accountInfo;
    } catch (error) {
        console.error("❌ Error crítico al verificar la API Key. Deteniendo el bot.");
        console.error("Posibles causas:");
        console.error("1. API Key o Secret Key incorrectas.");
        console.error("2. La API Key no tiene permisos para 'Futures Trading'.");
        console.error("3. Restricciones de IP en la API Key.");
        throw error;
    }
}

// Función para obtener el precio actual
async function getCurrentPrice() {
    try {
        const ticker = await binanceRequest('/fapi/v1/ticker/price', { symbol: SYMBOL });
        return parseFloat(ticker.price);
    } catch (error) {
        console.error(`Error al obtener el precio actual de ${SYMBOL}:`, error.message);
        throw error;
    }
}

// Función para obtener el balance de USDT disponible
async function getUsdtBalance() {
    try {
        const account = await binanceRequest('/fapi/v2/account');
        const asset = account.assets.find(a => a.asset === 'USDT');
        return asset ? parseFloat(asset.availableBalance) : 0;
    } catch (error) {
        console.error("Error al obtener el balance de USDT:", error.message);
        throw error;
    }
}

// Función para calcular la cantidad a comprar
function calculateQuantity(price) {
    return QUANTITY_USDT / price;
}

// Función para colocar una orden
async function placeOrder(symbol, side, type, quantity, price = null, timeInForce = 'GTC', stopPrice = null) {
    const orderParams = { symbol, side, type, quantity, timeInForce };
    if (type === 'LIMIT' && price !== null) orderParams.price = price.toFixed(4);
    if (type === 'STOP_MARKET' && stopPrice !== null) orderParams.stopPrice = stopPrice.toFixed(4);
    
    // Reducir la precisión de la cantidad para evitar errores
    const assetInfo = await binanceRequest('/fapi/v1/exchangeInfo', { symbol: symbol });
    const symbolInfo = assetInfo.symbols[0];
    const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    const tickSize = parseFloat(lotSizeFilter.stepSize);
    const precision = Math.floor(Math.log10(1 / tickSize));
    orderParams.quantity = parseFloat(quantity.toFixed(precision));

    try {
        const order = await binanceRequest('/fapi/v1/order', orderParams);
        console.log(`✅ Orden ${side} colocada exitosamente:`, order);
        return order;
    } catch (error) {
        console.error(`❌ Error al colocar orden ${side}:`, error.response ? error.response.data : error.message);
        throw error;
    }
}

// --- LÓGICA DE ESTRATEGIA ---

// Estrategia: Compra y venta inmediata con Take Profit y Stop Loss
async function runBuyAndSellStrategy() {
    console.log(`\n--- Iniciando ciclo de trading para ${SYMBOL} ---`);
    try {
        const currentPrice = await getCurrentPrice();
        console.log(`Precio actual de ${SYMBOL}: ${currentPrice}`);

        const quantityToBuy = calculateQuantity(currentPrice);
        console.log(`Se intentará comprar ${quantityToBuy.toFixed(4)} ${SYMBOL} por un valor de ${QUANTITY_USDT} USDT.`);

        // 1. Colocar orden de mercado de compra
        const buyOrder = await placeOrder(SYMBOL, 'BUY', 'MARKET', quantityToBuy);
        const avgBuyPrice = parseFloat(buyOrder.avgPrice);
        console.log(`📈 Compra ejecutada a precio promedio: ${avgBuyPrice}`);

        // 2. Calcular precios de Take Profit y Stop Loss
        const takeProfitPrice = avgBuyPrice * (1 + TAKE_PROFIT_PERCENT / 100);
        const stopLossPrice = avgBuyPrice * (1 - STOP_LOSS_PERCENT / 100);

        console.log(`🎯 Precio de Take Profit establecido en: ${takeProfitPrice.toFixed(4)} (+${TAKE_PROFIT_PERCENT}%)`);
        console.log(`🛡️ Precio de Stop Loss establecido en: ${stopLossPrice.toFixed(4)} (-${STOP_LOSS_PERCENT}%)`);

        // 3. Colocar orden de venta con Take Profit (LIMIT)
        await placeOrder(SYMBOL, 'SELL', 'LIMIT', quantityToBuy, takeProfitPrice);

        // 4. Colocar orden de venta con Stop Loss (STOP_MARKET)
        await placeOrder(SYMBOL, 'SELL', 'STOP_MARKET', quantityToBuy, null, 'GTC', stopLossPrice);
        
        console.log("--- Operación completada. Órdenes de TP y SL colocadas. ---");

    } catch (error) {
        console.error("--- Ocurrió un error en el ciclo de trading. ---");
        console.error(error.message);
        // Aquí podrías añadir lógica para notificar el error.
    }
}

// --- FUNCIÓN PRINCIPAL ---
async function main() {
    try {
        await checkApiPermissions();
        const usdtBalance = await getUsdtBalance();
        console.log(`Balance disponible de USDT: ${usdtBalance.toFixed(2)}`);

        if (usdtBalance < QUANTITY_USDT) {
            console.warn(`⚠️ Advertencia: El balance de USDT (${usdtBalance.toFixed(2)}) es menor que la cantidad a operar (${QUANTITY_USDT}). No se realizará la operación.`);
            return;
        }

        await runBuyAndSellStrategy();

    } catch (error) {
        console.error("El bot no pudo completar su ejecución debido a un error crítico.");
    }
}

main();
Haz clic en el botón verde Commit changes... para guardar el archivo.
Paso 2: Actualizar el Programador (main.yml)
Ve a la carpeta .github/workflows/.
Haz clic en el archivo main.yml y luego en el ícono del lápiz ✏️ (Edit this file).
BORRA TODO EL CONTENIDO y REEMPLÁZALO por este código completo:
name: Bot de Trading Avanzado

# Se ejecuta automáticamente cada 5 minutos y también permite ejecución manual
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

jobs:
  run-trading-bot:
    runs-on: ubuntu-latest
    
    # Variables de configuración del bot (leyendo desde 'Variables' del repositorio)
    env:
      SYMBOL: ${{ vars.SYMBOL }}
      TIMEFRAME_MINUTES: ${{ vars.TIMEFRAME_MINUTES }}
      TAKE_PROFIT_PERCENT: ${{ vars.TAKE_PROFIT_PERCENT }}
      STOP_LOSS_PERCENT: ${{ vars.STOP_LOSS_PERCENT }}
      QUANTITY_USDT: ${{ vars.QUANTITY_USDT }}

    steps:
      # 1. Descargar el código del repositorio
      - name: Clonar el repositorio
        uses: actions/checkout@v3

      # 2. Instalar Node.js
      - name: Configurar Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      # 3. Instalar las dependencias (axios)
      - name: Instalar dependencias
        run: npm install

      # 4. Ejecutar el script del bot, pasándole los secretos de forma segura
      - name: Ejecutar Bot de Trading
        run: node bot.js
        env:
          # Los secretos se pasan solo en este paso, por seguridad
          BINANCE_API_KEY: ${{ secrets.BINANCE_API_KEY }}
          BINANCE_SECRET_KEY: ${{ secrets.BINANCE_SECRET_KEY }}
          BINANCE_ENDPOINT: ${{ secrets.BINANCE_ENDPOINT }}
