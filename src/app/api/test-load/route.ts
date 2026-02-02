// Simple data load test
import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export async function GET(request: Request) {
    const startTime = Date.now();
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'RELIANCE';

    try {
        const filePath = join(process.cwd(), 'data', 'tv_data', `${symbol}.json`);

        console.log(`Reading ${symbol}...`);
        const readStart = Date.now();
        const rawData = readFileSync(filePath, 'utf-8');
        const readTime = Date.now() - readStart;

        console.log(`Parsing ${symbol}...`);
        const parseStart = Date.now();
        const data = JSON.parse(rawData);
        const parseTime = Date.now() - parseStart;

        const dayCount = Object.keys(data.days || {}).length;
        const firstDay = Object.keys(data.days || {})[0];
        const firstDayCandles = data.days[firstDay]?.length || 0;

        const elapsed = Date.now() - startTime;

        return NextResponse.json({
            status: 'success',
            symbol,
            timing: {
                total: `${elapsed}ms`,
                read: `${readTime}ms`,
                parse: `${parseTime}ms`
            },
            data: {
                days: dayCount,
                firstDay,
                firstDayCandles,
                fileSize: `${(rawData.length / 1024).toFixed(0)}KB`
            }
        });
    } catch (error) {
        return NextResponse.json({
            error: 'Failed',
            message: error instanceof Error ? error.message : 'Unknown',
            elapsed: `${Date.now() - startTime}ms`
        }, { status: 500 });
    }
}
