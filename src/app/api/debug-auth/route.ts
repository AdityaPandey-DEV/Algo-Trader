
import { NextResponse } from 'next/server';
import { loadToken, hasToken } from '@/lib/redis';
import { isUpstoxAuthenticated } from '@/lib/upstoxApi';

export async function GET() {
    try {
        const hasRedisToken = await hasToken();
        const redisToken = await loadToken();
        const inMemoryAuth = isUpstoxAuthenticated();

        // Check environment variables (redacted)
        const envVars = {
            UPSTOX_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ? '✅ Set' : '❌ Not set',
            UPSTOX_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ? '✅ Set' : '❌ Not set',
            KV_REST_API_URL: process.env.KV_REST_API_URL ? '✅ Set' : '❌ Not set',
            KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ? '✅ Set' : '❌ Not set',
            UPSTOX_API_KEY: process.env.UPSTOX_API_KEY ? '✅ Set' : '❌ Not set',
            UPSTOX_API_SECRET: process.env.UPSTOX_API_SECRET ? '✅ Set' : '❌ Not set',
            UPSTOX_REDIRECT_URI: process.env.UPSTOX_REDIRECT_URI || 'Not set (using default)'
        };

        return NextResponse.json({
            status: 'debug',
            redis: {
                hasToken: hasRedisToken,
                tokenPreview: redisToken ? redisToken.substring(0, 15) + '...' : null
            },
            memory: {
                isAuthenticated: inMemoryAuth
            },
            environment: envVars,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        return NextResponse.json({
            status: 'error',
            error: String(error),
            timestamp: new Date().toISOString()
        }, { status: 500 });
    }
}
