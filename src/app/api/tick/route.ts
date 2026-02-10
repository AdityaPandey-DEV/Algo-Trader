import { NextResponse } from 'next/server';
import { getState, updateState, addLog, updateEquity } from '@/lib/state';
import { loadTradingState } from '@/lib/storage';
import { fetchUpstoxQuotes, getUpstoxLoginUrl } from '@/lib/upstoxApi';
import { getPriorData, updatePriorData, calculateLevels } from '@/lib/marketUtils';
import { fetchYahooQuotes, transformYahooToOHLCV } from '@/lib/yahooFinance';
import { calculatePlannedTrade, generateSignal } from '@/lib/strategy';
import { CONFIG } from '@/lib/config';
import { isMarketOpen, getMarketInfo } from '@/lib/marketHours';
import { isDhanConfigured, placeOrder, shouldAutoSquareOff, squareOffAll } from '@/lib/dhanApi';
import {
    getTSDEngineState,
    updateTSDCount,
    getRegimePermissions,
    getRegimeDisplayInfo,
    processDailyMetrics
} from '@/lib/regimeEngine';
import { calculateSessionMetrics, OHLCV } from '@/lib/indicators';
import { getStateMachine } from '@/lib/stateMachine';
import { validateTradeSignal, calculateSafePositionSize } from '@/lib/riskGate';
import {
    saveHistoricalData,
    loadHistoricalData,
    saveRegimeState,
    loadRegimeState,
    saveTradingState,
    incrementTickCount,
    checkDailyReset,
    performDailyReset
} from '@/lib/storage';
import { exportState as exportRegimeState, importState as importRegimeState } from '@/lib/regimeEngine';
import { isAIConfigured, getCachedAnalysis, resolveConflict } from '@/lib/aiEngine';

// Professional Risk Engine (Upgrades #1, #6, #8)
import {
    initRiskEngine,
    canTrade as checkRiskLimits,
    recordTrade as recordTradeRisk,
    getRiskSummary,
    calculatePositionSize as calcRiskPositionSize,
    RISK_CONFIG
} from '@/lib/riskEngine';

// Trade Quality Filters (Upgrades #2, #3, #7)
import { runPreTradeChecks } from '@/lib/tradeFilters';

// Smart Trailing Stop (Upgrade #5)
import {
    initTrailingPosition,
    updateTrailingStop,
    getActiveTrailingPositions,
    closeTrailingPosition
} from '@/lib/trailingStop';

// Historical data cache for indicator calculations
const historicalData: Record<string, OHLCV[]> = {};
const MAX_HISTORY = 250; // Keep 250 candles for EMA(200)

