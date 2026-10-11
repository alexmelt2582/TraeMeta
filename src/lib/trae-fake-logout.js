import crypto from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { readJsonFile, writeJsonAtomic } from "./json-file.js";
import { applyAuthClear, applyAuthSnapshot } from "./storage-transaction.js";
import {
  extractAuthSnapshot,
  extractIdentityFromSnapshot,
  validateAuthSnapshot,
} from "./trae-storage.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SETTLE_MS = 800;
const COMPLETED_RETENTION_MS = 10 * 60 * 1000;
const SESSION_SCHEMA_VERSION = 1;

function publicSession(session) {
  if (!session) return { status: "missing" };
  return {
    sessionId: session.sessionId,
    status: session.status,
    message: session.message,
    error: session.error,
    account: session.account,
    originalAccount: session.originalAccount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
  };
}

function persistedSession(session) {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: session.sessionId,
    status: session.status,
    message: session.message,
    error: session.error,
    account: session.account,
    originalAccount: session.originalAccount,
    originalSnapshot: session.originalSnapshot,
    originalUserId: session.originalUserId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
  };
}

function isTerminalStatus(status) {
  return status === "complete" || status === "error" || status === "cancelled";
}

export class TraeFakeLogoutManager {
  constructor({
    accountStore,
    storagePath,
    stopTrae,
    startTrae,
    isTraeRunning = async () => false,
    getLiveIdentity = async () => null,
    onAccountSaved = null,
    sessionPath = null,
    logger = console,
    sessionTimeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    settleMs = DEFAULT_SETTLE_MS,
    now = () => Date.now(),
    sleep = delay,
  }) {
    this.accountStore = accountStore;
    this.storagePath = storagePath;
    this.stopTrae = stopTrae;
    this.startTrae = startTrae;
    this.isTraeRunning = isTraeRunning;
    this.getLiveIdentity = getLiveIdentity;
    this.onAccountSaved = typeof onAccountSaved === "function" ? onAccountSaved : null;
    this.sessionPath = sessionPath;
    this.logger = logger;
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.settleMs = settleMs;
    this.now = now;
    this.sleep = sleep;
    this.activeSession = null;
    this.latestSession = null;
  }

  async start() {
    this.pruneRetainedSession();
    if (this.getActiveSession()) {
      throw new Error("A fake logout login flow is already running");
    }

    const storageRoot = await readJsonFile(this.storagePath);
    const originalSnapshot = extractAuthSnapshot(storageRoot);
    const identity = extractIdentityFromSnapshot(originalSnapshot);
    if (!identity.userId) {
      throw new Error("Unable to identify the current TRAE account before fake logout");
    }
    const currentLiveIdentity = await this.getLiveIdentity().catch(() => null);
    const liveIdentity =
      currentLiveIdentity?.userId === identity.userId ? currentLiveIdentity : null;
    const backup = await this.accountStore.backupCurrent(storageRoot, {
      liveIdentity,
    });

    const timestamp = this.now();
    const session = {
      sessionId: crypto.randomUUID(),
      status: "preparing",
      message: "正在准备安全登录流程...",
      error: null,
      account: null,
      originalAccount: backup.account,
      originalSnapshot,
      originalUserId: identity.userId,
      cancelRequested: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + this.sessionTimeoutMs,
    };
    await this.persistSession(session);
    this.activeSession = session;
    this.latestSession = session;

    this.run(session).catch((error) => {
      this.logger.error(
        `[fake-logout] unexpected failure sessionId=${session.sessionId}: ${error.message || error}`,
      );
    });
    return publicSession(session);
  }

  async recover() {
    this.pruneRetainedSession();
    if (this.getActiveSession()) return publicSession(this.activeSession);
    if (!this.sessionPath) return { status: "missing" };

    let session;
    try {
      session = await this.loadPersistedSession();
    } catch (error) {
      this.logger.error(`[fake-logout] recovery state is invalid: ${error.message || error}`);
      await this.clearPersistedSession();
      return { status: "error", error: error.message || String(error) };
    }
    if (!session) return { status: "missing" };

    this.activeSession = session;
    this.latestSession = session;
    if (session.status === "complete" || session.status === "cancelled") {
      await this.clearPersistedSession();
      return publicSession(session);
    }
    if (session.status === "error") {
      session.status = "recovering";
      session.message = "正在恢复上次未完成的登录流程...";
      session.updatedAt = this.now();
      await this.persistSession(session);
    }

    this.runRecovery(session).catch((error) => {
      this.logger.error(
        `[fake-logout] recovery failed sessionId=${session.sessionId}: ${error.message || error}`,
      );
    });
    return publicSession(session);
  }

