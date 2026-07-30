import { EventEmitter } from "node:events";
import path from "node:path";

function providerConfig(config) {
  const provider = config.codex.provider;
  if (!provider) return {};
  return {
    model_provider: provider.id,
    model_providers: {
      [provider.id]: {
        name: provider.name,
        base_url: provider.baseUrl,
        wire_api: provider.wireApi,
        requires_openai_auth: provider.requiresOpenAIAuth,
      },
    },
  };
}

export function sandboxPolicy(sandbox, repositoryPath) {
  if (!path.isAbsolute(repositoryPath)) {
    throw new Error(`App-server repository path must be absolute: ${repositoryPath}`);
  }
  if (sandbox === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  if (sandbox === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [repositoryPath],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  }
  throw new Error(`Unsupported app-server sandbox: ${sandbox}`);
}

function finalAgentMessage(turn) {
  return [...(turn?.items ?? [])]
    .reverse()
    .find((item) => item.type === "agentMessage"
      && item.phase !== "commentary"
      && typeof item.text === "string"
      && item.text.trim().length > 0)?.text ?? "";
}

function itemSummary(item) {
  switch (item?.type) {
    case "commandExecution":
      return `命令：${item.command}`;
    case "fileChange":
      return `文件修改：${item.changes.length} 项`;
    case "mcpToolCall":
      return `MCP：${item.server}/${item.tool}`;
    case "webSearch":
      return "正在搜索网页";
    case "collabAgentToolCall":
      return `协作代理：${item.tool}`;
    case "plan":
      return "正在更新计划";
    default:
      return null;
  }
}

const TURN_MATERIALIZATION_RETRY_BUDGET_MS = 2_000;
const TURN_MATERIALIZATION_RETRY_DELAY_MS = 50;
const TURN_MATERIALIZATION_GRACE_BUFFER_MS = 250;
const TURN_PENDING_RECONCILE_INTERVAL_MS = 1_000;
const TURN_PENDING_RECONCILE_READ_TIMEOUT_MS = 1_000;
const TURN_TERMINAL_STABILITY_MS = 750;
const EARLY_COMPLETION_CACHE_LIMIT = 20;

function errorDiagnosticText(error) {
  const details = [
    error?.message,
    error?.code,
    error?.data?.code,
    error?.data?.kind,
    error?.data?.message,
  ];
  return details.filter((value) => value != null).map(String).join(" ");
}

export function transientTurnListError(error) {
  const diagnostic = errorDiagnosticText(error);
  if (/\b(?:thread[_ -]?not[_ -]?materiali[sz]ed|session[_ -]?not[_ -]?ready|rollout[_ -]?not[_ -]?ready)\b/i.test(diagnostic)) {
    return true;
  }
  const subject = /thread\/turns\/list|rollout|session metadata|thread history|session history/i;
  const readiness = /not materiali[sz]ed|not ready|temporar(?:ily)? unavailable|\bis empty\b|being (?:created|written)/i;
  return subject.test(diagnostic) && readiness.test(diagnostic);
}

function shortDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function threadBusyError(threadId, conflictingTurnId = null) {
  const detail = conflictingTurnId
    ? ` concurrently started turn ${conflictingTurnId}`
    : " already has an active turn";
  const error = new Error(`Thread ${threadId}${detail}`);
  error.code = "THREAD_BUSY";
  error.threadId = threadId;
  if (conflictingTurnId) error.conflictingTurnId = conflictingTurnId;
  return error;
}

function conclusiveTerminalTurn(turn) {
  return Boolean(turn?.error?.message
    || (turn?.status === "completed" && finalAgentMessage(turn)));
}

function preferMaterializedTurn(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  if (current === candidate) return current;
  const currentMessage = finalAgentMessage(current);
  const candidateMessage = finalAgentMessage(candidate);
  const items = candidateMessage || !currentMessage ? candidate.items : current.items;
  return {
    ...current,
    ...candidate,
    ...(items === undefined ? {} : { items }),
  };
}

function withFinalAgentMessage(turn, message) {
  if (!turn || !message?.trim() || finalAgentMessage(turn)) return turn;
  return {
    ...turn,
    items: [
      ...(turn.items ?? []),
      { type: "agentMessage", phase: "final_answer", text: message },
    ],
  };
}

async function operationBeforeDeadline(operation, cancellation, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { type: "deadline" };
  let timer;
  const deadlineReached = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ type: "deadline" }), remaining);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value) => ({ type: "value", value }),
          (error) => ({ type: "error", error }),
        ),
      cancellation.then(() => ({ type: "cancelled" })),
      deadlineReached,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class AppServerRunner extends EventEmitter {
  constructor(client, config) {
    super();
    this.client = client;
    this.config = config;
    this.active = new Map();
    this.materializationRetryBudgetMs = TURN_MATERIALIZATION_RETRY_BUDGET_MS;
    this.materializationRetryDelayMs = TURN_MATERIALIZATION_RETRY_DELAY_MS;
    this.materializationGraceBufferMs = TURN_MATERIALIZATION_GRACE_BUFFER_MS;
    this.pendingReconcileIntervalMs = TURN_PENDING_RECONCILE_INTERVAL_MS;
    this.pendingReconcileReadTimeoutMs = TURN_PENDING_RECONCILE_READ_TIMEOUT_MS;
    this.terminalStabilityMs = TURN_TERMINAL_STABILITY_MS;
  }

  threadOptions(repositoryPath) {
    return {
      model: this.config.codex.model,
      modelProvider: this.config.codex.provider?.id ?? null,
      cwd: repositoryPath,
      runtimeWorkspaceRoots: [repositoryPath],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: this.config.codex.sandbox,
      config: providerConfig(this.config),
    };
  }

  async run(job, options) {
    let threadId = options.resumeThreadId ?? null;
    const recoverableTurnIds = new Set(
      (options.recoverableTurnIds ?? []).filter((turnId) => (
        typeof turnId === "string" && turnId.length > 0
      )),
    );
    const errors = [];
    let lastMessage = "";
    let completed = false;
    let timedOut = false;
    let turnId = null;
    let exitCode = 1;
    const listeners = [];
    let turnFinished = false;
    let timeoutTimer = null;
    let extendRuntimeTimeout = null;
    let resolveCancellation;
    const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });
    let resolveMaterializationCancellation;
    const materializationCancellation = new Promise((resolve) => {
      resolveMaterializationCancellation = resolve;
    });
    const materializationAbort = Promise.race([cancellation, materializationCancellation]);
    const active = {
      threadId,
      turnId: null,
      job,
      cancelRequested: false,
      turnFinished: false,
      materializingCompletion: false,
      materializationPending: false,
      completedEmptyObserved: false,
      terminalCandidateObserved: false,
      terminalObserved: false,
      approvalsOpen: false,
      interruptPromise: null,
      resolveCancellation,
      resolveMaterializationCancellation,
    };
    this.active.set(job.id, active);

    const listen = (method, callback) => {
      this.client.on(method, callback);
      listeners.push([method, callback]);
    };
    const interruptRecoverableTurns = async (turns) => {
      const conflicts = turns.filter((turn) => turn?.status === "inProgress");
      const unrecoverable = conflicts.find((turn) => !recoverableTurnIds.has(turn.id));
      if (unrecoverable) return { recovered: false, conflict: unrecoverable };
      for (const conflict of conflicts) {
        this.emit("recovering-orphaned-turn", {
          job,
          threadId,
          turnId: conflict.id,
        });
        await this.client.interruptTurn(threadId, conflict.id);
        recoverableTurnIds.delete(conflict.id);
      }
      return { recovered: conflicts.length > 0, conflict: null };
    };

    try {
      if (threadId) {
        const resumed = await this.client.resumeThread({
          threadId,
          ...this.threadOptions(options.repositoryPath),
          excludeTurns: true,
        });
        const status = resumed.thread.status;
        if (status?.type === "active") {
          const listed = await this.client.listTurns(threadId, { limit: 100 });
          const recovery = await interruptRecoverableTurns(listed?.data ?? []);
          if (!recovery.recovered || recovery.conflict) {
            throw threadBusyError(threadId, recovery.conflict?.id ?? null);
          }
        }
      } else {
        const started = await this.client.startThread({
          ...this.threadOptions(options.repositoryPath),
          dynamicTools: [],
          ephemeral: false,
          historyMode: "legacy",
          selectedCapabilityRoots: [],
          threadSource: "feishu",
        });
        threadId = started.thread.id;
      }
      active.threadId = threadId;
      if (active.cancelRequested) {
        turnFinished = true;
        return {
          code: exitCode,
          signal: null,
          threadId,
          lastMessage,
          errors,
          completed,
          timedOut,
          turnId,
        };
      }

      const state = { job, threadId, turnId: null, lastMessage: "", toolSummaries: [] };
      const commentaryItems = new Set();
      const finalAnswerText = new Map();
      const streamedFinalMessage = () => [...finalAnswerText.values()]
        .reverse()
        .find((text) => text.trim().length > 0) ?? "";
      listen("item/agentMessage/delta", (params) => {
        if (!turnId || params.threadId !== threadId || params.turnId !== turnId) return;
        state.lastMessage += params.delta;
        if (finalAnswerText.has(params.itemId)) {
          finalAnswerText.set(params.itemId, finalAnswerText.get(params.itemId) + params.delta);
        }
        if (commentaryItems.has(params.itemId)) {
          this.emit("progress", { ...state, type: "text", delta: params.delta });
        }
      });
      listen("item/started", (params) => {
        if (!turnId || params.threadId !== threadId || params.turnId !== turnId) return;
        if (params.item?.type === "agentMessage") {
          if (params.item.phase === "commentary" && params.item.id) {
            commentaryItems.add(params.item.id);
          }
          if (params.item.phase === "final_answer" && params.item.id) {
            finalAnswerText.set(params.item.id, "");
          }
          return;
        }
        const summary = itemSummary(params.item);
        if (!summary) return;
        state.toolSummaries.push(summary);
        this.emit("progress", { ...state, type: "tool", summary });
      });
      listen("item/completed", (params) => {
        if (params.threadId !== threadId || params.turnId !== turnId) return;
        if (params.item?.type === "agentMessage"
          && params.item.phase === "final_answer"
          && params.item.id
          && typeof params.item.text === "string") {
          finalAnswerText.set(params.item.id, params.item.text);
        }
        if (params.item?.id) commentaryItems.delete(params.item.id);
      });
      listen("approval-declined", ({ params }) => {
        if (!turnId || params?.threadId !== threadId || params?.turnId !== turnId) return;
        this.emit("progress", { ...state, type: "approval-declined" });
      });

      let completionGeneration = 0;
      let latestCompletionTurn = null;
      let completionWaiter = null;
      const markTerminal = (candidate) => {
        if (!active.terminalObserved) {
          active.terminalObserved = true;
          active.terminalCandidateObserved = false;
          active.completedEmptyObserved = false;
          active.approvalsOpen = false;
          this.emit("turn-terminal", {
            job,
            threadId,
            turnId: candidate.id,
            status: candidate.status,
          });
        }
      };
      const publishCompletion = (candidate) => {
        if (candidate?.status !== "inProgress") {
          if (conclusiveTerminalTurn(candidate)) {
            markTerminal(candidate);
          } else {
            active.terminalCandidateObserved = true;
            active.completedEmptyObserved = candidate.status === "completed";
            if (active.approvalsOpen) {
              active.approvalsOpen = false;
              this.emit("turn-approval-close", {
                job,
                threadId,
                turnId: candidate.id,
                status: candidate.status,
              });
            }
          }
        }
        if (candidate?.status === "completed" && !finalAgentMessage(candidate)) {
          extendRuntimeTimeout?.();
        }
        latestCompletionTurn = preferMaterializedTurn(latestCompletionTurn, candidate);
        completionGeneration += 1;
        if (completionWaiter) {
          const resolve = completionWaiter;
          completionWaiter = null;
          resolve({ turn: latestCompletionTurn, generation: completionGeneration });
        }
      };
      const waitForCompletionAfter = (generation) => {
        if (completionGeneration > generation) {
          return Promise.resolve({ turn: latestCompletionTurn, generation: completionGeneration });
        }
        return new Promise((resolve) => { completionWaiter = resolve; });
      };
      const earlyCompletions = new Map();
      listen("turn/completed", (params) => {
        if (params.threadId !== threadId || !params.turn?.id) return;
        if (!turnId) {
          earlyCompletions.set(
            params.turn.id,
            preferMaterializedTurn(earlyCompletions.get(params.turn.id), params.turn),
          );
          while (earlyCompletions.size > EARLY_COMPLETION_CACHE_LIMIT) {
            earlyCompletions.delete(earlyCompletions.keys().next().value);
          }
          return;
        }
        if (params.turn.id !== turnId) return;
        publishCompletion(params.turn);
      });
      const startedTurn = await this.client.startTurn({
        threadId,
        clientUserMessageId: job.sourceMessageId ?? null,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
        cwd: options.repositoryPath,
        runtimeWorkspaceRoots: [options.repositoryPath],
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: sandboxPolicy(this.config.codex.sandbox, options.repositoryPath),
        model: this.config.codex.model,
      });
      turnId = startedTurn.turn.id;
      state.turnId = turnId;
      active.turnId = turnId;
      active.approvalsOpen = true;
      const earlyCompletion = earlyCompletions.get(turnId);
      earlyCompletions.clear();
      if (earlyCompletion) publishCompletion(earlyCompletion);
      this.emit("turn-started", { job, threadId, turnId });
      let turn = null;
      if (active.cancelRequested) {
        try {
          await this.interruptActive(active, "cancel");
        } catch (error) {
          errors.push(error.message);
        }
        turn = await Promise.race([
          waitForCompletionAfter(0).then((notice) => notice.turn),
          cancellation,
        ]);
      } else {
        let activeTurns = null;
        if (!active.terminalObserved) {
          const verificationGeneration = completionGeneration;
          try {
            activeTurns = await this.listTurnsAfterStart(threadId, cancellation, {
              expectedTurnId: latestCompletionTurn ? null : turnId,
            });
          } catch (error) {
            if (completionGeneration <= verificationGeneration) throw error;
          }
          if (completionGeneration > verificationGeneration) activeTurns = null;
        }
        if (activeTurns) {
          const listedTurn = activeTurns.data.find((listed) => listed.id === turnId);
          if (listedTurn && listedTurn.status !== "inProgress") {
            publishCompletion(listedTurn);
          }
          const exactCompletionKnown = Boolean(listedTurn && listedTurn.status !== "inProgress")
            || Boolean(latestCompletionTurn && latestCompletionTurn.status !== "inProgress");
          if (!exactCompletionKnown && listedTurn?.status === "inProgress") {
            const conflicts = activeTurns.data.filter(
              (listed) => listed.status === "inProgress" && listed.id !== turnId,
            );
            const recovery = await interruptRecoverableTurns(conflicts);
            if (recovery.conflict) {
              await this.interruptActive(active, "concurrent_turn").catch(() => {});
              throw threadBusyError(threadId, recovery.conflict.id);
            }
          }
        }

        let resolveTimeout;
        let rejectTimeout;
        let timeoutStarted = false;
        const timeout = new Promise((resolve, reject) => {
          resolveTimeout = resolve;
          rejectTimeout = reject;
        });
        const triggerTimeout = () => {
          if (timeoutStarted) return;
          timeoutStarted = true;
          if (active.terminalCandidateObserved && active.completedEmptyObserved) {
            resolveTimeout({ status: "completed", items: [], error: null });
            return;
          }
          timedOut = true;
          this.interruptActive(active, "timeout").then(
            () => resolveTimeout({ status: "interrupted", items: [], error: null }),
            rejectTimeout,
          );
        };
        let timeoutDeadline = Date.now() + this.config.codex.maxRuntimeMinutes * 60_000;
        let materializationGraceGranted = false;
        const armTimeout = () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          timeoutTimer = setTimeout(triggerTimeout, Math.max(0, timeoutDeadline - Date.now()));
          timeoutTimer.unref?.();
        };
        extendRuntimeTimeout = () => {
          if (timeoutStarted || materializationGraceGranted) return;
          const extendedDeadline = Date.now()
            + this.materializationRetryBudgetMs
            + this.materializationGraceBufferMs;
          if (extendedDeadline <= timeoutDeadline) return;
          materializationGraceGranted = true;
          timeoutDeadline = extendedDeadline;
          armTimeout();
        };
        armTimeout();
        if (latestCompletionTurn?.status === "completed"
          && !finalAgentMessage(latestCompletionTurn)) {
          extendRuntimeTimeout();
        }
        let seenCompletionGeneration = 0;
        let pendingCandidate = null;
        let inconclusiveCandidateSeen = false;
        while (!turn) {
          let outcome;
          if (completionGeneration > seenCompletionGeneration) {
            outcome = {
              type: "completion",
              turn: latestCompletionTurn,
              generation: completionGeneration,
            };
          } else if (pendingCandidate) {
            extendRuntimeTimeout();
            outcome = await Promise.race([
              shortDelay(this.pendingReconcileIntervalMs)
                .then(() => ({ type: "reconcile" })),
              timeout.then((timeoutTurn) => ({ type: "timeout", turn: timeoutTurn })),
              cancellation.then((cancelledTurn) => ({ type: "cancelled", turn: cancelledTurn })),
            ]);
          } else {
            outcome = await Promise.race([
              waitForCompletionAfter(seenCompletionGeneration).then((notice) => ({
                type: "completion",
                ...notice,
              })),
              timeout.then((timeoutTurn) => ({ type: "timeout", turn: timeoutTurn })),
              cancellation.then((cancelledTurn) => ({ type: "cancelled", turn: cancelledTurn })),
            ]);
          }
          if (timedOut) {
            turn = await timeout;
            break;
          }
          if (outcome.type === "reconcile") {
            if (completionGeneration > seenCompletionGeneration) continue;
            const reconcileGeneration = completionGeneration;
            let reconciled;
            let reconcileError;
            try {
              reconciled = await this.reconcilePendingTurn(
                threadId,
                turnId,
                cancellation,
                { readTimeoutMs: this.pendingReconcileReadTimeoutMs },
              );
            } catch (error) {
              reconcileError = error;
            }
            if (timedOut) {
              turn = await timeout;
              break;
            }
            if (completionGeneration > reconcileGeneration) continue;
            if (reconcileError) throw reconcileError;
            if (reconciled.type === "cancelled") {
              turn = await Promise.race([timeout, cancellation]);
              break;
            }
            if (reconciled.type === "pending") {
              active.completedEmptyObserved = reconciled.observedStatus === "completed";
              if (active.completedEmptyObserved) {
                active.terminalCandidateObserved = true;
                if (active.approvalsOpen) {
                  active.approvalsOpen = false;
                  this.emit("turn-approval-close", {
                    job,
                    threadId,
                    turnId,
                    status: "completed",
                  });
                }
              } else if (reconciled.observedStatus === "inProgress") {
                active.terminalCandidateObserved = false;
                active.approvalsOpen = !active.cancelRequested;
              } else {
                active.terminalCandidateObserved = true;
                if (active.approvalsOpen) {
                  active.approvalsOpen = false;
                  this.emit("turn-approval-close", {
                    job,
                    threadId,
                    turnId,
                    status: reconciled.observedStatus,
                  });
                }
              }
              continue;
            }
            active.materializationPending = false;
            pendingCandidate = null;
            markTerminal(reconciled.turn);
            turn = reconciled.turn;
            continue;
          }
          if (outcome.type !== "completion") {
            turn = outcome.turn;
            break;
          }

          seenCompletionGeneration = outcome.generation;
          const candidate = withFinalAgentMessage(outcome.turn, streamedFinalMessage());
          pendingCandidate = null;
          active.materializationPending = false;
          if (conclusiveTerminalTurn(candidate)) {
            markTerminal(candidate);
            turn = candidate;
            break;
          }
          const emptyNonCompleted = candidate.status !== "completed"
            && candidate.status !== "inProgress";
          if (emptyNonCompleted && inconclusiveCandidateSeen) {
            turn = candidate;
            break;
          }
          inconclusiveCandidateSeen = true;

          active.materializingCompletion = true;
          active.materializationPending = false;
          const materializationGeneration = completionGeneration;
          let materialized;
          let materializationError;
          try {
            materialized = await this.materializeCompletedTurn(
              threadId,
              turnId,
              candidate,
              materializationAbort,
              () => latestCompletionTurn,
              {
                retryBudgetMs: this.materializationRetryBudgetMs,
                delayMs: this.materializationRetryDelayMs,
                terminalStabilityMs: this.terminalStabilityMs,
              },
            );
          } catch (error) {
            materializationError = error;
          } finally {
            active.materializingCompletion = false;
          }
          if (timedOut) {
            turn = await timeout;
            break;
          }
          if (completionGeneration > materializationGeneration) continue;
          if (materializationError) throw materializationError;
          active.materializationPending = materialized.type === "pending"
            || Boolean(materialized.pendingObserved);
          if (materialized.type === "pending") {
            const confirmedInProgress = materialized.observedStatus === "inProgress";
            active.terminalCandidateObserved = !confirmedInProgress;
            active.completedEmptyObserved = false;
            active.approvalsOpen = confirmedInProgress && !active.cancelRequested;
            if (active.cancelRequested) {
              await this.interruptActive(active, "cancel");
              turn = await cancellation;
              break;
            }
            pendingCandidate = candidate;
            continue;
          }
          if (materialized.type === "cancelled") {
            if (active.cancelRequested) {
              if (materialized.pendingObserved) {
                await this.interruptActive(active, "cancel");
              } else {
                active.resolveCancellation({ status: "interrupted", items: [], error: null });
              }
            }
            turn = await Promise.race([timeout, cancellation]);
            break;
          }
          active.materializationPending = false;
          markTerminal(materialized.turn);
          turn = materialized.turn;
        }
      }
      turnFinished = true;
      active.turnFinished = true;
      turn = withFinalAgentMessage(turn, streamedFinalMessage());
      completed = turn.status === "completed";
      lastMessage = finalAgentMessage(turn);
      if (turn.error?.message) errors.push(turn.error.message);
      exitCode = completed && lastMessage ? 0 : 1;
    } catch (error) {
      errors.push(error.message);
      if (turnId && !turnFinished
        && !active.terminalObserved
        && !active.terminalCandidateObserved) {
        try {
          await this.interruptActive(active, "run_error");
        } catch (interruptError) {
          if (interruptError.message !== error.message) errors.push(interruptError.message);
          const unconfirmed = new Error(`Turn interruption could not be confirmed: ${interruptError.message}`);
          unconfirmed.code = "TURN_INTERRUPT_UNCONFIRMED";
          unconfirmed.cause = interruptError;
          throw unconfirmed;
        }
      }
      if (error.code === "THREAD_BUSY") throw error;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      extendRuntimeTimeout = null;
      this.active.delete(job.id);
      for (const [method, callback] of listeners) this.client.off(method, callback);
    }

    return {
      code: exitCode,
      signal: null,
      threadId,
      lastMessage,
      errors,
      completed,
      timedOut,
      turnId,
    };
  }

  async cancel(jobId) {
    const active = this.active.get(jobId);
    if (!active) return false;
    active.cancelRequested = true;
    if (active.turnFinished) {
      active.resolveCancellation({
        status: "interrupted",
        items: [],
        error: null,
      });
      return true;
    }
    if (active.materializingCompletion) {
      active.resolveMaterializationCancellation();
      return true;
    }
    if (active.terminalObserved && !active.materializationPending) {
      active.resolveCancellation({ status: "interrupted", items: [], error: null });
      return true;
    }
    if (active.turnId) await this.interruptActive(active, "cancel");
    return true;
  }

  async interruptActive(active, reason = "interrupt") {
    if (!active?.threadId || !active.turnId) return false;
    if (!active.interruptPromise) {
      active.approvalsOpen = false;
      this.emit("interrupting", {
        job: active.job,
        threadId: active.threadId,
        turnId: active.turnId,
        reason,
      });
      active.interruptPromise = this.client.interruptTurn(active.threadId, active.turnId)
        .then(() => active.resolveCancellation({
          status: "interrupted",
          items: [],
          error: null,
        }));
    }
    const interruptPromise = active.interruptPromise;
    try {
      await interruptPromise;
    } catch (error) {
      if (active.interruptPromise === interruptPromise) active.interruptPromise = null;
      throw error;
    }
    return true;
  }

  async listTurnsAfterStart(
    threadId,
    cancellation,
    {
      retryBudgetMs = TURN_MATERIALIZATION_RETRY_BUDGET_MS,
      delayMs = TURN_MATERIALIZATION_RETRY_DELAY_MS,
      expectedTurnId = null,
    } = {},
  ) {
    const deadline = Date.now() + retryBudgetMs;
    let lastError;
    while (true) {
      const listing = await operationBeforeDeadline(
        () => this.client.listTurns(
          threadId,
          { limit: 20 },
          Math.max(1, deadline - Date.now()),
        ),
        cancellation,
        deadline,
      );
      if (listing.type === "value") {
        if (!expectedTurnId
          || listing.value?.data?.some((turn) => turn.id === expectedTurnId)) {
          return listing.value;
        }
        const error = new Error(
          `Turn ${expectedTurnId} is not materialized in thread ${threadId}`,
        );
        error.code = "TURN_NOT_MATERIALIZED";
        lastError = error;
      }
      if (listing.type === "cancelled") return null;
      if (listing.type === "deadline") {
        if (lastError) throw lastError;
        const error = new Error(`Timed out verifying turn state for thread ${threadId}`);
        error.code = "TURN_LIST_TIMEOUT";
        throw error;
      }
      if (listing.type === "error") {
        if (!transientTurnListError(listing.error)) throw listing.error;
        lastError = listing.error;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lastError;
      const retry = await Promise.race([
        shortDelay(Math.min(delayMs, remaining)).then(() => true),
        cancellation.then(() => false),
      ]);
      if (!retry) return null;
    }
  }

  async materializeCompletedTurn(
    threadId,
    turnId,
    initialTurn,
    cancellation,
    getLatestCompletion,
    {
      retryBudgetMs = TURN_MATERIALIZATION_RETRY_BUDGET_MS,
      delayMs = TURN_MATERIALIZATION_RETRY_DELAY_MS,
      terminalStabilityMs = TURN_TERMINAL_STABILITY_MS,
    } = {},
  ) {
    const deadline = Date.now() + retryBudgetMs;
    let latestTurn = initialTurn;
    let pendingObserved = false;
    let observedStatus = initialTurn?.status ?? "completed";
    let nonCompletedTerminalSince = initialTurn?.status
      && !["completed", "inProgress"].includes(initialTurn.status)
      && !conclusiveTerminalTurn(initialTurn)
      ? Date.now()
      : null;
    while (true) {
      const eventTurn = getLatestCompletion();
      if (eventTurn?.id === turnId && eventTurn.status !== "inProgress") {
        if (conclusiveTerminalTurn(eventTurn)) {
          return { type: "terminal", turn: eventTurn };
        }
        if (eventTurn.status !== "completed"
          && eventTurn.status !== initialTurn?.status) {
          return { type: "terminal", turn: eventTurn };
        }
        latestTurn = preferMaterializedTurn(latestTurn, eventTurn);
        observedStatus = eventTurn.status;
        if (eventTurn.status !== "completed") nonCompletedTerminalSince ??= Date.now();
      }
      if (latestTurn.status === "completed" && finalAgentMessage(latestTurn)) {
        return { type: "materialized", turn: latestTurn };
      }

      const listing = await operationBeforeDeadline(
        () => this.client.listTurns(
          threadId,
          { limit: 20 },
          Math.max(1, deadline - Date.now()),
        ),
        cancellation,
        deadline,
      );
      if (listing.type === "deadline") {
        return {
          type: pendingObserved ? "pending" : "terminal",
          observedStatus,
          turn: latestTurn,
        };
      }
      if (listing.type === "cancelled") {
        return {
          type: "cancelled",
          observedStatus,
          pendingObserved,
          turn: latestTurn,
        };
      }
      if (listing.type === "error") {
        if (!transientTurnListError(listing.error)) throw listing.error;
        observedStatus = "error";
        pendingObserved = true;
      } else {
        const listedTurn = listing.value?.data?.find((candidate) => candidate.id === turnId);
        if (!listedTurn) {
          observedStatus = "missing";
          pendingObserved = nonCompletedTerminalSince == null;
        } else if (listedTurn.status === "inProgress") {
          observedStatus = "inProgress";
          pendingObserved = true;
          nonCompletedTerminalSince = null;
        } else if (listedTurn.status !== "completed") {
          if (conclusiveTerminalTurn(listedTurn)) {
            return { type: "terminal", turn: listedTurn };
          }
          observedStatus = listedTurn.status;
          pendingObserved = false;
          latestTurn = preferMaterializedTurn(latestTurn, listedTurn);
          nonCompletedTerminalSince ??= Date.now();
        } else {
          observedStatus = "completed";
          pendingObserved = false;
          nonCompletedTerminalSince = null;
          latestTurn = preferMaterializedTurn(latestTurn, listedTurn);
          if (finalAgentMessage(latestTurn)) return { type: "materialized", turn: latestTurn };
        }
      }

      if (nonCompletedTerminalSince != null
        && Date.now() - nonCompletedTerminalSince >= terminalStabilityMs) {
        return { type: "terminal", turn: latestTurn };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          type: pendingObserved ? "pending" : "terminal",
          observedStatus,
          turn: latestTurn,
        };
      }
      const retry = await Promise.race([
        shortDelay(Math.min(delayMs, remaining)).then(() => true),
        cancellation.then(() => false),
      ]);
      if (!retry) {
        return {
          type: "cancelled",
          observedStatus,
          pendingObserved,
          turn: latestTurn,
        };
      }
    }
  }

  async reconcilePendingTurn(
    threadId,
    turnId,
    cancellation,
    { readTimeoutMs = TURN_PENDING_RECONCILE_READ_TIMEOUT_MS } = {},
  ) {
    const deadline = Date.now() + readTimeoutMs;
    const listing = await operationBeforeDeadline(
      () => this.client.listTurns(
        threadId,
        { limit: 20 },
        Math.max(1, deadline - Date.now()),
      ),
      cancellation,
      deadline,
    );
    if (listing.type === "cancelled") return { type: "cancelled" };
    if (listing.type === "deadline") return { type: "pending", observedStatus: "timeout" };
    if (listing.type === "error") {
      if (!transientTurnListError(listing.error)) throw listing.error;
      return { type: "pending", observedStatus: "error" };
    }

    const listedTurn = listing.value?.data?.find((candidate) => candidate.id === turnId);
    if (!listedTurn) return { type: "pending", observedStatus: "missing" };
    if (listedTurn.status === "inProgress") {
      return { type: "pending", observedStatus: "inProgress" };
    }
    if (listedTurn.status !== "completed") return { type: "terminal", turn: listedTurn };
    if (!finalAgentMessage(listedTurn)) {
      return { type: "pending", observedStatus: "completed" };
    }
    return { type: "materialized", turn: listedTurn };
  }

  activeJobIds() {
    return [...this.active.keys()];
  }

  findJob(threadId, turnId) {
    if (typeof threadId !== "string" || threadId.trim().length === 0
      || typeof turnId !== "string" || turnId.trim().length === 0) return null;
    for (const active of this.active.values()) {
      if (active.cancelRequested || !active.approvalsOpen) continue;
      if (active.threadId !== threadId || active.turnId !== turnId) continue;
      return active.job;
    }
    return null;
  }
}
