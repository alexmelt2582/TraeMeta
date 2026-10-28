import assert from "node:assert/strict";
import test from "node:test";

import {
  computeTodayUsage,
  fetchTraeTodayUsage,
  getTraeAuthContext,
  parseTraeAccountInsights,
  shanghaiDayKey,
} from "../src/lib/trae-insights.js";

function pack({
  productType,
  fastLimit = 0,
  fastUsed = 0,
  basicLimit = 0,
  basicUsed = 0,
  endTime = 1790783999,
  soloParallelLimit = 2,
  displayDesc = "免费",
} = {}) {
  return {
    display_desc: displayDesc,
    entitlement_base_info: {
      product_type: productType,
      end_time: endTime,
      quota: {
        premium_model_fast_request_limit: fastLimit,
        basic_usage_limit: basicLimit,
        solo_agent_parallel_limit: soloParallelLimit,
      },
    },
    usage: {
      premium_model_fast_amount: fastUsed,
      basic_usage_amount: basicUsed,
    },
    is_hide: false,
    status: 1,
  };
}

test("CN free plan exposes plan, fast usage, and reset state", () => {
  const insights = parseTraeAccountInsights({
    payStatus: {
      user_pay_identity_str: "Free",
      detail: { fast_request_per: 0, can_get_express_status: 0 },
    },
    usageResponse: {
      user_entitlement_pack_list: [pack({ productType: 0 })],
    },
    now: 1_800_000_000_000,
  });
  assert.equal(insights.plan, "Free");
  assert.equal(insights.quota.model, "fast_request");
  assert.equal(insights.quota.fastLimit, 0);
  assert.equal(insights.quota.fastUsed, 0);
  assert.equal(insights.quota.fastAvailable, 0);
  assert.equal(insights.quota.fastPerMonth, 0);
  assert.equal(insights.quota.soloParallelLimit, 2);
  assert.equal(insights.resetAt, new Date(1790784000 * 1000).toISOString());
});

test("v2 credits summary exposes the same remaining balance shown by TRAE", () => {
  const insights = parseTraeAccountInsights({
    payStatus: { user_pay_identity_str: "Free", detail: {} },
    usageResponse: {
      is_credits_billing: true,
      usage_summary: {
        total_amount: 5200,
        consumed_amount: 5050,
      },
      user_entitlement_pack_list: [
        pack({
          productType: 2,
          basicLimit: 0,
          displayDesc: "签到奖励",
        }),
        {
          ...pack({
            productType: 2,
            basicLimit: 0,
            displayDesc: "签到奖励",
          }),
          entitlement_base_info: {
            product_type: 2,
            end_time: 1791940585,
            quota: { credits_limit: 150 },
          },
          usage: { credits_amount: 0 },
        },
      ],
    },
  });
  assert.equal(insights.plan, "Free");
  assert.equal(insights.quota.model, "credits");
  assert.equal(insights.credits.total, 5200);
  assert.equal(insights.credits.used, 5050);
  assert.equal(insights.credits.remaining, 150);
  assert.equal(insights.quota.usageExhausted, false);
});

test("fast request remaining balance is derived from quota and usage", () => {
  const insights = parseTraeAccountInsights({
    payStatus: { user_pay_identity_str: "CNExpress", detail: {} },
    usageResponse: {
      user_entitlement_pack_list: [
        pack({
          productType: 100,
          fastLimit: 100,
          fastUsed: 20,
          displayDesc: "速通",
        }),
      ],
    },
  });
  assert.equal(insights.plan, "CNExpress");
  assert.equal(insights.quota.fastLimit, 100);
  assert.equal(insights.quota.fastUsed, 20);
  assert.equal(insights.quota.fastAvailable, 80);
  assert.equal(insights.quota.usageExhausted, false);
});

test("USD quota is exposed when no fast request balance exists", () => {
  const insights = parseTraeAccountInsights({
    payStatus: { user_pay_identity_str: "Pro" },
    usageResponse: {
      user_entitlement_pack_list: [
        pack({
          productType: 1,
          fastLimit: null,
          basicLimit: 50,
          basicUsed: 12,
        }),
      ],
    },
  });
  assert.equal(insights.plan, "Pro");
  assert.equal(insights.quota.model, "usd");
  assert.equal(insights.quota.basicUsage, 12);
  assert.equal(insights.quota.basicQuota, 50);
});

test("missing balance data remains unknown instead of inventing a value", () => {
  const insights = parseTraeAccountInsights({
    payStatus: null,
    usageResponse: { user_entitlement_pack_list: [] },
  });
  assert.equal(insights.plan, "未知套餐");
  assert.equal(insights.quota.model, "unknown");
  assert.equal(insights.quota.fastAvailable, null);
  assert.equal(insights.quota.basicQuota, null);
});

test("auth context exposes the account user id for per-account requests", () => {
  const context = getTraeAuthContext({
    keys: {
      "iCubeAuthInfo://icube.cloudide": JSON.stringify({
        accessToken: "test-token",
        userId: "2504031931479881",
        loginHost: "api.trae.cn",
      }),
    },
  });

  assert.equal(context.accessToken, "test-token");
  assert.equal(context.userId, "2504031931479881");
  assert.equal(context.host, "https://api.trae.cn");
});

