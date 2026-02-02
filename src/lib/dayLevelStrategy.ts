// Day-Level Mean Reversion Strategy
// Designed for Yahoo Finance 15m/daily data
// No wick ratio dependency - focuses on daily deviation from mean

import { OHLCV, getCurrentATR, calculateSMA } from './indicators';
import { fetchHistoricalDataForBacktest, fetchDailyData } from './historicalData';

// ============================================
// Types
// ============================================

export interface DayLevelConfig {
    atrDeviation: number;      // Entry when price deviates X ATR from mean
    holdingDays: number;       // Max days to hold position
    stopAtr: number;           // Stop loss at X ATR
    targetAtr: number;         // Take profit at X ATR toward mean
}

export interface DayLevelTrade {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    entryDate: number;
    entryPrice: number;
    exitDate: number;
    exitPrice: number;
    exitReason: 'TP' | 'SL' | 'TIME';
    pnl: number;
    holdingDays: number;
}

export interface DayLevelResult {
    config: DayLevelConfig;
    trades: DayLevelTrade[];
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    netPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    winRate: number;
    avgHoldingDays: number;
    riskAdjustedScore: number;
    isValid: boolean;
    invalidReason?: string;
}

// ============================================
// Constants
// ============================================

const INITIAL_CAPITAL = 100000;
const RISK_PER_TRADE = 0.02;  // 2% risk per trade
const BROKERAGE_PER_TRADE = 20;
const STT_PERCENTAGE = 0.001;  // 0.1% for delivery trades
const SLIPPAGE_BPS = 10;

// Validation thresholds
const MAX_DRAWDOWN = 0.25;      // 25%
const MIN_TRADES = 10;
const MIN_WIN_RATE = 0.35;      // 35%
const MIN_PROFIT_FACTOR = 1.0;

// Test parameters
const ATR_DEVIATIONS = [1.0, 1.5, 2.0, 2.5];
const HOLDING_DAYS = [1, 2, 3, 5];
const STOP_ATRS = [1.0, 1.5, 2.0];

const TEST_SYMBOLS = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'SBIN', 'BHARTIARTL', 'ITC', 'LT', 'AXISBANK'
];

// ============================================
// Day-Level Signal Detection
// ============================================

interface DailySignal {
    signal: 'LONG' | 'SHORT' | null;
    deviation: number;
    sma: number;
    atr: number;
}

function detectDailySignal(
    dailyCandles: OHLCV[],
    atrDeviation: number
): DailySignal {
    if (dailyCandles.length < 25) {
        return { signal: null, deviation: 0, sma: 0, atr: 0 };
    }

    const closes = dailyCandles.map(c => c.close);
    const sma20 = calculateSMA(closes.slice(-20), 20);
    const atr = getCurrentATR(dailyCandles.slice(-20), 14);

    const lastClose = dailyCandles[dailyCandles.length - 1].close;
    const deviation = (lastClose - sma20) / atr;

    // Entry signal when price is extended from mean
    if (deviation <= -atrDeviation) {
        // Price is significantly BELOW mean → expect mean reversion UP
        return { signal: 'LONG', deviation, sma: sma20, atr };
    } else if (deviation >= atrDeviation) {
        // Price is significantly ABOVE mean → expect mean reversion DOWN
        return { signal: 'SHORT', deviation, sma: sma20, atr };
    }

    return { signal: null, deviation, sma: sma20, atr };
}

// ============================================
// Single Stock Backtest
// ============================================

