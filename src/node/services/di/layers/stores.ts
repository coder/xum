import { Layer } from "effect";
import type { ConfigStores } from "@/node/config";
import {
  ConfigTag,
  FileLeaseManagerTag,
  ProvidersConfigStoreTag,
  SecretsStoreTag,
  SessionLocatorTag,
  type StoreTags,
} from "@/node/services/di/tags";

/**
 * Exposes an already-constructed `ConfigStores` bundle as Layer outputs. The
 * stores are true siblings (no inter-dependencies), so `mergeAll` is correct
 * here; anything that depends on a store must be composed with
 * `Layer.provideMerge` instead.
 */
export function StoresLive(stores: ConfigStores): Layer.Layer<StoreTags> {
  return Layer.mergeAll(
    Layer.succeed(ConfigTag)(stores.config),
    Layer.succeed(SessionLocatorTag)(stores.sessionLocator),
    Layer.succeed(ProvidersConfigStoreTag)(stores.providersConfigStore),
    Layer.succeed(SecretsStoreTag)(stores.secretsStore),
    Layer.succeed(FileLeaseManagerTag)(stores.fileLeaseManager)
  );
}
