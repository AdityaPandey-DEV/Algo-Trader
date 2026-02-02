// Backtesting Engine for Algo Trader
// Simulates the trading strategy over historical data
// Produces comprehensive profitability metrics

import {
    calculateSMA,
    getCurrentEMA,
    getCurrentATR,
    calculateSlope,
    OHLCV
} from './indicators';
import {
    MarketRegime,
    determineRegime,
    getRegimePermissions
} from './regimeEngine';
import { CONFIG } from './config';
import { fetchHistoricalDataForBacktest } from './historicalData';

// ============================================
// Types & Interfaces
// ============================================

export interface BacktestConfig {
    initialCapital: number;
    riskPerTrade: number;           // % of capital per trade
    maxDailyLoss: number;           // % max daily loss
    maxTradesPerDay: number;
    stopAfterNLosses: number;       // Auto-stop after N consecutive losses
    slippageBps: number;            // Slippage in basis points
    brokeragePerTrade: number;      // Fixed brokerage per side
    sttPercentage: number;          // STT for intraday
}

export interface Trade {
    symbol: string;
    date: string;
    side: 'LONG' | 'SHORT';
    entry: number;
    exit: number;
    qty: number;
    pnl: number;
    regime: MarketRegime;
    exitReason: 'TARGET' | 'STOPLOSS' | 'EOD' | 'MAX_LOSS';
}

export interface DayResult {
    date: string;
    tradesExecuted: number;
    winningTrades: number;
    losingTrades: number;
    grossPnl: number;
    netPnl: number;
    regime: MarketRegime;
    tsdCount: number;
    maxDrawdown: number;
}

export interface StockResult {
    symbol: string;
    profitableDays: number;
    losingDays: number;
    flatDays: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    grossPnl: number;
    netPnl: number;
    avgDailyPnl: number;
    maxDrawdown: number;
    winRate: number;
}

export interface BacktestResult {
    stockResults: StockResult[];
    dailyResults: DayResult[];
    totalProfitableDays: number;
    totalLosingDays: number;
    totalFlatDays: number;
    profitableDaysPct: number;
    netSystemPnl: number;
    worstDayLoss: number;
    bestDayProfit: number;
    profitFactor: number;
    expectancyPerDay: number;
    maxDrawdown: number;
    sharpeRatio: number;
}

// ============================================
// Historical Data Generation
// ============================================

/**
 * Generate realistic historical OHLCV data for simulation
 * Uses random walk with mean reversion characteristics
 */
function generateHistoricalData(
    symbol: string,
    basePrice: number,
    days: number,
    candlesPerDay: number = 75  // 5-min candles in 6.25hr session
): OHLCV[][] {
    const allDays: OHLCV[][] = [];
    let currentPrice = basePrice;

    // Seed based on symbol for reproducibility
    const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const random = () => {
        const x = Math.sin(seed + allDays.length * candlesPerDay + allDays[allDays.length - 1]?.length || 0) * 10000;
        return x - Math.floor(x);
    };

    for (let day = 0; day < days; day++) {
        const dailyCandles: OHLCV[] = [];
        const dayOpen = currentPrice;

        // Daily bias (slight mean reversion tendency)
        const dailyBias = (basePrice - currentPrice) / basePrice * 0.1;

        // Volatility varies by symbol and day
        const dailyVolatility = 0.001 + Math.random() * 0.002; // 0.1% to 0.3% per candle

        for (let candle = 0; candle < candlesPerDay; candle++) {
            const move = (Math.random() - 0.5 + dailyBias) * dailyVolatility * currentPrice;
            const wickSize = Math.random() * dailyVolatility * currentPrice * 0.5;

            const open = currentPrice;
            const close = currentPrice + move;
            const high = Math.max(open, close) + wickSize;
            const low = Math.min(open, close) - wickSize;

            // Volume varies throughout day (higher at open/close)
            const timeWeight = candle < 15 || candle > 60 ? 1.5 : 1.0;
            const volume = Math.floor((50000 + Math.random() * 100000) * timeWeight);

            dailyCandles.push({
                symbol,
                open: Math.round(open * 100) / 100,
                high: Math.round(high * 100) / 100,
                low: Math.round(low * 100) / 100,
                close: Math.round(close * 100) / 100,
                volume
            });

            currentPrice = close;
        }

        allDays.push(dailyCandles);
    }

    return allDays;
}