  status(sessionId) {
    this.pruneRetainedSession();
    const session =
      (sessionId && this.activeSession?.sessionId === sessionId
        ? this.activeSession
        : sessionId && this.latestSession?.sessionId === sessionId
          ? this.latestSession
          : null) || (!sessionId ? this.activeSession || this.latestSession : null);
    return publicSession(session);
  }

  active() {
    this.pruneRetainedSession();
    return publicSession(this.activeSession);
  }

  isActive() {
    return !!this.getActiveSession();
  }

  async cancel(sessionId = "") {
    const session = this.getActiveSession();
    if (!session || (sessionId && session.sessionId !== sessionId)) return false;
    session.cancelRequested = true;
    if (
      session.status === "preparing" ||
      session.status === "stopping" ||
      session.status === "clearing" ||
      session.status === "starting" ||
      session.status === "awaiting_login" ||
      session.status === "recovering"
    ) {
      session.status = "cancelling";
      session.message = "正在取消并恢复原账号...";
      session.updatedAt = this.now();
      await this.persistSession(session);
    }
    return true;
  }

  getActiveSession() {
    if (!this.activeSession) return null;
    if (isTerminalStatus(this.activeSession.status)) return null;
    return this.activeSession;
  }

  pruneRetainedSession() {
    if (!this.activeSession) return;
    if (!isTerminalStatus(this.activeSession.status)) return;
    if (this.now() - this.activeSession.updatedAt < COMPLETED_RETENTION_MS) return;
    this.activeSession = null;
  }

  async setSessionState(session, status, message, { retainPersisted = false } = {}) {
    session.status = status;
    session.message = message;
    session.updatedAt = this.now();
    if (isTerminalStatus(status) && !retainPersisted) {
      await this.clearPersistedSession();
      return;
    }
    await this.persistSession(session);
  }

  async persistSession(session) {
    if (!this.sessionPath) return;
    await writeJsonAtomic(this.sessionPath, persistedSession(session), {
      mode: 0o600,
    });
  }

  async clearPersistedSession() {
    if (!this.sessionPath) return;
    await fs.rm(this.sessionPath, { force: true }).catch(() => {});
  }

  async loadPersistedSession() {
    const stored = await readJsonFile(this.sessionPath, { required: false });
    if (!stored) return null;
    if (
      stored.schemaVersion !== SESSION_SCHEMA_VERSION ||
      !stored.sessionId ||
      !stored.originalUserId ||
      !stored.originalSnapshot
    ) {
      throw new Error("Persisted fake logout session is incomplete");
    }
    validateAuthSnapshot(stored.originalSnapshot);
    return {
      ...stored,
      cancelRequested: false,
    };
  }

  async run(session) {
    let cleared = false;
    let traeStopped = false;
    try {
      if (session.cancelRequested) throw new Error("登录流程已取消");

      await this.setSessionState(session, "stopping", "正在安全关闭 Trae CN...");
      await this.stopTrae();
      traeStopped = true;
      if (session.cancelRequested) throw new Error("登录流程已取消");

      await this.setSessionState(session, "clearing", "正在切换到登录页...");
      await applyAuthClear({
        storagePath: this.storagePath,
        now: this.now(),
      });
      cleared = true;

      await this.setSessionState(session, "starting", "正在重新打开 TRAE 登录页...");
      const started = await this.startTrae();
      if (!started) throw new Error("TRAE did not expose the debugging port after restart");
      traeStopped = false;
      if (session.cancelRequested) throw new Error("登录流程已取消");

      await this.setSessionState(
        session,
        "awaiting_login",
        "请在 TRAE 登录页扫码登录新账号。",
      );
      await this.monitorForNewAccount(session);
    } catch (error) {
      await this.handleFailure(session, error, { cleared, traeStopped });
    }
  }

  async runRecovery(session) {
    try {
      const currentIdentity = await this.readCurrentIdentity();
      if (
        currentIdentity?.userId &&
        String(currentIdentity.userId) !== String(session.originalUserId)
      ) {
        const candidate = await this.detectNewAccount(session.originalUserId);
        if (candidate) {
          await this.completeWithCandidate(session, candidate);
          return;
        }
      }

      if (
        currentIdentity?.userId &&
        String(currentIdentity.userId) === String(session.originalUserId)
      ) {
        await this.ensureTraeStarted();
        await this.setSessionState(session, "cancelled", "已恢复到原账号。");
        return;
      }

      if (this.now() >= session.expiresAt) {
        throw new Error("等待新账号登录超时");
      }

      await this.setSessionState(
        session,
        "awaiting_login",
        "已恢复未完成的登录流程，请继续在 TRAE 登录页登录新账号。",
      );
      const started = await this.ensureTraeStarted();
      if (!started) {
        throw new Error("TRAE did not expose the debugging port after recovery");
      }
      await this.monitorForNewAccount(session);
    } catch (error) {
      await this.handleFailure(session, error, {
        cleared: true,
        traeStopped: false,
      });
    }
  }

