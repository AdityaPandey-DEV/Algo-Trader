
import { NextResponse } from 'next/server';
import { loadToken, hasToken } from '@/lib/redis';
import { isUpstoxAuthenticatedAsync } from '@/lib/upstoxApi';
import { isDhanConfigured, getBalance as getDhanBalance } from '@/lib/dhanApi';

export async function GET() {
    try {
        const hasRedisToken = await hasToken();
        const redisToken = await loadToken();
        const inMemoryAuth = await isUpstoxAuthenticatedAsync();

        // Check ALL possible Redis environment variables
        const redisEnvVars = {
            // Vercel KV (Upstash) integration names
            KV_URL: process.env.KV_URL ? '✅ Set' : '❌ Not set',
            KV_REST_API_URL: process.env.KV_REST_API_URL ? '✅ Set' : '❌ Not set',
            KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ? '✅ Set' : '❌ Not set',
            // Standard Upstash names
            UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ? '✅ Set' : '❌ Not set',
            UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ? '✅ Set' : '❌ Not set',
            // Other possible names
            REDIS_URL: process.env.REDIS_URL ? '✅ Set' : '❌ Not set',
            REDIS_REST_URL: process.env.REDIS_REST_URL ? '✅ Set' : '❌ Not set',
        };

        // Find all env vars containing relevant keywords
        const allRedisRelated = Object.keys(process.env)
            .filter(k => k.includes('REDIS') || k.includes('KV') || k.includes('UPSTASH'))
            .map(k => `${k}=${process.env[k]?.substring(0, 20)}...`);

        const upstoxEnvVars = {
            UPSTOX_API_KEY: process.env.UPSTOX_API_KEY ? '✅ Set' : '❌ Not set',
            UPSTOX_API_SECRET: process.env.UPSTOX_API_SECRET ? '✅ Set' : '❌ Not set',
            UPSTOX_REDIRECT_URI: process.env.UPSTOX_REDIRECT_URI || 'Not set (using default)'
        };

        // Test Dhan API
        const dhanConfigured = isDhanConfigured();
        let dhanBalance = null;
        let dhanError = null;
        let dhanRawResponse = null;

        if (dhanConfigured) {
            try {
                // Make a direct API call to see the raw response
                const dhanUrl = 'https://api.dhan.co/v2/fundlimit';
                const dhanHeaders = {
                    'access-token': process.env.DHAN_ACCESS_TOKEN || '',
                    'client-id': process.env.DHAN_CLIENT_ID || '',
                    'Content-Type': 'application/json'
                };

                const rawResponse = await fetch(dhanUrl, {
                    method: 'GET',
                    headers: dhanHeaders
                });

                const rawText = await rawResponse.text();
                dhanRawResponse = {
                    status: rawResponse.status,
                    statusText: rawResponse.statusText,
                    body: rawText.substring(0, 500)
                };

                // Also get via wrapper function
                dhanBalance = await getDhanBalance();
            } catch (e) {
                dhanError = String(e);
            }
        }

        return NextResponse.json({
            status: 'debug',
            dhan: {
                configured: dhanConfigured,
                clientIdSet: process.env.DHAN_CLIENT_ID ? '✅ Set' : '❌ Not set',
                accessTokenSet: process.env.DHAN_ACCESS_TOKEN ? '✅ Set' : '❌ Not set',
                balance: dhanBalance,
                rawResponse: dhanRawResponse,
                error: dhanError
            },
            redis: {
                hasToken: hasRedisToken,
                tokenPreview: redisToken ? redisToken.substring(0, 15) + '...' : null,
                envVars: redisEnvVars,
                allRelatedEnvVars: allRedisRelated
            },
            memory: {
                isAuthenticated: inMemoryAuth
            },
            upstox: upstoxEnvVars,
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