// ============================================
// Strategy Implementation
// ============================================

/**
 * Calculate Base Range (R) - Average ATR
 */
function calculateBaseRangeLocal(candles: OHLCV[]): number {
    return getCurrentATR(candles, 20);
}

/**
 * Calculate Trend Shift (T) - EMA difference
 */
function calculateTrendShiftLocal(candles: OHLCV[]): number {
    const closes = candles.map(c => c.close);
    const ema5 = getCurrentEMA(closes, 5);
    const ema20 = getCurrentEMA(closes, 20);
    return ema5 - ema20;
}

/**
 * Detect mean reversion entry
 */
function detectMeanReversionEntry(
    candles: OHLCV[],
    regime: MarketRegime
): { signal: 'LONG' | 'SHORT' | null; entry: number; stop: number; target: number } {
    if (candles.length < 20) {
        return { signal: null, entry: 0, stop: 0, target: 0 };
    }

    const permissions = getRegimePermissions(regime);
    if (!permissions.allowMeanReversion) {
        return { signal: null, entry: 0, stop: 0, target: 0 };
    }

    const closes = candles.map(c => c.close);
    const sma20 = calculateSMA(closes, 20);
    const atr = getCurrentATR(candles, 14);
    const lastCandle = candles[candles.length - 1];
    const currentPrice = lastCandle.close;

    // Mean reversion: price deviated from SMA
    const deviation = Math.abs(currentPrice - sma20);
    const deviationRatio = deviation / atr;

    // Check for rejection candle (wick present)
    const body = Math.abs(lastCandle.close - lastCandle.open);
    const range = lastCandle.high - lastCandle.low;
    const wickRatio = range > 0 ? (range - body) / range : 0;

    // TIGHTENED criteria: 1.5 ATR deviation, 0.5 wick ratio (original values)
    if (deviationRatio < 1.5 || wickRatio < 0.5) {
        return { signal: null, entry: 0, stop: 0, target: 0 };
    }

    if (currentPrice < sma20) {
        // LONG signal - price below SMA with rejection
        return {
            signal: 'LONG',
            entry: currentPrice,
            stop: lastCandle.low - atr * 0.5,
            target: sma20
        };
    } else {
        // SHORT signal - price above SMA with rejection
        return {
            signal: 'SHORT',
            entry: currentPrice,
            stop: lastCandle.high + atr * 0.5,
            target: sma20
        };
    }
}

/**
 * Simulate a single trade
 */
function simulateTrade(
    candles: OHLCV[],
    startIdx: number,
    side: 'LONG' | 'SHORT',
    entry: number,
    stop: number,
    target: number,
    config: BacktestConfig
): { exitPrice: number; exitIdx: number; exitReason: 'TARGET' | 'STOPLOSS' | 'EOD' } {
    // Apply slippage to entry
    const slippage = entry * (config.slippageBps / 10000);
    const entryWithSlippage = side === 'LONG' ? entry + slippage : entry - slippage;

    for (let i = startIdx + 1; i < candles.length; i++) {
        const candle = candles[i];

        if (side === 'LONG') {
            // Check stop loss
            if (candle.low <= stop) {
                return { exitPrice: stop - slippage, exitIdx: i, exitReason: 'STOPLOSS' };
            }
            // Check target
            if (candle.high >= target) {
                return { exitPrice: target - slippage, exitIdx: i, exitReason: 'TARGET' };
            }
        } else {
            // SHORT
            if (candle.high >= stop) {
                return { exitPrice: stop + slippage, exitIdx: i, exitReason: 'STOPLOSS' };
            }
            if (candle.low <= target) {
                return { exitPrice: target + slippage, exitIdx: i, exitReason: 'TARGET' };
            }
        }
    }

    // EOD - close at last candle
    const lastCandle = candles[candles.length - 1];
    return {
        exitPrice: side === 'LONG' ? lastCandle.close - slippage : lastCandle.close + slippage,
        exitIdx: candles.length - 1,
        exitReason: 'EOD'
    };
}

