// Yahoo Finance source — regression tests
// Uses Node.js built-in test runner (node:test) — no extra dependencies
//
// Regression: https://github.com/msrishav-28/Crucix/commit/ef2c5ed
// The previous implementation tracked ETF proxies (SPY, QQQ, DIA, IWM) as a
// stand-in for the broad market indexes and labelled SPY as "S&P 500". That
// produced misleading quotes on the dashboard because an ETF does not equal
// its underlying index (different prices, different open/close, no live
// intraday print for the index itself).
//
// The fix switched to the actual index symbols (^GSPC, ^IXIC, ^DJI, ^RUT).
// These tests lock in that mapping so the ETF symbols can never silently
// reappear in the index group again.
//
// Tests use `node --test test/yfinance.test.mjs` (the repo-wide convention).

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { collect } from '../apis/sources/yfinance.mjs';

// ─── Helpers ───

// Build a minimal Yahoo Finance /v8/finance/chart payload that safeFetch +
// fetchQuote know how to parse.
function buildChartPayload(symbol, { price, prevClose, shortName }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            shortName,
            currency: 'USD',
            exchangeName: 'SNP',
            marketState: 'REGULAR',
            regularMarketPrice: price,
            chartPreviousClose: prevClose,
          },
          timestamp: [now - 86400, now],
          indicators: {
            quote: [{ close: [prevClose, price] }],
          },
        },
      ],
      error: null,
    },
  };
}

// Mock globalThis.fetch to return a yfinance-shaped response for every symbol
// the module asks about. The symbol is parsed out of the URL so we can
// return the right payload per call. Every symbol reports a distinct
// shortName ("UNMAPPED ...") so we can prove the module's SYMBOLS table —
// not Yahoo's metadata — is what sets the display name.
function mockYahooFetch(overrides = {}) {
  return mock.fn((url) => {
    const match = String(url).match(/\/v8\/finance\/chart\/([^?]+)/);
    const symbol = match ? decodeURIComponent(match[1]) : 'UNKNOWN';
    const payload = overrides[symbol] ?? buildChartPayload(symbol, {
      price: 100,
      prevClose: 99,
      shortName: `UNMAPPED ${symbol}`,
    });
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(payload)),
    });
  });
}

// ─── Tests ───

describe('yfinance — index symbol regression (ef2c5ed)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should map '^GSPC' to 'S&P 500'", async () => {
    globalThis.fetch = mockYahooFetch({
      '^GSPC': buildChartPayload('^GSPC', {
        price: 5123.45,
        prevClose: 5100,
        // Yahoo's own shortName for ^GSPC is "S&P 500 INDEX". We deliberately
        // return something different so a passing test proves the name came
        // from the module's SYMBOLS table, not from the upstream payload.
        shortName: 'S&P 500 INDEX (from upstream)',
      }),
    });

    const out = await collect();

    const gspc = out.quotes['^GSPC'];
    assert.ok(gspc, 'expected a quote entry for ^GSPC');
    assert.equal(gspc.error, undefined, `^GSPC fetch failed: ${gspc.error}`);
    assert.equal(
      gspc.name,
      'S&P 500',
      "^GSPC must be labelled 'S&P 500' (not the ETF proxy label or upstream shortName)",
    );
    assert.equal(gspc.symbol, '^GSPC');
    assert.equal(gspc.price, 5123.45);
    assert.equal(gspc.prevClose, 5100);
  });

  it("should include ^GSPC (and not SPY) in the indexes group with 'S&P 500' as its name", async () => {
    globalThis.fetch = mockYahooFetch();

    const out = await collect();

    const sp500 = out.indexes.find((q) => q.name === 'S&P 500');
    assert.ok(sp500, "'S&P 500' entry missing from indexes group");
    assert.equal(
      sp500.symbol,
      '^GSPC',
      "'S&P 500' must be backed by the ^GSPC index symbol, not the SPY ETF",
    );

    const indexSymbols = out.indexes.map((q) => q.symbol);
    assert.deepEqual(
      indexSymbols,
      ['^GSPC', '^IXIC', '^DJI', '^RUT'],
      'indexes group must use the actual index symbols, not ETF proxies',
    );

    // Double-check none of the pre-fix ETF proxies leaked back in anywhere.
    for (const etf of ['SPY', 'QQQ', 'DIA', 'IWM']) {
      assert.equal(
        out.quotes[etf],
        undefined,
        `ETF proxy '${etf}' must not be tracked after ef2c5ed`,
      );
    }
  });

  it('should request the URL-encoded ^GSPC symbol from Yahoo', async () => {
    const fetchMock = mockYahooFetch();
    globalThis.fetch = fetchMock;

    await collect();

    const gspcCall = fetchMock.mock.calls.find((call) =>
      String(call.arguments[0]).includes('%5EGSPC'),
    );
    assert.ok(
      gspcCall,
      'expected a request for the URL-encoded ^GSPC symbol (%5EGSPC); the ^ must be encoded so Yahoo returns the index, not a ticker starting with GSPC',
    );
  });
});