  async monitorForNewAccount(session) {
    while (this.now() < session.expiresAt) {
      if (session.cancelRequested) throw new Error("登录流程已取消");
      const candidate = await this.detectNewAccount(session.originalUserId);
      if (candidate) {
        if (session.cancelRequested) throw new Error("登录流程已取消");
        await this.completeWithCandidate(session, candidate);
        return;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error("等待新账号登录超时");
  }

  async completeWithCandidate(session, candidate) {
    const liveIdentity = await this.getLiveIdentity().catch(() => null);
    const matchingLiveIdentity =
      liveIdentity?.userId === candidate.identity.userId ? liveIdentity : null;
    const saved = await this.accountStore.backupCurrent(candidate.storageRoot, {
      liveIdentity: matchingLiveIdentity,
      now: this.now(),
    });
    session.account = saved.account;
    await this.setSessionState(
      session,
      "syncing",
      "新账号已保存，正在同步额度和签到...",
    );
    if (this.onAccountSaved) {
      try {
        await this.onAccountSaved(saved.account, {
          source: "fake-logout",
          createdSnapshot: saved.createdSnapshot,
        });
      } catch (error) {
        session.syncError = error.message || String(error);
        this.logger.error(
          `[fake-logout] post-login sync failed sessionId=${session.sessionId}: ${session.syncError}`,
        );
      }
    }
    await this.setSessionState(
      session,
      "complete",
      `新账号「${saved.account.displayName}」已加入列表。`,
    );
    this.logger.log(`[fake-logout] completed sessionId=${session.sessionId}`);
  }

  async restoreOriginal(session, { cancelled, message }) {
    await this.setSessionState(session, "restoring", "登录未完成，正在恢复原账号...");
    if (await this.isTraeRunning()) await this.stopTrae();
    await applyAuthSnapshot({
      storagePath: this.storagePath,
      snapshot: session.originalSnapshot,
      now: this.now(),
    });
    const restarted = await this.startTrae();
    if (!restarted) {
      throw new Error("TRAE did not expose the debugging port after restoring the account");
    }
    await this.setSessionState(
      session,
      "cancelled",
      cancelled ? "已取消，原账号已恢复。" : `登录失败（${message}），原账号已恢复。`,
    );
  }

  async handleFailure(session, error, { cleared, traeStopped }) {
    const message = error.message || String(error);
    const cancelled = session.cancelRequested || message === "登录流程已取消";
    if (cleared) {
      try {
        await this.restoreOriginal(session, { cancelled, message });
      } catch (restoreError) {
        session.error = restoreError.message || String(restoreError);
        await this.setSessionState(
          session,
          "error",
          `恢复原账号失败：${session.error}`,
          { retainPersisted: true },
        );
        this.logger.error(
          `[fake-logout] restore failed sessionId=${session.sessionId}: ${session.error}`,
        );
        return;
      }
    } else {
      if (traeStopped) await this.ensureTraeStarted();
      session.error = cancelled ? null : message;
      await this.setSessionState(
        session,
        cancelled ? "cancelled" : "error",
        cancelled ? "已取消，当前账号未改变。" : message,
      );
    }
    this.logger.log(
      `[fake-logout] ${cancelled ? "cancelled" : "failed"} sessionId=${session.sessionId}`,
    );
  }

  async ensureTraeStarted() {
    if (await this.isTraeRunning()) return true;
    return await this.startTrae();
  }

  async detectNewAccount(originalUserId) {
    let first;
    try {
      first = await this.readCandidateIdentity();
    } catch {
      return null;
    }
    if (!first?.userId || String(first.userId) === String(originalUserId)) return null;

    await this.sleep(this.settleMs);
    let second;
    try {
      second = await this.readCandidateIdentity();
    } catch {
      return null;
    }
    if (!second?.userId || String(second.userId) !== String(first.userId)) return null;

    const storageRoot = await readJsonFile(this.storagePath);
    const snapshot = extractAuthSnapshot(storageRoot);
    const identity = extractIdentityFromSnapshot(snapshot);
    if (!identity.userId || String(identity.userId) !== String(first.userId)) return null;
    return { storageRoot, snapshot, identity };
  }

  async readCandidateIdentity() {
    const root = await readJsonFile(this.storagePath);
    const snapshot = extractAuthSnapshot(root);
    return extractIdentityFromSnapshot(snapshot);
  }

  async readCurrentIdentity() {
    try {
      return await this.readCandidateIdentity();
    } catch {
      return null;
    }
  }
}
