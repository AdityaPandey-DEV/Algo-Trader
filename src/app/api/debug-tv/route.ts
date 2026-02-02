// Debug endpoint to test data loading
import { NextResponse } from 'next/server';
import { loadAllTVData, getTVDataSummary } from '@/lib/tvDataLoader';

export async function GET() {
    try {
        console.log('Starting data load...');
        const summary = getTVDataSummary();
        console.log('Summary:', summary);

        if (!summary.available) {
            return NextResponse.json({ error: 'No data available', summary });
        }

        console.log('Loading all TV data...');
        const data = loadAllTVData();
        console.log(`Loaded ${data.size} symbols`);

        const symbolSummary: Record<string, { days: number; totalCandles: number }> = {};

        for (const [symbol, dayData] of data) {
            const totalCandles = dayData.reduce((sum, day) => sum + day.length, 0);
            symbolSummary[symbol] = {
                days: dayData.length,
                totalCandles
            };
        }

        return NextResponse.json({
            status: 'success',
            summary,
            symbolCount: data.size,
            symbolSummary
        });
    } catch (error) {
        console.error('Error:', error);
        return NextResponse.json({
            error: 'Failed to load data',
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        }, { status: 500 });
    }
}
