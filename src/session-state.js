import { MAIN_CONTEXT_ID } from "./state-store.js";

const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_LEASE_TTL_MS = 15 * 60 * 1000;

export class SessionStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SessionStateError";
    this.code = code;
    this.details = details;
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SessionStateError("invalid_argument", `${name} must be a non-empty string`, {
      field: name,
    });
  }
  return value;
}

function contextIdOrMain(value) {
  if (value == null || value === "") return MAIN_CONTEXT_ID;
  return requireString(value, "contextId");
}

function integerOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class SessionState {
  constructor(
    store,
    {
      clock = () => Date.now(),
      defaultLeaseTtlMs = DEFAULT_LEASE_TTL_MS,
      maxLeaseTtlMs = DEFAULT_MAX_LEASE_TTL_MS,
    } = {},
  ) {
    if (!store?.state || typeof store.save !== "function" || typeof store.sessionKey !== "function") {
      throw new SessionStateError("invalid_store", "SessionState requires a loaded StateStore");
    }
    this.store = store;
    this.clock = clock;
    this.defaultLeaseTtlMs = defaultLeaseTtlMs;
    this.maxLeaseTtlMs = maxLeaseTtlMs;
    this.operationChain = Promise.resolve();
    this.validateTtl(defaultLeaseTtlMs);
    this.validateTtl(maxLeaseTtlMs, Number.MAX_SAFE_INTEGER);
    if (defaultLeaseTtlMs > maxLeaseTtlMs) {
      throw new SessionStateError(
        "invalid_argument",
        "defaultLeaseTtlMs cannot exceed maxLeaseTtlMs",
      );
    }
  }

  scopeKey(scope) {
    const normalized = this.normalizeScope(scope);
    return this.store.sessionKey(
      normalized.senderId,
      normalized.chatId,
      normalized.repository,
      normalized.contextId,
    );
  }

  getBinding(scope) {
    const normalizedScope = this.normalizeScope(scope);
    const record = this.recordFor(normalizedScope);
    if (!record?.threadId) return null;
    return this.present(normalizedScope, record);
  }

  getSnapshot(scope) {
    const normalizedScope = this.normalizeScope(scope);
    const record = this.recordFor(normalizedScope);
    return {
      ...normalizedScope,
      threadId: record?.threadId ?? null,
      bindingGeneration: integerOr(record?.bindingGeneration, record?.threadId ? 1 : 0),
      leaseGeneration: integerOr(record?.leaseGeneration, 0),
    };
  }

  listBindings(filter = {}) {
    const entries = [];
    const contextId = Object.hasOwn(filter, "contextId")
      ? contextIdOrMain(filter.contextId)
      : null;
    for (const [key, rawRecord] of Object.entries(this.store.state.sessions ?? {})) {
      if (!rawRecord?.threadId) continue;
      const scope = this.scopeFromRecord(key, rawRecord);
      if (!scope) continue;
      if (filter.senderId && filter.senderId !== scope.senderId) continue;
      if (filter.chatId && filter.chatId !== scope.chatId) continue;
      if (contextId && contextId !== scope.contextId) continue;
      if (filter.repository && filter.repository !== scope.repository) continue;
      entries.push(this.present(scope, this.normalizeRecord(rawRecord)));
    }
    return entries.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async bind(scope, binding, options = {}) {
    const normalizedScope = this.normalizeScope(scope);
    const threadId = requireString(binding?.threadId, "threadId");
    const lastSyncedTurnId = binding?.lastSyncedTurnId == null
      ? null
      : requireString(binding.lastSyncedTurnId, "lastSyncedTurnId");
    return this.runExclusive(async () => {
      const current = this.recordFor(normalizedScope);
      if (Object.hasOwn(options, "expectedBindingGeneration")) {
        if (!Number.isSafeInteger(options.expectedBindingGeneration)) {
          throw new SessionStateError(
            "expected_generation_required",
            "Binding expectedBindingGeneration must be an integer",
          );
        }
        this.assertBindingGeneration(current, options.expectedBindingGeneration);
      }
      const replacing = Boolean(current?.threadId && current.threadId !== threadId);
      if (replacing) {
        if (!options.replace) {
          throw this.error("binding_conflict", "A different thread is already bound", current);
        }
        if (!Number.isSafeInteger(options.expectedBindingGeneration)) {
          throw new SessionStateError(
            "expected_generation_required",
            "Replacing a binding requires expectedBindingGeneration",
          );
        }
        this.assertBindingGeneration(current, options.expectedBindingGeneration);
        this.assertNoActiveLease(current);
      }

      const now = this.now();
      const changedThread = current?.threadId !== threadId;
      const next = {
        ...current,
        threadId,
        title: binding.title ?? (changedThread ? null : current?.title ?? null),
        source: binding.source ?? (changedThread ? "unknown" : current?.source ?? "unknown"),
        boundAt: changedThread ? now.iso : current?.boundAt ?? now.iso,
        updatedAt: now.iso,
        bindingGeneration: integerOr(current?.bindingGeneration, current?.threadId ? 1 : 0)
          + (changedThread ? 1 : 0),
        leaseGeneration: integerOr(current?.leaseGeneration, 0),
        lease: current?.lease ?? null,
        senderId: normalizedScope.senderId,
        chatId: normalizedScope.chatId,
        contextId: normalizedScope.contextId,
        repository: normalizedScope.repository,
      };
      if (changedThread) {
        this.invalidateLease(next, now.iso);
        delete next.lastSyncedTurnId;
        delete next.lastSyncedAt;
        delete next.forkedFromThreadId;
      }
      if (lastSyncedTurnId) {
        next.lastSyncedTurnId = lastSyncedTurnId;
        next.lastSyncedAt = now.iso;
      }
      delete next.detachedAt;
      delete next.leaseRecoveredAt;
      this.writeRecord(normalizedScope, next);
      await this.store.save();
      return this.present(normalizedScope, next);
    });
  }

  async detach(scope, { expectedBindingGeneration } = {}) {
    const normalizedScope = this.normalizeScope(scope);
    return this.runExclusive(async () => {
      const current = this.recordFor(normalizedScope);
      if (!current?.threadId) return null;
      if (!Number.isSafeInteger(expectedBindingGeneration)) {
        throw new SessionStateError(
          "expected_generation_required",
          "Detaching requires expectedBindingGeneration",
        );
      }
      this.assertBindingGeneration(current, expectedBindingGeneration);
      this.assertNoActiveLease(current);
      const now = this.now();
      const detached = {
        ...current,
        threadId: null,
        title: null,
        updatedAt: now.iso,
        detachedAt: now.iso,
        bindingGeneration: integerOr(current.bindingGeneration, 1) + 1,
      };
      this.invalidateLease(detached, now.iso);
      this.writeRecord(normalizedScope, detached);
      await this.store.save();
      return this.present(normalizedScope, detached);
    });
  }

  async acquireLease(
    scope,
    {
      owner,
      expectedThreadId,
      expectedBindingGeneration,
      ttlMs = this.defaultLeaseTtlMs,
    } = {},
  ) {
    const normalizedScope = this.normalizeScope(scope);
    requireString(owner, "owner");
    requireString(expectedThreadId, "expectedThreadId");
    if (!Number.isSafeInteger(expectedBindingGeneration) || expectedBindingGeneration < 0) {
      throw new SessionStateError(
        "expected_generation_required",
        "Acquiring a lease requires expectedBindingGeneration",
      );
    }
    this.validateTtl(ttlMs);
    return this.runExclusive(async () => {
      const record = this.requireBinding(normalizedScope);
      this.assertExpectedBinding(record, expectedThreadId, expectedBindingGeneration);
      const now = this.now();
      if (this.isLeaseActive(record.lease, now.ms)) {
        throw this.error("lease_conflict", "The thread is already leased", record);
      }
      const generation = integerOr(record.leaseGeneration, 0) + 1;
      record.leaseGeneration = generation;
      record.lease = this.newLease(owner, generation, ttlMs, now);
      record.updatedAt = now.iso;
      this.writeRecord(normalizedScope, record);
      await this.store.save();
      return this.leaseResult(normalizedScope, record);
    });
  }

  async renewLease(scope, token, { ttlMs = this.defaultLeaseTtlMs } = {}) {
    const normalizedScope = this.normalizeScope(scope);
    this.validateTtl(ttlMs);
    return this.runExclusive(async () => {
      const record = this.requireBinding(normalizedScope);
      const now = this.now();
      this.assertLease(record, token, now.ms);
      record.lease.renewedAt = now.iso;
      record.lease.expiresAt = new Date(now.ms + ttlMs).toISOString();
      record.updatedAt = now.iso;
      this.writeRecord(normalizedScope, record);
      await this.store.save();
      return this.leaseResult(normalizedScope, record);
    });
  }

  async releaseLease(scope, token) {
    const normalizedScope = this.normalizeScope(scope);
    return this.runExclusive(async () => {
      const record = this.requireBinding(normalizedScope);
      const now = this.now();
      this.assertLease(record, token, now.ms);
      this.invalidateLease(record, now.iso);
      record.updatedAt = now.iso;
      this.writeRecord(normalizedScope, record);
      await this.store.save();
      return this.present(normalizedScope, record);
    });
  }

  async takeoverLease(
    scope,
    {
      owner,
      observedGeneration,
      expectedThreadId,
      expectedBindingGeneration,
      ttlMs = this.defaultLeaseTtlMs,
      reason = "explicit_takeover",
    } = {},
  ) {
    const normalizedScope = this.normalizeScope(scope);
    requireString(owner, "owner");
    requireString(reason, "reason");
    requireString(expectedThreadId, "expectedThreadId");
    if (!Number.isSafeInteger(expectedBindingGeneration) || expectedBindingGeneration < 0) {
      throw new SessionStateError(
        "expected_generation_required",
        "Takeover requires expectedBindingGeneration",
      );
    }
    this.validateTtl(ttlMs);
    if (!Number.isSafeInteger(observedGeneration) || observedGeneration < 0) {
      throw new SessionStateError(
        "expected_generation_required",
        "Takeover requires the observed lease generation",
      );
    }
    return this.runExclusive(async () => {
      const record = this.requireBinding(normalizedScope);
      this.assertExpectedBinding(record, expectedThreadId, expectedBindingGeneration);
      const now = this.now();
      if (integerOr(record.leaseGeneration, 0) !== observedGeneration) {
        throw this.error("generation_mismatch", "The lease changed before takeover", record);
      }
      const previousLease = this.isLeaseActive(record.lease, now.ms) ? clone(record.lease) : null;
      const generation = integerOr(record.leaseGeneration, 0) + 1;
      record.leaseGeneration = generation;
      record.lease = { ...this.newLease(owner, generation, ttlMs, now), takeoverReason: reason };
      record.updatedAt = now.iso;
      this.writeRecord(normalizedScope, record);
      await this.store.save();
      return { ...this.leaseResult(normalizedScope, record), previousLease };
    });
  }

  async commitFork(
    scope,
    token,
    {
      sourceThreadId,
      newThreadId,
      title = null,
      source = "fork",
      ttlMs = this.defaultLeaseTtlMs,
    } = {},
  ) {
    const normalizedScope = this.normalizeScope(scope);
    requireString(sourceThreadId, "sourceThreadId");
    requireString(newThreadId, "newThreadId");
    requireString(source, "source");
    this.validateTtl(ttlMs);
    if (sourceThreadId === newThreadId) {
      throw new SessionStateError("invalid_argument", "A fork must have a new thread id");
    }
    return this.runExclusive(async () => {
      const record = this.requireBinding(normalizedScope);
      const now = this.now();
      this.assertLease(record, token, now.ms);
      if (record.threadId !== sourceThreadId) {
        throw this.error("binding_changed", "The source binding changed before fork commit", record);
      }

      const generation = integerOr(record.leaseGeneration, 0) + 1;
      record.threadId = newThreadId;
      record.title = title;
      record.source = source;
      record.forkedFromThreadId = sourceThreadId;
      record.boundAt = now.iso;
      record.updatedAt = now.iso;
      record.bindingGeneration = integerOr(record.bindingGeneration, 1) + 1;
      record.leaseGeneration = generation;
      record.lease = this.newLease(token.owner, generation, ttlMs, now);
      this.writeRecord(normalizedScope, record);
      await this.store.save();
      return this.leaseResult(normalizedScope, record);
    });
  }

  async cleanupExpiredLeases() {
    return this.runExclusive(async () => {
      const now = this.now();
      const cleaned = [];
      for (const [key, rawRecord] of Object.entries(this.store.state.sessions ?? {})) {
        const record = this.normalizeRecord(rawRecord);
        if (!record.lease || this.isLeaseActive(record.lease, now.ms)) continue;
        const scope = this.scopeFromRecord(key, record);
        if (!scope) continue;
        const previousLease = clone(record.lease);
        this.invalidateLease(record, now.iso);
        record.updatedAt = now.iso;
        this.writeRecord(scope, record);
        cleaned.push({ scope, previousLease, leaseGeneration: record.leaseGeneration });
      }
      if (cleaned.length > 0) await this.store.save();
      return cleaned;
    });
  }

  async recoverAfterRestart() {
    return this.runExclusive(async () => {
      const now = this.now();
      const recovered = [];
      let migrated = false;
      for (const [key, rawRecord] of Object.entries(this.store.state.sessions ?? {})) {
        const record = this.normalizeRecord(rawRecord);
        const scope = this.scopeFromRecord(key, record);
        if (!scope) continue;
        const needsMigration =
          rawRecord.senderId !== scope.senderId
          || rawRecord.chatId !== scope.chatId
          || rawRecord.contextId !== scope.contextId
          || rawRecord.repository !== scope.repository
          || !Number.isSafeInteger(rawRecord.bindingGeneration)
          || !Number.isSafeInteger(rawRecord.leaseGeneration)
          || !Object.hasOwn(rawRecord, "source");
        if (needsMigration) {
          Object.assign(record, scope);
          this.writeRecord(scope, record);
          const canonicalKey = this.scopeKey(scope);
          if (key !== canonicalKey) delete this.store.state.sessions[key];
          migrated = true;
        }
        if (!record.lease) continue;
        const previousLease = clone(record.lease);
        this.invalidateLease(record, now.iso);
        record.leaseRecoveredAt = now.iso;
        record.updatedAt = now.iso;
        this.writeRecord(scope, record);
        recovered.push({ scope, previousLease, leaseGeneration: record.leaseGeneration });
      }
      if (migrated || recovered.length > 0) await this.store.save();
      return recovered;
    });
  }

  normalizeScope(scope) {
    return {
      senderId: requireString(scope?.senderId, "senderId"),
      chatId: requireString(scope?.chatId, "chatId"),
      contextId: contextIdOrMain(scope?.contextId),
      repository: requireString(scope?.repository, "repository"),
    };
  }

  recordFor(scope) {
    const record = this.store.state.sessions?.[this.scopeKey(scope)];
    return record ? this.normalizeRecord(record) : null;
  }

  requireBinding(scope) {
    const record = this.recordFor(scope);
    if (!record?.threadId) {
      throw new SessionStateError("binding_missing", "No thread is bound to this conversation");
    }
    return record;
  }

  normalizeRecord(record) {
    return {
      ...record,
      title: record.title ?? null,
      source: record.source ?? "legacy",
      bindingGeneration: integerOr(record.bindingGeneration, record.threadId ? 1 : 0),
      leaseGeneration: integerOr(record.leaseGeneration, 0),
      lease: record.lease ?? null,
    };
  }

  scopeFromRecord(key, record) {
    if (record.senderId && record.chatId && record.repository) {
      return {
        senderId: record.senderId,
        chatId: record.chatId,
        contextId: contextIdOrMain(record.contextId),
        repository: record.repository,
      };
    }
    const senderSeparator = key.indexOf(":");
    const chatSeparator = key.indexOf(":", senderSeparator + 1);
    if (senderSeparator < 1 || chatSeparator <= senderSeparator + 1 || chatSeparator === key.length - 1) {
      return null;
    }
    const senderId = key.slice(0, senderSeparator);
    const chatId = key.slice(senderSeparator + 1, chatSeparator);
    const remainder = key.slice(chatSeparator + 1);
    if (remainder.startsWith("ctx=")) {
      const contextSeparator = remainder.indexOf(":");
      if (contextSeparator <= 4 || contextSeparator === remainder.length - 1) return null;
      try {
        return {
          senderId,
          chatId,
          contextId: contextIdOrMain(decodeURIComponent(remainder.slice(4, contextSeparator))),
          repository: remainder.slice(contextSeparator + 1),
        };
      } catch {
        return null;
      }
    }
    return { senderId, chatId, contextId: MAIN_CONTEXT_ID, repository: remainder };
  }

  writeRecord(scope, record) {
    this.store.state.sessions ??= {};
    this.store.state.sessions[this.scopeKey(scope)] = record;
  }

  present(scope, record) {
    const result = clone(record);
    if (result.lease) result.lease.active = this.isLeaseActive(result.lease, this.now().ms);
    return { ...result, ...scope };
  }

  newLease(owner, generation, ttlMs, now) {
    return {
      owner,
      generation,
      acquiredAt: now.iso,
      renewedAt: now.iso,
      expiresAt: new Date(now.ms + ttlMs).toISOString(),
    };
  }

  leaseResult(scope, record) {
    return {
      binding: this.present(scope, record),
      token: {
        owner: record.lease.owner,
        generation: record.lease.generation,
        threadId: record.threadId,
      },
    };
  }

  assertLease(record, token, nowMs) {
    if (!record.lease) {
      throw this.error("lease_missing", "The thread has no active lease", record);
    }
    if (!this.isLeaseActive(record.lease, nowMs)) {
      throw this.error("lease_expired", "The lease has expired", record);
    }
    if (
      token?.owner !== record.lease.owner
      || token?.generation !== record.lease.generation
      || token?.threadId !== record.threadId
    ) {
      throw this.error("lease_fenced", "The lease token is stale or belongs to another owner", record);
    }
  }

  assertNoActiveLease(record) {
    if (this.isLeaseActive(record?.lease, this.now().ms)) {
      throw this.error("lease_conflict", "Cannot change a binding while it is leased", record);
    }
  }

  assertBindingGeneration(record, expected) {
    if (integerOr(record?.bindingGeneration, record?.threadId ? 1 : 0) !== expected) {
      throw this.error("generation_mismatch", "The binding changed before the operation", record);
    }
  }

  assertExpectedBinding(record, expectedThreadId, expectedBindingGeneration) {
    if (record?.threadId !== expectedThreadId) {
      throw this.error("binding_changed", "The bound thread changed before the operation", record);
    }
    this.assertBindingGeneration(record, expectedBindingGeneration);
  }

  invalidateLease(record, timestamp) {
    record.leaseGeneration = integerOr(record.leaseGeneration, 0) + 1;
    record.lease = null;
    record.leaseInvalidatedAt = timestamp;
  }

  isLeaseActive(lease, nowMs) {
    const expiresAt = parseTimestamp(lease?.expiresAt);
    return Boolean(lease?.owner && Number.isSafeInteger(lease?.generation) && expiresAt > nowMs);
  }

  validateTtl(ttlMs, maximum = this.maxLeaseTtlMs) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maximum) {
      throw new SessionStateError(
        "invalid_argument",
        `Lease TTL must be an integer between 1 and ${maximum} milliseconds`,
      );
    }
  }

  now() {
    const ms = Number(this.clock());
    if (!Number.isFinite(ms)) {
      throw new SessionStateError("invalid_clock", "Clock returned an invalid timestamp");
    }
    return { ms, iso: new Date(ms).toISOString() };
  }

  error(code, message, record) {
    return new SessionStateError(code, message, {
      threadId: record?.threadId ?? null,
      bindingGeneration: integerOr(record?.bindingGeneration, record?.threadId ? 1 : 0),
      leaseGeneration: integerOr(record?.leaseGeneration, 0),
      leaseOwner: record?.lease?.owner ?? null,
      leaseExpiresAt: record?.lease?.expiresAt ?? null,
    });
  }

  runExclusive(operation) {
    const result = this.operationChain.then(operation);
    this.operationChain = result.catch(() => {});
    return result;
  }
}