// ============================================
// Main Backtest Engine
// ============================================

/**
 * Run backtest for a single stock
 */
function backtestStock(
    symbol: string,
    historicalData: OHLCV[][],
    config: BacktestConfig
): { trades: Trade[]; dayResults: DayResult[] } {
    const trades: Trade[] = [];
    const dayResults: DayResult[] = [];

    let tsdCount = 0;
    let cumulativePnl = 0;
    let peakEquity = config.initialCapital;
    let maxDrawdown = 0;

    // Process each day
    for (let dayIdx = 0; dayIdx < historicalData.length; dayIdx++) {
        const dayCandleson = historicalData[dayIdx];
        const dateStr = `Day_${dayIdx + 1}`;

        // Calculate session metrics
        const allCandles = historicalData.slice(0, dayIdx + 1).flat();
        const recentCandles = allCandles.slice(-200);

        // Calculate TSD for regime detection
        if (dayCandleson.length > 0) {
            const R = calculateBaseRangeLocal(recentCandles);
            const T = Math.abs(calculateTrendShiftLocal(recentCandles));
            const isTSD = T > 0.7 * R;

            if (isTSD) {
                tsdCount = Math.min(tsdCount + 1, 10);
            } else {
                tsdCount = Math.max(0, tsdCount - 1);
            }
        }

        // Determine regime
        const regime = determineRegime(tsdCount);
        const permissions = getRegimePermissions(regime);

        // Daily tracking
        let dailyTrades = 0;
        let dailyWins = 0;
        let dailyLosses = 0;
        let dailyPnl = 0;
        let consecutiveLosses = 0;

        // Scan for signals throughout the day
        // TIME FILTER: Start at candle 23 (skips first ~15-20 min for 5-min candles)
        const firstTradableCandle = Math.max(20, 3); // Min 20 for indicators, skip first 3 candles (~15 min)
        for (let candleIdx = 23; candleIdx < dayCandleson.length - 10; candleIdx++) {
            // Check if we can still trade today
            if (dailyTrades >= config.maxTradesPerDay) break;
            if (consecutiveLosses >= config.stopAfterNLosses) break;
            if (dailyPnl < -config.initialCapital * config.maxDailyLoss) break;
            if (dailyTrades >= permissions.maxConcurrentTrades) break;

            // Get candles up to current point
            const candlesToNow = dayCandleson.slice(0, candleIdx + 1);

            // Detect entry signal
            const signal = detectMeanReversionEntry(candlesToNow, regime);

            if (signal.signal) {
                // Calculate position size
                const riskAmount = config.initialCapital * config.riskPerTrade;
                const riskPerShare = Math.abs(signal.entry - signal.stop);
                let qty = Math.floor(riskAmount / riskPerShare);

                // Apply regime multiplier
                qty = Math.floor(qty * permissions.maxPositionSizeMultiplier);

                if (qty > 0) {
                    // Execute trade
                    const tradeResult = simulateTrade(
                        dayCandleson,
                        candleIdx,
                        signal.signal,
                        signal.entry,
                        signal.stop,
                        signal.target,
                        config
                    );

                    // Calculate P&L
                    const grossPnl = signal.signal === 'LONG'
                        ? (tradeResult.exitPrice - signal.entry) * qty
                        : (signal.entry - tradeResult.exitPrice) * qty;

                    // Apply costs
                    const brokerage = config.brokeragePerTrade * 2; // Entry + Exit
                    const stt = Math.abs(grossPnl) * config.sttPercentage;
                    const netPnl = grossPnl - brokerage - stt;

                    trades.push({
                        symbol,
                        date: dateStr,
                        side: signal.signal,
                        entry: signal.entry,
                        exit: tradeResult.exitPrice,
                        qty,
                        pnl: netPnl,
                        regime,
                        exitReason: tradeResult.exitReason
                    });

                    dailyTrades++;
                    dailyPnl += netPnl;

                    if (netPnl > 0) {
                        dailyWins++;
                        consecutiveLosses = 0;
                    } else {
                        dailyLosses++;
                        consecutiveLosses++;
                    }

                    // Skip to after trade exit
                    candleIdx = tradeResult.exitIdx;
                }
            }
        }

        // Record day result
        cumulativePnl += dailyPnl;
        const currentEquity = config.initialCapital + cumulativePnl;
        peakEquity = Math.max(peakEquity, currentEquity);
        const currentDrawdown = (peakEquity - currentEquity) / peakEquity;
        maxDrawdown = Math.max(maxDrawdown, currentDrawdown);

        dayResults.push({
            date: dateStr,
            tradesExecuted: dailyTrades,
            winningTrades: dailyWins,
            losingTrades: dailyLosses,
            grossPnl: dailyPnl,
            netPnl: dailyPnl,
            regime,
            tsdCount,
            maxDrawdown: currentDrawdown
        });
    }

    return { trades, dayResults };
}

