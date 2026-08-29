import * as crypto from "crypto";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildCoderAuthorizeUrl,
  buildCoderClientMetadata,
  buildCoderRefreshBody,
  buildCoderTokenExchangeBody,
  coderAibridgeBaseUrl,
  CODER_AI_PROVIDERS_PATH,
  CODER_BUILDINFO_PATH,
  CODER_GATEWAY_DEFAULT_PROVIDER_NAMES,
  coderGatewayWireProtocol,
  parseCoderGatewayProviders,
  CODER_OAUTH_CALLBACK_PATH,
  CODER_OAUTH_DISCOVERY_PATH,
  normalizeCoderDeploymentUrl,
  type CoderGatewayProvider,
} from "@/common/constants/coderOAuth";
import type { FileLeaseManager, ProvidersConfigStore } from "@/node/config";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  isCoderOauthAuthExpired,
  parseCoderOauthAuth,
  type CoderOauthAuth,
} from "@/node/utils/coderOauthAuth";
import { createDeferred } from "@/node/utils/oauthUtils";
import { startLoopbackServer } from "@/node/utils/oauthLoopbackServer";
import { OAuthFlowManager } from "@/node/utils/oauthFlowManager";
import { getErrorMessage } from "@/common/utils/errors";
import type { ProviderModelEntry } from "@/common/orpc/types";
import {
  maybeGetProviderModelEntryId,
  normalizeProviderModelEntries,
} from "@/common/utils/providers/modelEntries";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;

// The buildinfo/discovery probes run before a flow ID exists, so the Settings
// Cancel button cannot reach them — they must be time-bounded or a deployment
// that accepts connections but stalls would pin the UI in "starting" forever.
const DEPLOYMENT_PROBE_TIMEOUT_MS = 10_000;

// Token revocation is best-effort cleanup; bound it so a stalled revocation
// endpoint can never pin a mutex or an abandoned flow's cleanup indefinitely.
const REVOKE_TIMEOUT_MS = 10_000;

// Token endpoint round-trips (exchange + refresh) must be bounded: a refresh
// runs under refreshMutex — a stalled token endpoint would otherwise block
// every subsequent Coder request in this process — and an exchange would
// outlive Cancel and the flow timeout as a leaked background request.
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

// AI Bridge catalog requests are fetched per origin; bound each so a single
// stalled origin cannot block discovery (requests also run concurrently).
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

// The RFC 7592 stored-client redirect update is deliberately NOT aborted by
// flow cancellation: aborting a fetch does not retract a request the
// deployment may still commit, and the client lease must be held until the
// mutation settles (see the lease release wiring in startDesktopFlow). A
// timeout-only bound keeps a stalled endpoint from pinning that settlement.
const CLIENT_UPDATE_TIMEOUT_MS = 10_000;

// Transient per-origin catalog failures (network errors, timeouts, 5xx) are
// retried before discovery gives up: the persisted catalog is authoritative
// for routing, so it must not be built from a request that merely flaked.
const CATALOG_FETCH_RETRIES = 2;
const CATALOG_RETRY_DELAY_MS = 250;

/** RFC 8414 endpoints resolved from the deployment's discovery document. */
interface CoderOauthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
}

/** Dynamically registered OAuth client (RFC 7591/7592). */
interface CoderOauthClient {
  clientId: string;
  clientSecret: string;
  registrationAccessToken?: string;
  registrationClientUri?: string;
}

/** Token endpoint result; invalidGrant distinguishes dead refresh tokens from transient errors. */
type CoderTokenRequestResult =
  | { success: true; auth: CoderOauthAuth }
  | { success: false; error: string; invalidGrant: boolean };

/**
 * Result of the login-commit critical section (see commitDesktopLogin).
 * - replacedAuth: the credential a committed login superseded (revoked by the
 *   caller after the lock is released).
 * - persistedAuthRetained: a cancelled login's tokens are STILL the persisted
 *   credential because the rollback write failed — the caller must not revoke
 *   them or the stored account would look connected while every request fails.
 */
interface CoderLoginCommitResult {
  outcome: "committed" | "cancelled" | "failed";
  replacedAuth?: CoderOauthAuth;
  persistedAuthRetained?: boolean;
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest().toString("base64url");
}

