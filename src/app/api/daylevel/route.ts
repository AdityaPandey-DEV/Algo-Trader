// Day-Level Parameter Sweep API Endpoint
// Runs mean reversion optimization on daily Yahoo data

import { NextResponse } from 'next/server';
import {
    runDayLevelSweep,
    generateDayLevelReport
} from '@/lib/dayLevelStrategy';

/**
 * GET /api/daylevel - Run day-level mean reversion sweep
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const days = parseInt(searchParams.get('days') || '100');

        console.log(`Starting day-level parameter sweep (${days} days)...`);
        const startTime = Date.now();

        // Run sweep
        const report = await runDayLevelSweep(days);

        // Generate markdown report
        const markdownReport = generateDayLevelReport(report);

        const duration = (Date.now() - startTime) / 1000;
        console.log(`Day-level sweep completed in ${duration.toFixed(2)}s`);

        // Format results
        const formattedResults = report.allResults.map(r => ({
            deviation: r.config.atrDeviation,
            holdDays: r.config.holdingDays,
            stopAtr: r.config.stopAtr,
            trades: r.totalTrades,
            netPnl: Math.round(r.netPnl),
            maxDrawdown: (r.maxDrawdown * 100).toFixed(1) + '%',
            profitFactor: r.profitFactor.toFixed(2),
            winRate: (r.winRate * 100).toFixed(0) + '%',
            avgHold: r.avgHoldingDays.toFixed(1),
            score: r.riskAdjustedScore.toFixed(2),
            isValid: r.isValid,
            invalidReason: r.invalidReason
        }));

        const rankedResults = report.rankedResults.slice(0, 5).map((r, i) => ({
            rank: i + 1,
            deviation: r.config.atrDeviation,
            holdDays: r.config.holdingDays,
            stopAtr: r.config.stopAtr,
            netPnl: Math.round(r.netPnl),
            winRate: (r.winRate * 100).toFixed(0) + '%',
            score: r.riskAdjustedScore.toFixed(2)
        }));

        return NextResponse.json({
            status: 'success',
            duration: `${duration.toFixed(2)}s`,
            summary: {
                totalConfigurations: report.allResults.length,
                validConfigurations: report.validResults.length,
                bestConfig: report.bestConfig
            },
            allResults: formattedResults,
            rankedResults,
            report: markdownReport
        });

    } catch (error) {
        console.error('Day-level sweep error:', error);
        return NextResponse.json(
            { status: 'error', message: String(error) },
            { status: 500 }
        );
    }
}

export async function POST(request: Request) {
    return GET(request);
}
