(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpOperationLedger = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STORAGE_KEY = "premiere-mcp.operation-ledger.v1";
  const MAX_OPERATIONS = 4096;
  const MAX_STORAGE_CHARS = 1024 * 1024;
  function failure(code, message) { const error = new Error(message); error.code = code; return error; }
  function canonical(value, depth) {
    if ((depth || 0) > 32) throw failure("UXP_INVALID_ARGUMENT", "Invocation exceeds maximum object depth");
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map((item) => canonical(item, (depth || 0) + 1)).join(",") + "]";
    if (value && typeof value === "object") {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
      if (keys.length > 4096) throw failure("UXP_INVALID_ARGUMENT", "Invocation has too many fields");
      return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key], (depth || 0) + 1)).join(",") + "}";
    }
    throw failure("UXP_INVALID_ARGUMENT", "Invocation must contain finite JSON values");
  }
  function createOperationLedger(options) {
    const storage = options.storage;
    const digest = options.digest;
    const durable = !!(storage && typeof storage.getItem === "function" && typeof storage.setItem === "function");
    let sessionId = options.sessionId || "panel-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    const records = new Map();
    let corrupt = false;
    function refresh(initial) {
      if (!durable) return;
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw) {
          if (raw.length > MAX_STORAGE_CHARS) throw new Error("Oversized ledger");
          const value = JSON.parse(raw);
          if (value.version !== 1 || typeof value.sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.sessionId) || !Array.isArray(value.records) || value.records.length > MAX_OPERATIONS || Object.keys(value).some((key) => !["version", "sessionId", "records"].includes(key))) throw new Error("Invalid ledger");
          sessionId = value.sessionId;
          const incoming = new Map();
          for (const record of value.records) {
            if (!record || typeof record.id !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(record.id) || incoming.has(record.id) || Object.keys(record).some((key) => !["id", "binding", "scope", "outcome"].includes(key)) || !/^sha256:[a-f0-9]{64}$/.test(record.binding) || !/^sha256:[a-f0-9]{64}$/.test(record.scope) || !["pending", "unknown", "consumed", "verified", "committed", "committed_unverified", "failed"].includes(record.outcome)) throw new Error("Invalid ledger record");
            // A persisted reservation has no trustworthy terminal response after reload.
            const previous = records.get(record.id);
            incoming.set(record.id, { ...record, outcome: record.outcome === "pending" ? !initial && previous && previous.outcome === "pending" && previous.binding === record.binding ? "pending" : "unknown" : record.outcome });
          }
          records.clear();
          for (const [id, record] of incoming) records.set(id, record);
        } else if (records.size > 0) corrupt = true;
      } catch (_) { corrupt = true; }
    }
    refresh(true);
    function persist() {
      if (!storage || typeof storage.setItem !== "function") return;
      const raw = JSON.stringify({ version: 1, sessionId, records: Array.from(records.values()) });
      if (raw.length > MAX_STORAGE_CHARS) throw failure("UXP_OPERATION_LEDGER_FULL", "Operation ledger is full; reconnect alone does not make retry safe");
      try { storage.setItem(STORAGE_KEY, raw); } catch (_) { throw failure("UXP_OPERATION_LEDGER_UNAVAILABLE", "Cannot preserve operation reservation; no new host mutation was dispatched"); }
    }
    function scope(identity) { return digest(canonical({ backend: "uxp", sessionId, project: identity.projectGuid || null })); }
    function bind(command, args, identity) { refresh(false); return digest(canonical({ version: 1, backend: "uxp", sessionId, command, args, identity })); }
    function inspect(identity) {
      refresh(false);
      const targetScope = scope(identity);
      const operations = Array.from(records.values()).filter((item) => item.scope === targetScope && (item.outcome === "unknown" || item.outcome === "pending"));
      const value = { version: 1, backend: "uxp", sessionId, projectGuid: identity.projectGuid || null, recoveryRequired: corrupt || operations.length > 0, ledgerCorrupt: corrupt, operations };
      return { ...value, recoveryRevision: digest(canonical(value)), identityRevision: digest(canonical(identity)) };
    }
    return {
      get sessionId() { return sessionId; },
      durable,
      bind,
      get(id, binding) {
        refresh(false);
        const record = records.get(id);
        if (record && record.binding !== binding) throw failure("UXP_OPERATION_CONFLICT", "Operation ID is bound to different arguments, project, sequence, or command; inspect current state and use a new reviewed operation ID");
        return record || null;
      },
      assertReady(identity) { if (inspect(identity).recoveryRequired) throw failure("UXP_RECOVERY_REQUIRED", "An earlier mutation has unknown outcome. Inspect operation recovery and current project state before acknowledging reviewed reconciliation"); },
      reserve(id, binding, identity) {
        refresh(false);
        if (records.has(id)) throw failure("UXP_OPERATION_CONSUMED", "Operation ID was already reserved by another panel context; inspect its outcome before proceeding");
        if (options.requireDurability === true && !durable) throw failure("UXP_OPERATION_LEDGER_UNAVAILABLE", "Persistent operation storage is unavailable; no host mutation was dispatched");
        if (corrupt) throw failure("UXP_RECOVERY_REQUIRED", "Stored operation ledger cannot be validated; mutations are blocked");
        if (records.size >= MAX_OPERATIONS) throw failure("UXP_OPERATION_LEDGER_FULL", "Operation ledger reached its bounded capacity; consumed IDs cannot be silently evicted");
        const record = { id, binding, scope: scope(identity), outcome: "pending" };
        records.set(id, record);
        try { persist(); } catch (error) { records.delete(id); throw error; }
      },
      finish(id, outcome) { refresh(false); const record = records.get(id); if (record) { record.outcome = ["verified", "committed", "committed_unverified", "failed"].includes(outcome) ? outcome : "unknown"; persist(); } },
      unknown(id) { refresh(false); const record = records.get(id); if (record) { record.outcome = "unknown"; persist(); } },
      releasePreflight(id) { refresh(false); records.delete(id); persist(); },
      inspect,
      acknowledge(identity, args) {
        const view = inspect(identity);
        if (corrupt) throw failure("UXP_RECOVERY_REQUIRED", "Corrupt operation ledger requires manual repair; acknowledgement cannot discard it");
        if (args.reviewed !== true || args.expectedRecoveryRevision !== view.recoveryRevision || args.expectedIdentityRevision !== view.identityRevision || canonical(args.operationIds) !== canonical(view.operations.map((item) => item.id))) throw failure("UXP_STALE_RECOVERY", "Reviewed recovery must match the latest inspected operation IDs, revision, and current host identity");
        for (const record of view.operations) records.get(record.id).outcome = "consumed";
        persist();
        return { acknowledged: true, replayAuthorized: false, reconciledOperationIds: view.operations.map((item) => item.id), recoveryRequired: false, boundary: "user_reviewed_current_host_state", outcome: "verified" };
      }
    };
  }
  return { createOperationLedger, canonical, STORAGE_KEY, MAX_OPERATIONS };
});
