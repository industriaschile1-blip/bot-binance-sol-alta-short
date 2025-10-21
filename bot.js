// --- 🎛️ CONFIGURACIÓN DE LA ESTRATEGIA AVANZADA ---
// Modifica estos valores para ajustar el bot a tu necesidad
const CONFIG = {
  // --- Parámetros Principales ---
  symbol: 'SOLUSDT',              // Token a operar (ej: 'BTCUSDT', 'ETHUSDT')
  triggerPrice: 100.0,            // Precio LÍMITE para la primera compra (ACTIVADOR)
  // --- Niveles de DCA (Acumulación en Caída) ---
  numLevels: 4,                   // Número de compras totales (1 a 4). Poner 1 solo activa el TP individual.
  baseAmount: 20,                 // Cantidad en USDT a invertir en CADA compra
  dropPercentage: 1.0,            // % de caída entre cada nivel de compra (ej: 1.0 para 1%)
  // --- Take Profit (Venta en Rebote) ---
  takeProfitPercentage: 0.8,      // % de ganancia para CADA compra individual (ej: 0.8 para 0.8%)
  // --- Trailing Stop (Stop Loss Móvil Global) ---
  trailingStopPercentage: 2.0,    // % de seguimiento para el Trailing Stop (ej: 2.0 para 2%)
                                  // SE ACTIVA SOLO DESPUÉS DE LA PRIMERA VENTA EXITOSA.
};
// --- 🔧 NO TOCAR NADA A PARTIR DE AQUÍ ---
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Variables de entorno seguras desde GitHub
const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const API_ENDPOINT = process.env.BINANCE_ENDPOINT || 'https://api.binance.us'; // Elige .com o .us
// --- 📚 FUNCIONES AUXILIARES ---
function log(message) { console.log(`[${new Date().toISOString()}] ${message}`); }
function getSignature(queryString) {
  return crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
}
async function makeRequest(url, params = {}, method = 'GET') {
  const timestamp = Date.now();
  params.timestamp = timestamp;
  const queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
  const signature = getSignature(queryString);
  const fullUrl = method === 'GET' ? `${url}?${queryString}&signature=${signature}` : `${url}?${queryString}`;
  try {
    const response = await axios({ method, url: method === 'GET' ? fullUrl : url, headers: { 'X-MBX-APIKEY': API_KEY }, data: method === 'POST' ? new URLSearchParams({ ...params, signature }).toString() : undefined });
    return response.data;
  } catch (error) {
    log(`❌ ERROR en API: ${error.response?.data?.msg || error.message}`);
    throw error;
  }
}
async function getCurrentPrice() {
  const data = await makeRequest(`${API_ENDPOINT}/api/v3/ticker/price`, { symbol: CONFIG.symbol });
  return parseFloat(data.price);
}
async function getOpenOrders() { return await makeRequest(`${API_ENDPOINT}/api/v3/openOrders`, { symbol: CONFIG.symbol }); }
async function cancelAllOrders() { return await makeRequest(`${API_ENDPOINT}/api/v3/openOrders`, { symbol: CONFIG.symbol }, 'DELETE'); }
async function placeOrder(symbol, side, type, quantity, price = null) {
  const params = { symbol, side, type, quantity: quantity.toFixed(8), timeInForce: 'GTC' };
  if (price && type === 'LIMIT') params.price = price.toFixed(8);
  log(`📈 Colocando orden ${side} ${type}: ${quantity.toFixed(4)} a ${price ? '$' + price.toFixed(2) : 'precio de mercado'}`);
  return await makeRequest(`${API_ENDPOINT}/api/v3/order`, params, 'POST');
}
// --- 💾 GESTIÓN DE ESTADO ---
const STATE_FILE = path.join(__dirname, 'state.json');
function loadState() { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { status: 'IDLE' }; }
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
// --- 🤖 LÓGICA PRINCIPAL DEL BOT ---
async function runBot() {
  log('🚀 Iniciando ejecución del Bot de Trading Avanzado...');
  if (!API_KEY || !SECRET_KEY) throw new Error("❌ FALTAN LAS CLAVES DE API. Añádelas como 'Secrets' en GitHub.");
  if (CONFIG.numLevels < 1 || CONFIG.numLevels > 4) throw new Error("❌ 'numLevels' debe estar entre 1 y 4.");
  let state = loadState();
  log(`📊 Estado actual: ${state.status}`);
  const currentPrice = await getCurrentPrice();
  log(`💰 Precio actual de ${CONFIG.symbol}: $${currentPrice}`);
  // --- Máquina de Estados ---
  if (state.status === 'IDLE' || state.status === 'STOPPED') {
    log('🎯 Bot inactivo. Esperando activación...');
    if (currentPrice <= CONFIG.triggerPrice) {
      log(`✅ Precio de activación alcanzado ($${CONFIG.triggerPrice}). Iniciando secuencia de compra.`);
      state.status = 'ACTIVE';
      state.levels = [];
      state.trailingStop = { active: false, peakPrice: 0 };
      state.totalQuantityBought = 0;
      for (let i = 0; i < CONFIG.numLevels; i++) {
        const buyPrice = CONFIG.triggerPrice * Math.pow(1 - CONFIG.dropPercentage / 100, i);
        const quantity = CONFIG.baseAmount / buyPrice;
        state.levels.push({ level: i + 1, buyPrice, quantity, buyOrderId: null, sellOrderId: null, isComplete: false });
      }
      saveState(state);
      log(`✅ ${CONFIG.numLevels} niveles de compra definidos.`);
    }
  }
  if (state.status === 'ACTIVE') {
    // 1. Colocar órdenes si no existen
    for (const level of state.levels) {
      if (!level.buyOrderId) {
        const order = await placeOrder(CONFIG.symbol, 'BUY', 'LIMIT', level.quantity, level.buyPrice);
        level.buyOrderId = order.orderId;
        saveState(state);
      }
    }
    const openOrders = await getOpenOrders();
    const openOrderIds = new Set(openOrders.map(o => o.orderId.toString()));
    // 2. Comprobar compras ejecutadas y colocar TPs
    for (const level of state.levels) {
      if (level.buyOrderId && !openOrderIds.has(level.buyOrderId) && !level.sellOrderId) {
        log(`🎉 Compra Nivel ${level.level} ejecutada a $${level.buyPrice.toFixed(2)}.`);
        state.totalQuantityBought += level.quantity;
        const sellPrice = level.buyPrice * (1 + CONFIG.takeProfitPercentage / 100);
        const sellOrder = await placeOrder(CONFIG.symbol, 'SELL', 'LIMIT', level.quantity, sellPrice);
        level.sellOrderId = sellOrder.orderId;
        saveState(state);
      }
    }
    // 3. Comprobar ventas ejecutadas
    let firstSaleCompleted = false;
    for (const level of state.levels) {
      if (level.sellOrderId && !openOrderIds.has(level.sellOrderId) && !level.isComplete) {
        log(`💰 Venta Nivel ${level.level} completada con ganancia.`);
        level.isComplete = true;
        state.totalQuantityBought -= level.quantity;
        firstSaleCompleted = true;
        saveState(state);
      }
    }
    // 4. Activar Trailing Stop si es la primera venta
    if (firstSaleCompleted && !state.trailingStop.active) {
      log('🚀 ¡PRIMERA VENTA EXITOSA! Activando Trailing Stop global.');
      state.trailingStop.active = true;
      state.trailingStop.peakPrice = currentPrice;
      saveState(state);
    }
    // 5. Gestionar Trailing Stop Activo
    if (state.trailingStop.active) {
      if (currentPrice > state.trailingStop.peakPrice) {
        state.trailingStop.peakPrice = currentPrice;
        log(`📈 Nuevo pico del Trailing Stop: $${state.trailingStop.peakPrice.toFixed(2)}`);
        saveState(state);
      }
      const stopLossPrice = state.trailingStop.peakPrice * (1 - CONFIG.trailingStopPercentage / 100);
      if (currentPrice <= stopLossPrice) {
        log(`🛑 TRAILING STOP ACTIVADO! Vendiendo posición restante de ${state.totalQuantityBought.toFixed(4)} tokens.`);
        if (state.totalQuantityBought > 0) {
            await cancelAllOrders(); // Cancelar TPs restantes
            await placeOrder(CONFIG.symbol, 'SELL', 'MARKET', state.totalQuantityBought);
        }
        state.status = 'STOPPED';
        saveState(state);
        log('🏁 Bot detenido. Ciclo completado.');
        return "Ciclo completado por Trailing Stop.";
      }
    }
  }
  saveState(state);
  log('✅ Ciclo del bot finalizado. Estado guardado.');
  return "Ejecución completada.";
}
runBot().catch(err => { log(`💥 FATAL: ${err.message}`); process.exit(1); });
