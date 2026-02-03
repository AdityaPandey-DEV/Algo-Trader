import { NextResponse } from 'next/server';
import { getState, updateState, addLog, updateEquity } from '@/lib/state';
import { fetchUpstoxQuotes, getUpstoxLoginUrl } from '@/lib/upstoxApi';
import { generateMockData, getPriorData, updatePriorData, calculateLevels } from '@/lib/mockData';
import { fetchYahooQuotes, transformYahooToOHLCV } from '@/lib/yahooFinance';
import { calculatePlannedTrade, generateSignal } from '@/lib/strategy';
import { CONFIG } from '@/lib/config';
import { isMarketOpen, getMarketInfo } from '@/lib/marketHours';
import { fetchQuotes, isDhanConfigured, placeOrder, shouldAutoSquareOff, squareOffAll } from '@/lib/dhanApi';
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
        if (checkDailyReset()) {
            performDailyReset();
            addLog('📅 New trading day - state reset');
        }

        // Load persisted historical data if cache is empty
        if (Object.keys(historicalData).length === 0) {
            const savedHistory = loadHistoricalData();
            if (savedHistory) {
                Object.assign(historicalData, savedHistory);
                addLog('📂 Loaded historical data from storage');
            }
        }

        // Load persisted regime state
        const savedRegime = loadRegimeState();
        if (savedRegime) {
            importRegimeState(savedRegime);
        }

        // Increment tick count
        incrementTickCount();

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
                const result = await squareOffAll('Market close approaching', state.paper_mode);
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

        if (marketOpen && dhanConfigured && !state.paper_mode) {
            // LIVE MODE: Real data from Dhan
            marketData = await fetchQuotes(CONFIG.WATCHLIST);
            dataSource = 'DHAN_LIVE';

            if (Object.keys(marketData).length === 0) {
                // Fallback to mock if Dhan fails
                marketData = generateMockData(CONFIG.WATCHLIST);
                dataSource = 'MOCK_FALLBACK';
                addLog('⚠️ Dhan API failed, using mock data');
            }
        } else if (marketOpen && dhanConfigured && state.paper_mode) {
            // PAPER MODE: Real prices from Dhan, but simulated trades
            marketData = await fetchQuotes(CONFIG.WATCHLIST);
            dataSource = 'DHAN_PAPER';

            if (Object.keys(marketData).length === 0) {
                marketData = generateMockData(CONFIG.WATCHLIST);
                dataSource = 'MOCK_FALLBACK';
            }
        } else if (process.env.UPSTOX_API_KEY) {
            // UPSTOX LIVE DATA (Always try to fetch if configured, even if market closed)
            // This ensures we show Real LTP instead of Mock data
            try {
                const upstoxData = await fetchUpstoxQuotes(CONFIG.WATCHLIST);
                if (Object.keys(upstoxData).length > 0) {
                    marketData = upstoxData;
                    dataSource = marketOpen ? 'UPSTOX_LIVE' : 'UPSTOX_LTP (MARKET CLOSED)';
                } else {
                    // Upstox failed - try Yahoo Finance as backup
                    const yahooData = await fetchYahooQuotes(CONFIG.WATCHLIST);
                    if (Object.keys(yahooData).length > 0) {
                        marketData = transformYahooToOHLCV(yahooData);
                        dataSource = 'YAHOO_FINANCE';
                    } else {
                        // Last resort: mock data
                        marketData = generateMockData(CONFIG.WATCHLIST);
                        dataSource = 'MOCK_FALLBACK';
                    }
                }
            } catch (e) {
                console.error("Upstox fetch error", e);
                // Try Yahoo Finance as backup
                try {
                    const yahooData = await fetchYahooQuotes(CONFIG.WATCHLIST);
                    if (Object.keys(yahooData).length > 0) {
                        marketData = transformYahooToOHLCV(yahooData);
                        dataSource = 'YAHOO_FINANCE';
                    } else {
                        marketData = generateMockData(CONFIG.WATCHLIST);
                        dataSource = 'MOCK_FALLBACK';
                    }
                } catch (yahooError) {
                    console.error("Yahoo Finance fetch error", yahooError);
                    marketData = generateMockData(CONFIG.WATCHLIST);
                    dataSource = 'MOCK_FALLBACK';
                }
            }
        } else {
            // No Upstox configured: Try Yahoo Finance first
            try {
                const yahooData = await fetchYahooQuotes(CONFIG.WATCHLIST);
                if (Object.keys(yahooData).length > 0) {
                    marketData = transformYahooToOHLCV(yahooData);
                    dataSource = 'YAHOO_FINANCE';
                } else {
                    marketData = generateMockData(CONFIG.WATCHLIST);
                    dataSource = marketOpen ? 'MOCK_NO_BROKER' : 'MOCK_MARKET_CLOSED';
                }
            } catch (e) {
                console.error("Yahoo Finance fetch error", e);
                marketData = generateMockData(CONFIG.WATCHLIST);
                dataSource = marketOpen ? 'MOCK_NO_BROKER' : 'MOCK_MARKET_CLOSED';
            }
        }

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
            const data = marketData[symbol];
            if (!data) continue;

            const priorData = getPriorData(symbol);
            const levels = calculateLevels(data);

            // Get potential entry levels for display
            const trades = calculatePlannedTrade(data, levels.support, levels.resistance);
            plannedTrades.push(...trades);

            // Check for actionable signals (only during market hours with real data)
            if (marketOpen && (dataSource.includes('DHAN') || dataSource.includes('UPSTOX')) && regimePermissions.allowMeanReversion) {
                // Run pre-trade quality filters (Upgrades #2, #3, #7)
                const symbolCandles = historicalData[symbol] || [];
                const preTradeCheck = runPreTradeChecks(symbolCandles);

                if (!preTradeCheck.canTrade) {
                    // Skip this symbol - quality filters failed
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
        }

        // 6. Update positions prices and check exits
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

        // 7. Execute trades on signals (with full risk validation)
        if (signals.length > 0 && marketOpen && regimePermissions.tradingFrequency !== 'HALTED') {
            const openPositions = stateMachine.getOpenPositions();

            for (const signal of signals.slice(0, 2)) { // Max 2 trades per tick
                // Full risk validation
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

                // AI Confirmation (optional - if configured)
                let aiSizeMultiplier = 1.0;
                if (isAIConfigured()) {
                    const symbolCandles = historicalData[signal.symbol] || [];
                    if (symbolCandles.length >= 10) {
                        const aiResult = await getCachedAnalysis(signal.symbol, symbolCandles);
                        const conflict = resolveConflict(signal.side, aiResult, regimeResult.newRegime);

                        if (conflict.resolution === 'SKIP') {
                            addLog(`🤖 AI SKIP: ${signal.symbol} - ${conflict.reason}`);
                            continue;
                        }

                        if (conflict.resolution === 'REDUCE_SIZE') {
                            aiSizeMultiplier = 0.5; // Reduce size by half
                            addLog(`🤖 AI CAUTION: ${signal.symbol} - size reduced`);
                        }
                    }
                }

                // Calculate position size (regime-adjusted + AI-adjusted)
                let qty = riskCheck.adjustedSize || calculateSafePositionSize(
                    signal,
                    state.initial_capital,
                    regimeResult.newRegime
                );
                qty = Math.floor(qty * aiSizeMultiplier);

                if (state.paper_mode) {
                    // Paper trade: Add to state machine
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
                        addLog(`📝 PAPER ${signal.side} ${signal.symbol} @ ₹${signal.entry} (Qty: ${qty}) [${regimeResult.newRegime}]`);
                    }
                } else {
                    // LIVE trade: Execute through Dhan
                    const orderSide = signal.side === 'LONG' ? 'BUY' : 'SELL';
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
                            addLog(`🔥 LIVE ${signal.side} ${signal.symbol} @ ₹${signal.entry} (Order: ${order.orderId}) [${regimeResult.newRegime}]`);
                        }
                    }
                }
            }
        }

        // 8. Update prior data for next tick
        updatePriorData(marketData);

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

        const riskConsumed = Math.abs(totalPnl) / state.initial_capital * 100;

        // 10. Get state machine summary
        const stateSummary = stateMachine.getStateSummary();

        // 11. Update state
        updateState({
            pnl: Number(totalPnl.toFixed(2)),
            risk_consumed: Number(riskConsumed.toFixed(4)),
            positions: displayPositions,
            planned_trades: plannedTrades,
            watchlist: CONFIG.WATCHLIST,
            current_symbol: CONFIG.WATCHLIST[Math.floor(Math.random() * CONFIG.WATCHLIST.length)]
        });

        // 12. Update equity curve
        updateEquity();

        // 13. Persist data periodically (every 10 ticks)
        const now = Date.now();
        if (now % 10 === 0) {
            saveTradingState(getState());
            saveRegimeState(exportRegimeState());
            saveHistoricalData(historicalData);
        }

        // 14. Log activity (less frequently to avoid spam)
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

// Also allow GET for easy testing
export async function GET() {
    return POST();
}
