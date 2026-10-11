import fs from "node:fs/promises";
import path from "node:path";

import { readJsonFile, stableHash, writeJsonAtomic } from "./json-file.js";
import { readAuthFromSnapshot } from "./trae-refresh.js";
import {
  mintDeviceIdentity,
  readDeviceIdentity,
  recoverDeviceIdentity,
} from "./device-identity.js";
import {
  extractAuthSnapshot,
  extractIdentityFromSnapshot,
  maskAccountValue,
  mergeIdentity,
  normalizeEmail,
  sanitizeAuthSnapshotEmails,
  validateAuthSnapshot,
} from "./trae-storage.js";

function cleanIdentity(identity) {
  return {
    userId: identity?.userId ? String(identity.userId).trim() : null,
    email: normalizeEmail(identity?.email),
    phone: identity?.phone ? String(identity.phone).trim() : null,
    nickname: identity?.nickname ? String(identity.nickname).trim() : null,
  };
}

function accountIdentityKey(identity) {
  if (identity.userId) return `user:${identity.userId}`;
  if (identity.email) return `email:${identity.email.toLowerCase()}`;
  return null;
}

function safeDisplayName(identity) {
  return (
    identity.nickname ||
    identity.email ||
    (identity.userId ? `User ${identity.userId.slice(-6)}` : "TRAE account")
  );
}

function credentialExpiryFromSnapshot(snapshot) {
  try {
    const auth = readAuthFromSnapshot(snapshot);
    const accessExpiresAt = auth?.expiredAt || null;
    const refreshExpiresAt = auth?.refreshExpiredAt || null;
    if (!accessExpiresAt && !refreshExpiresAt) return null;
    return { accessExpiresAt, refreshExpiresAt };
  } catch {
    return null;
  }
}

/**
 * Adds display-only credential expiry metadata to a record.
 *
 * A newly saved snapshot already contains the expiry values, so there is no
 * reason to wait for the first keep-alive sweep before the panel can show them.
 * This intentionally leaves `keepalive.status` and `keepalive.updatedAt` alone:
 * those belong to the sweep, and stamping a fresh timestamp here would postpone
 * the real sweep by a full interval.
 */
function withCredentialExpiry(record, snapshot, { onlyMissing = false } = {}) {
  const expiry = credentialExpiryFromSnapshot(snapshot);
  if (!expiry) return record;
  const next = { ...(record || {}) };
  const keepalive = { ...(next.keepalive || {}) };
  let changed = false;
  if (
    expiry.accessExpiresAt &&
    (!onlyMissing || !keepalive.accessExpiresAt) &&
    keepalive.accessExpiresAt !== expiry.accessExpiresAt
  ) {
    keepalive.accessExpiresAt = expiry.accessExpiresAt;
    changed = true;
  }
  if (
    expiry.refreshExpiresAt &&
    (!onlyMissing || !keepalive.refreshExpiresAt) &&
    keepalive.refreshExpiresAt !== expiry.refreshExpiresAt
  ) {
    keepalive.refreshExpiresAt = expiry.refreshExpiresAt;
    changed = true;
  }
  if (!changed) return record;
  next.keepalive = keepalive;
  return next;
}

function publicAccount(record) {
  return {
    id: record.id,
    displayName: record.displayName,
    userId: record.userId,
    maskedUserId: maskAccountValue(record.userId),
    maskedEmail: maskAccountValue(record.email),
    phone: record.phone || null,
    maskedPhone: record.phone?.includes("*")
      ? record.phone
      : maskAccountValue(record.phone),
    nickname: record.nickname,
    insights: record.insights || null,
    checkin: record.checkin || null,
    keepalive: record.keepalive || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    snapshotCapturedAt: record.snapshotCapturedAt,
  };
}

function buildAccountRecord(identity, existing, snapshot, now) {
  const identityKey = accountIdentityKey(identity);
  if (!identityKey) {
    throw new Error("Imported TRAE account does not contain a stable identity");
  }
  return withCredentialExpiry({
    schemaVersion: 1,
    id: existing?.id || `acct_${stableHash(identityKey)}`,
    userId: identity.userId,
    email: identity.email,
    phone: identity.phone,
    nickname: identity.nickname,
    displayName: safeDisplayName(identity),
    insights: existing?.insights || null,
    checkin: existing?.checkin || null,
    keepalive: existing?.keepalive || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    snapshotCapturedAt: Number.isFinite(Number(snapshot.capturedAt))
      ? Number(snapshot.capturedAt)
      : now,
  }, snapshot);
}

