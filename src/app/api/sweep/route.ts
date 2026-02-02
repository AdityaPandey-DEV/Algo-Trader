// Parameter Sweep API Endpoint
// Runs systematic optimization across 12 configurations

import { NextResponse } from 'next/server';
import {
    runParameterSweep,
    validateConfiguration,
    generateSweepReport
} from '@/lib/parameterSweep';

/**
 * GET /api/sweep - Run parameter sweep optimization
 * GET /api/sweep?validate=true - Also run validation on best config
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const runValidation = searchParams.get('validate') === 'true';
        const days = parseInt(searchParams.get('days') || '60');

        console.log(`Starting parameter sweep optimization (${days} days)...`);
        const startTime = Date.now();

        // Run parameter sweep
        const report = await runParameterSweep(days);

        // Optionally validate best configuration
        if (runValidation && report.bestConfig && report.rankedResults.length > 0) {
            const bestResult = report.rankedResults[0];
            const validation = await validateConfiguration(
                report.bestConfig,
                bestResult.riskAdjustedScore,
                20  // 20-day validation period
            );
            report.validationResult = validation;
        }

        // Generate markdown report
        const markdownReport = generateSweepReport(report);

        const duration = (Date.now() - startTime) / 1000;
        console.log(`Parameter sweep completed in ${duration.toFixed(2)}s`);

        // Format results for JSON response
        const formattedResults = report.allResults.map(r => ({
            atr: r.config.atrMultiplier,
            wick: r.config.wickRatio,
            maxTrades: r.config.maxTradesPerDay,
            totalTrades: r.totalTrades,
            netPnl: Math.round(r.netPnl),
            maxDrawdown: (r.maxDrawdown * 100).toFixed(1) + '%',
            profitFactor: r.profitFactor.toFixed(2),
            score: r.riskAdjustedScore.toFixed(2),
            isValid: r.isValid,
            invalidReason: r.invalidReason
        }));

        const rankedResults = report.rankedResults.map((r, i) => ({
            rank: i + 1,
            atr: r.config.atrMultiplier,
            wick: r.config.wickRatio,
            maxTrades: r.config.maxTradesPerDay,
            netPnl: Math.round(r.netPnl),
            maxDrawdown: (r.maxDrawdown * 100).toFixed(1) + '%',
            score: r.riskAdjustedScore.toFixed(2)
        }));

        return NextResponse.json({
            status: 'success',
            duration: `${duration.toFixed(2)}s`,
            summary: {
                totalConfigurations: report.allResults.length,
                validConfigurations: report.validResults.length,
                invalidConfigurations: report.allResults.length - report.validResults.length,
                bestConfig: report.bestConfig,
                validationPassed: report.validationResult?.passed
            },
            allResults: formattedResults,
            rankedResults,
            validation: report.validationResult ? {
                originalScore: report.validationResult.originalScore.toFixed(2),
                validationScore: report.validationResult.validationScore.toFixed(2),
                degradation: (report.validationResult.degradation * 100).toFixed(1) + '%',
                passed: report.validationResult.passed
            } : null,
            report: markdownReport
        });

    } catch (error) {
        console.error('Parameter sweep error:', error);
        return NextResponse.json(
            { status: 'error', message: String(error) },
            { status: 500 }
        );
    }
}

export async function POST(request: Request) {
    return GET(request);
}
