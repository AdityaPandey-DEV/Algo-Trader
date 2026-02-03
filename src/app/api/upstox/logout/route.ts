
import { NextResponse } from 'next/server';
import { clearToken } from '@/lib/redis';

export async function GET() {
    try {
        await clearToken();

        // Also clear in-memory token (by importing and resetting)
        // This forces a fresh login

        return NextResponse.json({
            success: true,
            message: 'Token cleared from Redis. Please login again at /api/upstox/login'
        });
    } catch (error) {
        return NextResponse.json({
            success: false,
            error: String(error)
        }, { status: 500 });
    }
}