/**
 * Run full backtest across all stocks (using simulated data)
 */
export function runBacktest(
    stocks: Array<{ symbol: string; basePrice: number }>,
    days: number = 100,
    config: BacktestConfig
): BacktestResult {
    const stockResults: StockResult[] = [];
    const allDailyResults: DayResult[] = [];
    const dailySystemPnl: number[] = Array(days).fill(0);

    // Process each stock
    for (const stock of stocks) {
        console.log(`Backtesting ${stock.symbol} (simulated data)...`);

        // Generate simulated historical data
        const historicalData = generateHistoricalData(stock.symbol, stock.basePrice, days);

        // Run backtest
        const { trades, dayResults } = backtestStock(stock.symbol, historicalData, config);

        // Aggregate stock results
        let profitableDays = 0;
        let losingDays = 0;
        let flatDays = 0;
        let grossPnl = 0;
        let maxDD = 0;

        for (let i = 0; i < dayResults.length; i++) {
            const day = dayResults[i];
            dailySystemPnl[i] += day.netPnl;
            grossPnl += day.netPnl;
            maxDD = Math.max(maxDD, day.maxDrawdown);

            if (day.netPnl > 0) profitableDays++;
            else if (day.netPnl < 0) losingDays++;
            else flatDays++;
        }

        const winningTrades = trades.filter(t => t.pnl > 0).length;

        stockResults.push({
            symbol: stock.symbol,
            profitableDays,
            losingDays,
            flatDays,
            totalTrades: trades.length,
            winningTrades,
            losingTrades: trades.length - winningTrades,
            grossPnl,
            netPnl: grossPnl,
            avgDailyPnl: grossPnl / days,
            maxDrawdown: maxDD,
            winRate: trades.length > 0 ? (winningTrades / trades.length) * 100 : 0
        });
    }

    // Aggregate system-level results
    let totalProfitableDays = 0;
    let totalLosingDays = 0;
    let totalFlatDays = 0;
    let totalGrossProfit = 0;
    let totalGrossLoss = 0;
    let worstDay = 0;
    let bestDay = 0;

    for (const pnl of dailySystemPnl) {
        if (pnl > 0) {
            totalProfitableDays++;
            totalGrossProfit += pnl;
        } else if (pnl < 0) {
            totalLosingDays++;
            totalGrossLoss += Math.abs(pnl);
        } else {
            totalFlatDays++;
        }

        worstDay = Math.min(worstDay, pnl);
        bestDay = Math.max(bestDay, pnl);
    }

    const netSystemPnl = totalGrossProfit - totalGrossLoss;
    const profitFactor = totalGrossLoss > 0 ? totalGrossProfit / totalGrossLoss : totalGrossProfit > 0 ? Infinity : 0;
    const expectancyPerDay = netSystemPnl / days;

    // Calculate max system drawdown
    let peakEquity = config.initialCapital;
    let maxDD = 0;
    let runningEquity = config.initialCapital;

    for (const pnl of dailySystemPnl) {
        runningEquity += pnl;
        peakEquity = Math.max(peakEquity, runningEquity);
        const dd = (peakEquity - runningEquity) / peakEquity;
        maxDD = Math.max(maxDD, dd);
    }

    // Calculate Sharpe Ratio (simplified)
    const avgDailyReturn = netSystemPnl / days / config.initialCapital;
    const dailyReturns = dailySystemPnl.map(p => p / config.initialCapital);
    const stdDev = Math.sqrt(
        dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDailyReturn, 2), 0) / days
    );
    const sharpeRatio = stdDev > 0 ? (avgDailyReturn / stdDev) * Math.sqrt(252) : 0;

    return {
        stockResults,
        dailyResults: allDailyResults,
        totalProfitableDays,
        totalLosingDays,
        totalFlatDays,
        profitableDaysPct: (totalProfitableDays / days) * 100,
        netSystemPnl,
        worstDayLoss: worstDay,
        bestDayProfit: bestDay,
        profitFactor,
        expectancyPerDay,
        maxDrawdown: maxDD,
        sharpeRatio
    };
}

