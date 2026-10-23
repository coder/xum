// Preload of `make test-host-proof` only (tests/hostProof.bunfig.toml), before tests/setup.ts.
// It must stay first in that list (why: src/node/services/hostTrap/hostTrap.testHarness.ts).
import { installHostTrap } from "../src/node/services/hostTrap/hostTrap.testHarness";

installHostTrap();
