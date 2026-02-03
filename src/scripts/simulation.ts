
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables immediately
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { fetchHistoricalCandles, loadTokenAsync, isUpstoxAuthenticatedAsync } from '../lib/upstoxApi';
import { detectMarketRegime, calculateATR } from '../lib/regimeDetection';
import { calculatePositionSize } from '../lib/riskEngine';
import * as fs from 'fs';

// Trade Interface for Simulation
interface SimTrade {
    symbol: string;
    entryTime: string;
    exitTime?: string;
    entryPrice: number;
    exitPrice?: number;
    side: 'LONG' | 'SHORT';
    qty: number;
    pnl?: number;
    reason: string;
}

const SYMBOLS = ['RELIANCE', 'HDFCBANK', 'INFY', 'TCS', 'ICICIBANK'];
const INDICES = ['NIFTYBEES', 'BANKBEES']; // Proxies for NIFTY/BANKNIFTY

async function runSimulation() {
    console.log('🚀 Starting 10-Day Historical Simulation...');

    // 1. Auth Check
    await loadTokenAsync();
    if (!await isUpstoxAuthenticatedAsync()) {
        console.error('❌ Upstox not authenticated. Please login via Dashboard first.');
        process.exit(1);
    }
    console.log('✅ Upstox Authenticated');

    // 2. Date Range (Last 10 days)
    const today = new Date();
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(today.getDate() - 15); // Buffer for weekends

    const toDate = today.toISOString().split('T')[0];
    const fromDate = tenDaysAgo.toISOString().split('T')[0];

    console.log(`📅 Fetching data from ${fromDate} to ${toDate}...`);

    const marketData: Record<string, any[]> = {};

    // 3. Fetch Data
    for (const sym of [...SYMBOLS, ...INDICES]) {
        console.log(`   Fetching ${sym}...`);
        const candles = await fetchHistoricalCandles(sym, fromDate, toDate);
        if (candles.length > 0) {
            marketData[sym] = candles;
            console.log(`   ✅ ${sym}: ${candles.length} candles`);
        } else {
            console.warn(`   ⚠️ ${sym}: No data found`);
        }
    }

    // 4. Simulation Loop
    console.log('\n🔄 Running Replay Simulation...');

    // We assume data is aligned broadly by time. Real simulation requires precise timestamp alignment.
    // For simplicity, we process each stock independently for this test to verify ENGINE logic.

    const results: any[] = [];
    const trades: SimTrade[] = [];

    for (const sym of SYMBOLS) {
        console.log(`\nAnalyzing ${sym}...`);
        const candles = marketData[sym] || [];
        if (candles.length < 100) continue;

        let activeTrade: SimTrade | null = null;
        let capital = 100000; // Simulated capital per stock

        // Iterate through candles (simulating live feed)
        // Start from index 50 to have enough history for indicators
        for (let i = 50; i < candles.length; i++) {
            const history = candles.slice(0, i + 1); // Current simulated history
            const currentCandle = candles[i];
            const prevCandle = candles[i - 1];

            // 1. Detect Regime (V2 Engine)
            const regime = detectMarketRegime(history);

            // 2. Generate Signals (V3 Logic Mockup - typically in intradayEngine)
            // Logic: If Trending Strong + Price > EMA20 + Volume Spike -> LONG
            // Simple mockup to verify "can trade" logic

            if (activeTrade) {
                // Exit Logic
                // 1. Stop Loss: 1%
                // 2. Target: 2%
                // 3. End of Day (3:15 PM)

                const time = new Date(currentCandle.time).toLocaleTimeString('en-IN', { hour12: false });
                const isEOD = time >= '15:15';

                let exitPrice = 0;
                let reason = '';

                if (activeTrade.side === 'LONG') {
                    if (currentCandle.low <= activeTrade.entryPrice * 0.99) {
                        exitPrice = activeTrade.entryPrice * 0.99;
                        reason = 'Stop Loss';
                    } else if (currentCandle.high >= activeTrade.entryPrice * 1.02) {
                        exitPrice = activeTrade.entryPrice * 1.02;
                        reason = 'Target';
                    } else if (isEOD) {
                        exitPrice = currentCandle.close;
                        reason = 'EOD';
                    }
                }

                if (exitPrice > 0) {
                    trades.push({
                        ...activeTrade,
                        exitTime: currentCandle.time,
                        exitPrice,
                        pnl: (exitPrice - activeTrade.entryPrice) * activeTrade.qty * (activeTrade.side === 'SHORT' ? -1 : 1),
                        reason
                    });
                    activeTrade = null;
                }
            } else {
                // Entry Logic
                if (regime.shouldTrade && regime.regime === 'TRENDING') {
                    // Trend Following Entry
                    const atr = calculateATR(history);
                    const isGreen = currentCandle.close > currentCandle.open;
                    const breakout = currentCandle.close > prevCandle.high;

                    if (isGreen && breakout) {
                        // LONG
                        const stopLoss = currentCandle.low - atr;
                        const qty = calculatePositionSize(capital, currentCandle.close, stopLoss);

                        if (qty > 0) {
                            activeTrade = {
                                symbol: sym,
                                entryTime: currentCandle.time,
                                entryPrice: currentCandle.close,
                                side: 'LONG',
                                qty,
                                reason: `Trend Follow (${regime.strength})`
                            };
                        }
                    }
                }
            }
        }
    }

    // 5. Report
    console.log('\n📊 Simulation Complete.');
    console.log(`Total Trades: ${trades.length}`);
    const winningTrades = trades.filter(t => (t.pnl || 0) > 0);
    console.log(`Win Rate: ${((winningTrades.length / trades.length) * 100).toFixed(1)}%`);

    // Save to Markdown
    let md = '# 10-Day Historical Simulation Report\n\n';
    md += `**Date:** ${new Date().toLocaleString()}\n`;
    md += `**Symbols:** ${SYMBOLS.join(', ')}\n\n`;
    md += '## Performance Summary\n';
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| Total Trades | ${trades.length} |\n`;
    md += `| Win Rate | ${((winningTrades.length / trades.length) * 100).toFixed(1)}% |\n\n`;

    md += '## Trade Log (Last 20)\n';
    md += '| Symbol | Date | Side | Entry | Exit | PnL | Reason |\n|---|---|---|---|---|---|---|\n';
    trades.slice(-20).forEach(t => {
        md += `| ${t.symbol} | ${new Date(t.entryTime).toLocaleString()} | ${t.side} | ${t.entryPrice.toFixed(2)} | ${t.exitPrice?.toFixed(2)} | ${t.pnl?.toFixed(2)} | ${t.reason} |\n`;
    });

    const reportPath = path.join(process.cwd(), 'simulation_results.md');
    fs.writeFileSync(reportPath, md);
    console.log(`✅ Report saved to: ${reportPath}`);
}

runSimulation().catch(console.error);