function backtestStockDayLevel(
    symbol: string,
    dailyCandles: OHLCV[],
    config: DayLevelConfig
): DayLevelTrade[] {
    const trades: DayLevelTrade[] = [];

    if (dailyCandles.length < 30) return trades;

    let inPosition = false;
    let position: {
        direction: 'LONG' | 'SHORT';
        entry: number;
        entryIdx: number;
        stop: number;
        target: number;
    } | null = null;

    // Start from day 25 to have enough history
    for (let i = 25; i < dailyCandles.length; i++) {
        const candle = dailyCandles[i];

        // Check for exit if in position
        if (inPosition && position) {
            const holdingDays = i - position.entryIdx;
            let exitReason: 'TP' | 'SL' | 'TIME' | null = null;
            let exitPrice = 0;

            if (position.direction === 'LONG') {
                // Check stop loss
                if (candle.low <= position.stop) {
                    exitReason = 'SL';
                    exitPrice = position.stop;
                }
                // Check target (mean reversion)
                else if (candle.high >= position.target) {
                    exitReason = 'TP';
                    exitPrice = position.target;
                }
                // Check time-based exit
                else if (holdingDays >= config.holdingDays) {
                    exitReason = 'TIME';
                    exitPrice = candle.close;
                }
            } else {
                // SHORT position
                if (candle.high >= position.stop) {
                    exitReason = 'SL';
                    exitPrice = position.stop;
                }
                else if (candle.low <= position.target) {
                    exitReason = 'TP';
                    exitPrice = position.target;
                }
                else if (holdingDays >= config.holdingDays) {
                    exitReason = 'TIME';
                    exitPrice = candle.close;
                }
            }

            if (exitReason) {
                // Calculate P&L
                const qty = Math.floor((INITIAL_CAPITAL * RISK_PER_TRADE) / Math.abs(position.entry - position.stop));
                const grossPnl = position.direction === 'LONG'
                    ? (exitPrice - position.entry) * qty
                    : (position.entry - exitPrice) * qty;
                const costs = BROKERAGE_PER_TRADE * 2 + Math.abs(grossPnl) * STT_PERCENTAGE;
                const netPnl = grossPnl - costs;

                trades.push({
                    symbol,
                    direction: position.direction,
                    entryDate: position.entryIdx,
                    entryPrice: position.entry,
                    exitDate: i,
                    exitPrice,
                    exitReason,
                    pnl: netPnl,
                    holdingDays
                });

                inPosition = false;
                position = null;
            }
        }

        // Look for new entry if not in position
        if (!inPosition) {
            const historyToNow = dailyCandles.slice(0, i + 1);
            const signal = detectDailySignal(historyToNow, config.atrDeviation);

            if (signal.signal) {
                const slippage = candle.close * (SLIPPAGE_BPS / 10000);
                const entryPrice = signal.signal === 'LONG'
                    ? candle.close + slippage
                    : candle.close - slippage;

                const stopDistance = signal.atr * config.stopAtr;
                const targetDistance = Math.abs(candle.close - signal.sma) * 0.8; // 80% of distance to mean

                position = {
                    direction: signal.signal,
                    entry: entryPrice,
                    entryIdx: i,
                    stop: signal.signal === 'LONG'
                        ? entryPrice - stopDistance
                        : entryPrice + stopDistance,
                    target: signal.signal === 'LONG'
                        ? entryPrice + targetDistance
                        : entryPrice - targetDistance
                };

                inPosition = true;
            }
        }
    }

    return trades;
}

// ============================================
// Single Configuration Backtest
// ============================================

