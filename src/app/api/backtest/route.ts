// Backtest API Endpoint
// Runs simulation with real Yahoo Finance data or simulated data

import { NextResponse } from 'next/server';
import {
    runBacktest,
    runBacktestWithRealData,
    generateBacktestReport,
    DEFAULT_BACKTEST_CONFIG,
    TEST_UNIVERSE
} from '@/lib/backtest';

/**
 * GET /api/backtest - Run backtest with simulated data
 * GET /api/backtest?real=true - Run backtest with real Yahoo Finance data
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const useRealData = searchParams.get('real') === 'true';
        const days = parseInt(searchParams.get('days') || '60');

        console.log(`Starting ${days}-day backtest with ${useRealData ? 'REAL' : 'simulated'} data...`);
        const startTime = Date.now();

        let result;

        if (useRealData) {
            // Run with real Yahoo Finance data
            const symbols = TEST_UNIVERSE.map(s => s.symbol);
            result = await runBacktestWithRealData(symbols, Math.min(days, 60), DEFAULT_BACKTEST_CONFIG);
        } else {
            // Run with simulated data
            result = runBacktest(TEST_UNIVERSE, days, DEFAULT_BACKTEST_CONFIG);
        }

        // Generate report
        const report = generateBacktestReport(result, DEFAULT_BACKTEST_CONFIG);

        const duration = (Date.now() - startTime) / 1000;
        console.log(`Backtest completed in ${duration.toFixed(2)}s`);

        return NextResponse.json({
            status: 'success',
            dataSource: useRealData ? 'Yahoo Finance (Real)' : 'Simulated',
            daysRequested: days,
            duration: `${duration.toFixed(2)}s`,
            summary: {
                netPnl: result.netSystemPnl,
                netPnlPct: (result.netSystemPnl / DEFAULT_BACKTEST_CONFIG.initialCapital * 100).toFixed(2) + '%',
                profitableDays: result.totalProfitableDays,
                losingDays: result.totalLosingDays,
                flatDays: result.totalFlatDays,
                profitableDaysPct: result.profitableDaysPct.toFixed(1) + '%',
                profitFactor: result.profitFactor === Infinity ? 'N/A' : result.profitFactor.toFixed(2),
                maxDrawdown: (result.maxDrawdown * 100).toFixed(2) + '%',
                sharpeRatio: result.sharpeRatio.toFixed(2),
                expectancyPerDay: result.expectancyPerDay.toFixed(2)
            },
            stockResults: result.stockResults,
            report
        });

    } catch (error) {
        console.error('Backtest error:', error);
        return NextResponse.json(
            { status: 'error', message: String(error) },
            { status: 500 }
        );
    }
}

export async function POST(request: Request) {
    return GET(request);
}