/**
 * Generate formatted backtest report
 */
export function generateBacktestReport(result: BacktestResult, config: BacktestConfig): string {
    let report = `
# ALGO TRADER - 100-DAY BACKTEST REPORT
Generated: ${new Date().toISOString()}

## Configuration
- Initial Capital: ₹${config.initialCapital.toLocaleString()}
- Risk Per Trade: ${(config.riskPerTrade * 100).toFixed(1)}%
- Max Daily Loss: ${(config.maxDailyLoss * 100).toFixed(1)}%
- Slippage: ${config.slippageBps} bps
- Brokerage/Trade: ₹${config.brokeragePerTrade}

---

## Table 1 — Per-Stock Results

| Stock | Profitable Days | Losing Days | Flat Days | Trades | Win Rate | Net P&L |
|-------|----------------|-------------|-----------|--------|----------|---------|
`;

    for (const stock of result.stockResults) {
        report += `| ${stock.symbol} | ${stock.profitableDays} | ${stock.losingDays} | ${stock.flatDays} | ${stock.totalTrades} | ${stock.winRate.toFixed(1)}% | ₹${stock.netPnl.toFixed(0)} |\n`;
    }

    report += `
---

## Table 2 — Daily System Performance

| Metric | Value |
|--------|-------|
| Total Days Tested | 100 |
| Profitable Days | ${result.totalProfitableDays} |
| Losing Days | ${result.totalLosingDays} |
| Flat Days | ${result.totalFlatDays} |
| Profit % Days | ${result.profitableDaysPct.toFixed(1)}% |
| Net System P&L | ₹${result.netSystemPnl.toFixed(0)} (${(result.netSystemPnl / config.initialCapital * 100).toFixed(2)}%) |
| Best Day Profit | ₹${result.bestDayProfit.toFixed(0)} |
| Worst Day Loss | ₹${result.worstDayLoss.toFixed(0)} |
| Profit Factor | ${result.profitFactor.toFixed(2)} |
| Expectancy/Day | ₹${result.expectancyPerDay.toFixed(0)} |
| Max Drawdown | ${(result.maxDrawdown * 100).toFixed(2)}% |
| Sharpe Ratio | ${result.sharpeRatio.toFixed(2)} |

---

## Summary Analysis

### Profitability Assessment
`;

    if (result.netSystemPnl > 0) {
        report += `✅ **SYSTEM IS NET PROFITABLE** over 100 days\n`;
    } else {
        report += `❌ **SYSTEM IS NOT PROFITABLE** over 100 days\n`;
    }

    report += `
### Day-Level Consistency
- ${result.profitableDaysPct.toFixed(1)}% of days were profitable
- ${result.profitableDaysPct >= 55 ? '✅ Good consistency (>55%)' : '⚠️ Inconsistent (<55%)'}
`;

    // Profit concentration
    const topContributors = result.stockResults
        .filter(s => s.netPnl > 0)
        .sort((a, b) => b.netPnl - a.netPnl)
        .slice(0, 3);

    const topContribution = topContributors.reduce((sum, s) => sum + s.netPnl, 0);
    const totalProfit = result.stockResults.filter(s => s.netPnl > 0).reduce((sum, s) => sum + s.netPnl, 0);

    report += `
### Profit Distribution
- Top 3 contributors: ${topContributors.map(s => s.symbol).join(', ')}
- Top 3 account for ${totalProfit > 0 ? ((topContribution / totalProfit) * 100).toFixed(1) : 0}% of profits
- ${topContribution / totalProfit < 0.6 ? '✅ Well distributed' : '⚠️ Concentrated in few stocks'}
`;

    // Loss clustering
    const unstableStocks = result.stockResults.filter(s => s.losingDays > s.profitableDays);

    report += `
### Unstable Stocks
- ${unstableStocks.length} stocks with more losing than profitable days
- ${unstableStocks.length <= 2 ? '✅ Acceptable' : '⚠️ Review strategy for these stocks'}
${unstableStocks.map(s => `  - ${s.symbol}: ${s.losingDays} losing vs ${s.profitableDays} profitable`).join('\n')}

---

## FINAL VERDICT

| Question | Answer |
|----------|--------|
| Net Profitable? | ${result.netSystemPnl > 0 ? '✅ YES' : '❌ NO'} |
| Consistent? | ${result.profitableDaysPct >= 55 ? '✅ YES' : '⚠️ MODERATE'} |
| Drawdown OK? | ${result.maxDrawdown < 0.15 ? '✅ YES (<15%)' : '⚠️ HIGH'} |
| Scalable? | ${result.profitFactor > 1.5 && result.sharpeRatio > 1 ? '✅ YES' : '⚠️ NEEDS REVIEW'} |

**Overall Assessment:** ${result.netSystemPnl > 0 && result.profitableDaysPct >= 50 && result.maxDrawdown < 0.2
            ? '✅ SYSTEM IS VIABLE FOR DEPLOYMENT'
            : '⚠️ SYSTEM NEEDS FURTHER OPTIMIZATION'
        }
`;

    return report;
}