function runDayLevelConfig(
    config: DayLevelConfig,
    allDailyData: Map<string, OHLCV[]>
): DayLevelResult {
    const allTrades: DayLevelTrade[] = [];
    const dailyPnl: Map<number, number> = new Map();

    // Run backtest for each symbol
    for (const [symbol, candles] of allDailyData) {
        const trades = backtestStockDayLevel(symbol, candles, config);
        allTrades.push(...trades);

        // Track daily P&L
        for (const trade of trades) {
            const current = dailyPnl.get(trade.exitDate) || 0;
            dailyPnl.set(trade.exitDate, current + trade.pnl);
        }
    }

    // Calculate metrics
    const winningTrades = allTrades.filter(t => t.pnl > 0);
    const losingTrades = allTrades.filter(t => t.pnl <= 0);

    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
    const netPnl = grossProfit - grossLoss;

    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    const winRate = allTrades.length > 0 ? winningTrades.length / allTrades.length : 0;
    const avgHoldingDays = allTrades.length > 0
        ? allTrades.reduce((sum, t) => sum + t.holdingDays, 0) / allTrades.length
        : 0;

    // Calculate max drawdown
    const sortedDays = [...dailyPnl.keys()].sort((a, b) => a - b);
    let peak = INITIAL_CAPITAL;
    let maxDrawdown = 0;
    let equity = INITIAL_CAPITAL;

    for (const day of sortedDays) {
        equity += dailyPnl.get(day) || 0;
        peak = Math.max(peak, equity);
        const dd = peak > 0 ? (peak - equity) / peak : 0;
        maxDrawdown = Math.max(maxDrawdown, dd);
    }

    const riskAdjustedScore = maxDrawdown > 0 ? netPnl / (maxDrawdown * INITIAL_CAPITAL) : (netPnl > 0 ? 999 : 0);

    // Validation
    let isValid = true;
    let invalidReason: string | undefined;

    if (maxDrawdown > MAX_DRAWDOWN) {
        isValid = false;
        invalidReason = `DD ${(maxDrawdown * 100).toFixed(1)}% > 25%`;
    } else if (allTrades.length < MIN_TRADES) {
        isValid = false;
        invalidReason = `Trades ${allTrades.length} < 10`;
    } else if (profitFactor < MIN_PROFIT_FACTOR) {
        isValid = false;
        invalidReason = `PF ${profitFactor.toFixed(2)} < 1.0`;
    } else if (winRate < MIN_WIN_RATE) {
        isValid = false;
        invalidReason = `Win ${(winRate * 100).toFixed(0)}% < 35%`;
    }

    return {
        config,
        trades: allTrades,
        totalTrades: allTrades.length,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        netPnl,
        maxDrawdown,
        profitFactor,
        winRate,
        avgHoldingDays,
        riskAdjustedScore,
        isValid,
        invalidReason
    };
}

// ============================================
// Parameter Sweep
// ============================================

export interface DayLevelSweepReport {
    allResults: DayLevelResult[];
    validResults: DayLevelResult[];
    rankedResults: DayLevelResult[];
    bestConfig: DayLevelConfig | null;
}

