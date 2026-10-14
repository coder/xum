/**
 * Pure per-provider merge rules for a Coder AI Gateway catalog refresh.
 *
 * CoderOauthService.refreshBridgeModelsSerializedEffect fetches every
 * provider's catalog, then commits the merged result inside the providers-file
 * lock. The rules that decide what each provider contributes live here so they
 * can be tested without the OAuth service, the lock or the network.
 */
import { parseCoderGatewayProviders } from "@/common/constants/coderOAuth";
import type { CoderGatewayProvider } from "@/common/constants/coderOAuth";

/** One provider catalog request, classified (see fetchProviderCatalogEffect). */
export type CoderProviderCatalogResult =
  | { kind: "ok"; ids: string[] }
  | { kind: "unavailable" }
  | { kind: "error" };

/** Catalog state persisted before this refresh, read INSIDE the locked mutation. */
export interface PriorCoderCatalog {
  /** True when an authoritative `discoveredModels` list exists. */
  known: boolean;
  /** Model IDs of the authoritative catalog (empty when not known). */
  discovered: string[];
  /**
   * Catalog IDs carried through an earlier inconclusive refresh (the
   * authoritative catalog was deleted then; this marker is all that remains
   * of it). Never authoritative prior state — it only carries a provider's
   * entries forward across consecutive failed refreshes.
   */
  stale: string[];
  /** Provider metadata persisted by earlier discovery. */
  providers: CoderGatewayProvider[];
}

/** What one provider contributes to the next catalog write. */
export interface ProviderCatalogContribution {
  /** Model IDs to persist for this provider. */
  ids: string[];
  /** Provider metadata to persist on the probe path: zero or one entry. */
  providers: CoderGatewayProvider[];
  /** True when this provider makes the whole catalog inconclusive. */
  inconclusive: boolean;
}

function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function readPriorCoderCatalog(
  section: Record<string, unknown> | undefined
): PriorCoderCatalog {
  return {
    known: Array.isArray(section?.discoveredModels),
    discovered: stringEntries(section?.discoveredModels),
    stale: stringEntries(section?.staleDiscoveredModels),
    providers: parseCoderGatewayProviders(section?.discoveredProviders),
  };
}

function idsUnderProvider(ids: string[], providerName: string): string[] {
  return ids.filter((id) => id.startsWith(`${providerName}/`));
}

/**
 * Per-provider conclusiveness: "ok" replaces the provider's entries,
 * "unavailable" (404) conclusively clears them, and a transient "error"
 * carries the provider's previous entries forward — one provider whose
 * upstream rejects /models (Bedrock) or merely flaked must not poison
 * every other provider's refresh, and a recovered provider heals on the
 * next refresh instead of the next login. Carry-forward requires PRIOR
 * STATE for that provider (a prior catalog naming it, or prior entries
 * under its prefix): an errored provider without prior state — fresh
 * login, or an instance the admin just added — makes the whole catalog
 * inconclusive, because persisting the other providers' lists would
 * read as an authoritative catalog that blocks every model of the
 * failed provider until a later successful refresh.
 *
 * `authoritative` is true when the provider set came from the admin listing,
 * false when it came from probing default and known names.
 */
export function reconcileProviderCatalog(
  provider: CoderGatewayProvider,
  result: CoderProviderCatalogResult,
  prior: PriorCoderCatalog,
  authoritative: boolean
): ProviderCatalogContribution {
  const previous = prior.providers.find((prev) => prev.name === provider.name);
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
    prior.known &&
    typeUnchanged &&
    (previous !== undefined || prior.discovered.some((id) => id.startsWith(`${provider.name}/`)));
  if (result.kind === "ok") {
    // The probe confirmed the route exists; prefer previously stored
    // metadata (its type may come from an earlier authoritative
    // listing) over the probe-derived name === type default.
    return {
      ids: result.ids,
      providers: authoritative ? [] : [previous ?? provider],
      inconclusive: false,
    };
  }
  if (result.kind === "error") {
    if (!hasPriorState) {
      // Consecutive failed refreshes: after an inconclusive refresh the
      // authoritative catalog is gone (prior.known false), so a
      // transiently failing provider has no carry-forward state — but
      // its stale entries must not vanish (a later successful refresh
      // would otherwise start from nothing). The catalog stays
      // inconclusive, so these IDs land back in staleDiscoveredModels,
      // never in discoveredModels. Type-gated like authoritative
      // carry-forward.
      return {
        ids: typeUnchanged ? idsUnderProvider(prior.stale, provider.name) : [],
        providers: [],
        inconclusive: true,
      };
    }
    return {
      ids: idsUnderProvider(prior.discovered, provider.name),
      providers: !authoritative && previous ? [previous] : [],
      inconclusive: false,
    };
  }
  if (!authoritative && previous !== undefined) {
    // "unavailable" on the PROBE path for an instance recorded by an
    // earlier authoritative listing: the 404 proves only that the
    // upstream serves no /models route — not that the admin removed
    // the gateway instance (only an authoritative listing can say
    // that). Dropping it would leave manually configured
    // coder:<custom>/<model> entries unresolvable until a listing
    // succeeds again, so keep the metadata and carry prior entries
    // forward like a transient error. Without an authoritative prior
    // catalog, stale entries must not be promoted into a conclusive write.
    return prior.known
      ? {
          ids: idsUnderProvider(prior.discovered, provider.name),
          providers: [previous],
          inconclusive: false,
        }
      : {
          ids: idsUnderProvider(prior.stale, provider.name),
          providers: [previous],
          inconclusive: true,
        };
  }
  // "unavailable" otherwise: the authoritative listing already names
  // every existing instance (a listed instance whose /models 404s
  // conclusively serves no catalog), and probe-default names carry no
  // recorded metadata — the route is conclusively absent; drop it.
  return { ids: [], providers: [], inconclusive: false };
}