export class AccountStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.accountsDir = path.join(dataDir, "accounts");
    this.indexPath = path.join(this.accountsDir, "index.json");
  }

  async readIndex() {
    const index = await readJsonFile(this.indexPath, { required: false });
    if (!index) return { schemaVersion: 1, accounts: [] };
    if (!Array.isArray(index.accounts)) {
      throw new Error("Trae Meta account index is invalid");
    }
    return index;
  }

  async list() {
    const index = await this.readIndex();
    const result = [];
    for (const record of index.accounts) {
      const snapshotPath = this.snapshotPath(record.id);
      try {
        await fs.access(snapshotPath);
        result.push(publicAccount(record));
      } catch {
        // Broken records stay hidden until a fresh backup repairs them.
      }
    }
    return result.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async repairIndex() {
    const index = await this.readIndex();
    let repaired = 0;
    let snapshotsRepaired = 0;
    const accounts = [];
    for (const record of index.accounts) {
      try {
        const snapshot = await readJsonFile(this.snapshotPath(record.id), {
          required: false,
        });
        if (snapshot) {
          const sanitized = sanitizeAuthSnapshotEmails(snapshot);
          if (JSON.stringify(snapshot) !== JSON.stringify(sanitized)) {
            snapshotsRepaired += 1;
            await writeJsonAtomic(this.snapshotPath(record.id), sanitized, {
              mode: 0o600,
            });
          }
        }
      } catch {
        // Broken snapshots remain hidden until a fresh backup repairs them.
      }
      const email = normalizeEmail(record.email);
      if (email !== record.email) {
        repaired += 1;
        accounts.push({
          ...record,
          email,
          displayName:
            record.displayName === record.email
              ? safeDisplayName({ ...record, email })
              : record.displayName,
        });
      } else {
        accounts.push(record);
      }
    }
    if (repaired) {
      await writeJsonAtomic(
        this.indexPath,
        { ...index, schemaVersion: 1, accounts },
        { mode: 0o600 },
      );
    }
    return { repaired, snapshotsRepaired };
  }

  snapshotPath(accountId) {
    return path.join(this.accountsDir, accountId, "snapshot.json");
  }

  async backupCurrent(storageRoot, { liveIdentity = null, now = Date.now() } = {}) {
    const snapshot = sanitizeAuthSnapshotEmails(
      extractAuthSnapshot(storageRoot, { capturedAt: now }),
    );
    const storedIdentity = extractIdentityFromSnapshot(snapshot);
    const identity = cleanIdentity(mergeIdentity(liveIdentity, storedIdentity));
    const identityKey = accountIdentityKey(identity);
    if (!identityKey) {
      throw new Error(
        "Unable to identify the current TRAE account. Keep TRAE running and retry the backup.",
      );
    }

    const accountId = `acct_${stableHash(identityKey)}`;
    const snapshotPath = this.snapshotPath(accountId);
    // Every account carries a fixed device identity no matter how it is added.
    // The OAuth login path supplies one via buildStorageRoot; adopting or
    // syncing the signed-in account reads live TRAE storage which has none. Reuse
    // a previously-stored identity for this account; otherwise recover the one
    // TRAE bound (so deviceId and its signing key stay paired — minting a fresh
    // id here mismatches the stored key and breaks refresh with 20403); only when
    // neither exists mint a single new identity.
    if (!readDeviceIdentity(snapshot)) {
      let stored = null;
      try {
        stored = recoverDeviceIdentity(snapshot);
      } catch {
        stored = null;
      }
      if (!stored) {
        try {
          stored = readDeviceIdentity(
            await readJsonFile(snapshotPath, { required: false }),
          );
        } catch {
          stored = null;
        }
      }
      snapshot.deviceIdentity = stored ?? mintDeviceIdentity();
    }
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeJsonAtomic(snapshotPath, snapshot, { mode: 0o600 });

    const index = await this.readIndex();
    const existingIndex = index.accounts.findIndex(
      (record) => record.id === accountId || accountIdentityKey(record) === identityKey,
    );
    const existing = existingIndex >= 0 ? index.accounts[existingIndex] : null;
    const record = {
      ...buildAccountRecord(identity, existing, snapshot, now),
      id: accountId,
    };

    if (existingIndex >= 0) index.accounts[existingIndex] = record;
    else index.accounts.push(record);
    await writeJsonAtomic(this.indexPath, index, { mode: 0o600 });

    return {
      account: publicAccount(record),
      createdSnapshot: !existing,
    };
  }

  async readSnapshot(accountId) {
    if (!/^acct_[a-f0-9]{24}$/.test(accountId)) {
      throw new Error("Invalid account id");
    }
    const snapshot = await readJsonFile(this.snapshotPath(accountId));
    validateAuthSnapshot(snapshot);
    return snapshot;
  }

  async saveSnapshot(accountId, snapshot, { now = Date.now() } = {}) {
    snapshot = sanitizeAuthSnapshotEmails(snapshot);
    validateAuthSnapshot(snapshot);
    const index = await this.readIndex();
    const position = index.accounts.findIndex((record) => record.id === accountId);
    if (position < 0) throw new Error("Account backup was not found");
    const identity = cleanIdentity(extractIdentityFromSnapshot(snapshot));
    await writeJsonAtomic(this.snapshotPath(accountId), snapshot, { mode: 0o600 });
    index.accounts[position] = withCredentialExpiry({
      ...index.accounts[position],
      userId: identity.userId || index.accounts[position].userId,
      email: identity.email || index.accounts[position].email,
      phone: identity.phone || index.accounts[position].phone,
      nickname: identity.nickname || index.accounts[position].nickname,
      displayName: safeDisplayName({
        ...index.accounts[position],
        ...identity,
      }),
      updatedAt: now,
      snapshotCapturedAt: snapshot.capturedAt,
    }, snapshot);
    await writeJsonAtomic(this.indexPath, index, { mode: 0o600 });
    return publicAccount(index.accounts[position]);
  }

  async saveInsights(accountId, insights, { now = Date.now() } = {}) {
    const index = await this.readIndex();
    const position = index.accounts.findIndex((record) => record.id === accountId);
    if (position < 0) throw new Error("Account backup was not found");
    index.accounts[position] = {
      ...index.accounts[position],
      insights: {
        ...(insights || {}),
        updatedAt: (insights || {}).updatedAt || new Date(now).toISOString(),
      },
    };
    await writeJsonAtomic(this.indexPath, index, { mode: 0o600 });
    return publicAccount(index.accounts[position]);
  }

  async saveCheckin(accountId, checkin, { now = Date.now() } = {}) {
    const index = await this.readIndex();
    const position = index.accounts.findIndex((record) => record.id === accountId);
    if (position < 0) throw new Error("Account backup was not found");
    index.accounts[position] = {
      ...index.accounts[position],
      checkin: {
        ...(checkin || {}),
        updatedAt: (checkin || {}).updatedAt || new Date(now).toISOString(),
      },
    };
    await writeJsonAtomic(this.indexPath, index, { mode: 0o600 });
    return publicAccount(index.accounts[position]);
  }

  async saveKeepalive(accountId, keepalive, { now = Date.now() } = {}) {
    const index = await this.readIndex();
    const position = index.accounts.findIndex((record) => record.id === accountId);
    if (position < 0) throw new Error("Account backup was not found");
    index.accounts[position] = {
      ...index.accounts[position],
      keepalive: {
        ...(keepalive || {}),
        updatedAt: (keepalive || {}).updatedAt || new Date(now).toISOString(),
      },
    };
    await writeJsonAtomic(this.indexPath, index, { mode: 0o600 });
    return publicAccount(index.accounts[position]);
  }

  /**
   * Copies the credential expiry across for display only.
   *
   * The panel's「有效期至」reads `keepalive.accessExpiresAt`, which only the sweep
   * writes — and the sweep is skipped entirely while Cockpit Tools is running or
   * while TRAE's signed-in account cannot be read. The same value is already
   * sitting in the account snapshot, so this copies it across locally: no
   * network, no credential, no rotation, and nothing about the sweep changes.
   *
   * `status` and `updatedAt` are deliberately left alone. Stamping a fresh
   * `updatedAt` would make `isKeepaliveDue` believe the account had just been
   * synced and postpone the real sweep by a full interval.
   */
  async mergeCredentialExpiry(accountId, { accessExpiresAt, refreshExpiresAt } = {}) {
    const index = await this.readIndex();
    const position = index.accounts.findIndex((record) => record.id === accountId);
    if (position < 0) return null;
    const keepalive = { ...(index.accounts[position].keepalive || {}) };
    if (accessExpiresAt) keepalive.accessExpiresAt = accessExpiresAt;
    if (refreshExpiresAt) keepalive.refreshExpiresAt = refreshExpiresAt;
    index.accounts[position] = { ...index.accounts[position], keepalive };
    await writeJsonAtomic(this.indexPath, index, { mode: 0o600 });
    return publicAccount(index.accounts[position]);
  }

  /**
   * Fills the panel's「有效期至」for every account whose snapshot already knows it.
   *
   * The value the sweep writes into the index is `auth.expiredAt` — the very field
   * the saved snapshot carries — so this is the same datum moved to where the panel
   * reads it, not a second source of truth. It opens no socket and touches no
   * credential, which is why it may run even when the sweep itself has to be
   * skipped: Cockpit Tools running, or TRAE's signed-in account being unreadable.
   *
   * Returns how many records gained a value.
   */
  async fillCredentialExpiryFromSnapshots() {
    const index = await this.readIndex();
    let filled = 0;
    for (const record of index.accounts) {
      // A failed sweep owns the panel's「同步失败」message; a date here would only
      // hide that failure.
      if (record.keepalive?.status === "error") continue;
      const missingAccess = !record.keepalive?.accessExpiresAt;
      const missingRefresh = !record.keepalive?.refreshExpiresAt;
      if (!missingAccess && !missingRefresh) continue;
      let snapshot = null;
      try {
        snapshot = await this.readSnapshot(record.id);
      } catch {
        continue;
      }
      const updatedRecord = withCredentialExpiry(record, snapshot, { onlyMissing: true });
      if (updatedRecord === record) continue;
      const updated = await this.mergeCredentialExpiry(record.id, {
        accessExpiresAt: updatedRecord.keepalive?.accessExpiresAt,
        refreshExpiresAt: updatedRecord.keepalive?.refreshExpiresAt,
      });
      if (updated) filled += 1;
    }
    return filled;
  }

  async exportSnapshots(accountIds = null) {
    const index = await this.readIndex();
    const requested = accountIds ? new Set(accountIds.map(String)) : null;
    const records = requested
      ? index.accounts.filter((record) => requested.has(record.id))
      : index.accounts;
    if (requested && records.length !== requested.size) {
      throw new Error("One or more selected account backups were not found");
    }
    const result = [];
    for (const record of records) {
      const snapshot = await this.readSnapshot(record.id);
      result.push({
        account: publicAccount(record),
        snapshot,
      });
    }
    if (!result.length) throw new Error("没有可导出的账号备份");
    return result;
  }

  async importSnapshots(items, { now = Date.now() } = {}) {
    if (!Array.isArray(items) || !items.length) {
      throw new Error("导入文件中没有账号数据");
    }

    const index = await this.readIndex();
    const plannedByIdentity = new Map();
    let skipped = 0;
    for (const item of items) {
      const snapshot = sanitizeAuthSnapshotEmails(item?.snapshot);
      validateAuthSnapshot(snapshot);
      const identity = cleanIdentity(extractIdentityFromSnapshot(snapshot));
      const identityKey = accountIdentityKey(identity);
      if (!identityKey) {
        skipped += 1;
        continue;
      }
      if (plannedByIdentity.has(identityKey)) skipped += 1;
      plannedByIdentity.set(identityKey, { identity, identityKey, snapshot });
    }
    if (!plannedByIdentity.size) {
      throw new Error("导入文件中没有可识别的账号");
    }

    const previousSnapshots = new Map();
    const planned = [];
    let imported = 0;
    let updated = 0;
    for (const { identity, identityKey, snapshot } of plannedByIdentity.values()) {
      const existingIndex = index.accounts.findIndex(
        (record) => record.id === `acct_${stableHash(identityKey)}` ||
          accountIdentityKey(record) === identityKey,
      );
      const existing = existingIndex >= 0 ? index.accounts[existingIndex] : null;
      const record = buildAccountRecord(identity, existing, snapshot, now);
      previousSnapshots.set(
        record.id,
        await readJsonFile(this.snapshotPath(record.id), { required: false }),
      );
      planned.push({ existingIndex, record, snapshot });
      if (existing) updated += 1;
      else imported += 1;
    }

    const written = [];
    try {
      for (const item of planned) {
        await writeJsonAtomic(this.snapshotPath(item.record.id), item.snapshot, {
          mode: 0o600,
        });
        written.push(item.record.id);
      }
      const nextIndex = {
        ...index,
        schemaVersion: 1,
        accounts: [...index.accounts],
      };
      for (const item of planned) {
        if (item.existingIndex >= 0) nextIndex.accounts[item.existingIndex] = item.record;
        else nextIndex.accounts.push(item.record);
      }
      await writeJsonAtomic(this.indexPath, nextIndex, { mode: 0o600 });
    } catch (error) {
      for (const accountId of written.reverse()) {
        const previous = previousSnapshots.get(accountId);
        if (previous) {
          await writeJsonAtomic(this.snapshotPath(accountId), previous, {
            mode: 0o600,
          }).catch(() => {});
        } else {
          await fs.rm(this.snapshotPath(accountId), { recursive: true, force: true }).catch(() => {});
        }
      }
      throw error;
    }

    return {
      imported,
      updated,
      skipped,
      total: items.length,
      accounts: planned.map((item) => publicAccount(item.record)),
    };
  }

  async findAccount(accountId) {
    const index = await this.readIndex();
    return index.accounts.find((record) => record.id === accountId) || null;
  }

  /**
   * Removes one local account backup.
   *
   * The account index is the source of truth, so it is updated first. The
   * snapshot directory is then removed by its validated account id. A failed
   * directory removal can leave an orphan file behind, but it can never leave a
   * list entry pointing at account data the user believes was deleted.
   */
  async deleteAccount(accountId) {
    if (!/^acct_[a-f0-9]{24}$/.test(String(accountId || ""))) {
      throw new Error("Invalid account id");
    }
    const index = await this.readIndex();
    const position = index.accounts.findIndex((record) => record.id === accountId);
    if (position < 0) return null;
    const [record] = index.accounts.splice(position, 1);
    await writeJsonAtomic(
      this.indexPath,
      { ...index, schemaVersion: 1, accounts: index.accounts },
      { mode: 0o600 },
    );
    await fs.rm(path.join(this.accountsDir, accountId), { recursive: true, force: true });
    return publicAccount(record);
  }

  /**
   * Which saved account TRAE is signed in as right now — and whether that could
   * be determined at all.
   *
   * The distinction matters before any credential rotation. `not-managed` is
   * safe: TRAE holds an account this tool does not manage, so refreshing a saved
   * account cannot disturb that session. `unknown` is not safe: we cannot tell
   * which account TRAE holds, so rotating could invalidate the live login.
   * Callers must refuse to rotate while the state is `unknown`.
   */
  async resolveActiveAccount(storageRoot) {
    let identity;
    try {
      identity = extractIdentityFromSnapshot(extractAuthSnapshot(storageRoot));
    } catch {
      return { id: null, state: "unknown" };
    }
    if (!identity.userId && !identity.email) return { id: null, state: "unknown" };
    const index = await this.readIndex();
    const record = index.accounts.find((candidate) => {
      if (identity.userId && candidate.userId) {
        return String(identity.userId) === String(candidate.userId);
      }
      if (identity.email && candidate.email) {
        return String(identity.email).toLowerCase() === String(candidate.email).toLowerCase();
      }
      return false;
    });
    return record ? { id: record.id, state: "matched" } : { id: null, state: "not-managed" };
  }

  async resolveCurrentAccountId(storageRoot) {
    return (await this.resolveActiveAccount(storageRoot)).id;
  }
}
