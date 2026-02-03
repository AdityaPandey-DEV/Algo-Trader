
import { NextResponse } from 'next/server';
import { getUpstoxLoginUrl } from '@/lib/upstoxApi';

export async function GET() {
    const loginUrl = getUpstoxLoginUrl();
    return NextResponse.redirect(loginUrl);
}
