#!/usr/bin/env python3
"""
TVDatafeed Daily Data Exporter - For Extended Historical Testing
Fetches NSE DAILY data for 20 symbols going back several years
"""

import json
import os
from datetime import datetime
from pathlib import Path

try:
    from tvDatafeed import TvDatafeed, Interval
except ImportError:
    print("Installing tvdatafeed...")
    os.system("pip install git+https://github.com/rongardF/tvdatafeed.git")
    from tvDatafeed import TvDatafeed, Interval

# Extended list of liquid NSE stocks (20 symbols)
SYMBOLS = [
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK",
    "SBIN", "BHARTIARTL", "ITC", "LT", "AXISBANK",
    "KOTAKBANK", "WIPRO", "MARUTI", "TITAN", "SUNPHARMA",
    "BAJFINANCE", "NESTLEIND", "TATASTEEL", "POWERGRID", "ADANIENT"
]

# Output directory
OUTPUT_DIR = Path(__file__).parent.parent / "data" / "tv_data_daily"
BARS_PER_SYMBOL = 5000  # Daily bars = ~5000 trading days (~20 years)


def fetch_symbol_data(tv: TvDatafeed, symbol: str, bars: int = BARS_PER_SYMBOL) -> list:
    """Fetch DAILY data for a symbol from TradingView"""
    try:
        print(f"Fetching {symbol} DAILY ({bars} bars)...")
        df = tv.get_hist(
            symbol=symbol,
            exchange="NSE",
            interval=Interval.in_daily,  # Daily interval
            n_bars=bars
        )
        
        if df is None or df.empty:
            print(f"  No data for {symbol}")
            return []
        
        candles = []
        for idx, row in df.iterrows():
            candles.append({
                "symbol": symbol,
                "timestamp": idx.isoformat(),
                "open": round(row["open"], 2),
                "high": round(row["high"], 2),
                "low": round(row["low"], 2),
                "close": round(row["close"], 2),
                "volume": int(row["volume"])
            })
        
        print(f"  Got {len(candles)} DAILY candles for {symbol}")
        if candles:
            first_date = candles[0]["timestamp"][:10]
            last_date = candles[-1]["timestamp"][:10]
            print(f"  Date range: {first_date} to {last_date}")
        return candles
        
    except Exception as e:
        print(f"  Error fetching {symbol}: {e}")
        return []


def main():
    """Main function to fetch and export daily data"""
    print("=" * 60)
    print("TVDatafeed NSE DAILY Data Exporter")
    print(f"Symbols: {len(SYMBOLS)}")
    print(f"Bars per symbol: {BARS_PER_SYMBOL}")
    print("=" * 60)
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    tv = TvDatafeed()
    
    all_data = {}
    summary = {
        "fetched_at": datetime.now().isoformat(),
        "interval": "daily",
        "symbols": {},
        "total_candles": 0
    }
    
    for symbol in SYMBOLS:
        candles = fetch_symbol_data(tv, symbol)
        
        if candles:
            all_data[symbol] = candles
            
            summary["symbols"][symbol] = {
                "total_candles": len(candles),
                "date_range": f"{candles[0]['timestamp'][:10]} to {candles[-1]['timestamp'][:10]}"
            }
            summary["total_candles"] += len(candles)
            
            symbol_file = OUTPUT_DIR / f"{symbol}.json"
            with open(symbol_file, "w") as f:
                json.dump({"symbol": symbol, "candles": candles}, f, indent=2)
            print(f"  Saved to {symbol_file}")
    
    # Save summary
    summary_file = OUTPUT_DIR / "summary.json"
    with open(summary_file, "w") as f:
        json.dump(summary, f, indent=2)
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Symbols fetched: {len(summary['symbols'])}")
    print(f"Total candles: {summary['total_candles']:,}")
    print(f"Output directory: {OUTPUT_DIR}")
    
    return summary


if __name__ == "__main__":
    main()
