/**
 * Upstash Redis Client for token persistence
 * Environment variables (Vercel automatically sets these when you add Upstash integration):
 * - UPSTASH_REDIS_REST_URL or KV_REST_API_URL
 * - UPSTASH_REDIS_REST_TOKEN or KV_REST_API_TOKEN
 */

import { Redis } from '@upstash/redis';

// Create Redis client (lazy initialization)
let redis: Redis | null = null;
let redisInitAttempted = false;

function getRedis(): Redis | null {
    if (redis) return redis;
    if (redisInitAttempted) return null; // Don't retry if already failed

    redisInitAttempted = true;

    // Check for multiple possible env var names (Vercel uses different names)
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

    if (!url || !token) {
        console.warn('⚠️ Redis not configured. Available env vars:',
            Object.keys(process.env).filter(k => k.includes('REDIS') || k.includes('KV') || k.includes('UPSTASH')).join(', ') || 'NONE');
        return null;
    }

    console.log('🔗 Initializing Redis connection...');
    redis = new Redis({ url, token });
    return redis;
}

// Token keys
const UPSTOX_TOKEN_KEY = 'upstox:access_token';
const UPSTOX_EXPIRY_KEY = 'upstox:token_expiry';

/**
 * Save Upstox token to Redis with 24-hour expiry
 */
export async function saveToken(token: string): Promise<boolean> {
    const client = getRedis();
    if (!client) return false;

    try {
        const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
        await client.set(UPSTOX_TOKEN_KEY, token, { ex: 86400 }); // 24h TTL
        await client.set(UPSTOX_EXPIRY_KEY, expiry.toString(), { ex: 86400 });
        console.log('💾 Saved Upstox token to Redis');
        return true;
    } catch (e) {
        console.error('Redis save error:', e);
        return false;
    }
}

/**
 * Load Upstox token from Redis
 */
export async function loadToken(): Promise<string | null> {
    const client = getRedis();
    if (!client) return null;

    try {
        const token = await client.get<string>(UPSTOX_TOKEN_KEY);
        if (token) {
            console.log('✅ Loaded Upstox token from Redis');
            return token;
        }
        return null;
    } catch (e) {
        console.error('Redis load error:', e);
        return null;
    }
}

/**
 * Check if token exists in Redis
 */
export async function hasToken(): Promise<boolean> {
    const client = getRedis();
    if (!client) return false;

    try {
        const exists = await client.exists(UPSTOX_TOKEN_KEY);
        return exists === 1;
    } catch (e) {
        console.error('Redis check error:', e);
        return false;
    }
}

/**
 * Clear token from Redis (logout)
 */
export async function clearToken(): Promise<void> {
    const client = getRedis();
    if (!client) return;

    try {
        await client.del(UPSTOX_TOKEN_KEY);
        await client.del(UPSTOX_EXPIRY_KEY);
        console.log('🗑️ Cleared Upstox token from Redis');
    } catch (e) {
        console.error('Redis clear error:', e);
    }
}