test("Shanghai day key follows the Beijing calendar day", () => {
  // 2026-10-28 12:00 +08:00 == 04:00 UTC; 2026-10-28 07:00 +08:00 stays the same day.
  assert.equal(shanghaiDayKey(Date.UTC(2026, 9, 28, 4, 0, 0)), "2026-10-28");
  assert.equal(shanghaiDayKey(Date.UTC(2026, 9, 27, 16, 0, 0)), "2026-10-28");
  assert.equal(shanghaiDayKey(Date.UTC(2026, 9, 27, 15, 59, 0)), "2026-10-27");
});

test("today usage grows from the same-day baseline", () => {
  const now = Date.UTC(2026, 9, 28, 4, 0, 0);
  const { todayUsage, baseline } = computeTodayUsage(
    { date: "2026-10-28", consumed: 100 },
    { used: 150 },
    { now },
  );
  assert.deepEqual(todayUsage, { date: "2026-10-28", amount: 50, estimated: true });
  assert.deepEqual(baseline, { date: "2026-10-28", consumed: 100 });
});

test("today usage restarts with a fresh baseline on a new day", () => {
  const now = Date.UTC(2026, 9, 28, 4, 0, 0);
  const first = computeTodayUsage(
    { date: "2026-10-27", consumed: 3000 },
    { used: 3100 },
    { now },
  );
  assert.equal(first.todayUsage.amount, 0);
  assert.deepEqual(first.baseline, { date: "2026-10-28", consumed: 3100 });
  const later = computeTodayUsage(first.baseline, { used: 3120.5 }, { now });
  assert.equal(later.todayUsage.amount, 20.5);
});

test("a dropping period counter means the billing period reset today", () => {
  const now = Date.UTC(2026, 9, 28, 4, 0, 0);
  const { todayUsage, baseline } = computeTodayUsage(
    { date: "2026-10-28", consumed: 3600 },
    { used: 42 },
    { now },
  );
  assert.equal(todayUsage.amount, 42);
  assert.deepEqual(baseline, { date: "2026-10-28", consumed: 42 });
});

test("today usage is unavailable without a finite period counter", () => {
  const now = Date.UTC(2026, 9, 28, 4, 0, 0);
  assert.deepEqual(computeTodayUsage(null, null, { now }), {
    todayUsage: null,
    baseline: null,
  });
  assert.deepEqual(computeTodayUsage(null, { unlimited: true, used: -1 }, { now }), {
    todayUsage: null,
    baseline: null,
  });
});

const USAGE_CONTEXT = { host: "https://api.trae.cn", accessToken: "jwt-token" };
const usageRow = (credits) => ({ credits_float: credits, model_name: "GLM-5.3-Flash" });

test("today usage sums the server's paged usage records", async () => {
  const now = Date.UTC(2026, 9, 28, 4, 0, 0);
  const pages = [
    { total: 3, user_usage_group_by_sessions: [usageRow(1.9), usageRow(2.5)] },
    { total: 3, user_usage_group_by_sessions: [usageRow(2.74)] },
  ];
  const calls = [];
  const amount = await fetchTraeTodayUsage(USAGE_CONTEXT, {
    now,
    fetchPage: async ({ url, accessToken, body }) => {
      calls.push({ url, accessToken, body });
      return pages[calls.length - 1];
    },
  });
  assert.equal(amount, 7.14);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session");
  assert.equal(calls[0].accessToken, "jwt-token");
  assert.deepEqual(calls[0].body.usage_type, [7]);
  assert.equal(calls[0].body.start_time, Date.UTC(2026, 9, 27, 16, 0, 0) / 1000);
  assert.equal(calls[0].body.end_time, now / 1000);
  assert.deepEqual(calls[1].body, { ...calls[0].body, page_num: 2 });
});

test("today usage tolerates the data-wrapped response and an empty day", async () => {
  const now = Date.UTC(2026, 9, 28, 4, 0, 0);
  const wrapped = await fetchTraeTodayUsage(USAGE_CONTEXT, {
    now,
    fetchPage: async () => ({
      data: { total: 1, user_usage_group_by_sessions: [usageRow(1.5)] },
    }),
  });
  assert.equal(wrapped, 1.5);
  const empty = await fetchTraeTodayUsage(USAGE_CONTEXT, {
    now,
    fetchPage: async () => ({ total: 0, user_usage_group_by_sessions: [] }),
  });
  assert.equal(empty, 0);
});

test("today usage fails closed on an incomplete or oversized listing", async () => {
  const now = Date.UTC(2026, 9, 28, 4, 0, 0);
  let callsTotal3 = 0;
  await assert.rejects(
    fetchTraeTodayUsage(USAGE_CONTEXT, {
      now,
      fetchPage: async () =>
        callsTotal3++ === 0
          ? { total: 3, user_usage_group_by_sessions: [usageRow(1)] }
          : { total: 3, user_usage_group_by_sessions: [] },
    }),
    /今日用量明细不完整（1\/3）/,
  );
  await assert.rejects(
    fetchTraeTodayUsage(USAGE_CONTEXT, {
      now,
      maxPages: 2,
      fetchPage: async () => ({
        total: 99,
        user_usage_group_by_sessions: Array.from({ length: 20 }, () => usageRow(1)),
      }),
    }),
    /今日用量明细分页超出上限/,
  );
});