export async function runDayLevelSweep(
    days: number = 100
): Promise<DayLevelSweepReport> {
    console.log('='.repeat(60));
    console.log('DAY-LEVEL MEAN REVERSION SWEEP');
    console.log('Using Yahoo Finance DAILY data');
    console.log('='.repeat(60));

    // Fetch daily data for all symbols
    console.log(`\nFetching daily data for ${TEST_SYMBOLS.length} symbols...`);
    const allDailyData = new Map<string, OHLCV[]>();

    for (const symbol of TEST_SYMBOLS) {
        const data = await fetchDailyData(symbol, days);
        if (data.length > 0) {
            allDailyData.set(symbol, data);
            console.log(`  ${symbol}: ${data.length} days`);
        }
    }

    if (allDailyData.size === 0) {
        console.log('No data fetched, using simulated data...');
        // Generate simulated daily data as fallback
        for (const symbol of TEST_SYMBOLS) {
            const basePrice = {
                'RELIANCE': 2500, 'TCS': 4200, 'HDFCBANK': 1650, 'INFY': 1800,
                'ICICIBANK': 1100, 'SBIN': 780, 'BHARTIARTL': 1400, 'ITC': 480,
                'LT': 3600, 'AXISBANK': 1150
            }[symbol] || 1000;

            const dailyCandles = generateMeanRevertingDaily(symbol, basePrice, days);
            allDailyData.set(symbol, dailyCandles);
        }
    }

    // Generate all configurations
    const configs: DayLevelConfig[] = [];
    for (const atrDev of ATR_DEVIATIONS) {
        for (const holdDays of HOLDING_DAYS) {
            for (const stopAtr of STOP_ATRS) {
                configs.push({
                    atrDeviation: atrDev,
                    holdingDays: holdDays,
                    stopAtr: stopAtr,
                    targetAtr: atrDev * 0.5  // Target is 50% of entry deviation
                });
            }
        }
    }

    console.log(`\nRunning ${configs.length} configurations...`);

    const allResults: DayLevelResult[] = [];

    for (let i = 0; i < configs.length; i++) {
        const config = configs[i];
        const result = runDayLevelConfig(config, allDailyData);
        allResults.push(result);

        console.log(`[${i + 1}/${configs.length}] DEV=${config.atrDeviation} HOLD=${config.holdingDays} STOP=${config.stopAtr} | Trades: ${result.totalTrades} | PnL: ₹${result.netPnl.toFixed(0)} | Win: ${(result.winRate * 100).toFixed(0)}% | Valid: ${result.isValid ? '✓' : '✗'}`);
    }

    const validResults = allResults.filter(r => r.isValid);
    const rankedResults = [...validResults].sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Valid: ${validResults.length}/${allResults.length}`);

    if (rankedResults.length > 0) {
        const best = rankedResults[0];
        console.log(`\nBEST CONFIG:`);
        console.log(`  ATR Deviation: ${best.config.atrDeviation}`);
        console.log(`  Holding Days: ${best.config.holdingDays}`);
        console.log(`  Stop ATR: ${best.config.stopAtr}`);
        console.log(`  Score: ${best.riskAdjustedScore.toFixed(2)}`);
    }

    return {
        allResults,
        validResults,
        rankedResults,
        bestConfig: rankedResults.length > 0 ? rankedResults[0].config : null
    };
}

// ============================================
// Mean-Reverting Daily Data Generator
// ============================================

function generateMeanRevertingDaily(
    symbol: string,
    basePrice: number,
    days: number
): OHLCV[] {
    const candles: OHLCV[] = [];
    let price = basePrice;

    // Seeded random
    let seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };

    for (let i = 0; i < days; i++) {
        // Mean reversion component - price tends to return to base
        const meanPull = (basePrice - price) * 0.1;

        // Random component
        const randomMove = (random() - 0.5) * basePrice * 0.02;

        // Occasional large moves (10% chance)
        const spike = random() > 0.9 ? (random() - 0.5) * basePrice * 0.05 : 0;

        const move = meanPull + randomMove + spike;
        const close = price + move;

        const dailyVol = basePrice * 0.015;
        const open = price;
        const high = Math.max(open, close) + random() * dailyVol;
        const low = Math.min(open, close) - random() * dailyVol;
        const volume = Math.floor(500000 + random() * 500000);

        candles.push({
            symbol,
            open: Math.round(open * 100) / 100,
            high: Math.round(high * 100) / 100,
            low: Math.round(low * 100) / 100,
            close: Math.round(close * 100) / 100,
            volume
        });

        price = close;
    }

    return candles;
}

// ============================================
// Report Generator
// ============================================

export function generateDayLevelReport(report: DayLevelSweepReport): string {
    let output = `# DAY-LEVEL MEAN REVERSION REPORT\n\n`;
    output += `## Strategy Overview\n`;
    output += `- Entry: When price deviates X ATR from 20-day SMA\n`;
    output += `- Exit: TP at mean, SL at X ATR, or time-based\n`;
    output += `- Timeframe: Daily candles\n\n`;

    output += `## Results Summary\n`;
    output += `| Configs | Valid | Best Score |\n`;
    output += `|---------|-------|------------|\n`;
    output += `| ${report.allResults.length} | ${report.validResults.length} | ${report.bestConfig ? report.rankedResults[0].riskAdjustedScore.toFixed(2) : 'N/A'} |\n\n`;

    output += `## Top 10 Configurations\n\n`;
    output += `| Dev | Hold | Stop | Trades | PnL | DD | PF | Win% | Score | Valid |\n`;
    output += `|-----|------|------|--------|-----|-----|-----|------|-------|-------|\n`;

    const top10 = report.allResults
        .sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore)
        .slice(0, 10);

    for (const r of top10) {
        output += `| ${r.config.atrDeviation} | ${r.config.holdingDays} | ${r.config.stopAtr} | ${r.totalTrades} | ₹${r.netPnl.toFixed(0)} | ${(r.maxDrawdown * 100).toFixed(1)}% | ${r.profitFactor.toFixed(2)} | ${(r.winRate * 100).toFixed(0)}% | ${r.riskAdjustedScore.toFixed(2)} | ${r.isValid ? '✓' : '✗'} |\n`;
    }

    if (report.bestConfig) {
        output += `\n## OPTIMAL CONFIGURATION\n\n`;
        output += `| Parameter | Value |\n`;
        output += `|-----------|-------|\n`;
        output += `| ATR Deviation | ${report.bestConfig.atrDeviation} |\n`;
        output += `| Holding Days | ${report.bestConfig.holdingDays} |\n`;
        output += `| Stop ATR | ${report.bestConfig.stopAtr} |\n`;
    }

    return output;
}