export async function POST() {
    // 0. Load persisted state first (CRITICAL for Vercel/Serverless)
    const persistedState = await loadTradingState();
    if (persistedState) {
        updateState(persistedState);
    }

    const state = getState();
    const stateMachine = getStateMachine();

    // Don't run if kill switch is active
    if (state.kill_switch) {
        stateMachine.activateKillSwitch('Manual kill switch');
        return NextResponse.json({ status: 'halted', message: 'Kill switch active' });
    }

    // Check if state machine allows trading
    const canTrade = stateMachine.canOpenPosition();
    if (!canTrade.allowed && stateMachine.getState() === 'HALTED_FOR_DAY') {
        return NextResponse.json({ status: 'halted', message: canTrade.reason });
    }

    try {
        // Daily reset check
        if (await checkDailyReset()) {
            await performDailyReset();
            addLog('📅 New trading day - state reset');
        }

        // Load persisted historical data if cache is empty
        if (Object.keys(historicalData).length === 0) {
            const savedHistory = await loadHistoricalData();
            if (savedHistory) {
                Object.assign(historicalData, savedHistory);
                addLog('📂 Loaded historical data from storage');
            }
        }

        // Load persisted regime state
        const savedRegime = await loadRegimeState();
        if (savedRegime) {
            importRegimeState(savedRegime);
        }

        // Increment tick count
        await incrementTickCount();

        const marketInfo = getMarketInfo();
        const marketOpen = isMarketOpen();
        const dhanConfigured = isDhanConfigured();
        const tsdState = getTSDEngineState();

        // Initialize risk engine with current equity (Upgrades #1, #6)
        initRiskEngine(state.initial_capital + state.pnl);

        // Check if risk engine allows trading
        const riskCheck = checkRiskLimits();
        if (!riskCheck.allowed) {
            addLog(`🛑 RISK: ${riskCheck.reason}`);
            return NextResponse.json({
                status: 'risk_blocked',
                message: riskCheck.reason,
                risk_summary: getRiskSummary()
            });
        }

        // Auto square-off check (3:15 PM for intraday)
        if (marketOpen && shouldAutoSquareOff()) {
            const openPositions = stateMachine.getOpenPositions();
            if (openPositions.length > 0) {
                addLog('⏰ AUTO SQUARE-OFF TIME REACHED');
                const result = await squareOffAll('Market close approaching', state.broker_mode === 'PAPER');
                addLog(`📊 Squared off ${result.closedCount} positions`);

                // Close positions in state machine
                for (const pos of openPositions) {
                    const priceMap: Record<string, number> = {};
                    priceMap[pos.symbol] = pos.current;
                    stateMachine.updatePositionPrices(priceMap);
                }
            }
        }

        // 1. Fetch market data (real or mock)
        let marketData: Record<string, any>;
        let dataSource: string;

        // PRIORITY 1: Always use Upstox for market data when configured (any broker mode)
        if (process.env.UPSTOX_API_KEY) {
            try {
                const upstoxData = await fetchUpstoxQuotes(CONFIG.WATCHLIST);
                if (Object.keys(upstoxData).length > 0) {
                    marketData = upstoxData;
                    dataSource = marketOpen ? 'UPSTOX_LIVE' : 'UPSTOX_LTP (MARKET CLOSED)';
                } else {
                    // Upstox returned empty - fallback to Yahoo
                    const yahooData = await fetchYahooQuotes(CONFIG.WATCHLIST);
                    if (Object.keys(yahooData).length > 0) {
                        marketData = transformYahooToOHLCV(yahooData);
                        dataSource = 'YAHOO_FINANCE';
                        addLog('⚠️ Upstox returned empty, using Yahoo Finance');
                    } else {
                        marketData = {};
                        dataSource = 'NO_DATA';
                    }
                }
            } catch (e) {
                console.error("Upstox fetch error", e);
                const yahooData = await fetchYahooQuotes(CONFIG.WATCHLIST);
                if (Object.keys(yahooData).length > 0) {
                    marketData = transformYahooToOHLCV(yahooData);
                    dataSource = 'YAHOO_FINANCE';
                } else {
                    marketData = {};
                    dataSource = 'NO_DATA';
                }
            }
        } else {
            // No Upstox configured or it failed: Try Yahoo Finance as strictly the fallback
            // We explicitly DO NOT use Dhan for data to avoid costs/API limits as requested
            try {
                const yahooData = await fetchYahooQuotes(CONFIG.WATCHLIST);

                // transformYahooToOHLCV might return empty if yahooData is empty, so check keys
                if (Object.keys(yahooData).length > 0) {
                    marketData = transformYahooToOHLCV(yahooData);
                    dataSource = 'YAHOO_FINANCE';
                } else {
                    marketData = {};
                    dataSource = 'NO_DATA';
                    addLog('⚠️ CRITICAL: Yahoo Finance returned no data');
                }
            } catch (e) {
                console.error("Yahoo Finance fetch error", e);
                marketData = {};
                dataSource = 'NO_DATA';
                addLog('⚠️ CRITICAL: Yahoo Finance failed - Trading disabled');
            }
        }

        // 1.5 PROCESS PENDING ORDERS (BROKER: PAPER)
        if (state.broker_mode === 'PAPER' && state.pending_orders?.length > 0) {
            const pending = state.pending_orders;
            const remaining: typeof pending = [];
            const executedIds: string[] = [];

            for (const order of pending) {
                try {
                    // LATENCY CHECK: Assume 2s minimum delay
                    const LATENCY_THRESHOLD = 2000;

                    if (Date.now() - order.createdAt < LATENCY_THRESHOLD) {
                        remaining.push(order); // Keep waiting
                        continue;
                    }

                    // DATA CHECK
                    const quote = marketData[order.symbol];
                    if (!quote) {
                        remaining.push(order);
                        continue;
                    }

                    // SLIPPAGE SIMULATION (0.00% to 0.05%)
                    const currentPrice = quote.close || quote.lastPrice || order.signalPrice;
                    const slippageBps = Math.random() * 5; // 0-5 basis points
                    const slippageAmt = currentPrice * (slippageBps / 10000);

                    const fillPrice = order.side === 'LONG'
                        ? currentPrice + slippageAmt
                        : currentPrice - slippageAmt;

                    // EXECUTE
                    const position = stateMachine.openPosition({
                        symbol: order.symbol,
                        side: order.side,
                        entry: Number(fillPrice.toFixed(2)),
                        current: Number(currentPrice.toFixed(2)),
                        qty: order.qty,
                        pnl: 0,
                        stopLoss: order.stop,
                        target: order.target,
                        regime: order.regime
                    });

                    if (position) {
                        const deviation = Math.abs(fillPrice - order.signalPrice).toFixed(2);
                        addLog(`✅ FILLED ${order.symbol} @ ₹${fillPrice.toFixed(2)} (Slip: ₹${deviation})`);
                        executedIds.push(order.id);
                    } else {
                        const reason = stateMachine.canOpenPosition().reason;
                        addLog(`❌ EXPIRED ${order.symbol}: ${reason}`);
                    }
                } catch (err) {
                    console.error(`Pending order failed for ${order.symbol}`, err);
                    addLog(`❌ ORDER ERROR ${order.symbol}: ${err}`);
                    // Don't discard, maybe try again? Or discard to prevent block?
                    // For safety, let's discard so we don't loop forever on a bad order
                }
            }

            // Update state if we processed any
            if (executedIds.length > 0) {
                updateState({ pending_orders: remaining });
            }
        } // End of PAPER check

        // 2. Update historical data for indicators
        for (const symbol of CONFIG.WATCHLIST) {
            const data = marketData[symbol];
            if (!data) continue;

            if (!historicalData[symbol]) {
                historicalData[symbol] = [];
            }

            // Add new candle to history
            const candle: OHLCV = {
                symbol,
                open: data.open,
                high: data.high,
                low: data.low,
                close: data.close || data.lastPrice,
                volume: data.volume,
                timestamp: new Date()
            };

            historicalData[symbol].push(candle);

            // Keep only MAX_HISTORY candles
            if (historicalData[symbol].length > MAX_HISTORY) {
                historicalData[symbol] = historicalData[symbol].slice(-MAX_HISTORY);
            }
        }

        // 3. Calculate session metrics (for regime detection)
        // Use aggregate of all symbols for overall market analysis
        const allCandles = Object.values(historicalData).flat();
        const sessionMetrics = calculateSessionMetrics(allCandles);

        // 4. Update regime based on TSD
        const regimeResult = processDailyMetrics(sessionMetrics);
        const regimePermissions = getRegimePermissions(regimeResult.newRegime);
        const regimeDisplay = getRegimeDisplayInfo(regimeResult.newRegime);

        // Update state with regime info
        updateState({
            regime: regimeResult.newRegime,
            tsd_count: regimeResult.newTSDCount
        });



        // 5. Calculate planned trades for each symbol
        const plannedTrades: any[] = [];
        const signals: any[] = [];

        for (const symbol of CONFIG.WATCHLIST) {
            try {
                const data = marketData[symbol];
                if (!data) continue;

                const priorData = getPriorData(symbol);
                const levels = calculateLevels(data, historicalData[symbol]);

                // Get potential entry levels for display
                const trades = calculatePlannedTrade(data, levels.support, levels.resistance);
                plannedTrades.push(...trades);

                // Check for actionable signals (only during market hours with real data)
                if (marketOpen && dataSource !== 'NO_DATA' && regimePermissions.allowMeanReversion) {
                    // Run pre-trade quality filters (Upgrades #2, #3, #7)
                    const symbolCandles = historicalData[symbol] || [];
                    const preTradeCheck = runPreTradeChecks(symbolCandles);

                    if (!preTradeCheck.canTrade) {
                        continue;
                    }

                    const signal = generateSignal(data, priorData, levels.support, levels.resistance, regimeResult.newRegime);
                    if (signal) {
                        // Quality score verified above (preTradeCheck.qualityScore)
                        signals.push(signal);
                    }
                }

                // Update trailing stops for active positions (Upgrade #5)
                const trailingResult = updateTrailingStop(symbol, historicalData[symbol] || []);
                if (trailingResult.stopped) {
                    addLog(`🎯 TRAIL EXIT ${symbol}: PnL ₹${trailingResult.pnl.toFixed(2)}`);
                    // Record trade in risk engine
                    const rMultiple = trailingResult.pnl / (state.initial_capital * RISK_CONFIG.MAX_RISK_PER_TRADE);
                    recordTradeRisk(trailingResult.pnl, rMultiple);
                }
            } catch (err) {
                console.error(`Signal generation failed for ${symbol}`, err);
                // Don't log to prevent spam, just skip this symbol for this tick
            }
        }

        // 6. Update positions prices and check exits (MOVED HERE)
        const priceMap: Record<string, number> = {};
        for (const symbol of CONFIG.WATCHLIST) {
            const data = marketData[symbol];
            if (data) {
                priceMap[symbol] = data.close || data.lastPrice;
            }
        }

        stateMachine.updatePositionPrices(priceMap);
        const closedPositions = stateMachine.checkExits(priceMap);

        if (closedPositions.length > 0) {
            for (const msg of closedPositions) {
                addLog(`📍 ${msg}`);
            }
        }

        // 7. Execute trades on signals (Queuing instead of Instant Fill for Paper)
        if (signals.length > 0 && marketOpen && regimePermissions.tradingFrequency !== 'HALTED') {
            const openPositions = stateMachine.getOpenPositions();

            // Limit to 2 signals processed per tick to avoid overwhelm
            for (const signal of signals.slice(0, 2)) {
                try {
                    // Risk Gate Check
                    const riskCheck = validateTradeSignal(
                        {
                            symbol: signal.symbol,
                            side: signal.side,
                            entry: signal.entry,
                            stop: signal.stop,
                            target: signal.target
                        },
                        state.initial_capital,
                        state.pnl,
                        regimeResult.newRegime,
                        openPositions
                    );

                    if (!riskCheck.passed) {
                        const failedChecks = riskCheck.checks.filter(c => !c.passed).map(c => c.name);
                        addLog(`⚠️ BLOCKED ${signal.symbol}: ${failedChecks.join(', ')}`);
                        continue;
                    }

                    // AI Confirmation Logic
                    let aiSizeMultiplier = 1.0;
                    if (isAIConfigured()) {
                        const symbolCandles = historicalData[signal.symbol] || [];
                        if (symbolCandles.length >= 10) {
                            const aiResult = await getCachedAnalysis(signal.symbol, symbolCandles);
                            const conflict = resolveConflict(signal.side, aiResult, regimeResult.newRegime);

                            if (conflict.resolution === 'SKIP') {
                                addLog(`🤖 AI SKIP: ${signal.symbol} - ${conflict.reason}`);
                                continue;
                            } else if (conflict.resolution === 'REDUCE_SIZE') {
                                aiSizeMultiplier = 0.5;
                            }
                        }
                    }

                    // Calculate Size
                    let qty = riskCheck.adjustedSize || calculateSafePositionSize(
                        signal,
                        state.initial_capital,
                        regimeResult.newRegime
                    );
                    qty = Math.floor(qty * aiSizeMultiplier);

                    if (qty <= 0) {
                        addLog(`⚠️ QTY 0 for ${signal.symbol} - Skipping`);
                        continue;
                    }

                    // BROKER EXECUTION ROUTING
                    switch (state.broker_mode) {
                        case 'PAPER':
                            // REALISTIC PAPER TRADING: QUEUE ORDER (Latency Simulation)
                            const newOrder = {
                                id: `ORD_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                                symbol: signal.symbol,
                                side: signal.side,
                                qty,
                                signalPrice: signal.entry,
                                target: signal.target,
                                stop: signal.stop,
                                regime: regimeResult.newRegime,
                                createdAt: Date.now()
                            };

                            const currentPending = state.pending_orders || [];
                            updateState({ pending_orders: [...currentPending, newOrder] });
                            addLog(`⏳ QUEUED PAPER ${signal.side} ${signal.symbol} @ ₹${signal.entry} (Simulating Latency...)`);
                            break;

                        case 'DHAN':
                            // LIVE trade: Execute through Dhan API
                            try {
                                const orderSide = signal.side === 'LONG' ? 'BUY' : 'SELL';
                                // market order for now
                                const order = await placeOrder(signal.symbol, orderSide, qty, 'MARKET', undefined, false);

                                if (order) {
                                    const position = stateMachine.openPosition({
                                        symbol: signal.symbol,
                                        side: signal.side,
                                        entry: signal.entry,
                                        current: signal.entry,
                                        qty,
                                        pnl: 0,
                                        stopLoss: signal.stop,
                                        target: signal.target,
                                        regime: regimeResult.newRegime
                                    });

                                    if (position) {
                                        addLog(`🔥 LIVE DHAN ${signal.side} ${signal.symbol} @ ₹${signal.entry} (Order: ${order.orderId})`);
                                    }
                                } else {
                                    addLog(`❌ DHAN API returned null order`);
                                }
                            } catch (err) {
                                addLog(`❌ DHAN ORDER FAILED: ${err}`);
                            }
                            break;

                        case 'UPSTOX':
                            // Placeholder for Future Upstox Execution
                            addLog(`⚠️ Upstox execution not yet implemented. Signal ignored.`);
                            break;
                    }
                } catch (signalErr) {
                    console.error(`Execution failed for ${signal.symbol}`, signalErr);
                    addLog(`❌ EXECUTION ERROR ${signal.symbol}: ${signalErr}`);
                }
            }
        }

        // 8. Update prior data for next tick
        try {
            updatePriorData(marketData);
        } catch (e) { console.error("UpdatePriorData failed", e); }


        // 9. Calculate PnL from state machine positions
        const managedPositions = stateMachine.getOpenPositions();
        let totalPnl = managedPositions.reduce((sum, p) => sum + p.pnl, 0);

        // Convert managed positions to display format
        const displayPositions = managedPositions.map(p => ({
            symbol: p.symbol,
            side: p.side,
            entry: p.entry,
            current: p.current,
            qty: p.qty,
            pnl: p.pnl
        }));

        const riskConsumed = Math.abs(totalPnl) / (state.initial_capital || 100000) * 100;

        // 10. Get state machine summary
        const stateSummary = stateMachine.getStateSummary();

        // 11. Update state
        updateState({
            pnl: Number(totalPnl.toFixed(2)),
            risk_consumed: Number(riskConsumed.toFixed(4)),
            positions: displayPositions,
            planned_trades: plannedTrades,
            watchlist: CONFIG.WATCHLIST,
            current_symbol: CONFIG.WATCHLIST[Math.floor(Math.random() * CONFIG.WATCHLIST.length)],
            quotes: marketData // Add market data quotes for dashboard display
        });

        // 12. Update equity curve
        try {
            updateEquity();
        } catch (e) { console.error("UpdateEquity failed", e); }


        // 13. Persist data periodically (every 10 ticks)
        const now = Date.now();
        if (now % 10 === 0) {
            try {
                await saveTradingState(getState());
                await saveRegimeState(exportRegimeState());
                await saveHistoricalData(historicalData);
            } catch (pErr) {
                console.error("Persistence failed", pErr);
                addLog(`⚠️ State Save Failed: ${pErr}`);
            }
        }

        // 14. Log activity
        if (plannedTrades.length > 0 && now % 30000 < 5000) { // Roughly every 30s
            const longCount = plannedTrades.filter(t => t.side === 'LONG').length;
            const shortCount = plannedTrades.filter(t => t.side === 'SHORT').length;
            addLog(`SCAN: ${longCount}L/${shortCount}S | ${regimeDisplay.label} | TSD:${regimeResult.newTSDCount} | ${dataSource}`);
        }

        return NextResponse.json({
            status: 'success',
            tick_time: new Date().toLocaleTimeString('en-IN'),
            market_status: marketInfo.status,
            data_source: dataSource,
            regime: regimeResult.newRegime,
            tsd_count: regimeResult.newTSDCount,
            signals_count: signals.length,
            positions_count: managedPositions.length,
            system_state: stateSummary.state,
            can_trade: stateSummary.canTrade
        });

    } catch (e) {
        console.error('Tick error:', e);
        addLog(`ERROR: ${e}`);
        return NextResponse.json({ status: 'error', message: String(e) }, { status: 500 });
    }

}

export async function GET() {
    return POST();
}