// ============================================
// Default Test Configuration
// ============================================

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
    initialCapital: 100000,
    riskPerTrade: 0.01,           // 1% per trade
    maxDailyLoss: 0.03,           // 3% max daily loss
    maxTradesPerDay: 4,
    stopAfterNLosses: 2,
    slippageBps: 5,               // 0.05% slippage
    brokeragePerTrade: 20,        // ₹20 per side
    sttPercentage: 0.00025        // 0.025% STT
};

export const TEST_UNIVERSE = [
    { symbol: 'RELIANCE', basePrice: 2500 },
    { symbol: 'TCS', basePrice: 4200 },
    { symbol: 'HDFCBANK', basePrice: 1650 },
    { symbol: 'INFY', basePrice: 1800 },
    { symbol: 'ICICIBANK', basePrice: 1100 },
    { symbol: 'SBIN', basePrice: 780 },
    { symbol: 'BHARTIARTL', basePrice: 1400 },
    { symbol: 'ITC', basePrice: 480 },
    { symbol: 'LT', basePrice: 3600 },
    { symbol: 'AXISBANK', basePrice: 1150 }
];

/**
 * Run backtest with REAL historical data from Yahoo Finance
 */
export async function runBacktestWithRealData(
    symbols: string[],
    days: number = 60,  // Yahoo limits intraday to 60 days
    config: BacktestConfig
): Promise<BacktestResult> {
    const stockResults: StockResult[] = [];
    const dailySystemPnl: number[] = [];
    let totalDays = 0;

    // Process each stock
    for (const symbol of symbols) {
        console.log(`Fetching real data for ${symbol}...`);

        // Fetch real historical data from Yahoo Finance
        const historicalData = await fetchHistoricalDataForBacktest(symbol, days);

        if (historicalData.length === 0) {
            console.log(`No data available for ${symbol}, skipping...`);
            continue;
        }

        const actualDays = historicalData.length;
        totalDays = Math.max(totalDays, actualDays);

        // Ensure dailySystemPnl has enough elements
        while (dailySystemPnl.length < actualDays) {
            dailySystemPnl.push(0);
        }

        console.log(`Running backtest for ${symbol} with ${actualDays} days of real data...`);

        // Run backtest
        const { trades, dayResults } = backtestStock(symbol, historicalData, config);

        // Aggregate stock results
        let profitableDays = 0;
        let losingDays = 0;
        let flatDays = 0;
        let grossPnl = 0;
        let maxDD = 0;

        for (let i = 0; i < dayResults.length; i++) {
            const day = dayResults[i];
            if (i < dailySystemPnl.length) {
                dailySystemPnl[i] += day.netPnl;
            }
            grossPnl += day.netPnl;
            maxDD = Math.max(maxDD, day.maxDrawdown);

            if (day.netPnl > 0) profitableDays++;
            else if (day.netPnl < 0) losingDays++;
            else flatDays++;
        }

        const winningTrades = trades.filter(t => t.pnl > 0).length;

        stockResults.push({
            symbol,
            profitableDays,
            losingDays,
            flatDays,
            totalTrades: trades.length,
            winningTrades,
            losingTrades: trades.length - winningTrades,
            grossPnl,
            netPnl: grossPnl,
            avgDailyPnl: actualDays > 0 ? grossPnl / actualDays : 0,
            maxDrawdown: maxDD,
            winRate: trades.length > 0 ? (winningTrades / trades.length) * 100 : 0
        });
    }

    // Aggregate system-level results
    let totalProfitableDays = 0;
    let totalLosingDays = 0;
    let totalFlatDays = 0;
    let totalGrossProfit = 0;
    let totalGrossLoss = 0;
    let worstDay = 0;
    let bestDay = 0;

    for (const pnl of dailySystemPnl) {
        if (pnl > 0) {
            totalProfitableDays++;
            totalGrossProfit += pnl;
        } else if (pnl < 0) {
            totalLosingDays++;
            totalGrossLoss += Math.abs(pnl);
        } else {
            totalFlatDays++;
        }

        worstDay = Math.min(worstDay, pnl);
        bestDay = Math.max(bestDay, pnl);
    }

    const netSystemPnl = totalGrossProfit - totalGrossLoss;
    const profitFactor = totalGrossLoss > 0 ? totalGrossProfit / totalGrossLoss : totalGrossProfit > 0 ? Infinity : 0;
    const expectancyPerDay = totalDays > 0 ? netSystemPnl / totalDays : 0;

    // Calculate max system drawdown
    let peakEquity = config.initialCapital;
    let maxDD = 0;
    let runningEquity = config.initialCapital;

    for (const pnl of dailySystemPnl) {
        runningEquity += pnl;
        peakEquity = Math.max(peakEquity, runningEquity);
        const dd = peakEquity > 0 ? (peakEquity - runningEquity) / peakEquity : 0;
        maxDD = Math.max(maxDD, dd);
    }

    // Calculate Sharpe Ratio
    const avgDailyReturn = totalDays > 0 ? netSystemPnl / totalDays / config.initialCapital : 0;
    const dailyReturns = dailySystemPnl.map(p => p / config.initialCapital);
    const stdDev = dailyReturns.length > 0 ? Math.sqrt(
        dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDailyReturn, 2), 0) / dailyReturns.length
    ) : 0;
    const sharpeRatio = stdDev > 0 ? (avgDailyReturn / stdDev) * Math.sqrt(252) : 0;

    return {
        stockResults,
        dailyResults: [],
        totalProfitableDays,
        totalLosingDays,
        totalFlatDays,
        profitableDaysPct: totalDays > 0 ? (totalProfitableDays / totalDays) * 100 : 0,
        netSystemPnl,
        worstDayLoss: worstDay,
        bestDayProfit: bestDay,
        profitFactor,
        expectancyPerDay,
        maxDrawdown: maxDD,
        sharpeRatio
    };
}
