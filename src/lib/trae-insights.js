import { pickNumber, pickString, requestJson, safeRemoteError } from "./http.js";
import { parseIcubesValue } from "./trae-crypto.js";
import { traeStorageKeys } from "./trae-storage.js";

const PAY_STATUS_PATH = "/trae/api/v2/pay/ide_user_pay_status";
const ENTITLEMENT_USAGE_PATH = "/trae/api/v2/pay/ide_user_ent_usage";
const USAGE_DETAIL_PATH = "/trae/api/v1/pay/query_user_usage_group_by_session";
const PRODUCT_TYPES = new Map([
  [100, "CNExpress"],
  [6, "Ultra"],
  [5, "Pro+"],
  [4, "Pro+"],
  [1, "Pro"],
  [9, "Pro"],
  [8, "Lite"],
  [0, "Free"],
]);

export class TraeInsightsAuthError extends Error {
  constructor(message = "TRAE session has expired") {
    super(message);
    this.name = "TraeInsightsAuthError";
    this.unauthorized = true;
  }
}

function normalize(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function record(value) {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function nested(root, ...keys) {
  let current = record(root);
  for (const key of keys) {
    if (!current) return null;
    current = record(current[key]);
  }
  return current;
}

function numberValue(root, ...keys) {
  for (const key of keys) {
    const value = pickNumber(record(root), [[key]]);
    if (value !== null) return value;
  }
  return null;
}

function productType(pack) {
  const base = nested(pack, "entitlement_base_info");
  return (
    numberValue(base, "product_type") ??
    numberValue(pack, "product_type")
  );
}

function packQuota(pack) {
  const base = nested(pack, "entitlement_base_info");
  const productExtra = nested(base, "product_extra");
  return (
    nested(base, "quota") ||
    nested(productExtra, "subscription_extra", "quota") ||
    nested(productExtra, "package_extra", "quota")
  );
}

function usageRoots(usageResponse) {
  return [
    record(usageResponse),
    nested(usageResponse, "data"),
    nested(usageResponse, "Result"),
    nested(usageResponse, "result"),
    nested(usageResponse, "payload"),
    nested(usageResponse, "ide_user_ent_usage"),
    nested(usageResponse, "user_current_entitlement_list"),
  ].filter(Boolean);
}

function visiblePacks(usageResponse) {
  for (const root of usageRoots(usageResponse)) {
    const packs = array(root.user_entitlement_pack_list);
    if (packs.length) {
      return packs
        .map((pack) => record(pack))
        .filter((pack) => pack && pack.is_hide !== true);
    }
  }
  return [];
}

function parseCreditsUsage(usageResponse, packs) {
  const root = usageRoots(usageResponse).find((item) => record(item.usage_summary))
    || record(usageResponse);
  const summary = record(root?.usage_summary);
  const segments = [];
  let segmentTotal = 0;
  let segmentUsed = 0;
  let unlimited = false;

  for (const pack of packs) {
    const quota = packQuota(pack);
    const limit = numberValue(quota, "credits_limit");
    const used = numberValue(nested(pack, "usage"), "credits_amount") ?? 0;
    if (limit === -1) {
      unlimited = true;
      continue;
    }
    if (limit === null || limit <= 0) continue;
    const remaining = Math.max(limit - used, 0);
    segmentTotal += limit;
    segmentUsed += used;
    segments.push({
      source: normalize(pack.display_desc) || "积分",
      total: limit,
      used,
      remaining,
      expiresAt: unixSecondsToIso(numberValue(pack, "expire_time")),
    });
  }

  const summaryTotal = numberValue(summary, "total_amount");
  const summaryUsed = numberValue(summary, "consumed_amount");
  const total = summaryTotal !== null && summaryTotal > 0 ? summaryTotal : segmentTotal;
  const used = summaryUsed !== null ? summaryUsed : segmentUsed;
  const hasCredits =
    unlimited ||
    total > 0 ||
    segments.length > 0 ||
    root?.is_credits_billing === true;
  if (!hasCredits) return null;
  return {
    total: unlimited ? -1 : total,
    used,
    remaining: unlimited ? -1 : Math.max(total - used, 0),
    unlimited,
    isCreditsBilling: root?.is_credits_billing === true,
    segments: segments
      .filter((segment) => segment.remaining > 0)
      .sort((left, right) => String(left.expiresAt || "").localeCompare(String(right.expiresAt || ""))),
  };
}

/**
 * Today's calendar day in Asia/Shanghai as `YYYY-MM-DD`.
 *
 * China has observed a fixed UTC+8 offset since 1991 (see formatLogTimestamp),
 * so a constant shift is exact.
 */
export function shanghaiDayKey(now = Date.now()) {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Estimates today's usage from period consumption deltas (fallback only).
 *
 * The real figure comes from `fetchTraeTodayUsage`, which sums the server's
 * own per-session usage records for today. This delta-based estimate only
 * runs when that API call failed: the first refresh that sees an account on
 * a given day records `credits.used` as the baseline, and today's usage is
 * the growth since then. A counter that *dropped* means the billing period
 * reset mid-day, so today's usage is the whole new counter. `estimated: true`
 * lets the UI say so instead of presenting it as an exact server figure.
 */
export function computeTodayUsage(previousBaseline, credits, { now = Date.now() } = {}) {
  if (!credits || credits.unlimited || !Number.isFinite(credits.used)) {
    return { todayUsage: null, baseline: null };
  }
  const day = shanghaiDayKey(now);
  const consumed = credits.used;
  const prev =
    previousBaseline && previousBaseline.date === day ? previousBaseline : null;
  if (prev && Number.isFinite(prev.consumed) && consumed >= prev.consumed) {
    return {
      todayUsage: {
        date: day,
        amount: Math.round((consumed - prev.consumed) * 100) / 100,
        estimated: true,
      },
      baseline: { date: day, consumed: prev.consumed },
    };
  }
  return {
    todayUsage: {
      date: day,
      amount: prev && consumed < prev.consumed ? consumed : 0,
      estimated: true,
    },
    baseline: { date: day, consumed },
  };
}

function selectPack(packs) {
  for (const type of [100, 6, 5, 4, 1, 9, 8, 0]) {
    const found = packs.find((pack) => productType(pack) === type);
    if (found) return found;
  }
  return packs[0] || null;
}

function unixSecondsToIso(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

function sumNumbers(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  if (usable.includes(-1)) return -1;
  return usable.reduce((sum, value) => sum + value, 0);
}

export function parseTraeAccountInsights({
  payStatus,
  usageResponse,
  now = Date.now(),
} = {}) {
  const packs = visiblePacks(usageResponse);
  const selected = selectPack(packs);
  const selectedType = productType(selected);
  const selectedQuota = packQuota(selected);
  const selectedUsage = nested(selected, "usage");
  const payDetail = nested(payStatus, "detail");

  const fastLimits = packs.map((pack) =>
    numberValue(packQuota(pack), "premium_model_fast_request_limit"),
  );
  const fastLimit = sumNumbers(fastLimits);
  const fastUsed = sumNumbers(
    packs.map((pack) => numberValue(nested(pack, "usage"), "premium_model_fast_amount")),
  ) ?? 0;
  const fastAvailable =
    fastLimit === null ? null : fastLimit === -1 ? -1 : Math.max(fastLimit - fastUsed, 0);
  const fastPerMonth = numberValue(payDetail, "fast_request_per");
  const canGetExpressStatus = numberValue(payDetail, "can_get_express_status");
  const soloParallelLimit = numberValue(selectedQuota, "solo_agent_parallel_limit");
  const basicUsage = numberValue(selectedUsage, "basic_usage_amount") ?? 0;
  const rawBasicQuota = numberValue(selectedQuota, "basic_usage_limit");
  const basicQuota =
    rawBasicQuota !== null && rawBasicQuota >= 0 ? rawBasicQuota : null;
  const endTime = numberValue(nested(selected, "entitlement_base_info"), "end_time");
  const planLabel =
    normalize(pickString(record(payStatus), [["user_pay_identity_str"]])) ||
    normalize(selected?.display_desc) ||
    PRODUCT_TYPES.get(selectedType) ||
    "未知套餐";
  const credits = parseCreditsUsage(usageResponse, packs);

  let model = "unknown";
  if (credits) {
    model = "credits";
  } else if (
    fastLimit !== null &&
    (fastLimit !== 0 || fastPerMonth !== null || packs.length > 0)
  ) {
    model = "fast_request";
  } else if (basicQuota !== null && basicQuota > 0) {
    model = "usd";
  }

  const resetAt = endTime !== null && endTime > 0
    ? unixSecondsToIso(endTime + 1)
    : null;
  const quota = {
    model,
    fastLimit,
    fastUsed,
    fastAvailable,
    fastPerMonth,
    canGetExpressStatus,
    basicUsage,
    basicQuota,
    soloParallelLimit,
    credits,
  };
  const planKey = (planLabel || "").toLowerCase();
  quota.usageExhausted =
    model === "credits"
      ? credits.remaining === 0
      : model === "fast_request"
      ? fastAvailable === 0
      : basicQuota !== null && basicQuota > 0 && basicUsage >= basicQuota;

  return {
    plan: planLabel,
    planKey,
    quota,
    credits,
    resetAt,
    updatedAt: new Date(now).toISOString(),
    error: null,
  };
}

export function getTraeAuthContext(snapshot) {
  const authKey = Object.keys(snapshot?.keys || {}).find(
    (key) =>
      key.startsWith(traeStorageKeys.AUTH_PREFIX) &&
      key !== traeStorageKeys.USERTAG_KEY &&
      !key.startsWith(traeStorageKeys.DEVICE_PREFIX),
  );
  if (!authKey) throw new Error("TRAE snapshot is missing the user authentication key");
  const auth = parseIcubesValue(snapshot.keys[authKey]);
  const accessToken = normalize(auth.accessToken) || normalize(auth.token);
  if (!accessToken) throw new Error("TRAE snapshot is missing an access token");
  const host = normalize(auth.loginHost) || normalize(auth.host) || "https://api.trae.cn";
  const userId =
    normalize(auth.userId) ||
    normalize(auth.user_id) ||
    normalize(auth.account?.userId) ||
    normalize(auth.account?.user_id);
  return {
    accessToken,
    host: /^https?:\/\//i.test(host) ? host.replace(/\/$/, "") : `https://${host}`,
    userId,
  };
}

async function requestInsights(url, accessToken, body) {
  const response = await requestJson(url, {
    body,
    headers: {
      authorization: `Cloud-IDE-JWT ${accessToken}`,
      "user-agent": "Trae/1.0.0 antigravity-cockpit-tools",
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new TraeInsightsAuthError();
  }
  if (!response.ok) throw new Error(safeRemoteError(response));
  return response.json;
}

/**
 * Sums today's real credit consumption from the server's usage records.
 *
 * `query_user_usage_group_by_session` is the endpoint behind TRAE CN's own
 * usage page (设置 → 用量管理). The request shape matters: `usage_type` must
 * be the ARRAY `[7]` — the constant the official client sends — otherwise the
 * gateway answers 400, and omitting it yields a silent empty result. Windows
 * are epoch seconds in UTC+8, so the window starts at today's 00:00
 * Asia/Shanghai. Pages of 20 are pulled until `total` is covered; anything
 * short of the full set fails instead of reporting a silently small number.
 */
export async function fetchTraeTodayUsage(
  context,
  { now = Date.now(), pageSize = 20, maxPages = 50, fetchPage } = {},
) {
  const request = fetchPage || (({ url, accessToken, body }) => requestInsights(url, accessToken, body));
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  const startSeconds =
    Math.floor(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) / 1000) - 8 * 60 * 60;
  const endSeconds = Math.floor(now / 1000);
  let pageNum = 1;
  let fetched = 0;
  let total = null;
  let amount = 0;
  while (pageNum <= maxPages) {
    const root = await request({
      url: `${context.host}${USAGE_DETAIL_PATH}`,
      accessToken: context.accessToken,
      body: {
        usage_type: [7],
        start_time: startSeconds,
        end_time: endSeconds,
        page_num: pageNum,
        page_size: pageSize,
      },
    });
    // Documented wrapper is data.user_usage_group_by_sessions; the live
    // gateway answers with the fields at the top level — accept both.
    const payload = record(root?.data) ?? record(root);
    const rows = array(payload?.user_usage_group_by_sessions);
    if (total === null && Number.isFinite(payload?.total)) total = payload.total;
    for (const row of rows) {
      const credits = record(row)?.credits_float;
      if (typeof credits === "number" && Number.isFinite(credits) && credits > 0) {
        amount += credits;
      }
    }
    fetched += rows.length;
    if (total !== null && fetched >= total) {
      return Math.round(amount * 100) / 100;
    }
    if (rows.length === 0) {
      // A short page before `total` is covered: either the server lost count
      // or total was omitted. Fail rather than report a silently small sum.
      throw new Error(
        total !== null
          ? `今日用量明细不完整（${fetched}/${total}）`
          : "今日用量明细返回为空",
      );
    }
    pageNum += 1;
  }
  throw new Error(`今日用量明细分页超出上限（已取 ${fetched} 条）`);
}

export async function fetchTraeAccountInsights(
  snapshot,
  { now = Date.now(), previousInsights = null } = {},
) {
  const context = getTraeAuthContext(snapshot);
  const results = await Promise.allSettled([
    requestInsights(`${context.host}${PAY_STATUS_PATH}`, context.accessToken, {}),
    requestInsights(`${context.host}${ENTITLEMENT_USAGE_PATH}`, context.accessToken, {
      require_usage: true,
    }),
    fetchTraeTodayUsage(context, { now }),
  ]);
  if (results.some((result) => result.status === "rejected" && result.reason?.unauthorized)) {
    throw new TraeInsightsAuthError();
  }
  const payStatus = results[0].status === "fulfilled" ? results[0].value : null;
  const usageResponse = results[1].status === "fulfilled" ? results[1].value : null;
  if (!payStatus && !usageResponse) {
    const error = results.find((result) => result.status === "rejected")?.reason;
    throw error instanceof Error ? error : new Error("Unable to load TRAE account insights");
  }
  const insights = parseTraeAccountInsights({ payStatus, usageResponse, now });
  const estimate = computeTodayUsage(
    previousInsights?.todayUsageBaseline,
    insights.credits,
    { now },
  );
  // The baseline is kept even when the real API succeeded, so a later API
  // failure degrades to a delta estimate instead of losing the day entirely.
  insights.todayUsageBaseline = estimate.baseline;
  if (results[2].status === "fulfilled") {
    insights.todayUsage = {
      date: shanghaiDayKey(now),
      amount: results[2].value,
      estimated: false,
    };
  } else if (estimate.todayUsage) {
    insights.todayUsage = estimate.todayUsage;
  }
  const failures = results
    .slice(0, 2)
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || String(result.reason));
  if (failures.length) insights.error = failures.join(" | ");
  return insights;
}
