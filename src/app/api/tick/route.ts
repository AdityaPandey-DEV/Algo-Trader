import { NextResponse } from 'next/server';
import { getState, updateState, addLog, updateEquity } from '@/lib/state';
import { generateMockData, getPriorData, updatePriorData, calculateLevels } from '@/lib/mockData';
import { calculatePlannedTrade, generateSignal } from '@/lib/strategy';
import { CONFIG } from '@/lib/config';
import { isMarketOpen, getMarketStatus, getMarketInfo } from '@/lib/marketHours';
import { fetchQuotes, isDhanConfigured, placeOrder } from '@/lib/dhanApi';

export async function POST() {
    const state = getState();

    // Don't run if kill switch is active
    if (state.kill_switch) {
        return NextResponse.json({ status: 'halted', message: 'Kill switch active' });
    }

    try {
        const marketInfo = getMarketInfo();
        const marketOpen = isMarketOpen();
        const dhanConfigured = isDhanConfigured();

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
        } else {
            // Market closed or Dhan not configured: Use mock data
            marketData = generateMockData(CONFIG.WATCHLIST);
            dataSource = marketOpen ? 'MOCK_NO_DHAN' : 'MOCK_MARKET_CLOSED';
        }

        // 2. Calculate planned trades for each symbol
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
            if (marketOpen && dataSource.includes('DHAN')) {
                const signal = generateSignal(data, priorData, levels.support, levels.resistance, state.regime);
                if (signal) {
                    signals.push(signal);
                }
            }
        }

        // 3. Execute trades on signals (PAPER mode simulates, LIVE mode executes)
        if (signals.length > 0 && marketOpen) {
            for (const signal of signals.slice(0, 2)) { // Max 2 trades per tick
                // Risk check: Max daily loss
                if (Math.abs(state.pnl) >= CONFIG.MAX_DAILY_LOSS) {
                    addLog('⚠️ MAX DAILY LOSS reached. Halting trades.');
                    break;
                }

                // Calculate position size (fixed 1% risk per trade for now)
                const riskAmount = state.initial_capital * 0.01;
                const stopDistance = Math.abs(signal.entry - signal.stop);
                const qty = Math.floor(riskAmount / stopDistance) || 1;

                if (state.paper_mode) {
                    // Paper trade: Add to positions without real execution
                    const newPosition = {
                        symbol: signal.symbol,
                        side: signal.side,
                        entry: signal.entry,
                        current: signal.entry,
                        qty: qty,
                        pnl: 0
                    };
                    updateState({
                        positions: [...state.positions, newPosition]
                    });
                    addLog(`📝 PAPER ${signal.side} ${signal.symbol} @ ₹${signal.entry} (Qty: ${qty})`);
                } else {
                    // LIVE trade: Execute through Dhan
                    const orderSide = signal.side === 'LONG' ? 'BUY' : 'SELL';
                    const order = await placeOrder(signal.symbol, orderSide, qty, 'MARKET', undefined, false);

                    if (order) {
                        const newPosition = {
                            symbol: signal.symbol,
                            side: signal.side,
                            entry: signal.entry,
                            current: signal.entry,
                            qty: qty,
                            pnl: 0
                        };
                        updateState({
                            positions: [...state.positions, newPosition]
                        });
                        addLog(`🔥 LIVE ${signal.side} ${signal.symbol} @ ₹${signal.entry} (Order: ${order.orderId})`);
                    }
                }
            }
        }

        // 4. Update prior data for next tick
        updatePriorData(marketData);

        // 5. Calculate PnL from actual positions
        let totalPnl = 0;
        const updatedPositions = state.positions.map(pos => {
            const currentData = marketData[pos.symbol];
            if (currentData) {
                const current = currentData.close || currentData.lastPrice;
                const pnl = pos.side === 'LONG'
                    ? (current - pos.entry) * pos.qty
                    : (pos.entry - current) * pos.qty;
                return { ...pos, current, pnl: Number(pnl.toFixed(2)) };
            }
            return pos;
        });
        updatedPositions.forEach(p => totalPnl += p.pnl);

        const riskConsumed = Math.abs(totalPnl) / state.initial_capital * 100;

        // 6. Update state
        updateState({
            pnl: Number(totalPnl.toFixed(2)),
            risk_consumed: Number(riskConsumed.toFixed(4)),
            positions: updatedPositions,
            planned_trades: plannedTrades,
            watchlist: CONFIG.WATCHLIST,
            current_symbol: CONFIG.WATCHLIST[Math.floor(Math.random() * CONFIG.WATCHLIST.length)]
        });

        // 7. Update equity curve
        updateEquity();

        // 8. Log activity (less frequently to avoid spam)
        const now = Date.now();
        if (plannedTrades.length > 0 && now % 30000 < 5000) { // Roughly every 30s
            const longCount = plannedTrades.filter(t => t.side === 'LONG').length;
            const shortCount = plannedTrades.filter(t => t.side === 'SHORT').length;
            addLog(`SCAN: ${longCount} Long, ${shortCount} Short | ${dataSource} | ${marketInfo.status}`);
        }

        return NextResponse.json({
            status: 'success',
            tick_time: new Date().toLocaleTimeString('en-IN'),
            market_status: marketInfo.status,
            data_source: dataSource,
            signals_count: signals.length,
            positions_count: state.positions.length
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