function randomBase64Url(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

/**
 * Normalize a persisted generation counter (coderDisconnectGeneration,
 * coderCatalogGeneration) to a non-negative safe integer, treating anything
 * else as 0. providers.jsonc is hand-editable, and a finite-but-unsafe value
 * such as Number.MAX_VALUE would freeze the counter (MAX_VALUE + 1 ===
 * MAX_VALUE): the incrementer could no longer advance it, so an in-flight
 * flow in another process would see its unchanged start-time snapshot and
 * commit stale state (a login after disconnect, a stale catalog over a newer
 * one). Every reader and every incrementer MUST share this normalization, or
 * their generation comparison would diverge on malformed input.
 */
function sanitizeGenerationCounter(value: unknown): number {
  const parsed = parseOptionalNumber(value);
  return parsed != null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isInvalidGrantError(errorText: string): boolean {
  const trimmed = errorText.trim();
  if (trimmed.length === 0) {
    return false;
  }

  try {
    const json = JSON.parse(trimmed) as unknown;
    if (isPlainObject(json) && json.error === "invalid_grant") {
      return true;
    }
  } catch {
    // Ignore parse failures - fall back to substring checks.
  }

  return trimmed.toLowerCase().includes("invalid_grant");
}

/** Discovery endpoint URLs must parse and use http(s). */
function parseEndpointUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Entries of the coder section's `models` list that carry user-managed data:
 * everything NOT recorded in `discoveredModels` (the bookkeeping of what
 * catalog discovery wrote), plus any object-form entry — normalization
 * collapses override-free objects to plain strings, so an object entry means
 * the user edited it (context window override, model mapping) even when its
 * ID was discovered. Logins, catalog refreshes, and disconnects must carry
 * these forward instead of clobbering them with the server catalog.
 */
function manualModelEntries(section: Record<string, unknown> | undefined): ProviderModelEntry[] {
  if (!Array.isArray(section?.models)) {
    return [];
  }
  // Discovered classification unions the authoritative catalog with the
  // stale marker (entries retained in `models` while the catalog was
  // inconclusive). Without the marker, an inconclusive refresh would
  // reclassify retained catalog entries as manual — surviving disconnect and
  // resurrecting across refreshes as if the user had added them.
  const discovered = new Set(
    [section.discoveredModels, section.staleDiscoveredModels].flatMap((value) =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
    )
  );
  return normalizeProviderModelEntries(section.models).filter((entry) => {
    if (typeof entry !== "string") {
      return true; // User-authored settings on a (possibly discovered) model.
    }
    const id = maybeGetProviderModelEntryId(entry);
    return id == null || !discovered.has(id);
  });
}

export class CoderOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly refreshMutex = new AsyncMutex();
  // Serializes whole catalog refresh runs (fetch + locked commit). Automatic
  // post-login discovery and the Settings/command-palette refresh are
  // independently concurrent entry points, and the locked write predicate
  // only verifies the credential — a slower, older run could otherwise
  // commit last and overwrite newer provider/model results.
  private readonly catalogRefreshMutex = new AsyncMutex();
  // Serializes desktop-login persist -> commit/rollback critical sections
  // across overlapping flows (see commitDesktopLogin for the invariant).
  private readonly loginCommitMutex = new AsyncMutex();

  // Cancellations that arrive while startDesktopFlow is still starting the
  // flow (deployment probes run before the flow is registered): recorded here
  // so the start attempt aborts at its next checkpoint instead of continuing
  // as an orphan the UI can no longer reach. Keyed by caller-supplied flow ID
  // with an insertion timestamp for pruning.
  private readonly preCancelledFlowIds = new Map<string, number>();

  // Bumped by disconnect() so login attempts still in their pre-registration
  // probes (no flow entry yet — cancelAll cannot see them, and disconnect
  // does not know their caller-generated IDs) abort at their next checkpoint
  // instead of resuming after the credentials were cleared and committing a
  // replacement login the user never asked for.
  private disconnectGeneration = 0;

  // In-memory cache so getValidAuth() skips JSONC parse work when tokens are
  // valid. Invalidated on every write (exchange, refresh, disconnect), on
  // every provider-config change notification (below), AND verified against
  // the providers file's content fingerprint on every read — watcher
  // delivery alone is not trusted (see readStoredAuth).
  private cachedAuth: CoderOauthAuth | null = null;
  // Fingerprint of providers.jsonc at the time cachedAuth was populated.
  private cachedAuthFingerprint: string | null = null;

  private readonly unsubscribeConfigChanged: () => void;

  constructor(
    private readonly providersConfigStore: ProvidersConfigStore,
    private readonly fileLeaseManager: FileLeaseManager,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService,
    private readonly policyService?: PolicyService
  ) {
    // Another Xum process sharing providers.jsonc (desktop vs `mux run`) can
    // disconnect or re-login to the SAME deployment; the deployment URL then
    // still matches, so without invalidation getValidAuth would keep serving
    // the stale cached token until it expires. onConfigChanged fires for both
    // in-app writes and external file-watcher events.
    this.unsubscribeConfigChanged = this.providerService.onConfigChanged(() => {
      this.cachedAuth = null;
    });
  }

  /**
   * True when an enforced policy denies the coder provider outright —
   * including the "blocked" state, which must behave as deny-all so direct
   * backend RPCs (CLI/headless/orpc) cannot bypass the UI block. Checked
   * before login network I/O AND again before commit: policy can refresh
   * while the browser authorization is pending.
   */
  private isCoderDeniedByPolicy(): boolean {
    return (
      this.policyService?.isEnforced() === true && !this.policyService.isProviderAllowed("coder")
    );
  }

  /**
   * An enforced policy forcedBaseUrl overrides every user-supplied or stored
   * deployment URL: logins, refreshes, and issuer checks must all target the
   * policy-locked deployment or Coder traffic could bypass it.
   */
  private effectiveDeploymentUrl(candidate: string | null): string | null {
    const forced = this.policyService?.isEnforced()
      ? this.policyService.getForcedBaseUrl("coder")
      : undefined;
    if (!forced) {
      return candidate;
    }
    return normalizeCoderDeploymentUrl(forced);
  }

  async disconnect(): Promise<Result<void, string>> {
    // Cancel in-flight login flows FIRST: disconnect is authoritative. An
    // outstanding flow could otherwise exchange its code and commit a
    // replacement login right after the clear below — silently reconnecting
    // the account the user just disconnected. Cancellation removes each flow
    // from the manager before resolving, so the commit path's liveness
    // checks (`desktopFlows.has`) reject those flows' persists/commits.
    // The generation bump covers attempts cancelAll cannot see: ones still in
    // their pre-registration probes. startDesktopFlow snapshots the
    // generation at entry and re-checks it at every pre-registration
    // checkpoint — the last check and register() run with no intervening
    // await, so an attempt either observes this bump and aborts, or has
    // already registered and is cancelled by cancelAll here.
    this.disconnectGeneration++;
    await this.desktopFlows.cancelAll();
    this.cachedAuth = null;

    // Clear FIRST, revoke after: disconnect must be authoritative over
    // concurrent refreshes, and awaiting (possibly slow) revocation first
    // would let a refresh rotate + persist in the meantime. The predicate
    // matches on the session lineage id — stable across rotations, re-minted
    // by each login — so it clears the disconnected session even if it just
    // rotated, while a genuinely newer login is preserved. Tokens and models
    // are cleared in ONE locked mutation so racing observers see either the
    // connected state or the fully disconnected state, never a mix.
    //
    // The clear runs under the cross-process login-commit lock: a commit in
    // another Xum process persists its login and announces success as one
    // critical section under that lock, so an unserialized disconnect could
    // land between the foreign write and its announcement — clearing and
    // revoking the just-persisted credential while the other process still
    // reports the login as connected. Serialized, this disconnect either
    // precedes the commit (the tombstone stamped below refuses it) or
    // follows it entirely (the clear removes the freshly committed
    // credential — a coherent login-then-disconnect history). Revocation
    // stays OUTSIDE the lock: best-effort network I/O must not block other
    // processes' commits.
    let removed: CoderOauthAuth | null = null;
    let clearOutcome: {
      clearResult: Awaited<ReturnType<ProviderService["updateProviderSection"]>>;
      auth: CoderOauthAuth | null;
    };
    try {
      clearOutcome = await this.fileLeaseManager.withCoderOauthLoginCommitLock(async () => {
        const auth = this.readStoredAuth();
        const clearResult = await this.providerService.updateProviderSection("coder", (section) => {
          const stored = parseCoderOauthAuth(section?.coderOauth);
          if (stored && (!auth || stored.sessionId !== auth.sessionId)) {
            return null; // A newer login landed since we captured `auth`; keep it.
          }
          // Capture the freshest rotation of the session so revocation below
          // targets a token that is actually still alive server-side.
          removed = stored;
          const next = { ...(section ?? {}) };
          delete next.coderOauth;
          // Cross-process tombstone: cancelAll/disconnectGeneration above only
          // reach flows in THIS process. A login flow in another Xum process
          // sharing this file snapshots this counter at start and refuses to
          // commit under the commit lock once it changed, so it cannot
          // silently reconnect the account (see
          // commitDesktopLoginCrossProcess). A monotonic counter, not a
          // wall-clock stamp — clock skew must not reorder disconnects and
          // flow starts. Kept in the section permanently — later logins
          // snapshot the new value and commit normally.
          next.coderDisconnectGeneration =
            sanitizeGenerationCounter(section?.coderDisconnectGeneration) + 1;
          // Discovered models/providers were fetched from the deployment's AI
          // Gateway at login time; they are meaningless without credentials and
          // are refetched on the next login. discoveredModels stays PRESENT
          // (as []) so the catalog reads as authoritatively empty, while
          // manually added entries (and additionalProviders) are user-managed
          // data and survive the disconnect.
          next.models = manualModelEntries(section);
          next.discoveredModels = [];
          next.discoveredProviders = [];
          delete next.staleDiscoveredModels;
          return { value: next };
        });
        this.cachedAuth = null;
        return { clearResult, auth };
      });
    } catch (error) {
      // Lock acquisition itself can fail (timeout, EACCES); surface it
      // instead of pretending the account was disconnected.
      return Err(`Failed to disconnect Coder: ${getErrorMessage(error)}`);
    }
    const { clearResult, auth } = clearOutcome;
    if (!clearResult.success) {
      return Err(clearResult.error);
    }
    if (!clearResult.data.applied) {
      log.debug("[Coder OAuth] Disconnect raced a newer login; keeping the new credentials");
    }

    // Best-effort RFC 7009 revocation so the Coder-side API key is invalidated.
    // Revoke against the issuer stored in the blob (not the currently configured
    // deployment URL) so tokens are revoked on the deployment that minted them
    // even if the user changed the URL since logging in. Runs after the clear:
    // even if revocation fails or hangs, the account is already disconnected.
    const toRevoke = removed ?? auth;
    if (toRevoke) {
      await this.revokeTokens(toRevoke.deploymentUrl, toRevoke);
    }
    return Ok(undefined);
  }

  /**
   * Compare-and-clear the persisted OAuth blob: clears only while the stored
   * refresh token still matches `expected` (refresh tokens rotate on every
   * use, so they uniquely identify a credential generation). When `expected`
   * is null the clear is unconditional. Returns whether the clear applied.
   */
  private async clearStoredAuthIfMatches(
    expected: CoderOauthAuth | null
  ): Promise<Result<{ applied: boolean }, string>> {
    this.cachedAuth = null;
    const result = await this.providerService.updateConfigValue(
      "coder",
      ["coderOauth"],
      (current) => {
        if (expected) {
          const stored = parseCoderOauthAuth(current);
          if (stored && stored.refresh !== expected.refresh) {
            return null; // A different (newer) credential landed; keep it.
          }
        }
        return { value: undefined };
      }
    );
    // Drop the cache again after the write so readers re-read the final state.
    this.cachedAuth = null;
    return result;
  }

  async startDesktopFlow(input: {
    deploymentUrl: string;
    /**
     * Caller-generated flow ID (doubles as the OAuth state param). The UI
     * supplies one BEFORE this call so its Cancel action can reference the
     * attempt while probes/registration are still in flight; generated when
     * omitted (CLI/tests).
     */
    flowId?: string;
  }): Promise<Result<{ flowId: string; authorizeUrl: string }, string>> {
    if (input.flowId !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(input.flowId)) {
      return Err("Invalid flow ID");
    }
    const flowId = input.flowId ?? randomBase64Url();
    // Snapshot before the first await: a disconnect() during any of the
    // probes below must abort this attempt (see disconnectGeneration), and a
    // disconnect in ANOTHER process must beat this flow's commit (compared
    // against the persisted coderDisconnectGeneration counter under the
    // commit lock — the in-memory generation cannot cross processes).
    const initialDisconnectGeneration = this.disconnectGeneration;
    const flowStartPersistedGeneration = this.readPersistedDisconnectGeneration();

    // Policy gate BEFORE any network I/O: a deny-all/provider-restricted (or
    // blocked) policy must stop direct backend RPCs from registering OAuth
    // clients or minting credentials, not just hide the login UI.
    if (this.isCoderDeniedByPolicy()) {
      return Err("The Coder provider is not allowed by the enforced policy");
    }

    const requestedUrl = normalizeCoderDeploymentUrl(input.deploymentUrl);
    if (!requestedUrl) {
      return Err("Invalid Coder deployment URL (expected e.g. https://coder.example.com)");
    }

    // Policy override: login must target the policy-locked deployment so the
    // minted tokens are issuer-bound to it (getValidAuth enforces the match).
    const deploymentUrl = this.effectiveDeploymentUrl(requestedUrl);
    if (!deploymentUrl) {
      return Err("Policy-forced Coder base URL is not a valid deployment URL");
    }
    if (deploymentUrl !== requestedUrl) {
      log.debug(
        `[Coder OAuth] Deployment URL overridden by policy: ${requestedUrl} -> ${deploymentUrl}`
      );
    }

    const buildinfoResult = await this.validateDeployment(deploymentUrl);
    if (!buildinfoResult.success) {
      return Err(buildinfoResult.error);
    }

    const endpointsResult = await this.discoverEndpoints(deploymentUrl);
    if (!endpointsResult.success) {
      return Err(endpointsResult.error);
    }
    const endpoints = endpointsResult.data;

    // The deployment URL is intentionally NOT persisted here: flow start races
    // other flows/logins, and an abandoned flow's early URL write could strand
    // a completed login with a mismatched issuer. The exchange commits the URL
    // atomically with the auth blob when this flow actually completes.
    const codeVerifier = randomBase64Url();
    const codeChallenge = sha256Base64Url(codeVerifier);

    // Cancel or disconnect may have landed while the probes above were in
    // flight — before the flow was registered. Honor it here instead of
    // opening a listener for an attempt the caller already abandoned.
    if (
      this.consumePreCancelled(flowId) ||
      this.disconnectGeneration !== initialDisconnectGeneration
    ) {
      return Err("Login was cancelled");
    }

    // Ephemeral port: Coder requires exact redirect URI matching (OAuth 2.1),
    // so the freshly bound URI is (re-)registered on the client below.
    let loopback: Awaited<ReturnType<typeof startLoopbackServer>>;
    try {
      loopback = await startLoopbackServer({
        port: 0,
        host: "127.0.0.1",
        callbackPath: CODER_OAUTH_CALLBACK_PATH,
        validateLoopback: true,
        expectedState: flowId,
        deferSuccessResponse: true,
      });
    } catch (error) {
      return Err(`Failed to start OAuth callback listener: ${getErrorMessage(error)}`);
    }

    // Last pre-registration checkpoint: this check and register() below run
    // with no intervening await, so a cancel (or disconnect) is either
    // observed here or finds the registered flow — no gap either way.
    if (
      this.consumePreCancelled(flowId) ||
      this.disconnectGeneration !== initialDisconnectGeneration
    ) {
      await loopback.close();
      return Err("Login was cancelled");
    }

    const resultDeferred = createDeferred<Result<void, string>>();

    // The flow is registered BEFORE the client-registration round-trip: the
    // loopback listener is already open, and this network await would
    // otherwise be uncancellable (no flow ID exists yet, so neither Cancel
    // nor a flow timeout can reach it) — a registration endpoint that accepts
    // the connection but stalls its response would leave one listener and RPC
    // alive per retry until the requests eventually returned. Registering
    // first puts the whole window under the flow timeout, and finishing the
    // flow (cancel/timeout/shutdown) aborts the in-flight RPC below.
    this.desktopFlows.register(flowId, {
      server: loopback.server,
      resultDeferred,
      // Keep server-side timeout tied to flow lifetime so abandoned flows
      // (e.g. callers that never invoke waitForDesktopFlow) still self-clean.
      timeoutHandle: setTimeout(() => {
        void this.desktopFlows.finish(flowId, Err("Timed out waiting for OAuth callback"));
      }, DEFAULT_DESKTOP_TIMEOUT_MS),
    });

    // Aborts every network round-trip owned by this flow (client
    // registration, token exchange) when the flow finishes — Cancel, flow
    // timeout, and shutdown all resolve the deferred.
    const flowAbort = new AbortController();
    void resultDeferred.promise.then(() => flowAbort.abort());

    // Reserve the stored client's single redirect slot for this flow, or —
    // when another active flow already owns it — fall back to registering a
    // fresh client so the flows' redirect URIs cannot clobber each other. The
    // lease is a filesystem lock shared by every Xum process using this
    // providers file (desktop + CLI), because a concurrent flow in ANOTHER
    // process would clobber the redirect just the same. A crashed holder's
    // lease goes stale after the flow timeout.
    let releaseClientLease: (() => void) | null = null;
    try {
      releaseClientLease = this.fileLeaseManager.tryAcquireCoderOauthClientLease(
        DEFAULT_DESKTOP_TIMEOUT_MS
      );
    } catch (error) {
      // Lease failures must not break login; degrade to a fresh client.
      log.debug(`[Coder OAuth] Client lease unavailable: ${getErrorMessage(error)}`);
    }
    const ownsStoredClient = releaseClientLease !== null;

    // Set (to the stored client's id) when its redirect PUT ended without a
    // definitive server answer (timeout/network error before a response):
    // the mutation may STILL land later, so that client generation must be
    // quarantined before the lease can be released (below).
    let uncertainClientId: string | null = null;
    const ensureClientPromise = this.ensureClient(
      deploymentUrl,
      endpoints,
      loopback.redirectUri,
      flowAbort.signal,
      ownsStoredClient,
      (clientId) => {
        uncertainClientId = clientId;
      }
    );
    if (releaseClientLease !== null) {
      const release = releaseClientLease;
      // Release only after BOTH the flow finished (the flow manager resolves
      // resultDeferred on every completion/cancel/timeout path) AND the
      // stored-client mutation settled: Cancel can win while the RFC 7592 PUT
      // is in flight, and releasing on flow completion alone would let a
      // replacement flow write redirect B before the earlier PUT lands with
      // redirect A, invalidating the replacement's authorization URL.
      void Promise.allSettled([resultDeferred.promise, ensureClientPromise]).then(() => {
        if (uncertainClientId !== null) {
          // The PUT ended without a server answer and may land at ANY later
          // time (a fully received request can stay queued server-side —
          // elapsed time settles nothing). Quarantine that client generation
          // in the persisted blob FIRST — after it, no flow in any process
          // reuses or redirect-updates the client, so the lease is safe to
          // release; without releasing, every re-login until Xum exits would
          // register a fresh client (the stale-break path rightly refuses
          // live-owner markers). If the quarantine cannot be persisted, keep
          // the lease held as the fallback guard.
          void this.quarantineStoredClient(uncertainClientId).then((quarantined) => {
            if (quarantined) {
              release();
            }
          });
          return;
        }
        release();
      });
    }

    const clientResult = await ensureClientPromise;
    if (!clientResult.success) {
      // No-op if the flow already ended (its cancel/timeout aborted the RPC);
      // otherwise this closes the loopback listener too.
      await this.desktopFlows.finish(flowId, Err(clientResult.error));
      return Err(clientResult.error);
    }
    if (flowAbort.signal.aborted) {
      // Cancel/flow-timeout won while the stored-client update settled (the
      // PUT is deliberately not flow-aborted, see CLIENT_UPDATE_TIMEOUT_MS).
      // The flow is already finished — don't hand out an authorize URL for it.
      const finished = await resultDeferred.promise;
      return Err(finished.success ? "Login was cancelled" : finished.error);
    }
    const client = clientResult.data;

    const authorizeUrl = buildCoderAuthorizeUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri: loopback.redirectUri,
      state: flowId,
      codeChallenge,
    });

    // Background task: wait for the loopback callback, exchange code for tokens,
    // then commit the login. Races against resultDeferred (which resolves on
    // cancel/timeout) so the task exits cleanly if the flow is cancelled.
    void (async () => {
      const callbackResult = await Promise.race([
        loopback.result,
        resultDeferred.promise.then(() => null),
      ]);

      // null means the flow was finished externally (cancel/timeout).
      if (!callbackResult) return;

      if (!callbackResult.success) {
        await this.desktopFlows.finish(flowId, Err(callbackResult.error));
        return;
      }

      // The token exchange stays OUTSIDE the login commit lock: it is a
      // network round-trip, and one stalled exchange must not block other
      // logins from committing. The flow's abort signal cancels it on
      // Cancel/flow-timeout (plus the request timeout inside requestTokens).
      const tokenResult = await this.requestTokens(
        endpoints.tokenEndpoint,
        {
          kind: "exchange",
          deploymentUrl,
          // Fresh session lineage: rotations preserve this id, a later login
          // mints a new one, letting disconnect tell rotations and re-logins
          // apart.
          sessionId: randomBase64Url(16),
          client,
          code: callbackResult.data.code,
          redirectUri: loopback.redirectUri,
          codeVerifier,
        },
        flowAbort.signal
      );
      if (!tokenResult.success) {
        loopback.sendFailureResponse(tokenResult.error);
        await this.desktopFlows.finish(flowId, Err(tokenResult.error));
        return;
      }

      const committed = await this.commitDesktopLogin(
        flowId,
        flowStartPersistedGeneration,
        deploymentUrl,
        tokenResult.auth,
        loopback
      );

      // Model discovery runs only after the flow is committed: Cancel is no
      // longer possible, so this network await cannot strand half-cancelled
      // state (persisted auth with a cancelled flow).
      if (committed) {
        await this.refreshBridgeModels(tokenResult.auth);
      }
    })();

    log.debug(`[Coder OAuth] Desktop flow started (flowId=${flowId})`);

    return Ok({ flowId, authorizeUrl });
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    return this.desktopFlows.waitFor(flowId, opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS);
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    if (this.desktopFlows.has(flowId)) {
      log.debug(`[Coder OAuth] Desktop flow cancelled (flowId=${flowId})`);
      await this.desktopFlows.cancel(flowId);
      return;
    }
    // The flow may still be starting (probes run before registration, and the
    // caller generated this ID before startDesktopFlow returned): record the
    // cancel so the start attempt aborts at its next checkpoint rather than
    // living on as an orphan until the flow timeout.
    this.prunePreCancelled();
    this.preCancelledFlowIds.set(flowId, Date.now());
  }

  /**
   * The persisted cross-process disconnect generation (0 when never
   * disconnected). Login flows snapshot this at start; the commit predicate
   * refuses once it changed (see coderDisconnectGeneration in the schema).
   */
  private readPersistedDisconnectGeneration(): number {
    const section = this.providersConfigStore.loadProvidersConfig()?.coder as
      | { coderDisconnectGeneration?: unknown }
      | undefined;
    return sanitizeGenerationCounter(section?.coderDisconnectGeneration);
  }

  /** True (and consumes the record) when `flowId` was cancelled before the flow registered. */
  private consumePreCancelled(flowId: string): boolean {
    return this.preCancelledFlowIds.delete(flowId);
  }

  /** Drop pre-cancel records for start attempts that never materialized. */
  private prunePreCancelled(): void {
    const cutoff = Date.now() - DEFAULT_DESKTOP_TIMEOUT_MS;
    for (const [flowId, cancelledAt] of this.preCancelledFlowIds) {
      if (cancelledAt < cutoff) {
        this.preCancelledFlowIds.delete(flowId);
      }
    }
  }

  /**
   * Return a valid (non-expired) auth blob, refreshing when necessary.
   *
   * Coder rotates refresh tokens on every use, so refreshes are serialized via
   * a mutex and the rotated tokens are persisted before this resolves.
   */
  async getValidAuth(): Promise<Result<CoderOauthAuth, string>> {
    const stored = this.readStoredAuth();
    if (!stored) {
      return Err("Coder OAuth is not configured. Use 'Login with Coder' in Settings.");
    }

    // Tokens are bound to the deployment (issuer) that minted them: never hand
    // out a bearer token when the configured deployment URL has changed since
    // login, or the old deployment's API key would be sent to the new host.
    const deploymentUrl = this.getDeploymentUrl();
    if (!deploymentUrl || stored.deploymentUrl !== deploymentUrl) {
      return Err(
        "Coder deployment URL changed since login. Use 'Login with Coder' in Settings to reconnect."
      );
    }

    if (!isCoderOauthAuthExpired(stored)) {
      return Ok(stored);
    }

    await using _lock = await this.refreshMutex.acquire();

    // The refresh round-trip is additionally serialized ACROSS processes: a
    // concurrent desktop/CLI process refreshing the same credential would
    // otherwise race destructively — its invalid_grant compare-and-clear can
    // land while our winning rotation is still in flight (not yet on disk),
    // after which our persist CAS fails too and both processes discard the
    // only valid token. Inside the lock the loser re-reads disk and adopts
    // the winner's rotation without ever sending a doomed request.
    return await this.fileLeaseManager.withCoderOauthRefreshLock(async () => {
      // Re-read after acquiring both locks in case another caller (this
      // process or another) refreshed first. Drop the in-memory cache so the
      // read reflects cross-process writes.
      this.cachedAuth = null;
      const latest = this.readStoredAuth();
      if (!latest) {
        return Err("Coder OAuth is not configured. Use 'Login with Coder' in Settings.");
      }

      // The configured deployment can change while this call waits for the
      // locks (a Settings edit in this or another process). The pre-lock
      // issuer check used the old URL — and long-lived model wrappers pinned
      // that URL at creation — so re-validate against the CURRENT effective
      // deployment before serving or refreshing, or the old deployment's
      // bearer token would still be handed out after the user's change.
      const currentDeploymentUrl = this.getDeploymentUrl();
      if (!currentDeploymentUrl || latest.deploymentUrl !== currentDeploymentUrl) {
        return Err(
          "Coder deployment URL changed since login. Use 'Login with Coder' in Settings to reconnect."
        );
      }

      if (!isCoderOauthAuthExpired(latest)) {
        return Ok(latest);
      }

      // Await inside the mutex scope: a bare `return promise` would dispose the
      // lock before the refresh finishes, letting concurrent callers refresh too.
      const refreshed = await this.refreshTokens(latest);
      if (!refreshed.success) {
        return Err(refreshed.error);
      }

      return Ok(refreshed.data);
    });
  }

  getDeploymentUrl(): string | null {
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    const coderConfig = providersConfig.coder as Record<string, unknown> | undefined;
    const raw = coderConfig?.deploymentUrl;
    const configured = typeof raw === "string" ? normalizeCoderDeploymentUrl(raw) : null;
    return this.effectiveDeploymentUrl(configured);
  }

  async dispose(): Promise<void> {
    this.unsubscribeConfigChanged();
    await this.desktopFlows.shutdownAll();
  }

  // -------------------------------------------------------------------------
  // Deployment validation + discovery
  // -------------------------------------------------------------------------

  private async validateDeployment(deploymentUrl: string): Promise<Result<void, string>> {
    try {
      const response = await fetch(`${deploymentUrl}${CODER_BUILDINFO_PATH}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(DEPLOYMENT_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        return Err(
          `Could not reach Coder deployment at ${deploymentUrl} (buildinfo returned ${response.status})`
        );
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json) || typeof json.version !== "string") {
        return Err(`${deploymentUrl} does not look like a Coder deployment (invalid buildinfo)`);
      }

      return Ok(undefined);
    } catch (error) {
      return Err(`Could not reach Coder deployment: ${getErrorMessage(error)}`);
    }
  }

  private async discoverEndpoints(
    deploymentUrl: string
  ): Promise<Result<CoderOauthEndpoints, string>> {
    try {
      const response = await fetch(`${deploymentUrl}${CODER_OAUTH_DISCOVERY_PATH}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(DEPLOYMENT_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        return Err(
          `OAuth discovery failed (${response.status}). Ensure the deployment runs with --experiments=oauth2.`
        );
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("OAuth discovery returned an invalid JSON payload");
      }

      const authorizationEndpoint = parseEndpointUrl(json.authorization_endpoint);
      const tokenEndpoint = parseEndpointUrl(json.token_endpoint);
      const registrationEndpoint = parseEndpointUrl(json.registration_endpoint);
      const revocationEndpoint = parseEndpointUrl(json.revocation_endpoint) ?? undefined;

      if (!authorizationEndpoint || !tokenEndpoint || !registrationEndpoint) {
        return Err("OAuth discovery response is missing required endpoints");
      }

      // Coder only supports S256; fail fast if a future deployment drops it.
      const methods = json.code_challenge_methods_supported;
      if (Array.isArray(methods) && !methods.includes("S256")) {
        return Err("Coder deployment does not support PKCE S256");
      }

      return Ok({ authorizationEndpoint, tokenEndpoint, registrationEndpoint, revocationEndpoint });
    } catch (error) {
      return Err(`OAuth discovery failed: ${getErrorMessage(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic client registration (RFC 7591) + redirect URI updates (RFC 7592)
  // -------------------------------------------------------------------------

  /**
   * Reuse the stored client when possible by pointing its registered redirect
   * URI at the current loopback port; otherwise register a fresh client.
   */
  private async ensureClient(
    deploymentUrl: string,
    endpoints: CoderOauthEndpoints,
    redirectUri: string,
    // Aborted when the owning flow finishes (cancel/timeout/shutdown), so a
    // stalled registration endpoint cannot pin the RPC past the flow's life.
    // Applies to fresh registrations only — the stored-client redirect update
    // is timeout-bounded instead (see updateClientRedirectUri).
    signal: AbortSignal,
    // Only the flow holding the stored-client lease may reuse (and
    // redirect-update) it; see the lease wiring in startDesktopFlow.
    allowStoredClient: boolean,
    // Invoked with the stored client's id when its update ended without a
    // definitive server answer — the caller must then quarantine that client
    // generation before the lease may be released.
    onStoredClientUpdateUncertain: (clientId: string) => void
  ): Promise<Result<CoderOauthClient, string>> {
    const stored = this.readStoredAuth();
    // Only reuse a client registered on the SAME deployment; a client from a
    // different deployment is meaningless there (and its RFC 7592 endpoint
    // would point at the old host).
    if (
      allowStoredClient &&
      stored?.deploymentUrl === deploymentUrl &&
      stored.registrationAccessToken &&
      stored.registrationClientUri
    ) {
      const updated = await this.updateClientRedirectUri(
        stored,
        redirectUri,
        onStoredClientUpdateUncertain
      );
      if (updated.success) {
        return updated;
      }
      // Stored client may have been deleted server-side; fall through to re-register.
      log.debug(`[Coder OAuth] Client update failed, re-registering: ${updated.error}`);
    }

    return this.registerClient(endpoints.registrationEndpoint, redirectUri, signal);
  }

  private async registerClient(
    registrationEndpoint: string,
    redirectUri: string,
    signal: AbortSignal
  ): Promise<Result<CoderOauthClient, string>> {
    try {
      const response = await fetch(registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildCoderClientMetadata(redirectUri)),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Coder OAuth client registration failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Coder OAuth client registration returned an invalid JSON payload");
      }

      const clientId = typeof json.client_id === "string" ? json.client_id : null;
      // Coder always issues a client secret (all clients are treated as
      // confidential) and requires it at the token endpoint.
      const clientSecret = typeof json.client_secret === "string" ? json.client_secret : null;

      if (!clientId || !clientSecret) {
        return Err("Coder OAuth client registration response missing client credentials");
      }

      const registrationAccessToken =
        typeof json.registration_access_token === "string" && json.registration_access_token
          ? json.registration_access_token
          : undefined;
      const registrationClientUri =
        typeof json.registration_client_uri === "string" && json.registration_client_uri
          ? json.registration_client_uri
          : undefined;

      return Ok({ clientId, clientSecret, registrationAccessToken, registrationClientUri });
    } catch (error) {
      return Err(`Coder OAuth client registration failed: ${getErrorMessage(error)}`);
    }
  }

  private async updateClientRedirectUri(
    stored: CoderOauthAuth,
    redirectUri: string,
    // Reports an outcome the server may still commit (no response received,
    // or an ambiguous 5xx response).
    onUncertainOutcome: (clientId: string) => void
  ): Promise<Result<CoderOauthClient, string>> {
    if (!stored.registrationAccessToken || !stored.registrationClientUri) {
      return Err("No registration access token stored");
    }

    try {
      // RFC 7592 requires the full metadata set on update, not a partial patch.
      // Timeout-only bound, NOT the flow abort signal: aborting the fetch on
      // Cancel would not retract a mutation the deployment may still commit,
      // and the client lease is only released once this request settles.
      const response = await fetch(stored.registrationClientUri, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${stored.registrationAccessToken}`,
        },
        body: JSON.stringify({
          ...buildCoderClientMetadata(redirectUri),
          client_id: stored.clientId,
        }),
        signal: AbortSignal.timeout(CLIENT_UPDATE_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Coder OAuth client update failed (${response.status})`;
        // 5xx is ambiguous, not authoritative: a reverse proxy can answer
        // 502/504 AFTER forwarding the PUT (and a server can fail after
        // committing), so the upstream mutation may still land at any later
        // time — exactly like the no-response path below. Only a 4xx is a
        // definitive refusal that provably left the registration unchanged.
        if (response.status >= 500) {
          onUncertainOutcome(stored.clientId);
        }
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      // Coder keeps the existing client secret and registration token on update.
      return Ok({
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        registrationAccessToken: stored.registrationAccessToken,
        registrationClientUri: stored.registrationClientUri,
      });
    } catch (error) {
      // Thrown before any response arrived (timeout / connection error): the
      // deployment may have received the request and could still commit it.
      onUncertainOutcome(stored.clientId);
      return Err(`Coder OAuth client update failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Mark a stored dynamic client unusable after an uncertain redirect update:
   * the server may commit the orphaned PUT at ANY later time (a fully
   * received request can stay queued server-side — no amount of waiting
   * settles it), so the client's redirect registration can no longer be
   * trusted. Deleting the RFC 7592 management fields makes ensureClient skip
   * reuse permanently; the next committed login replaces the whole blob with
   * a fresh client, which is the only event that actually supersedes the
   * orphan. Runs under the cross-process refresh lock so an in-flight token
   * rotation (which rebuilds the persisted blob from its pre-rotation read)
   * cannot resurrect the deleted fields.
   *
   * Returns true when the quarantine is effective (fields removed, or the
   * client was already replaced/cleared) — only then may the caller release
   * the client lease.
   */
  private async quarantineStoredClient(clientId: string): Promise<boolean> {
    try {
      const result = await this.fileLeaseManager.withCoderOauthRefreshLock(() =>
        this.providerService.updateProviderSection("coder", (section) => {
          const stored = parseCoderOauthAuth(section?.coderOauth);
          if (stored?.clientId !== clientId) {
            return null; // Already replaced or cleared; nothing to quarantine.
          }
          const next = { ...(section ?? {}) };
          next.coderOauth = {
            ...stored,
            registrationAccessToken: undefined,
            registrationClientUri: undefined,
          };
          return { value: next };
        })
      );
      this.cachedAuth = null;
      if (!result.success) {
        log.warn(`[Coder OAuth] Failed to quarantine stored client: ${result.error}`);
        return false;
      }
      return true;
    } catch (error) {
      log.warn(`[Coder OAuth] Failed to quarantine stored client: ${getErrorMessage(error)}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Token exchange + refresh
  // -------------------------------------------------------------------------

  /**
   * Persist a completed login and finish its flow — or, when Cancel raced the
   * commit, revoke/roll back instead — as ONE exclusive critical section.
   *
   * The commit lock spans persist -> finish/rollback so overlapping login
   * flows cannot interleave: a rollback snapshot (`previousSection`) can then
   * only ever capture a committed section. Without serialization, flow B
   * could snapshot flow A's persisted-but-uncommitted login; if both were
   * then cancelled, A's rollback would skip (B's auth is current) and revoke
   * A's tokens, after which B's rollback would restore that already-revoked
   * auth over the original login. Flows are process-local, but the persisted
   * section is shared across every Xum process using this providers file, so
   * the critical section is guarded by BOTH the process-local mutex (fair,
   * spin-free queueing within a process) and the cross-process
   * withCoderOauthLoginCommitLock (a flow in another process could compose
   * the same snapshot bug); the CAS predicates inside the locked mutations
   * remain as defense in depth.
   *
   * Returns true when the login was committed (flow finished with Ok).
   */
  private async commitDesktopLogin(
    flowId: string,
    flowStartPersistedGeneration: number,
    deploymentUrl: string,
    auth: CoderOauthAuth,
    loopback: Pick<
      Awaited<ReturnType<typeof startLoopbackServer>>,
      "sendSuccessResponse" | "sendFailureResponse"
    >
  ): Promise<boolean> {
    const result = await this.commitDesktopLoginLocked(
      flowId,
      flowStartPersistedGeneration,
      deploymentUrl,
      auth,
      loopback
    );

    // Revocation is best-effort network I/O against a possibly stalled
    // endpoint: it runs AFTER the commit lock is released so one abandoned
    // flow's cleanup can never block later logins from committing (the fetch
    // is additionally time-bounded, see REVOKE_TIMEOUT_MS).
    if (result.outcome !== "committed") {
      // NOTE: no pending browser response can leak here. When cancellation or
      // the flow timeout wins mid-commit, the flow manager closes the raw
      // loopback server, whose patched close() ends the deferred callback
      // response first (see startLoopbackServer) — so the awaited cancel RPC
      // never hangs on server.close().

      // Every non-committed outcome revokes the exchanged tokens: a failed
      // persist (unwritable providers.jsonc, lock timeout) would otherwise
      // leave them active and untracked on the deployment while the UI
      // reports the login as failed. The one exception: a post-persist
      // cancellation whose ROLLBACK write failed — the persisted section
      // still holds these tokens, so revoking would leave Settings showing
      // a connected account whose every request fails. Keep the working
      // credential instead; the stored blob keeps it tracked (Disconnect or
      // the next successful login revokes it).
      if (!result.persistedAuthRetained) {
        await this.revokeTokens(deploymentUrl, auth);
      }
    } else if (result.replacedAuth && result.replacedAuth.refresh !== auth.refresh) {
      // A successful re-login replaced a previous credential: revoke it, or
      // the old full-privilege token would stay valid forever with nothing
      // tracking it (Disconnect only knows the new blob). Revoked against its
      // own issuer — the replaced blob may belong to a different deployment.
      await this.revokeTokens(result.replacedAuth.deploymentUrl, result.replacedAuth);
    }

    return result.outcome === "committed";
  }

  /**
   * The persist -> finish/rollback critical section of commitDesktopLogin.
   * Any non-"committed" outcome means the caller must revoke the login's
   * tokens (after the lock is released) — they were exchanged but never
   * persisted, so nothing else references them. A committed outcome carries
   * the auth blob it replaced (if any) so the caller can revoke the
   * superseded credential.
   */
  private async commitDesktopLoginLocked(
    flowId: string,
    flowStartPersistedGeneration: number,
    deploymentUrl: string,
    auth: CoderOauthAuth,
    loopback: Pick<
      Awaited<ReturnType<typeof startLoopbackServer>>,
      "sendSuccessResponse" | "sendFailureResponse"
    >
  ): Promise<CoderLoginCommitResult> {
    await using _commitLock = await this.loginCommitMutex.acquire();

    // The cross-process lock itself can fail (acquisition timeout, EACCES on
    // the lock directory). That rejection must not escape this detached
    // flow task: the flow would stay pending until its five-minute timeout
    // while the exchanged tokens stayed active — finish the flow with the
    // error and report "failed" so the caller's revocation still runs.
    try {
      return await this.commitDesktopLoginCrossProcess(
        flowId,
        flowStartPersistedGeneration,
        deploymentUrl,
        auth,
        loopback
      );
    } catch (error) {
      const message = `Failed to commit Coder login: ${getErrorMessage(error)}`;
      log.warn(`[Coder OAuth] ${message}`);
      loopback.sendFailureResponse(message);
      await this.desktopFlows.finish(flowId, Err(message));
      return { outcome: "failed" };
    }
  }

  private async commitDesktopLoginCrossProcess(
    flowId: string,
    flowStartPersistedGeneration: number,
    deploymentUrl: string,
    auth: CoderOauthAuth,
    loopback: Pick<
      Awaited<ReturnType<typeof startLoopbackServer>>,
      "sendSuccessResponse" | "sendFailureResponse"
    >
  ): Promise<CoderLoginCommitResult> {
    return await this.fileLeaseManager.withCoderOauthLoginCommitLock(async () => {
      // The flow may have been cancelled (or timed out) while the exchange
      // round-trip was in flight (or while waiting for the locks). Persisting
      // anyway would leave the account connected after the user clicked
      // Cancel — drop and revoke the tokens.
      if (!this.desktopFlows.has(flowId)) {
        return { outcome: "cancelled" as const };
      }

      // Persist the new credentials, the deployment URL they belong to, and a
      // reset model catalog in ONE locked mutation:
      // - URL + auth together: a slower flow finishing after a login to another
      //   deployment must re-assert its own URL alongside its auth or it would
      //   store auth A next to URL B and fail issuer validation. Last completed
      //   login wins with a fully coherent section.
      // - discoveredModels DELETED (not set to []): the flow resolves before
      //   discovery runs, so the old deployment's catalog must not linger —
      //   but the new deployment's catalog is not known yet either. A missing
      //   key means "catalog unknown" (routing fails open) until discovery
      //   persists a conclusive list; [] would read as an authoritative empty
      //   catalog and block Coder routing entirely (see gatewayModelCatalog.ts).
      // - models reduced to the MANUAL entries: discovered entries belong to
      //   the old catalog, but manually added ones are user-managed data and
      //   must survive every re-login.
      // The previous section is captured under the same lock so a post-persist
      // cancellation can restore it verbatim (not just delete the new blob,
      // which would log out a previously connected account).
      let previousSection: Record<string, unknown> = {};
      let commitRefusalMessage: string | null = null;
      const persistResult = await this.providerService.updateProviderSection("coder", (section) => {
        // Cancellation can also win while this mutation waits for the
        // providers-file lock: re-check liveness at write time, inside the
        // lock, so a cancelled flow never replaces the prior login's state.
        if (!this.desktopFlows.has(flowId)) {
          return null;
        }
        // Cross-process disconnect check: cancelAll/disconnectGeneration only
        // reach flows in THIS process, but a disconnect in another Xum
        // process increments coderDisconnectGeneration in the shared section.
        // A flow whose start-time snapshot no longer matches must not commit
        // — it would silently reconnect the account the user just
        // disconnected. A counter comparison, not wall-clock ordering: clock
        // skew must neither let a pre-disconnect flow slip through nor lock
        // out every post-disconnect login.
        const disconnectGeneration = sanitizeGenerationCounter(section?.coderDisconnectGeneration);
        if (disconnectGeneration !== flowStartPersistedGeneration) {
          commitRefusalMessage = "Login was superseded by a disconnect";
          return null;
        }
        // Policy checks run HERE, inside the synchronous write predicate —
        // not merely before the mutation. Another process can hold the
        // providers-file lock for seconds, and policy can refresh while this
        // mutation waits for it (updateProviderSection itself does no policy
        // gating). A login started under a permissive policy must not
        // persist a credential after coder was denied, and a credential
        // minted by deployment A must not be persisted once the policy pins
        // B — routing and Settings would resolve against B and strand the
        // issuer-mismatched credential while the login reported success.
        // Refusing here routes the exchanged tokens through the caller's
        // non-committed revocation path.
        if (this.isCoderDeniedByPolicy()) {
          commitRefusalMessage = "The Coder provider is not allowed by the enforced policy";
          return null;
        }
        if (this.effectiveDeploymentUrl(deploymentUrl) !== deploymentUrl) {
          commitRefusalMessage = "The policy-enforced Coder deployment URL changed during login";
          return null;
        }
        previousSection = { ...(section ?? {}) };
        const next = { ...(section ?? {}) };
        next.deploymentUrl = deploymentUrl;
        next.coderOauth = auth;
        const manual = manualModelEntries(section);
        if (manual.length > 0) {
          next.models = manual;
        } else {
          delete next.models;
        }
        // Fresh login: the previous deployment's catalog and provider set are
        // meaningless; discovery (running right after commit) repopulates
        // them. Deleted, not emptied, so routing fails open until then.
        delete next.discoveredModels;
        delete next.discoveredProviders;
        delete next.staleDiscoveredModels;
        return { value: next };
      });
      this.cachedAuth = null;
      if (!persistResult.success) {
        loopback.sendFailureResponse(persistResult.error);
        await this.desktopFlows.finish(flowId, Err(persistResult.error));
        return { outcome: "failed" as const };
      }
      if (!persistResult.data.applied) {
        if (commitRefusalMessage !== null) {
          // A refusal recorded by the write predicate (disconnect tombstone
          // or policy): unlike the local-cancel case below, this flow is
          // still live in this process — finish it so the waiter and browser
          // callback see the failure instead of hanging until the flow
          // timeout.
          loopback.sendFailureResponse(commitRefusalMessage);
          await this.desktopFlows.finish(flowId, Err(commitRefusalMessage));
          return { outcome: "failed" as const };
        }
        // Cancel won while the mutation waited for the providers-file lock; the
        // flow is already finished, so only the raced tokens need cleanup.
        return { outcome: "cancelled" as const };
      }

      // Cancellation may also race the window between the persist write and
      // this check. `has` + `finish` below run with no intervening await, so
      // exactly one of Cancel and completion wins the flow; if Cancel won
      // mid-persist, restore the pre-login section (a previously connected
      // account stays connected).
      if (!this.desktopFlows.has(flowId)) {
        const cleared = await this.rollbackPersistedAuth(auth, previousSection);
        return { outcome: "cancelled" as const, persistedAuthRetained: !cleared };
      }

      loopback.sendSuccessResponse();
      this.windowService?.focusMainWindow();
      await this.desktopFlows.finish(flowId, Ok(undefined));

      log.debug("[Coder OAuth] Desktop login committed");

      // The credential this login replaced (from the same snapshot the
      // rollback path restores): the caller revokes it after the lock is
      // released, otherwise the superseded full-privilege token would stay
      // valid forever with nothing tracking it.
      const replacedAuth = parseCoderOauthAuth(previousSection.coderOauth) ?? undefined;

      return { outcome: "committed" as const, replacedAuth };
    });
  }

  /**
   * Undo a persisted login whose flow was cancelled between the persist write
   * and the flow commit. Restores the section captured under the persist lock
   * (a previously connected account stays connected with its URL and catalog)
   * — but only while the stored credential is still the cancelled login's;
   * a newer cross-process write that landed in between is kept. Runs under
   * the login commit locks (process-local + cross-process; see
   * commitDesktopLogin), so the restored snapshot is always a committed
   * section, never another flow's pending login — in this process or any
   * other sharing the providers file. The caller revokes the cancelled
   * login's tokens after the lock is released.
   *
   * Returns true when the cancelled login's tokens are no longer the
   * persisted credential (previous section restored, or a newer login already
   * replaced them) — only then may the caller revoke them. False means the
   * restore write failed and the persisted section still holds the tokens.
   */
  private async rollbackPersistedAuth(
    auth: CoderOauthAuth,
    previousSection: Record<string, unknown>
  ): Promise<boolean> {
    log.debug("[Coder OAuth] Flow cancelled during persist; restoring previous provider state");
    this.cachedAuth = null;
    const restoreResult = await this.providerService.updateProviderSection("coder", (section) => {
      const stored = parseCoderOauthAuth(section?.coderOauth);
      if (stored?.sessionId !== auth.sessionId) {
        return null; // Superseded by a newer login; keep it.
      }
      return { value: previousSection };
    });
    this.cachedAuth = null;
    if (!restoreResult.success) {
      log.warn(
        `[Coder OAuth] Failed to roll back cancelled login; keeping its credential unrevoked: ${restoreResult.error}`
      );
      return false;
    }
    if (!restoreResult.data.applied) {
      log.debug("[Coder OAuth] Rollback skipped: a newer login already replaced the credentials");
    }
    return true;
  }

  private async refreshTokens(current: CoderOauthAuth): Promise<Result<CoderOauthAuth, string>> {
    // Refresh against the issuer the tokens came from (getValidAuth already
    // guarantees it matches the configured deployment URL). Endpoints derive
    // from the access URL; skip a discovery round-trip on the hot request path.
    const tokenEndpoint = `${current.deploymentUrl}/oauth2/tokens`;
    const result = await this.requestTokens(tokenEndpoint, {
      kind: "refresh",
      deploymentUrl: current.deploymentUrl,
      // Rotations stay in the same login session (see CoderOauthAuth.sessionId).
      sessionId: current.sessionId,
      client: current,
      refreshToken: current.refresh,
    });

    if (!result.success) {
      // When the refresh token is invalid/revoked (rotation means a reused token
      // is dead), clear persisted auth so requests surface "reconnect" errors.
      if (result.invalidGrant) {
        // The refresh mutex is process-local: a concurrent desktop/CLI process
        // sharing providers.jsonc may have consumed this refresh token and
        // persisted the rotated one. Compare-and-clear: the stored blob is
        // deleted only while it still holds the rejected refresh token, so a
        // winner that persists concurrently is never erased (the predicate and
        // the write run in one synchronous block; see updateConfigValue).
        const clearResult = await this.clearStoredAuthIfMatches(current);
        if (!clearResult.success) {
          log.warn(
            `[Coder OAuth] Failed to clear stored auth after refresh failure: ${clearResult.error}`
          );
          return Err(
            "Coder OAuth session expired. Use 'Login with Coder' in Settings to reconnect."
          );
        }

        if (!clearResult.data.applied) {
          // A different credential is on disk: another process won the
          // rotation race. Adopt the winner instead of failing.
          const stored = this.readStoredAuth();
          if (stored && stored.refresh !== current.refresh) {
            log.debug("[Coder OAuth] Refresh lost a cross-process rotation race; adopting winner");
            if (!isCoderOauthAuthExpired(stored)) {
              return Ok(stored);
            }
            // Recursion is bounded: it only recurses when the on-disk token
            // changed again since the last attempt.
            return this.refreshTokens(stored);
          }
        }

        log.debug("[Coder OAuth] Refresh token rejected; cleared stored auth");
        return Err("Coder OAuth session expired. Use 'Login with Coder' in Settings to reconnect.");
      }

      return Err(result.error);
    }

    // Coder rotates the refresh token on every use: persist the new tokens
    // BEFORE handing them to the caller so a crash cannot strand us with a
    // consumed (now invalid) refresh token on disk. The write is conditional:
    // it lands only while the credential we consumed is still the stored one.
    // If a re-login (possibly to another deployment) or a disconnect finished
    // while the token endpoint round-trip was in flight, overwriting would
    // clobber the newer state with a blob from the old generation.
    const persistResult = await this.persistRotatedAuth(result.auth, current.refresh);
    if (!persistResult.success) {
      // Persistence failed outright (providers.jsonc unwritable, lock
      // timeout): persist-before-use means the rotation cannot be handed out,
      // yet the exchange already consumed the stored refresh token. Like the
      // CAS-lost path below, revoke the orphaned rotation (best-effort) so a
      // full-privilege token no tracking references cannot stay alive.
      await this.revokeTokens(result.auth.deploymentUrl, result.auth);
      return Err(persistResult.error);
    }

    if (!persistResult.data.applied) {
      // Our rotation lost: revoke the now-orphaned tokens (nothing references
      // them) and defer to whatever credential replaced ours.
      await this.revokeTokens(result.auth.deploymentUrl, result.auth);
      const stored = this.readStoredAuth();
      if (stored && stored.refresh === current.refresh) {
        // The stored blob is unchanged — the persist was refused because the
        // configured deployment URL changed mid-round-trip. The consumed
        // credential cannot be served (issuer mismatch) or refreshed again
        // (its refresh token was just rotated away), so surface reconnect
        // guidance instead of recursing into a doomed request.
        return Err(
          "Coder deployment URL changed since login. Use 'Login with Coder' in Settings to reconnect."
        );
      }
      if (stored) {
        log.debug("[Coder OAuth] Refresh superseded by a newer login; adopting it");
        if (!isCoderOauthAuthExpired(stored)) {
          return Ok(stored);
        }
        // Bounded: recursion only happens when the on-disk credential changed.
        return this.refreshTokens(stored);
      }
      return Err("Coder OAuth was disconnected. Use 'Login with Coder' in Settings to reconnect.");
    }

    return Ok(result.auth);
  }

  private async requestTokens(
    tokenEndpoint: string,
    input:
      | {
          kind: "exchange";
          deploymentUrl: string;
          sessionId: string;
          client: CoderOauthClient;
          code: string;
          redirectUri: string;
          codeVerifier: string;
        }
      | {
          kind: "refresh";
          deploymentUrl: string;
          sessionId: string;
          client: CoderOauthClient;
          refreshToken: string;
        },
    // Always time-bounded; exchanges additionally pass the flow's abort
    // signal so Cancel/flow-timeout kills the in-flight round-trip.
    signal?: AbortSignal
  ): Promise<CoderTokenRequestResult> {
    const label = input.kind === "exchange" ? "exchange" : "refresh";

    try {
      const body =
        input.kind === "exchange"
          ? buildCoderTokenExchangeBody({
              clientId: input.client.clientId,
              clientSecret: input.client.clientSecret,
              code: input.code,
              redirectUri: input.redirectUri,
              codeVerifier: input.codeVerifier,
            })
          : buildCoderRefreshBody({
              clientId: input.client.clientId,
              clientSecret: input.client.clientSecret,
              refreshToken: input.refreshToken,
            });

      const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Coder OAuth ${label} failed (${response.status})`;
        return {
          success: false,
          error: errorText ? `${prefix}: ${errorText}` : prefix,
          invalidGrant: isInvalidGrantError(errorText),
        };
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return {
          success: false,
          error: `Coder OAuth ${label} returned an invalid JSON payload`,
          invalidGrant: false,
        };
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);

      if (!accessToken || !refreshToken || expiresIn === null) {
        return {
          success: false,
          error: `Coder OAuth ${label} response missing access_token/refresh_token/expires_in`,
          invalidGrant: false,
        };
      }

      return {
        success: true,
        auth: {
          type: "oauth",
          sessionId: input.sessionId,
          deploymentUrl: input.deploymentUrl,
          access: accessToken,
          refresh: refreshToken,
          expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
          clientId: input.client.clientId,
          clientSecret: input.client.clientSecret,
          registrationAccessToken: input.client.registrationAccessToken,
          registrationClientUri: input.client.registrationClientUri,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Coder OAuth ${label} failed: ${getErrorMessage(error)}`,
        invalidGrant: false,
      };
    }
  }

  /** Best-effort RFC 7009 revocation; failures are logged, never surfaced. */
  private async revokeTokens(
    deploymentUrl: string,
    auth: Pick<CoderOauthAuth, "refresh" | "clientId" | "clientSecret">
  ): Promise<void> {
    try {
      const body = new URLSearchParams();
      body.set("token", auth.refresh);
      body.set("client_id", auth.clientId);
      body.set("client_secret", auth.clientSecret);
      await fetch(`${deploymentUrl}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
    } catch (error) {
      log.debug(`[Coder OAuth] Best-effort token revocation failed: ${getErrorMessage(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Model list refresh (AI Gateway per-provider catalogs)
  // -------------------------------------------------------------------------

  /**
   * List the deployment's configured AI Gateway provider instances, classified:
   * - "ok": authoritative list of enabled, non-Copilot instances.
   * - "unavailable": 403 (the endpoint requires site-wide AIProvider read,
   *   which regular members lack) or 404 (older coderd without the endpoint)
   *   — fall back to probing default provider names.
   * - "error": transient failure; the provider set is unknown.
   */
  private async fetchGatewayProviders(
    auth: CoderOauthAuth
  ): Promise<
    { kind: "ok"; providers: CoderGatewayProvider[] } | { kind: "unavailable" } | { kind: "error" }
  > {
    try {
      const response = await fetch(`${auth.deploymentUrl}${CODER_AI_PROVIDERS_PATH}`, {
        headers: {
          Authorization: `Bearer ${auth.access}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          log.debug(`[Coder OAuth] Provider listing unavailable (${response.status})`);
          return { kind: "unavailable" };
        }
        log.debug(`[Coder OAuth] Provider listing failed transiently (${response.status})`);
        return { kind: "error" };
      }
      const json = (await response.json()) as unknown;
      if (!Array.isArray(json)) {
        log.debug("[Coder OAuth] Provider listing returned an invalid payload");
        return { kind: "error" };
      }
      const providers: CoderGatewayProvider[] = [];
      for (const entry of json) {
        if (!isPlainObject(entry) || typeof entry.name !== "string" || !entry.name) {
          continue;
        }
        const type = typeof entry.type === "string" ? entry.type : "";
        // Disabled instances are unroutable; Copilot instances need
        // request-time tokens only an official Copilot client can mint.
        if (entry.enabled === false || type === "copilot") {
          continue;
        }
        providers.push({ name: entry.name, type });
      }
      return { kind: "ok", providers };
    } catch (error) {
      log.debug(`[Coder OAuth] Failed to list gateway providers: ${getErrorMessage(error)}`);
      return { kind: "error" };
    }
  }

  /**
   * One provider catalog request (GET <gateway>/<name>/v1/models), classified:
   * - "ok": 2xx with a valid payload — the provider's model list.
   * - "unavailable": conclusive non-2xx (404 when the provider instance does
   *   not exist on the gateway, or AI Gateway is not entitled) — the provider
   *   serves nothing.
   * - "error": network error, timeout, 5xx/408/429, auth failures (401/403),
   *   or invalid payload — the provider's state is UNKNOWN and must not become
   *   authoritative. Auth failures are transient by nature here: the access
   *   token can expire or rotate between exchange and discovery, and a
   *   catalog persisted from a rejected request would hide valid models
   *   until the next refresh even after authentication recovers. Upstreams
   *   without a real /models route (e.g. AWS Bedrock behind the passthrough)
   *   also land here and simply never contribute discovered entries.
   */
  private async fetchProviderCatalog(
    auth: CoderOauthAuth,
    provider: CoderGatewayProvider
  ): Promise<{ kind: "ok"; ids: string[] } | { kind: "unavailable" } | { kind: "error" }> {
    const providerName = provider.name;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${auth.access}`,
        Accept: "application/json",
      };
      // /v1/models is a passthrough: Anthropic-wire upstreams reject requests
      // without the required anthropic-version header with a conclusive 400,
      // which would read as "no models" and hide every Anthropic model.
      if (coderGatewayWireProtocol(provider.type) === "anthropic") {
        headers["anthropic-version"] = "2023-06-01";
      }
      const response = await fetch(
        `${coderAibridgeBaseUrl(auth.deploymentUrl, providerName)}/models`,
        {
          headers,
          signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
        }
      );

      if (!response.ok) {
        if (
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 429 ||
          response.status === 401 ||
          response.status === 403
        ) {
          log.debug(
            `[Coder OAuth] ${providerName} model list failed transiently (${response.status})`
          );
          return { kind: "error" };
        }
        log.debug(`[Coder OAuth] ${providerName} model list unavailable (${response.status})`);
        return { kind: "unavailable" };
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json) || !Array.isArray(json.data)) {
        log.debug(`[Coder OAuth] ${providerName} model list returned an invalid payload`);
        return { kind: "error" };
      }
      const ids: string[] = [];
      for (const entry of json.data) {
        if (isPlainObject(entry) && typeof entry.id === "string" && entry.id) {
          ids.push(`${providerName}/${entry.id}`);
        }
      }
      return { kind: "ok", ids };
    } catch (error) {
      log.debug(`[Coder OAuth] Failed to fetch ${providerName} models: ${getErrorMessage(error)}`);
      return { kind: "error" };
    }
  }

  /** Retry the transient ("error") outcomes of a discovery request. */
  private async retryTransient<T extends { kind: string }>(
    fetchOnce: () => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const result = await fetchOnce();
      if (result.kind !== "error" || attempt >= CATALOG_FETCH_RETRIES) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, CATALOG_RETRY_DELAY_MS));
    }
  }

  /**
   * Re-discover the deployment's AI Gateway providers and model catalogs with
   * the stored credential. Runs automatically after login; exposed to the UI
   * as the Settings "Refresh models" action so new providers/models don't
   * require a re-login.
   */
  async refreshModels(): Promise<Result<void, string>> {
    const authResult = await this.getValidAuth();
    if (!authResult.success) {
      return Err(authResult.error);
    }
    return this.refreshBridgeModels(authResult.data);
  }

  private async refreshBridgeModels(auth: CoderOauthAuth): Promise<Result<void, string>> {
    await using _lock = await this.catalogRefreshMutex.acquire();
    // `return await` is load-bearing: a bare `return` would run the lock
    // disposal before the returned promise settles, releasing the mutex
    // while the refresh is still in flight.
    return await this.refreshBridgeModelsSerialized(auth);
  }

  private async refreshBridgeModelsSerialized(auth: CoderOauthAuth): Promise<Result<void, string>> {
    // Cross-process refresh ordering: catalogRefreshMutex serializes only
    // THIS process's refreshes, but multiple Xum processes share
    // providers.jsonc (Config.withProvidersFileLock exists for exactly that).
    // Snapshot the persisted catalog generation BEFORE any fetch; the locked
    // commit below refuses when it moved, so a refresh that captured an
    // older provider list can never overwrite a catalog another process
    // committed mid-flight. A stale snapshot read here is safe: it can only
    // cause a conservative refusal, never a stale commit.
    const refreshStartGeneration = sanitizeGenerationCounter(
      (
        this.providersConfigStore.loadProvidersConfig()?.coder as
          | { coderCatalogGeneration?: unknown }
          | undefined
      )?.coderCatalogGeneration
    );
    // The deployment's configured provider instances decide which gateway
    // routes exist (each is mounted at /<name>/...), so list them first.
    const listing = await this.retryTransient(() => this.fetchGatewayProviders(auth));
    if (listing.kind === "error") {
      // The provider set is unknown; keep the catalog in its current state
      // (fail-open after login) rather than guessing.
      log.debug("[Coder OAuth] Skipping catalog write: provider listing failed");
      return Err("Failed to list the deployment's AI Gateway providers");
    }

    // When the admin-only listing is unavailable (regular members, older
    // coderd), probe instead: the default type-named routes plus every name
    // already known from earlier discovery or user config. Absent routes 404
    // conclusively, so probing converges on the configured set for
    // default-named deployments; custom-named instances stay reachable via
    // the user-managed additionalProviders escape hatch.
    const authoritative = listing.kind === "ok";
    let providers: CoderGatewayProvider[];
    if (authoritative) {
      providers = listing.providers;
    } else {
      const section = this.providersConfigStore.loadProvidersConfig()?.coder as
        | Record<string, unknown>
        | undefined;
      const known = new Map<string, CoderGatewayProvider>();
      for (const name of CODER_GATEWAY_DEFAULT_PROVIDER_NAMES) {
        known.set(name, { name, type: name });
      }
      for (const provider of [
        ...parseCoderGatewayProviders(section?.discoveredProviders),
        ...parseCoderGatewayProviders(section?.additionalProviders),
      ]) {
        known.set(provider.name, provider);
      }
      providers = [...known.values()];
    }

    // Provider catalogs are independent: fetch them concurrently and bound
    // each request, so one stalled provider can neither delay nor starve a
    // healthy one. Transient failures are retried per provider.
    const results = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        result: await this.retryTransient(() => this.fetchProviderCatalog(auth, provider)),
      }))
    );

    const everyFetchFailed =
      results.length > 0 && results.every(({ result }) => result.kind === "error");

    // Discovery races logins/disconnects: the flow resolves before this runs,
    // so a newer login (or a disconnect) may replace or clear the stored
    // credential while catalogs are fetched. The credential check and the
    // catalog write happen in ONE locked mutation, so only the login whose
    // tokens are still current can commit — a stale discovery can never
    // repopulate models over a disconnect or a newer deployment's catalog.
    // The credential check also pins the deployment, so per-provider
    // carry-forward below can only resurrect entries from THIS deployment.
    // `models` stays the user-visible union: manually added entries (those
    // not recorded in discoveredModels) are carried forward ahead of the
    // fresh catalog, so discovery never clobbers user-managed data.
    let catalogInconclusive = false;
    let supersededByConcurrentRefresh = false;
    const setResult = await this.providerService.updateProviderSection("coder", (section) => {
      const stored = parseCoderOauthAuth(section?.coderOauth);
      // Compare the stable login-session lineage, not the access token:
      // ordinary requests rotate the token while catalogs are fetched
      // (rotations preserve sessionId — see refreshTokens), and rejecting a
      // same-session rotation would silently discard the fetched catalog.
      // A new login mints a fresh sessionId, so stale discoveries still lose.
      if (
        !stored ||
        stored.sessionId !== auth.sessionId ||
        stored.deploymentUrl !== auth.deploymentUrl
      ) {
        return null;
      }
      // Same counter-comparison pattern as coderDisconnectGeneration, checked
      // inside the providers-file lock so compare + increment are atomic
      // ACROSS processes: a catalog commit anywhere since this refresh began
      // means these results were fetched against a superseded provider
      // list/catalog — refuse rather than let the older refresh win.
      const currentCatalogGeneration = sanitizeGenerationCounter(section?.coderCatalogGeneration);
      if (currentCatalogGeneration !== refreshStartGeneration) {
        supersededByConcurrentRefresh = true;
        return null;
      }
      // Prior catalog state must be read INSIDE the locked mutation (a
      // concurrent login/refresh may have changed it since discovery began).
      const previousKnown = Array.isArray(section?.discoveredModels);
      const previousDiscovered = Array.isArray(section?.discoveredModels)
        ? section.discoveredModels.filter((id): id is string => typeof id === "string")
        : [];
      // Display state retained through an earlier inconclusive refresh (the
      // authoritative catalog was deleted then; this marker is all that
      // remains of it). Never authoritative prior state — it only keeps
      // entries user-visible across consecutive failed refreshes.
      const staleDiscovered = Array.isArray(section?.staleDiscoveredModels)
        ? section.staleDiscoveredModels.filter((id): id is string => typeof id === "string")
        : [];
      const previousProviders = parseCoderGatewayProviders(section?.discoveredProviders);

      // Per-provider conclusiveness: "ok" replaces the provider's entries,
      // "unavailable" (404) conclusively clears them, and a transient "error"
      // carries the provider's previous entries forward — one provider whose
      // upstream rejects /models (Bedrock) or merely flaked must not poison
      // every other provider's refresh, and a recovered provider heals on the
      // next refresh instead of the next login. Carry-forward requires PRIOR
      // STATE for that provider (a prior catalog naming it, or prior entries
      // under its prefix): an errored provider without prior state — fresh
      // login, or an instance the admin just added — makes the whole catalog
      // inconclusive, because persisting the other providers' lists would
      // read as an authoritative catalog that blocks every model of the
      // failed provider until a later successful refresh.
      // The COMPLETE discovered catalog is persisted, deliberately without
      // policy filtering: policies refresh remotely, so a temporarily
      // restrictive policy must not carve models out of the durable catalog.
      // Policy is applied at exposure time instead — getConfig() filters the
      // reported lists, routing checks the current policy, and the factory
      // enforces it per model at creation.
      const modelIds: string[] = [];
      const nextProviders: CoderGatewayProvider[] = [];
      for (const { provider, result } of results) {
        const previous = previousProviders.find((prev) => prev.name === provider.name);
        // Prior state must also TYPE-match under an authoritative listing:
        // when the admin changes an instance's type (same name), the old
        // type's model IDs are not valid carry-forward state — the write
        // persists the NEW type, so carried entries would stay selectable and
        // be sent over the new wire protocol until a successful refresh.
        // A name with no stored metadata previously resolved via the
        // name === type default, so that default is its effective prior type.
        // The probe path persists `previous` (not the probe default), so no
        // type change can occur there and the check is skipped.
        const previousType = previous?.type ?? provider.name;
        const typeUnchanged = !authoritative || previousType === provider.type;
        const hasPriorState =
          previousKnown &&
          typeUnchanged &&
          (previous !== undefined ||
            previousDiscovered.some((id) => id.startsWith(`${provider.name}/`)));
        if (result.kind === "ok") {
          modelIds.push(...result.ids);
          if (!authoritative) {
            // The probe confirmed the route exists; prefer previously stored
            // metadata (its type may come from an earlier authoritative
            // listing) over the probe-derived name === type default.
            nextProviders.push(previous ?? provider);
          }
        } else if (result.kind === "error") {
          if (!hasPriorState) {
            catalogInconclusive = true;
            // Consecutive failed refreshes: after an inconclusive refresh the
            // authoritative catalog is gone (previousKnown false), so a
            // transiently failing provider has no carry-forward state — but
            // its stale display entries must stay user-visible instead of
            // vanishing from Settings/the selector. The catalog stays
            // inconclusive, so these IDs land back in models +
            // staleDiscoveredModels, never in discoveredModels. Type-gated
            // like authoritative carry-forward.
            if (typeUnchanged) {
              modelIds.push(...staleDiscovered.filter((id) => id.startsWith(`${provider.name}/`)));
            }
            continue;
          }
          modelIds.push(...previousDiscovered.filter((id) => id.startsWith(`${provider.name}/`)));
          if (!authoritative && previous) {
            nextProviders.push(previous);
          }
        } else if (!authoritative && previous !== undefined) {
          // "unavailable" on the PROBE path for an instance recorded by an
          // earlier authoritative listing: the 404 proves only that the
          // upstream serves no /models route — not that the admin removed
          // the gateway instance (only an authoritative listing can say
          // that). Dropping it would leave manually configured
          // coder:<custom>/<model> entries unresolvable until a listing
          // succeeds again, so keep the metadata and carry prior entries
          // forward like a transient error.
          nextProviders.push(previous);
          if (previousKnown) {
            modelIds.push(...previousDiscovered.filter((id) => id.startsWith(`${provider.name}/`)));
          } else {
            // No authoritative prior catalog: stale display entries must not
            // be promoted into a conclusive write.
            catalogInconclusive = true;
            modelIds.push(...staleDiscovered.filter((id) => id.startsWith(`${provider.name}/`)));
          }
        }
        // "unavailable" otherwise: the authoritative listing already names
        // every existing instance (a listed instance whose /models 404s
        // conclusively serves no catalog), and probe-default names carry no
        // recorded metadata — the route is conclusively absent; drop it.
      }

      const manual = manualModelEntries(section);
      const manualIds = new Set(manual.map((entry) => maybeGetProviderModelEntryId(entry)));
      // User-removed discovered models (recorded by setModels) stay excluded:
      // a catalog refresh or re-login must not resurrect entries the user
      // deleted from the model list.
      const removed = new Set(
        Array.isArray(section?.removedModels)
          ? section.removedModels.filter((id): id is string => typeof id === "string")
          : []
      );
      // User-visible union: manual entries first, then discovered/carried IDs.
      const retainedDiscovered = modelIds.filter((id) => !manualIds.has(id) && !removed.has(id));
      const merged = [...manual, ...retainedDiscovered];

      if (catalogInconclusive) {
        // The catalog cannot be written as authoritative. Keep/flip it to
        // UNKNOWN so routing fails open (the failed provider's models stay
        // reachable), losing at worst one refresh's worth of catalog data —
        // the next successful refresh rebuilds it. The healthy providers'
        // fetched and carried-forward entries STAY user-visible in `models`
        // (only the authoritative `discoveredModels` marker is dropped):
        // wiping them would empty Settings and the model selector until a
        // later fully successful refresh. The authoritative admin listing is
        // conclusive independently of the catalog fetches, so it is still
        // persisted: custom-named instances must stay resolvable (e.g. for
        // manually added models). Probe-derived metadata is just the
        // name === type default that resolveCoderGatewayProvider already
        // applies without persistence, so the probe path persists nothing
        // new and keeps any previously stored metadata.
        const next = { ...(section ?? {}) };
        if (merged.length > 0) {
          next.models = merged;
        } else {
          delete next.models;
        }
        delete next.discoveredModels;
        // Record which retained entries came from discovery so
        // manualModelEntries keeps classifying them as catalog data (cleared
        // by disconnect/login, excluded from manual carry-forward) while the
        // authoritative marker is absent.
        if (retainedDiscovered.length > 0) {
          next.staleDiscoveredModels = retainedDiscovered;
        } else {
          delete next.staleDiscoveredModels;
        }
        if (authoritative) {
          next.discoveredProviders = providers;
        }
        // Even an inconclusive write is a catalog commit: a slower concurrent
        // refresh must re-fetch rather than overwrite the retained state.
        next.coderCatalogGeneration = currentCatalogGeneration + 1;
        return { value: next };
      }

      if (authoritative) {
        // The admin listing is authoritative metadata: every listed instance
        // is persisted (routable for manually added models even when its
        // catalog fetch failed), and deleted/disabled instances drop out.
        nextProviders.length = 0;
        nextProviders.push(...providers);
      }
      // Conclusive catalog: the stale marker's entries are either re-listed
      // in discoveredModels or conclusively gone.
      const conclusive: Record<string, unknown> = {
        ...(section ?? {}),
        models: merged,
        discoveredModels: modelIds,
        discoveredProviders: nextProviders,
        coderCatalogGeneration: currentCatalogGeneration + 1,
      };
      delete conclusive.staleDiscoveredModels;
      return { value: conclusive };
    });
    if (!setResult.success) {
      log.debug(`[Coder OAuth] Failed to persist bridge models: ${setResult.error}`);
      return Err(setResult.error);
    }
    if (catalogInconclusive || everyFetchFailed) {
      // The catalog itself was not conclusively refreshed (at most provider
      // metadata and carried-forward entries were persisted): surface the
      // failure so the user knows to refresh again.
      log.debug("[Coder OAuth] Catalog refresh inconclusive: provider fetches failed transiently");
      return Err(
        everyFetchFailed
          ? "Model discovery failed for every AI Gateway provider"
          : "Model discovery failed for at least one AI Gateway provider; try refreshing again"
      );
    }
    if (!setResult.data.applied) {
      // Nothing was persisted — report failure so Settings/palette callers
      // don't claim models were refreshed when the fetched catalog was
      // discarded (login superseded, disconnected mid-refresh, or another
      // process committed a newer catalog first).
      log.debug(
        supersededByConcurrentRefresh
          ? "[Coder OAuth] Skipping stale model catalog write (concurrent refresh committed first)"
          : "[Coder OAuth] Skipping stale model catalog write (login superseded)"
      );
      return Err(
        supersededByConcurrentRefresh
          ? "Model refresh superseded by a concurrent refresh; try again"
          : "Model refresh superseded by a newer login; try again"
      );
    }
    return Ok(undefined);
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  private readStoredAuth(): CoderOauthAuth | null {
    // The cache is verified against the providers file's CONTENT fingerprint
    // on every read, not just invalidated by the config-change notification:
    // that notification rides on fs.watch, which Config.watchProvidersFile
    // explicitly degrades to a no-op on unsupported mounts (NFS/SMB, watch
    // limit exhaustion) and can silently die after an error. A long-lived
    // headless process trusting watcher delivery alone would keep serving a
    // token another Xum process disconnected or replaced until it expired —
    // failing every request against a revoked token, or keeping an
    // un-revoked credential in use after the user disconnected it. The
    // fingerprint is captured BEFORE the read, so a write racing this load
    // at worst forces an extra re-read on the next call, never a stale hit.
    const fingerprint = this.providersConfigStore.getProvidersFileFingerprint();
    if (this.cachedAuth && fingerprint != null && fingerprint === this.cachedAuthFingerprint) {
      return this.cachedAuth;
    }
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    const coderConfig = providersConfig.coder as Record<string, unknown> | undefined;
    const auth = parseCoderOauthAuth(coderConfig?.coderOauth);
    this.cachedAuth = auth;
    this.cachedAuthFingerprint = fingerprint;
    return auth;
  }

  /**
   * Compare-and-swap credential write (refreshes): persists `auth` only while
   * the stored blob still holds `expectedRefresh` — the token this refresh
   * consumed — AND the section's effective deployment URL still matches the
   * credential's issuer. Skipped means a newer login/disconnect superseded
   * the refresh, or a deployment URL edit landed while the token round-trip
   * was in flight (persisting then would store a rotation the new
   * configuration can never serve, keeping it alive unrevoked forever).
   */
  private async persistRotatedAuth(
    auth: CoderOauthAuth,
    expectedRefresh: string
  ): Promise<Result<{ applied: boolean }, string>> {
    const result = await this.providerService.updateProviderSection("coder", (section) => {
      const stored = parseCoderOauthAuth(section?.coderOauth);
      if (stored?.refresh !== expectedRefresh) {
        return null;
      }
      const raw = section?.deploymentUrl;
      const configured = typeof raw === "string" ? normalizeCoderDeploymentUrl(raw) : null;
      if (this.effectiveDeploymentUrl(configured) !== auth.deploymentUrl) {
        return null;
      }
      return { value: { ...(section ?? {}), coderOauth: auth } };
    });
    this.cachedAuth = null;
    return result;
  }
}
